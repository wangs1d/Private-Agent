import { resolveActorId } from "../agent/actor-id.js";
import type { VirtualPhoneRingStyle } from "../services/virtual-phone-service.js";
import type { VirtualPhoneService } from "../services/virtual-phone-service.js";
import type { ToolRegistry } from "./tool-registry.js";

/**
 * `phone.call_user` 同轮内去重：同一 chatUserMessageId + 同一被叫只打一次。
 * 跨轮（用户主动说「再打一次」/「打一次确认」）必须真的能响铃。
 * chatUserMessageId 缺失时回退到 sessionId + 30s 短窗口防重试，避免完全无界。
 */
const CALL_USER_DEDUP_TTL_MS = 30_000; // 30s 内同 round 重复去重；跨 round 重新放行
const callUserDedupCache = new Map<string, { result: Record<string, unknown>; ts: number }>();

function cleanCallUserDedupCache(): void {
  const now = Date.now();
  for (const [key, entry] of callUserDedupCache) {
    if (now - entry.ts > CALL_USER_DEDUP_TTL_MS) {
      callUserDedupCache.delete(key);
    }
  }
}

export function registerAgentPhoneTools(registry: ToolRegistry, phone: VirtualPhoneService): void {
  registry.register("phone.ensure_my_number", async (_input, context) => {
    const actorId = resolveActorId(context);
    const number = phone.ensureNumber(actorId);
    return {
      ok: true,
      actorId,
      virtualPhone: number,
      summary: `您的虚拟号码为 ${number}（登记在本 Agent 名下，与您共用）。其他 Agent 可拨打此号联系您（配对规则同中继）。`,
    };
  });

  registry.register("phone.virtual_call", async (input, context) => {
    const actorId = resolveActorId(context);
    const toPhone = String(input.toPhone ?? "").trim();
    const spokenMessage = String(input.spokenMessage ?? input.message ?? "").trim();
    const ringStyleRaw = String(input.ringStyle ?? "peer").trim().toLowerCase();
    const ringStyle: VirtualPhoneRingStyle =
      ringStyleRaw === "reminder" ? "reminder" : "peer";

    if (!toPhone) throw new Error("缺少 toPhone（6 位号码）");
    if (!spokenMessage) throw new Error("缺少 spokenMessage（对方将听到的内容）");

    const result = await phone.placeCall({
      fromActorId: actorId,
      toPhone,
      transcript: spokenMessage,
      ringStyle,
      initiatedBy: "user",
    });

    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? "呼叫失败",
      };
    }

    return {
      ok: true,
      callId: result.callId,
      pushed: result.pushed,
      targetActorId: result.targetActorId,
      fromPhone: result.fromPhone,
      dialed: toPhone.replace(/\D/g, ""),
      summary: result.pushed
        ? "已向对方在线线路推送虚拟来电（含语音稿，若已配置 OpenAI 则附带 TTS 音频）"
        : "已生成通话，但对方当前离线或未连接 WebSocket，无法实时振铃",
    };
  });

  registry.register("phone.call_user", async (input, context) => {
    const actorId = resolveActorId(context);
    const toUserId = String(input.toUserId ?? input.userId ?? context.userId ?? context.sessionId ?? "").trim();
    const spokenMessage = String(input.spokenMessage ?? input.message ?? input.transcript ?? "").trim();
    const ringStyleRaw = String(input.ringStyle ?? "peer").trim().toLowerCase();
    const ringStyle: VirtualPhoneRingStyle =
      ringStyleRaw === "reminder" ? "reminder" : "peer";

    if (!toUserId) throw new Error("缺少 toUserId / userId（被叫用户标识）");
    if (!spokenMessage) throw new Error("缺少 spokenMessage（用户将听到的语音内容）");

    // 去重：同一轮（chatUserMessageId）+ 同一被叫只打一次
    // 跨轮（用户下一句「再打一次」）必须真的能响铃
    cleanCallUserDedupCache();
    const roundId = context.chatUserMessageId || context.sessionId;
    const dedupKey = `${roundId}:${toUserId}`;
    const cached = callUserDedupCache.get(dedupKey);
    if (cached) {
      return {
        ...cached.result,
        deduped: true,
        summary: `(同轮重复调用已拦截) ${cached.result.summary ?? ""}`,
      };
    }

    const result = await phone.callUser({
      fromActorId: actorId,
      toUserId,
      transcript: spokenMessage,
      ringStyle,
    });

    const response: Record<string, unknown> = {};
    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? "呼叫用户失败",
        retryable: true,
        hint: "电话功能暂时不可用，可能是网络或配置问题，稍后可重试。不要回复用户「做不到」「无法拨号」等否定性表述。",
      };
    }

    response.ok = true;
    response.callId = result.callId;
    response.pushed = result.pushed;
    response.toUserId = result.toUserId;
    response.fromPhone = result.fromPhone;
    response.summary = result.pushed
        ? `已向用户推送虚拟来电（含TTS语音），用户可在客户端接听并回复。${!result.fromPhone ? "提示：尚未申领共用虚拟号码，来电显示为未知号码。" : ""}`
        : "通话请求已发出但用户当前离线（未连接 WebSocket），上线后可收到。这不是功能缺失，是网络状态问题。";

    // 写入缓存
    callUserDedupCache.set(dedupKey, { result: response, ts: Date.now() });

    return response;
  });
}
