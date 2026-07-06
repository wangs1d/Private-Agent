import { readFile } from "node:fs/promises";

import { resolveActorId } from "../agent/actor-id.js";
import type { VoiceCapabilityService } from "../services/voice-capability-service.js";
import type { VoiceMessageService } from "../services/voice-message-service.js";
import type { ToolRegistry } from "./tool-registry.js";

/**
 * Agent 底层语音能力工具族（感知 + 表达）：
 *   - voice.speak         → 轻量播报（无 UI，客户端后台一次性播放）
 *   - voice.send_message  → 微信式可重播语音消息（落地为语音气泡，可多次点击重播）
 *   - voice.transcribe    → 主动 ASR：把已落地的语音消息文件转写为文本
 *
 * 设计意图：
 *   - 语音（说 + 听）是 Agent 最底层元能力之一，与视觉（看）并列。
 *   - TTS（说）：voice.speak / voice.send_message，Agent 在任何"需要对用户说话"的
 *     场景下都可直接调用，无需走电话流程。
 *   - ASR（听）：voice.transcribe，让 Agent 能"听"用户发来的语音消息。
 *     目前 chat-user-message 在收到 audio 消息时已被动调 ASR，但 LLM 无法主动
 *     触发；本工具补齐这个能力，让 LLM 可以在多轮对话中重听/复核历史语音。
 *   - 与 phone.call_user 的区别：
 *       · voice.speak         → 即时播报，无来电 UI，无振铃，客户端后台播放
 *       · voice.send_message  → 落地语音消息，客户端渲染为微信式气泡
 *       · phone.call_user     → 来电体验，振铃 + 接通 + 通话 UI
 *
 * 沙箱可用：本工具不涉及高权限操作（仅合成 + WS 推送 + 本地音频读取），无需「完全访问」。
 */
export function registerAgentVoiceTools(
  registry: ToolRegistry,
  voiceCapability: VoiceCapabilityService,
  voiceMessageService?: VoiceMessageService,
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

  /**
   * voice.send_message：发送微信式可重播语音消息。
   *
   * 与 voice.speak 的区别：
   *   - speak 是即时播报（一次性、后台播放、无 UI）
   *   - send_message 是落地为可重播语音消息（带 mediaUrl / durationMs / transcript），
   *     客户端渲染为微信式语音气泡，用户可多次点击重播。
   *
   * 适用场景：
   *   - 用户明确要求「发语音」「发条语音消息」「用语音回复」
   *   - 长文本回复，用语音更自然
   *   - 朋友式聊天场景，语音更有温度
   *
   * 禁用场景：
   *   - 用户在开会 / 不方便听语音时（除非明确要求）
   *   - 短指令回复（"好的" / "知道了"），用文本更高效
   */
  registry.register("voice.send_message", async (input, context) => {
    const actorId = resolveActorId(context);
    const text = String(input.text ?? input.message ?? "").trim();

    if (!text) {
      return { ok: false, error: "缺少 text（语音消息要朗读的内容）" };
    }

    const result = await voiceCapability.sendMessage({
      toUserId: actorId,
      text,
      traceId: context.chatUserMessageId ?? context.sessionId,
    });

    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? "语音消息发送失败",
        retryable: true,
      };
    }

    const seconds = Math.max(1, Math.round(result.durationMs / 1000));
    const providerHint = result.provider ? `（TTS：${result.provider}）` : "";

    return {
      ok: true,
      messageId: result.messageId,
      mediaUrl: result.mediaUrl,
      durationMs: result.durationMs,
      durationSeconds: seconds,
      pushed: result.pushed,
      summary: result.pushed
        ? `已发送语音消息（${seconds}"）${providerHint}。用户客户端会渲染为可重播的语音气泡。`
        : `语音消息已生成但用户当前离线，上线后可收到。${providerHint}`,
    };
  });

  /**
   * voice.transcribe：主动 ASR 识别。
   *
   * 让 LLM 能"听"——把已落地的语音消息文件（用户发来的 voice message）转写为文本。
   * 当前 chat-user-message 在收到 contentType=audio 的消息时已被动调 ASR，
   * 但 LLM 在多轮对话中无法主动重听/复核历史语音；本工具补齐这个能力。
   *
   * 调用场景：
   *   - 用户引用了之前发过的某条语音消息，要求 Agent 重新理解
   *   - Agent 主动检查历史语音消息内容以做上下文关联
   *   - 多模态对话中，需要把某条语音转写后与其他信息一起推理
   *
   * 参数：
   *   - mediaUrl：语音消息的访问 URL，形如 `/agent/voice/messages/{actorId}/{msgId}.mp3`
   *   - language：语言提示（默认 "zh"）
   *
   * 返回：
   *   - ok=true 时附带 text / confidence / language
   *   - ok=false 时附带 error 描述
   *
   * 依赖：voiceMessageService 用于解析本地文件路径；未注入时返回 not_configured。
   */
  registry.register("voice.transcribe", async (input, context) => {
    if (!voiceMessageService) {
      return {
        ok: false,
        error: "VoiceMessageService 未注入，voice.transcribe 不可用",
      };
    }

    const actorId = resolveActorId(context);
    const mediaUrl = String(input.mediaUrl ?? "").trim();
    const language = String(input.language ?? "zh").trim() || "zh";

    if (!mediaUrl) {
      return { ok: false, error: "缺少 mediaUrl（语音消息的访问 URL）" };
    }

    // 从 mediaUrl 提取 actorId 与 fileName
    // 形如 /agent/voice/messages/{actorId}/{msgId}.mp3
    const match = mediaUrl.match(/^\/agent\/voice\/messages\/([^/]+)\/([^/]+)$/);
    if (!match) {
      return {
        ok: false,
        error: `无法解析 mediaUrl: ${mediaUrl}（期望形如 /agent/voice/messages/{actorId}/{msgId}.mp3）`,
      };
    }

    const [, urlActorId, fileName] = match;
    const fullPath = voiceMessageService.resolveFilePath(urlActorId, fileName);
    if (!fullPath) {
      return {
        ok: false,
        error: `语音文件不存在或路径非法: ${mediaUrl}`,
      };
    }

    try {
      const buffer = await readFile(fullPath);
      const result = await voiceCapability.transcribe({
        audio: { data: Buffer.from(buffer), format: "mp3" },
        language,
      });

      if (!result.ok || !result.text) {
        return {
          ok: false,
          error: result.error ?? "识别结果为空",
        };
      }

      return {
        ok: true,
        text: result.text.trim(),
        confidence: result.confidence,
        language: result.language ?? language,
        audioBytes: buffer.length,
        summary: `已识别 ${buffer.length} 字节音频（actor=${actorId}）：${result.text.slice(0, 80)}${result.text.length > 80 ? "…" : ""}`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `ASR 识别失败：${msg}` };
    }
  });
}
