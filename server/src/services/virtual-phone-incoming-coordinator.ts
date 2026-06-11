import { randomUUID } from "crypto";
import { ServerEventType } from "../protocol.js";
import type { AgentCore } from "./agent-core.js";
import type { WsConnectionRegistry } from "./ws-connection-registry.js";
import { dedupeAdjacentLines } from "../utils/text.js";
import { getToolResultProcessor } from "./tool-result-processor.js";
import { AssistantRewriterService } from "./assistant-rewriter.js";
import { createExternalChatProviderFromEnv } from "../external-model/resolve-provider.js";

export type PeerIncomingCallPayload = {
  callId: string;
  fromActorId: string;
  fromPhone: string;
  toPhone: string;
  transcript: string;
  ringStyle: string;
  initiatedBy?: string;
};

export type IncomingPhoneUserAction = "accept" | "decline" | "agent_takeover";

type PendingPeerCall = PeerIncomingCallPayload & {
  targetActorId: string;
  registeredAt: number;
  timeout: ReturnType<typeof setTimeout>;
};

const DEFAULT_RING_TIMEOUT_MS = Number(
  process.env.VIRTUAL_PHONE_PEER_RING_TIMEOUT_MS ?? 50_000,
);

function ringTimeoutMs(): number {
  const n = DEFAULT_RING_TIMEOUT_MS;
  return Number.isFinite(n) && n >= 5_000 ? n : 50_000;
}

function actionReasonLabel(action: IncomingPhoneUserAction | "timeout"): string {
  switch (action) {
    case "accept":
      return "已自行接听";
    case "decline":
      return "选择拒接";
    case "agent_takeover":
      return "委托 Agent 代接";
    case "timeout":
      return "未及时接听";
    default:
      return "未接听";
  }
}

export class VirtualPhoneIncomingCoordinator {
  private readonly pending = new Map<string, PendingPeerCall>();

  constructor(
    private readonly agentCore: AgentCore,
    private readonly wsRegistry: WsConnectionRegistry,
  ) {}

  /**
   * 其他 Agent 拨打本 Agent 虚拟号后登记；超时未响应则自动代接。
   */
  registerPeerIncoming(targetActorId: string, payload: PeerIncomingCallPayload): void {
    const callId = payload.callId.trim();
    const target = targetActorId.trim();
    if (!callId || !target) return;

    const existing = this.pending.get(callId);
    if (existing) {
      clearTimeout(existing.timeout);
      this.pending.delete(callId);
    }

    const timeout = setTimeout(() => {
      void this.handleUserResponse(target, callId, "agent_takeover", "timeout");
    }, ringTimeoutMs());

    if (typeof timeout.unref === "function") timeout.unref();

    this.pending.set(callId, {
      ...payload,
      targetActorId: target,
      registeredAt: Date.now(),
      timeout,
    });

    this.wsRegistry.trySend(
      target,
      JSON.stringify({
        type: ServerEventType.VirtualPhoneCallStatus,
        payload: {
          callId,
          status: "ringing",
          direction: "agent_to_agent",
          fromPhone: payload.fromPhone,
          fromActorId: payload.fromActorId,
          message: "其他 Agent 来电，请选择接听或委托你的 Agent 代接",
          ringTimeoutSec: Math.round(ringTimeoutMs() / 1000),
        },
      }),
    );
  }

  async handleUserResponse(
    actorId: string,
    callId: string,
    action: IncomingPhoneUserAction,
    source: IncomingPhoneUserAction | "timeout" = action,
  ): Promise<{ ok: boolean; error?: string }> {
    const id = callId.trim();
    const pending = this.pending.get(id);
    if (!pending || pending.targetActorId !== actorId.trim()) {
      return { ok: false, error: "来电不存在或已处理" };
    }

    clearTimeout(pending.timeout);
    this.pending.delete(id);

    if (action === "accept") {
      this.wsRegistry.trySend(
        actorId,
        JSON.stringify({
          type: ServerEventType.VirtualPhoneCallStatus,
          payload: {
            callId: id,
            status: "answered_by_user",
            direction: "agent_to_agent",
            fromPhone: pending.fromPhone,
            message: "你已接听，可在来电弹窗中查看语音内容",
          },
        }),
      );
      return { ok: true };
    }

    await this.runAgentDelegate(pending, source);
    return { ok: true };
  }

  private async runAgentDelegate(
    call: PendingPeerCall,
    source: IncomingPhoneUserAction | "timeout",
  ): Promise<void> {
    const actorId = call.targetActorId;
    const assistantMessageId = `phone-delegate:${call.callId}:${randomUUID()}`;
    const reason = actionReasonLabel(source);

    const prompt = [
      "【系统通知 · 其他 Agent 虚拟来电】",
      `用户${reason}，请你代接并向用户转告来电内容。`,
      "",
      `主叫 Agent ID：${call.fromActorId}`,
      `主叫虚拟号：${call.fromPhone}`,
      `来电 ID：${call.callId}`,
      "",
      "来电方语音稿全文：",
      call.transcript.trim() || "（无文字稿）",
      "",
      "请你务必：",
      "1. 用简短中文向用户说明「谁打来、什么事、是否紧急」；不要假设用户已听过电话。",
      "2. 若确需回复主叫，可用 agent.send_to_peer；仅在用户明确要求且已申领号码时才用 phone.virtual_call。",
      "3. 不要调用 phone.ensure_my_number，除非用户在本条对话里明确要求申领号码。",
    ].join("\n");

    const send = (body: Record<string, unknown>) =>
      this.wsRegistry.trySend(actorId, JSON.stringify(body));

    send({
      type: ServerEventType.VirtualPhoneCallStatus,
      payload: {
        callId: call.callId,
        status: "agent_handling",
        direction: "agent_to_agent",
        fromPhone: call.fromPhone,
        message: "你的 Agent 正在代接并整理来电内容…",
      },
    });

    send({
      type: ServerEventType.ChatAgentStatus,
      payload: {
        messageId: assistantMessageId,
        status: `正在代接其他 Agent 来电（${call.fromPhone}）…`,
        source: "phone.delegate",
      },
    });

    const sendChunk = (delta: string) => {
      if (!delta) return;
      send({
        type: ServerEventType.ChatAssistantChunk,
        payload: {
          messageId: assistantMessageId,
          delta,
          source: "phone.delegate",
        },
      });
    };

    try {
      const reply = await this.agentCore.handleUserMessage(actorId, prompt, {
        chatUserMessageId: `phone-incoming:${call.callId}`,
        preferFullPipeline: true,
        onAssistantDelta: sendChunk,
      });

      await this.agentCore.runToolIfNeeded(actorId, reply, {
        chatUserMessageId: `phone-incoming-tool:${call.callId}`,
      });

      let finalText =
        reply.text.trim() || "已代接来电，但未能生成完整说明，请查看主叫语音稿。";
      finalText = getToolResultProcessor().processAssistantText(finalText.trim(), {
        plainTextMode: true,
        userText: call.transcript,
      });
      finalText = await new AssistantRewriterService(
        createExternalChatProviderFromEnv(),
      ).rewriteIfNeeded(call.transcript, finalText);

      send({
        type: ServerEventType.ChatAssistantDone,
        payload: {
          sessionId: actorId,
          messageId: assistantMessageId,
          finalText,
          toolCalls: reply.toolName ? [reply.toolName] : [],
          source: "phone.delegate",
        },
      });

      send({
        type: ServerEventType.VirtualPhoneCallStatus,
        payload: {
          callId: call.callId,
          status: "agent_handled",
          direction: "agent_to_agent",
          fromPhone: call.fromPhone,
          fromActorId: call.fromActorId,
          transcript: call.transcript,
          summary: finalText,
          delegateReason: source,
          message: "Agent 已代接，来电说明已写入对话",
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[virtual-phone-incoming] delegate failed:", err);
      send({
        type: ServerEventType.VirtualPhoneCallStatus,
        payload: {
          callId: call.callId,
          status: "agent_handled",
          direction: "agent_to_agent",
          fromPhone: call.fromPhone,
          error: msg,
          message: `代接失败：${msg}`,
        },
      });
    }
  }
}
