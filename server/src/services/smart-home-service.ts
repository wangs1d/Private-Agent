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
}
