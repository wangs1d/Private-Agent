import { resolveActorId } from "../agent/actor-id.js";
import type { VoiceCapabilityService } from "../services/voice-capability-service.js";
import type { ToolRegistry } from "./tool-registry.js";

/**
 * Agent 底层语音能力工具：`voice.speak`。
 *
 * 设计意图：
 *   - TTS 是 Agent 的底层能力，不应被 phone.call_user（电话触达）独占。
 *   - Agent 在任何"需要对用户说话"的场景下都可直接调用本工具，无需走电话流程。
 *   - 与 phone.call_user 的区别：
 *       · voice.speak    → 轻量播报，无来电 UI，无振铃，客户端后台播放
 *       · phone.call_user → 来电体验，振铃 + 接通 + 通话 UI
 *   - 后续接入 ASR 后，本工具族将扩展 voice.transcribe / voice.dialogue 等。
 *
 * 沙箱可用：本工具不涉及高权限操作（仅合成 + WS 推送），无需「完全访问」。
 */
export function registerAgentVoiceTools(
  registry: ToolRegistry,
  voiceCapability: VoiceCapabilityService,
): void {
  registry.register("voice.speak", async (input, context) => {
    const actorId = resolveActorId(context);
    const text = String(input.text ?? input.message ?? "").trim();
    const modeRaw = String(input.mode ?? "instant").trim().toLowerCase();
    const mode = modeRaw === "reminder" ? "reminder" : "instant";

    if (!text) {
      return { ok: false, error: "缺少 text（要朗读的内容）" };
    }

    const title = String(input.title ?? "").trim() || undefined;
    const priorityRaw = String(input.priority ?? "medium").trim().toLowerCase();
    const priority: "low" | "medium" | "high" | "urgent" =
      priorityRaw === "low" || priorityRaw === "high" || priorityRaw === "urgent"
        ? priorityRaw
        : "medium";

    const result = await voiceCapability.speak({
      toUserId: actorId,
      text,
      mode,
      title,
      priority,
      traceId: context.chatUserMessageId ?? context.sessionId,
    });

    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? "语音播报失败",
        retryable: true,
      };
    }

    const providerHint = result.provider
      ? `（TTS 提供商：${result.provider}）`
      : result.skippedReason
        ? `（TTS 未启用：${result.skippedReason}，客户端将用本地语音兜底）`
        : "";

    return {
      ok: true,
      voiceId: result.voiceId,
      pushed: result.pushed,
      mode,
      summary: result.pushed
        ? `已向用户推送语音播报${providerHint}。用户客户端会自动播放。`
        : `语音播报已生成但用户当前离线（未连接 WebSocket），上线后可收到。${providerHint}`,
    };
  });
}
