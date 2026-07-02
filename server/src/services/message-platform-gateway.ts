import type { MessageHubPlatform } from "./message-hub-service.js";

export type MessagePlatformSendInput = {
  actorId: string;
  platform: MessageHubPlatform;
  channelId: string;
  text: string;
  conversationId?: string;
  replyToMessageId?: string;
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

function normalizeUrl(raw: string | undefined): string | null {
  const v = raw?.trim() ?? "";
  return v ? v : null;
}

function normalizeToken(raw: string | undefined): string | null {
  const v = raw?.trim() ?? "";
  return v ? v : null;
}

export class MessagePlatformGateway {
  private readonly wechat: PlatformBridgeConfig;
  private readonly qq: PlatformBridgeConfig;
  private readonly feishu: PlatformBridgeConfig;

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

  async send(input: MessagePlatformSendInput): Promise<MessagePlatformSendResult> {
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
