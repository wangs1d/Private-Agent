import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const DEFAULT_CHANNEL = "openclaw-weixin";
const BRIDGE_PATH = "/integrations/wechat-claw/bridge/chat";

function pluginConfig(api, ctx) {
  const cfg =
    ctx?.pluginConfig ??
    api.config?.plugins?.entries?.["private-agent-wechat-bridge"]?.config ??
    {};
  const serverBaseUrl = (cfg.serverBaseUrl ?? "http://127.0.0.1:3000").replace(/\/$/, "");
  const bridgeToken = typeof cfg.bridgeToken === "string" ? cfg.bridgeToken.trim() : "";
  const defaultActorId =
    typeof cfg.defaultActorId === "string" && cfg.defaultActorId.trim()
      ? cfg.defaultActorId.trim()
      : "session-mvp-001";
  const channels = Array.isArray(cfg.channels) && cfg.channels.length > 0
    ? cfg.channels.map((c) => String(c))
    : [DEFAULT_CHANNEL];
  return { serverBaseUrl, bridgeToken, defaultActorId, channels };
}

function sanitizeInboundText(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "";
  const withoutEnvelope = trimmed.replace(
    /Conversation info\s*\(untrusted metadata\):\s*```[\s\S]*?```\s*/i,
    "",
  ).trim();
  if (withoutEnvelope && withoutEnvelope !== trimmed) return withoutEnvelope;
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  if (last && !last.startsWith("{") && !last.includes("chat_id")) return last;
  return trimmed;
}

function extractDispatchText(event) {
  const candidates = [event.body, event.content]
    .filter((v) => typeof v === "string" && v.trim())
    .map((v) => sanitizeInboundText(v))
    .filter(Boolean);
  if (candidates.length === 0) return "";
  return candidates.sort((a, b) => b.length - a.length)[0];
}

function channelMatches(config, event, ctx) {
  const channel = (event.channel ?? ctx.channelId ?? "").trim();
  if (!channel) return true;
  return config.channels.includes(channel);
}

async function callPrivateAgentBridge(config, payload) {
  const headers = { "Content-Type": "application/json" };
  if (config.bridgeToken) {
    headers.Authorization = `Bearer ${config.bridgeToken}`;
  }
  const res = await fetch(`${config.serverBaseUrl}${BRIDGE_PATH}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180_000),
  });
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg =
      (body && (body.message || body.error)) ||
      `HTTP ${res.status}`;
    throw new Error(String(msg));
  }
  if (!body?.ok || typeof body.replyText !== "string") {
    throw new Error("消息桥返回格式无效");
  }
  return body.replyText.trim();
}

async function bridgeWechatTurn(api, config, { text, channel, senderId, accountId, messageId }) {
  try {
    const replyText = await callPrivateAgentBridge(config, {
      text,
      sessionId: config.defaultActorId,
      userId: config.defaultActorId,
      weixinSenderId: senderId || undefined,
      channel,
      accountId,
      messageId,
    });
    return replyText || "（无回复内容）";
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    api.logger?.warn?.(`[private-agent-wechat-bridge] ${detail}`);
    return `⚠️ 主服务处理失败：${detail}\n请确认 server 已启动且 WECHAT_CLAW_BRIDGE_ENABLED=1。`;
  }
}

export default definePluginEntry({
  id: "private-agent-wechat-bridge",
  name: "Private Agent WeChat Bridge",
  description: "Route WeChat inbound to Private AI Agent AgentCore",
  register(api) {
    const hookOpts = { priority: 200, timeoutMs: 300_000 };

    // 微信渠道走 dispatchReplyFromConfig → before_dispatch（不会跑全局 inbound_claim）
    api.on(
      "before_dispatch",
      async (event, ctx) => {
        const config = pluginConfig(api, ctx);
        const channel = (event.channel ?? ctx.channelId ?? "openclaw-weixin").trim();
        if (!channelMatches(config, event, ctx)) {
          return;
        }
        if (event.isGroup) {
          return;
        }

        const text = extractDispatchText(event);
        if (!text) {
          api.logger?.warn?.(
            `[private-agent-wechat-bridge] skip empty inbound channel=${channel}`,
          );
          return;
        }

        api.logger?.info?.(
          `[private-agent-wechat-bridge] bridge start channel=${channel} actor=${config.defaultActorId} textLen=${text.length}`,
        );

        const replyText = await bridgeWechatTurn(api, config, {
          text,
          channel,
          senderId: event.senderId ?? ctx.senderId ?? ctx.conversationId,
          accountId: ctx.accountId,
          messageId: undefined,
        });

        api.logger?.info?.(
          `[private-agent-wechat-bridge] bridge done channel=${channel} replyLen=${replyText.length}`,
        );

        return { handled: true, text: replyText };
      },
      hookOpts,
    );
  },
});
