import { resolveActorId } from "../../../agent/actor-id.js";
import type { ToolHandler, ToolRegistry } from "../../tool-registry.js";
import type { PhoneCallCoordinator } from "../../../services/phone-call-coordinator.js";

/**
 * phone_call.* 工具 handler 集合 + 注册入口。
 *
 * 执行链：handler 只做 ctx 解析（actorId / 桥接在线性 / 轮次 id），
 * 全部业务规则（确认门 / 黑名单 / 频控 / 静默时段 / 状态机 / 持久化 / 审计）
 * 收敛在 PhoneCallCoordinator —— 保证工具层与 WS 确认 hook（connection.ts
 * observeCardAction）走同一权威状态。
 */
export interface PhoneCallModuleDeps {
  phoneCallCoordinator: PhoneCallCoordinator;
}

function createCoordinatorHandler(
  coordinator: PhoneCallCoordinator,
  run: (actorId: string, input: Record<string, unknown>, ctx: {
    phoneBridgeOnline?: boolean;
    chatUserMessageId?: string;
    sessionId?: string;
  }) => Promise<Record<string, unknown>>,
): ToolHandler {
  return async (input, context) => {
    if (!coordinator.isEnabled()) {
      return { ok: false, error: "电话代办能力未启用（PHONE_CALL_ENABLED=false）" };
    }
    const actorId = resolveActorId(context);
    return run(actorId, input, {
      phoneBridgeOnline: context.phoneBridgeOnline,
      chatUserMessageId: context.chatUserMessageId,
      sessionId: context.sessionId,
    });
  };
}

/**
 * 注册 phone-call 全部工具到 ToolRegistry。
 *
 * 调用方：`capability-modules/index.ts` 的 `buildCapabilityModules` 闭包。
 */
export function registerPhoneCallTools(
  registry: ToolRegistry,
  deps: PhoneCallModuleDeps,
): void {
  const { phoneCallCoordinator: coordinator } = deps;

  registry.register(
    "phone_call.prepare",
    createCoordinatorHandler(coordinator, (actorId, input, ctx) =>
      coordinator.prepare(actorId, {
        number: String(input.number ?? "").trim(),
        contactName: typeof input.contactName === "string" ? input.contactName : undefined,
        goal: String(input.goal ?? "").trim(),
        facts:
          input.facts && typeof input.facts === "object" && !Array.isArray(input.facts)
            ? (input.facts as Record<string, unknown>)
            : {},
        mustAsk: Array.isArray(input.mustAsk) ? input.mustAsk.map(String) : [],
        fallback: typeof input.fallback === "string" ? input.fallback : undefined,
        script: typeof input.script === "string" ? input.script : undefined,
        maxDurationSec: typeof input.maxDurationSec === "number" ? input.maxDurationSec : undefined,
        sessionId: ctx.sessionId,
      })),
  );

  registry.register(
    "phone_call.start",
    createCoordinatorHandler(coordinator, (actorId, input, ctx) =>
      coordinator.start(actorId, String(input.callId ?? "").trim(), {
        phoneBridgeOnline: ctx.phoneBridgeOnline,
        chatUserMessageId: ctx.chatUserMessageId,
        sessionId: ctx.sessionId,
      })),
  );

  registry.register(
    "phone_call.status",
    createCoordinatorHandler(coordinator, (actorId, input) =>
      coordinator.status(actorId, String(input.callId ?? "").trim())),
  );

  registry.register(
    "phone_call.finish",
    createCoordinatorHandler(coordinator, (actorId, input) =>
      coordinator.finish(actorId, {
        callId: String(input.callId ?? "").trim(),
        outcome: input.outcome as never,
        detail: typeof input.detail === "string" ? input.detail : undefined,
        appointmentTime: typeof input.appointmentTime === "string" ? input.appointmentTime : undefined,
        bookingRef: typeof input.bookingRef === "string" ? input.bookingRef : undefined,
        followUps: Array.isArray(input.followUps) ? input.followUps.map(String) : [],
      })),
  );

  registry.register(
    "phone_call.list",
    createCoordinatorHandler(coordinator, (actorId, input) =>
      coordinator.list(actorId, typeof input.limit === "number" ? input.limit : 10)),
  );

  registry.register(
    "phone_call.cancel",
    createCoordinatorHandler(coordinator, (actorId, input) =>
      coordinator.cancel(
        actorId,
        String(input.callId ?? "").trim(),
        String(input.reason ?? "user_cancelled").trim() || "user_cancelled",
      )),
  );
}
