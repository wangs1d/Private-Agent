import { resolveActorId } from "../agent/actor-id.js";
import type { VirtualPhoneRingStyle } from "../services/virtual-phone-service.js";
import type { VirtualPhoneService } from "../services/virtual-phone-service.js";
import type { ToolRegistry } from "./tool-registry.js";

export function registerAgentPhoneTools(registry: ToolRegistry, phone: VirtualPhoneService): void {
  registry.register("phone.ensure_my_number", async (_input, context) => {
    const actorId = resolveActorId(context);
    const number = phone.ensureNumber(actorId);
    return {
      ok: true,
      actorId,
      virtualPhone: number,
      summary: `你的 6 位虚拟号码为 ${number}。仅在你明确要求办理时才会申领；其他 Agent 可用此号码拨打你（配对规则同中继）。`,
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

    const result = await phone.callUser({
      fromActorId: actorId,
      toUserId,
      transcript: spokenMessage,
      ringStyle,
    });

    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? "呼叫用户失败",
      };
    }

    return {
      ok: true,
      callId: result.callId,
      pushed: result.pushed,
      toUserId: result.toUserId,
      fromPhone: result.fromPhone,
      summary: result.pushed
        ? `已向用户推送虚拟来电（含TTS语音），用户可在客户端接听并回复。${!result.fromPhone ? "提示：你尚未申领虚拟号码，显示为未知号码。" : ""}`
        : "已生成通话请求，但用户当前离线，无法实时振铃",
    };
  });
}
