import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyRequest } from "fastify";

import { resolveActorId } from "../agent/actor-id.js";
import { parseAgentAccessMode } from "../agent/agent-access-mode.js";
import { resolvePrimaryChatSessionId } from "../agent/master-chat-session.js";
import { getAgentRuntimeConfig } from "../agent/agent-runtime-config.js";
import { createExternalChatProviderFromEnv } from "../external-model/resolve-provider.js";
import type { ClientLocationWire } from "../types/client-location.js";
import type { AgentCore } from "./agent-core.js";
import { runChatTurnForActor, type ChatTurnInput } from "./chat-turn-runner.js";
import { isWechatClawFeatureEnabled } from "./openclaw-gateway-client.js";
import type { WeatherPrefsService } from "./weather-prefs-service.js";
import { sanitizeWechatInboundText } from "./wechat-inbound-text.js";

function parseBooleanEnv(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function isWechatClawBridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanEnv(env.WECHAT_CLAW_BRIDGE_ENABLED);
}

export function readWechatClawBridgeConfig(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  token: string | null;
  defaultActorId: string;
  serverPort: number;
} {
  const port = Number(env.PORT ?? "3000");
  return {
    enabled: isWechatClawBridgeEnabled(env),
    token: env.WECHAT_CLAW_BRIDGE_TOKEN?.trim() || null,
    defaultActorId:
      env.WECHAT_CLAW_BRIDGE_ACTOR_ID?.trim() ||
      env.DESKTOP_BRIDGE_USER_ID?.trim() ||
      "session-mvp-001",
    serverPort: Number.isFinite(port) ? port : 3000,
  };
}

function isLoopbackIp(ip: string | undefined): boolean {
  if (!ip) return false;
  const n = ip.replace(/^::ffff:/, "");
  return n === "127.0.0.1" || n === "::1" || n === "localhost";
}

export function assertWechatClawBridgeAuthorized(
  request: FastifyRequest,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const { token } = readWechatClawBridgeConfig(env);
  if (token) {
    const header =
      (typeof request.headers.authorization === "string"
        ? request.headers.authorization.replace(/^Bearer\s+/i, "").trim()
        : "") ||
      (typeof request.headers["x-wechat-claw-bridge-token"] === "string"
        ? request.headers["x-wechat-claw-bridge-token"].trim()
        : "");
    if (header !== token) {
      throw new Error("微信消息桥鉴权失败");
    }
    return;
  }
  const ip = request.ip;
  if (!isLoopbackIp(ip)) {
    throw new Error("未配置 WECHAT_CLAW_BRIDGE_TOKEN 时仅允许本机访问消息桥");
  }
}

export type WechatClawBridgeChatBody = {
  text: string;
  userId?: string;
  sessionId?: string;
  weixinSenderId?: string;
  channel?: string;
  accountId?: string;
  messageId?: string;
};

export class WechatClawBridgeService {
  constructor(
    private readonly agentCore: AgentCore,
    private readonly deps: {
      weatherPrefsService?: WeatherPrefsService;
      env?: NodeJS.ProcessEnv;
    } = {},
  ) {}

  private get env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env;
  }

  isEnabled(): boolean {
    return isWechatClawBridgeEnabled(this.env) && isWechatClawFeatureEnabled(this.env);
  }

  resolveActorId(body: WechatClawBridgeChatBody): string {
    const explicit = resolveActorId({
      userId: body.userId,
      sessionId: body.sessionId ?? "",
    });
    if (body.userId?.trim() || body.sessionId?.trim()) {
      return explicit;
    }
    return readWechatClawBridgeConfig(this.env).defaultActorId;
  }

  /** App 绑定文件中的 actorId，与 Flutter USER_ID 对齐。 */
  private async resolveBoundActorId(): Promise<string | null> {
    const path =
      this.env.WECHAT_CLAW_BINDING_FILE?.trim() ||
      join(process.cwd(), "data", "wechat-claw-bindings.json");
    try {
      const raw = await readFile(path, "utf8");
      const data = JSON.parse(raw) as {
        bindings?: Record<string, { actorId?: string }>;
      };
      const bindings = data.bindings ?? {};
      const keys = Object.keys(bindings);
      if (keys.length === 0) return null;
      const first = bindings[keys[0]!];
      const actor = first?.actorId?.trim() || keys[0]!.trim();
      return actor || null;
    } catch {
      return null;
    }
  }

  private async resolveActorIdForTurn(body: WechatClawBridgeChatBody): Promise<string> {
    if (body.userId?.trim() || body.sessionId?.trim()) {
      return this.resolveActorId(body);
    }
    const bound = await this.resolveBoundActorId();
    if (bound) return bound;
    return readWechatClawBridgeConfig(this.env).defaultActorId;
  }

  async handleChat(body: WechatClawBridgeChatBody): Promise<
    | { ok: true; replyText: string; actorId: string; messageId: string }
    | { ok: false; message: string }
  > {
    if (!this.isEnabled()) {
      return { ok: false, message: "微信消息桥未启用（WECHAT_CLAW_BRIDGE_ENABLED=1）" };
    }

    const text = sanitizeWechatInboundText(body.text);
    if (!text) {
      return { ok: false, message: "消息内容为空" };
    }

    const actorId = await this.resolveActorIdForTurn(body);

    if (/^\/new\b/i.test(text) || /^\/reset\b/i.test(text)) {
      await this.resetChatSession(actorId);
      return {
        ok: true,
        actorId,
        messageId: body.messageId ?? `wechat-bridge-${randomUUID()}`,
        replyText: "已开启新对话，与 App 共用同一套记忆与工具。请继续发送你的问题。",
      };
    }

    const accessMode = parseAgentAccessMode(
      this.env.WECHAT_CLAW_BRIDGE_AGENT_ACCESS_MODE?.trim() || "sandbox",
    );
    const turnInput: ChatTurnInput = {
      text,
      messageId: body.messageId,
      userId: body.userId ?? actorId,
      agentAccessMode: accessMode,
      preferFullPipeline: true,
      clientLocation: this.clientLocationForActor(actorId),
    };

    console.log(
      `[wechat-claw-bridge] turn actor=${actorId} textLen=${text.length} access=${accessMode} location=${turnInput.clientLocation?.label ?? "none"}`,
    );

    const result = await runChatTurnForActor(this.agentCore, actorId, turnInput);
    if (!result.ok) {
      return { ok: false, message: result.message };
    }
    return {
      ok: true,
      actorId,
      messageId: result.messageId,
      replyText: result.finalText,
    };
  }

  private clientLocationForActor(actorId: string): ClientLocationWire | undefined {
    const prefs = this.deps.weatherPrefsService?.get(actorId);
    if (!prefs) return undefined;
    return {
      latitude: prefs.latitude,
      longitude: prefs.longitude,
      label: prefs.label,
      timezone: prefs.timezone,
    };
  }

  async resetChatSession(actorId: string): Promise<void> {
    const provider = createExternalChatProviderFromEnv();
    if (!provider?.clearSession) return;
    const masterOn = getAgentRuntimeConfig().masterDelegation.enabled;
    const chatSessionId = resolvePrimaryChatSessionId(actorId, masterOn);
    provider.clearSession(chatSessionId);
  }

  /** 供 OpenClaw 插件安装时写入 bridgeToken（与 server .env 对齐）。 */
  bridgeTokenFingerprint(token: string): string {
    return createHash("sha256").update(token).digest("hex").slice(0, 12);
  }
}
