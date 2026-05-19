import { randomInt, randomUUID } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { ServerEventType } from "../protocol.js";
import type { TtsService } from "./tts-service.js";
import type { WsConnectionRegistry } from "./ws-connection-registry.js";
import { relayRequiresPairEnv } from "./agent-pairing-service.js";
import type { AgentPairingService } from "./agent-pairing-service.js";

export type VirtualPhoneRingStyle = "reminder" | "peer";
export type VirtualPhoneInitiator = "user" | "agent";

type PersistedVirtualPhones = {
  byActor: Record<string, string>;
};

export type PlaceVirtualCallParams = {
  fromActorId: string;
  toPhone: string;
  transcript: string;
  ringStyle: VirtualPhoneRingStyle;
  initiatedBy: VirtualPhoneInitiator;
};

export class VirtualPhoneService {
  private readonly byActor = new Map<string, string>();
  private readonly byPhone = new Map<string, string>();
  private persistChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly tts: TtsService,
    private readonly wsRegistry: WsConnectionRegistry,
    private readonly pairing: AgentPairingService,
  ) {}

  private get persistPath(): string {
    return process.env.VIRTUAL_PHONES_FILE ?? join(process.cwd(), "data", "virtual-phones.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const data = JSON.parse(raw) as PersistedVirtualPhones;
      this.byActor.clear();
      this.byPhone.clear();
      for (const [actor, phone] of Object.entries(data.byActor ?? {})) {
        const a = actor?.trim() ?? "";
        const p = normalizeVirtualPhone(phone);
        if (!a || !p) continue;
        const owner = this.byPhone.get(p);
        if (owner && owner !== a) {
          continue;
        }
        this.byActor.set(a, p);
        this.byPhone.set(p, a);
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return;
      throw e;
    }
  }

  private schedulePersist(): void {
    this.persistChain = this.persistChain.then(() => this.persistNow());
  }

  private async persistNow(): Promise<void> {
    const dir = dirname(this.persistPath);
    await mkdir(dir, { recursive: true });
    const byActor: Record<string, string> = {};
    for (const [k, v] of this.byActor) byActor[k] = v;
    await writeFile(this.persistPath, JSON.stringify({ byActor }, null, 2), "utf8");
  }

  getPhoneForActor(actorId: string): string | undefined {
    return this.byActor.get(actorId);
  }

  /**
   * 申领或返回该 Actor 的 6 位虚拟号码。
   * 仅应在用户明确要求 Agent 办理时调用（如工具 `phone.ensure_my_number`），不得在其它路径隐式调用。
   */
  ensureNumber(actorId: string): string {
    const id = actorId.trim();
    if (!id) throw new Error("actorId 不能为空");
    const existing = this.byActor.get(id);
    if (existing) return existing;

    const maxAttempts = 16_384;
    const poolSize = 1_000_000;
    const taken = this.byPhone.size;
    if (taken >= poolSize) {
      throw new Error("6 位虚拟号已用尽");
    }
    for (let i = 0; i < maxAttempts; i++) {
      const candidate = randomSixDigits();
      if (this.byPhone.has(candidate)) continue;
      this.byActor.set(id, candidate);
      this.byPhone.set(candidate, id);
      this.schedulePersist();
      return candidate;
    }
    throw new Error("虚拟号池忙碌，请稍后重试");
  }

  resolveActorByPhone(phoneRaw: string): string | undefined {
    const p = normalizeVirtualPhone(phoneRaw);
    if (!p) return undefined;
    return this.byPhone.get(p);
  }

  /**
   * 向持有该号码的 Actor 推送 WebSocket「来电」；可拨打本人号码作语音提醒。
   */
  async placeCall(params: PlaceVirtualCallParams): Promise<{
    ok: boolean;
    callId?: string;
    pushed?: boolean;
    targetActorId?: string;
    fromPhone?: string;
    error?: string;
  }> {
    const fromActorId = params.fromActorId.trim();
    const toPhone = normalizeVirtualPhone(params.toPhone);
    if (!fromActorId) {
      return { ok: false, error: "主叫方无效" };
    }
    if (!toPhone) {
      return { ok: false, error: "号码须为 6 位数字" };
    }

    const targetActorId = this.byPhone.get(toPhone);
    if (!targetActorId) {
      return { ok: false, error: "该号码未注册虚拟线路（对方可能尚未申领号码）" };
    }

    if (targetActorId !== fromActorId) {
      if (relayRequiresPairEnv() && !this.pairing.arePaired(fromActorId, targetActorId)) {
        return {
          ok: false,
          error:
            "拨打其他 Agent 需先配对：请双方 POST /agent/pair 相同配对码，或开发环境设置 AGENT_RELAY_REQUIRE_PAIR=0",
        };
      }
    }

    const fromPhone = this.byActor.get(fromActorId);
    if (!fromPhone) {
      return {
        ok: false,
        error:
          "主叫方尚未申领虚拟号码：请用户明确要求后再由 Agent 调用 phone.ensure_my_number，无法自动分配",
      };
    }
    const ttsResult = await this.tts.synthesizeMp3Base64(params.transcript);
    const callId = randomUUID();

    const payload: Record<string, unknown> = {
      callId,
      fromActorId,
      fromPhone,
      toPhone,
      transcript: params.transcript.trim(),
      ringStyle: params.ringStyle,
      initiatedBy: params.initiatedBy,
      tts: ttsResult.ok
        ? { format: ttsResult.format, base64: ttsResult.base64 }
        : { format: null, skippedReason: ttsResult.reason },
    };

    const pushed = this.wsRegistry.trySend(
      targetActorId,
      JSON.stringify({
        type: ServerEventType.VirtualPhoneIncoming,
        payload,
      }),
    );

    return {
      ok: true,
      callId,
      pushed,
      targetActorId,
      fromPhone,
    };
  }
}

export function normalizeVirtualPhone(raw: string): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length !== 6) return null;
  return digits;
}

/** 密码学安全随机，均匀分布于 000000–999999；与 byPhone 配合保证进程内唯一。 */
function randomSixDigits(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}
