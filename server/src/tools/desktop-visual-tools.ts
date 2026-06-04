import { resolveActorId } from "../agent/actor-id.js";
import type { DesktopBridgeCoordinator } from "../services/desktop-bridge-coordinator.js";
import type { DesktopVisualPort } from "../services/desktop-visual-port.js";
import { resolveDesktopVisualVlmConfig } from "../services/desktop-visual-vlm-config.js";
import type { ToolRegistry } from "./tool-registry.js";

export type DesktopVisualToolsDeps = {
  localVisual: DesktopVisualPort;
  bridge: DesktopBridgeCoordinator;
};

function desktopBridgeInvokeTimeoutMs(): number {
  const t = Number.parseInt(process.env.DESKTOP_BRIDGE_INVOKE_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(t) && t > 0 ? t : 600_000;
}

function parseRegion(input: Record<string, unknown>): [number, number, number, number] | undefined {
  const r = input.region;
  if (Array.isArray(r) && r.length === 4 && r.every((x) => typeof x === "number" && Number.isFinite(x))) {
    return [Math.floor(r[0]), Math.floor(r[1]), Math.floor(r[2]), Math.floor(r[3])];
  }
  return undefined;
}

function bridgeInvokePayload(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const vlm = resolveDesktopVisualVlmConfig();
  return vlm ? { ...body, vlm } : body;
}

function desktopUnavailableMessage(bridgeEnabled: boolean): string {
  if (bridgeEnabled) {
    return "电脑端未在线：请在本机运行桌面桥接（与手机相同 userId，session.init 带 desktopBridge:true），或设置 DESKTOP_VISUAL_ENABLED=1 由服务端本机截图。";
  }
  return "桌面能力未配置：请设置 DESKTOP_BRIDGE_ENABLED=1（或 DESKTOP_BRIDGE_TOKEN）并运行桥接客户端，或设置 DESKTOP_VISUAL_ENABLED=1 由服务端本机执行。";
}

/** 始终注册；执行时按桥接在线 / 本机 Python 择优，避免「完全访问」已开但工具未注册。 */
export function registerDesktopVisualTools(registry: ToolRegistry, deps: DesktopVisualToolsDeps): void {
  const bridgeEnabled = deps.bridge.isBridgeFeatureEnabled();

  registry.register("desktop.visual.screenshot", async (input, ctx) => {
    const region = parseRegion(input);
    const actorId = resolveActorId(ctx);

    if (deps.bridge.hasExecutor(actorId)) {
      const remote = await deps.bridge.invoke(
        actorId,
        bridgeInvokePayload({ action: "screenshot", region: region ?? null }),
        Math.min(desktopBridgeInvokeTimeoutMs(), 120_000),
      );
      if (remote?.ok && remote.imageBase64) {
        return {
          ok: true,
          imageBase64: remote.imageBase64,
          mimeType: remote.mimeType ?? "image/png",
          width: remote.width,
          height: remote.height,
          capturedAt: remote.capturedAt,
          message: `已通过电脑桥接截取屏幕${region ? `区域 [${region.join(", ")}]` : ""}，尺寸 ${remote.width ?? "?"}x${remote.height ?? "?"}`,
        };
      }
      if (remote && !remote.ok) {
        return { ok: false, error: remote.error ?? "电脑端截图失败" };
      }
    }

    if (deps.localVisual.isEnabled() && deps.localVisual.screenshot) {
      const result = await deps.localVisual.screenshot({ region });
      if (!result.ok) {
        return { ok: false, error: result.error ?? "截图失败" };
      }
      return {
        ok: true,
        imageBase64: result.imageBase64,
        mimeType: result.mimeType ?? "image/png",
        width: result.width,
        height: result.height,
        capturedAt: result.capturedAt,
        message: `已截取屏幕${region ? `区域 [${region.join(", ")}]` : ""}，尺寸 ${result.width}x${result.height}`,
      };
    }

    return { ok: false, error: desktopUnavailableMessage(bridgeEnabled) };
  });

  registry.register("desktop.visual.run_task", async (input, ctx) => {
    const task = typeof input.task === "string" ? input.task.trim() : "";
    if (!task) {
      return { ok: false, error: "缺少 task" };
    }
    const maxStepsRaw = input.maxSteps;
    const maxSteps =
      typeof maxStepsRaw === "number" && Number.isFinite(maxStepsRaw)
        ? Math.min(120, Math.max(1, Math.floor(maxStepsRaw)))
        : undefined;
    const region = parseRegion(input);
    const stub = input.stub === true;
    const actorId = resolveActorId(ctx);

    if (deps.bridge.hasExecutor(actorId)) {
      const remote = await deps.bridge.invoke(
        actorId,
        bridgeInvokePayload({
          action: "run_task",
          task,
          maxSteps: maxSteps ?? 40,
          region: region ?? null,
          stub,
        }),
        desktopBridgeInvokeTimeoutMs(),
      );
      if (remote) {
        deps.bridge.recordTaskResult(actorId, remote);
        return { ...remote };
      }
      return { ok: false, error: "电脑端执行器在调度瞬间不可用，请重试" };
    }

    if (deps.localVisual.isEnabled()) {
      const out = await deps.localVisual.runTask({ task, maxSteps, region, stub });
      if (deps.bridge.isBridgeFeatureEnabled()) {
        deps.bridge.recordTaskResult(actorId, out);
      }
      return out;
    }

    return { ok: false, error: desktopUnavailableMessage(bridgeEnabled) };
  });
}
