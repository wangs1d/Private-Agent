import type { MessageHubPlatform } from "./message-hub-service.js";

export type MessagePlatformSendInput = {
  actorId: string;
  platform: MessageHubPlatform;
  channelId: string;
  text: string;
  conversationId?: string;
  replyToMessageId?: string;
  /** sms 代发的接收号码；缺省从 channelId 解析（短信会话的 channelId 即号码） */
  to?: string;
};

export type MessagePlatformSendResult = {
  ok: boolean;
  externalMessageId?: string;
  delivered?: boolean;
  message?: string;
};

type PlatformBridgeConfig = {
  url: string | null;
  token: string | null;
};

/** 手机桥接发送端口：sms 平台经用户手机真发（SmsManager + 手机确认窗）。 */
export type PhoneBridgeSender = {
  hasExecutor: (actorId: string) => boolean;
  invoke: (
    actorId: string,
    action: string,
    params: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
};

function normalizeUrl(raw: string | undefined): string | null {
  const v = raw?.trim() ?? "";
  return v ? v : null;
}

function normalizeToken(raw: string | undefined): string | null {
  const v = raw?.trim() ?? "";
  return v ? v : null;
}

/** 短信号码形态校验：纯数字/区号/分隔符，5~25 位 */
const PHONE_LIKE = /^\+?[\d\s-]{5,25}$/;

export class MessagePlatformGateway {
  private readonly wechat: PlatformBridgeConfig;
  private readonly qq: PlatformBridgeConfig;
  private readonly feishu: PlatformBridgeConfig;
  private phoneBridgeSender: PhoneBridgeSender | null = null;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
    this.wechat = {
      url: normalizeUrl(env.WECHAT_BRIDGE_SEND_URL),
      token: normalizeToken(env.WECHAT_BRIDGE_SEND_TOKEN),
    };
    this.qq = {
      url: normalizeUrl(env.QQ_BRIDGE_SEND_URL),
      token: normalizeToken(env.QQ_BRIDGE_SEND_TOKEN),
    };
    this.feishu = {
      url: normalizeUrl(env.FEISHU_BRIDGE_SEND_URL),
      token: normalizeToken(env.FEISHU_BRIDGE_SEND_TOKEN),
    };
  }

  /** bootstrap 装配：接入 PhoneBridgeCoordinator（sms 平台真发通道） */
  setPhoneBridgeSender(sender: PhoneBridgeSender | null): void {
    this.phoneBridgeSender = sender;
  }

  private configFor(platform: MessageHubPlatform): PlatformBridgeConfig | null {
    switch (platform) {
      case "wechat":
        return this.wechat;
      case "qq":
        return this.qq;
      case "feishu":
        return this.feishu;
      default:
        return null;
    }
  }

  private async sendViaHttpBridge(
    platform: MessageHubPlatform,
    config: PlatformBridgeConfig,
    input: MessagePlatformSendInput,
  ): Promise<MessagePlatformSendResult> {
    if (!config.url) {
      return {
        ok: true,
        delivered: false,
        message: `queued locally; ${platform} bridge send url not configured`,
        externalMessageId: `${platform}-${Date.now()}`,
      };
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.token) {
      headers.Authorization = `Bearer ${config.token}`;
    }

    const response = await fetch(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        actorId: input.actorId,
        platform,
        channelId: input.channelId,
        text: input.text,
        conversationId: input.conversationId,
        replyToMessageId: input.replyToMessageId,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    let payload: Record<string, unknown> | null = null;
    try {
      payload = (await response.json()) as Record<string, unknown>;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      return {
        ok: false,
        delivered: false,
        message:
          (payload?.message as string | undefined) ||
          `${platform} bridge send failed with status ${response.status}`,
      };
    }

    return {
      ok: true,
      delivered: payload?.delivered === true || response.ok,
      message: (payload?.message as string | undefined) || "bridge delivered",
      externalMessageId:
        (payload?.externalMessageId as string | undefined) || `${platform}-${Date.now()}`,
    };
  }

  /**
   * sms 代发：经手机桥接 invoke("send_sms") → 手机端弹出确认窗 → 用户确认后
   * SmsManager 真发。手机不在线 / 会话无法解析号码时诚实返回 delivered:false。
   */
  private async sendViaPhoneSms(input: MessagePlatformSendInput): Promise<MessagePlatformSendResult> {
    const sender = this.phoneBridgeSender;
    if (!sender) {
      return {
        ok: false,
        delivered: false,
        message: "短信代发通道未装配（手机桥接未启用）",
      };
    }
    if (!sender.hasExecutor(input.actorId)) {
      return {
        ok: false,
        delivered: false,
        message: "手机不在线，无法代发短信",
      };
    }
    const candidate = (input.to ?? input.channelId ?? "").trim();
    if (!PHONE_LIKE.test(candidate)) {
      return {
        ok: false,
        delivered: false,
        message:
          "无法从会话解析接收号码（会话标识不是号码形态）。请提供对方手机号后重试。",
      };
    }
    const number = candidate.replace(/[\s-]/g, "");
    const result = await sender.invoke(input.actorId, "send_sms", {
      number,
      text: input.text,
      confirmTimeoutSec: 25,
    });
    const state = String(result.state ?? "");
    if (result.ok === true && state === "sent") {
      return {
        ok: true,
        delivered: true,
        message: "用户已在手机上确认，短信已发出",
        externalMessageId: `sms-${Date.now()}`,
      };
    }
    if (state === "cancelled") {
      return {
        ok: false,
        delivered: false,
        message: `手机端确认未通过（${String(result.reason ?? result.error ?? "用户取消或超时")}），短信未发出`,
      };
    }
    return {
      ok: false,
      delivered: false,
      message: `短信发送失败：${String(result.error ?? state ?? "手机端异常")}`,
    };
  }

  async send(input: MessagePlatformSendInput): Promise<MessagePlatformSendResult> {
    if (input.platform === "sms") {
      return this.sendViaPhoneSms(input);
    }
    const config = this.configFor(input.platform);
    if (config) {
      return this.sendViaHttpBridge(input.platform, config, input);
    }
    return {
      ok: true,
      delivered: false,
      message: "queued locally; generic platform has no send bridge",
      externalMessageId: `${input.platform}-${Date.now()}`,
    };
  }
}
