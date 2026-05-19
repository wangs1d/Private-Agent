import { ServerEventType as S } from "../protocol.js";
import type { AgentPairingService } from "../services/agent-pairing-service.js";
import { relayRequiresPairEnv } from "../services/agent-pairing-service.js";
import type { AgentRelayService } from "../services/agent-relay-service.js";
import type { WsConnectionRegistry } from "../services/ws-connection-registry.js";
import type { ToolRegistry } from "./tool-registry.js";

export function registerAgentRelayTools(
  registry: ToolRegistry,
  relay: AgentRelayService,
  wsRegistry: WsConnectionRegistry,
  pairing: AgentPairingService,
): void {
  registry.register("agent.send_to_peer", async (input, context) => {
    const targetSessionId = String(input.targetSessionId ?? "").trim();
    const body = String(input.body ?? "").trim();
    const subject =
      input.subject !== undefined && input.subject !== null
        ? String(input.subject).trim()
        : undefined;
    if (!targetSessionId) {
      throw new Error("缺少 targetSessionId");
    }
    if (!body) {
      throw new Error("缺少 body");
    }
    if (targetSessionId === context.sessionId) {
      throw new Error("不能向自己的 session 发中继消息");
    }

    if (relayRequiresPairEnv() && !pairing.arePaired(context.sessionId, targetSessionId)) {
      throw new Error(
        "中继已要求配对：请双方先使用相同配对码调用 POST /agent/pair，或设置环境变量 AGENT_RELAY_REQUIRE_PAIR=0（仅开发环境）。",
      );
    }

    const record = relay.postMessage({
      fromSessionId: context.sessionId,
      toSessionId: targetSessionId,
      text: body,
      subject: subject || undefined,
      traceId:
        typeof input.traceId === "string" ? input.traceId : undefined,
      chatUserMessageId: context.chatUserMessageId,
    });

    const envelope = {
      type: S.AgentPeerMessage,
      payload: {
        messageId: record.messageId,
        fromSessionId: record.fromSessionId,
        toSessionId: record.toSessionId,
        text: record.text,
        subject: record.subject,
        receivedAt: record.createdAt,
        ...(record.chatUserMessageId ? { chatUserMessageId: record.chatUserMessageId } : {}),
        ...(record.aip ? { aip: record.aip } : {}),
      },
    };
    const pushed = wsRegistry.trySend(
      targetSessionId,
      JSON.stringify(envelope),
    );

    return {
      ok: true,
      messageId: record.messageId,
      toSessionId: targetSessionId,
      pushedToPeer: pushed,
      summary: pushed ? "已投递并推送给对方在线连接" : "已写入对方收件箱（对方离线或未连接）",
    };
  });
}
