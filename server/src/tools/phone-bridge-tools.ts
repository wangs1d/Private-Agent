import type { PhoneBridgeCoordinator } from "../services/phone-bridge-coordinator.js";
import { resolveActorId } from "../agent/actor-id.js";
import type { ToolContext, ToolRegistry } from "./tool-registry.js";

export type PhoneBridgeToolsDeps = {
  bridge: PhoneBridgeCoordinator;
};

function mustBeOnline(ctx: ToolContext): string {
  if (!ctx.phoneBridgeOnline) {
    return "phone bridge is not online";
  }
  const actorId = resolveActorId(ctx);
  if (!actorId) {
    return "actorId is missing";
  }
  return "";
}

export function registerPhoneBridgeTools(registry: ToolRegistry, deps: PhoneBridgeToolsDeps) {
  registry.register("phone.battery", async (_params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    const err = mustBeOnline(ctx);
    if (err) return { ok: false, error: err };
    return deps.bridge.invoke(actorId, "battery", {});
  });

  registry.register("phone.notifications", async (params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    const err = mustBeOnline(ctx);
    if (err) return { ok: false, error: err };
    return deps.bridge.invoke(actorId, "notifications", { limit: params.limit ?? 20 });
  });

  registry.register("phone.camera_capture", async (params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    const err = mustBeOnline(ctx);
    if (err) return { ok: false, error: err };
    return deps.bridge.invoke(actorId, "camera_capture", { camera: params.camera ?? "back" });
  });

  registry.register("phone.screen_record", async (params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    const err = mustBeOnline(ctx);
    if (err) return { ok: false, error: err };
    return deps.bridge.invoke(actorId, "screen_record", { durationSec: params.durationSec ?? 15 });
  });

  registry.register("phone.locate", async (_params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    const err = mustBeOnline(ctx);
    if (err) return { ok: false, error: err };
    return deps.bridge.invoke(actorId, "locate", {});
  });

  registry.register("phone.ring", async (params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    const err = mustBeOnline(ctx);
    if (err) return { ok: false, error: err };
    return deps.bridge.invoke(actorId, "ring", {
      reason: params.reason ?? "",
      durationSec: params.durationSec ?? 15,
      volume: params.volume ?? 100,
      vibrate: params.vibrate ?? true,
    });
  });

  registry.register("phone.sms_list", async (params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    const err = mustBeOnline(ctx);
    if (err) return { ok: false, error: err };
    return deps.bridge.invoke(actorId, "sms_list", { limit: params.limit ?? 20 });
  });

  registry.register("phone.call_log", async (params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    const err = mustBeOnline(ctx);
    if (err) return { ok: false, error: err };
    return deps.bridge.invoke(actorId, "call_log", { limit: params.limit ?? 20 });
  });
}
