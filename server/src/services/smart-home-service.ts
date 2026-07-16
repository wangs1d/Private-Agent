import type { LifeSignalHubService } from "./life-signal-hub-service.js";

export interface HADeviceState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

export interface HAServiceDomain {
  domain: string;
  services: Record<string, HAServiceInfo>;
}

interface HAServiceInfo {
  name?: string;
  description?: string;
  fields?: Record<string, unknown>;
}

export class SmartHomeService {
  private baseUrl: string;
  private token: string;
  private enabled: boolean;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastStates = new Map<string, string>();

  constructor(baseUrl?: string, token?: string) {
    this.baseUrl = (baseUrl ?? process.env.HA_BASE_URL ?? "").replace(/\/+$/, "");
    this.token = token ?? process.env.HA_TOKEN ?? "";
    this.enabled = Boolean(this.baseUrl && this.token);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    if (!this.enabled) {
      throw new Error("HomeAssistant 未配置（HA_BASE_URL / HA_TOKEN 缺失）");
    }
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HA API ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }

  async getAllStates(): Promise<HADeviceState[]> {
    return this.request<HADeviceState[]>("/api/states");
  }

  async getState(entityId: string): Promise<HADeviceState> {
    return this.request<HADeviceState>(`/api/states/${encodeURIComponent(entityId)}`);
  }

  async callService(
    domain: string,
    service: string,
    data?: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request(`/api/services/${domain}/${service}`, {
      method: "POST",
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  async getServices(): Promise<HAServiceDomain[]> {
    return this.request<HAServiceDomain[]>("/api/services");
  }

  formatDeviceList(states: HADeviceState[]): string {
    const lines = states
      .filter((s) => !s.entity_id.startsWith("automation.") && !s.entity_id.startsWith("script."))
      .map((s) => {
        const name = (s.attributes.friendly_name as string) ?? s.entity_id;
        const domain = s.entity_id.split(".")[0];
        const isOn = s.state === "on" || s.state === "home" || s.state === "open";
        const stateIcon =
          domain === "light"
            ? isOn
              ? "💡"
              : "⚫"
            : domain === "switch"
              ? isOn
                ? "🔌"
                : "⚫"
              : domain === "climate"
                ? `${s.state}°C`
                : domain === "sensor"
                  ? `${s.state}`
                  : domain === "cover"
                    ? s.state === "open"
                      ? "🪟"
                      : "⬛"
                    : `[${s.state}]`;
        return `- ${name} (${s.entity_id}) ${stateIcon}`;
      });
    return lines.length > 0 ? lines.join("\n") : "（未发现设备）";
  }

  /**
   * 启动设备状态轮询：30s 间隔拉取 getAllStates，对比上次快照，
   * 状态变化时通过 LifeSignalHub 发布 smart_home.state_change 信号。
   */
  startStatePolling(lifeSignalHub: LifeSignalHubService): void {
    if (!this.enabled) return;
    if (this.pollTimer) return;
    // 首次立即拉取以建立基线快照，避免首轮将所有设备误报为"新增变化"
    void this.pollOnce(lifeSignalHub, true);
    this.pollTimer = setInterval(() => {
      void this.pollOnce(lifeSignalHub, false);
    }, 30_000);
    this.pollTimer.unref?.();
  }

  stopStatePolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.lastStates.clear();
  }

  private async pollOnce(
    lifeSignalHub: LifeSignalHubService,
    baseline: boolean,
  ): Promise<void> {
    if (!this.enabled) return;
    try {
      const states = await this.getAllStates();
      const prev = this.lastStates;
      const next = new Map(states.map((s) => [s.entity_id, s.state]));
      if (baseline) {
        this.lastStates = next;
        return;
      }
      for (const entity of states) {
        const oldState = prev.get(entity.entity_id);
        const newState = entity.state;
        if (oldState === undefined) continue;
        if (oldState === newState) continue;
        const domain = entity.entity_id.split(".")[0];
        const occurredAt = new Date().toISOString();
        lifeSignalHub.publish({
          id: `system:smart-home:${entity.entity_id}:${occurredAt}`,
          actorId: "system",
          source: "smart_home",
          kind: "smart_home.state_change",
          title: `${entity.attributes.friendly_name ?? entity.entity_id} 状态变化`,
          summary: `${oldState} → ${newState}`,
          tags: ["smart_home", "device_state_change", domain],
          importance: "low",
          evidence: [
            `entity_id=${entity.entity_id}`,
            `domain=${domain}`,
            `oldState=${oldState}`,
            `newState=${newState}`,
          ],
          occurredAt,
          metadata: {
            entity_id: entity.entity_id,
            oldState,
            newState,
            domain,
          },
        });
      }
      this.lastStates = next;
    } catch (err) {
      console.error("[SmartHomeService] state polling failed:", err);
    }
  }
}
