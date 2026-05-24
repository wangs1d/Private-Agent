import { resolveActorId } from "../agent/actor-id.js";
import type { DesktopBridgeCoordinator } from "../services/desktop-bridge-coordinator.js";
import type { DesktopVisualAgentPort } from "../services/desktop-visual-agent-port.js";
import type { ToolRegistry } from "./tool-registry.js";

export type DesktopVisualToolsDeps = {
  localAgent: DesktopVisualAgentPort;
  bridge: DesktopBridgeCoordinator;
};

function desktopBridgeInvokeTimeoutMs(): number {
  const t = Number.parseInt(process.env.DESKTOP_BRIDGE_INVOKE_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(t) && t > 0 ? t : 600_000;
}

export function registerDesktopVisualTools(registry: ToolRegistry, deps: DesktopVisualToolsDeps): void {
  const allow = deps.localAgent.isEnabled() || deps.bridge.isBridgeFeatureEnabled();
  if (!allow) return;

  registry.register("desktop.visual.screenshot", async (input, _ctx) => {
    let region: [number, number, number, number] | undefined;
    const r = input.region;
    if (Array.isArray(r) && r.length === 4 && r.every((x) => typeof x === "number" && Number.isFinite(x))) {
      region = [Math.floor(r[0]), Math.floor(r[1]), Math.floor(r[2]), Math.floor(r[3])];
    }

    if (deps.localAgent.isEnabled() && deps.localAgent.screenshot) {
      const result = await deps.localAgent.screenshot({ region });
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

    return {
      ok: false,
      error: "桌面视觉 Agent 未启用或不支持截图（需要 DESKTOP_VISUAL_AGENT_ENABLED=1）",
    };
  });

  registry.register("desktop.visual.run_task", async (input, ctx) => {
    const task = typeof input.task === "string" ? input.task.trim() : "";
    if (!task) {
      return { ok: false, error: "缺少 task" };
    }
    const maxStepsRaw = input.maxSteps;
    const maxSteps =
      typeof maxStepsRaw === "number" && Number.isFinite(maxStepsRaw) ?
        Math.min(120, Math.max(1, Math.floor(maxStepsRaw)))
      : undefined;
    let region: [number, number, number, number] | undefined;
    const r = input.region;
    if (Array.isArray(r) && r.length === 4 && r.every((x) => typeof x === "number" && Number.isFinite(x))) {
      region = [Math.floor(r[0]), Math.floor(r[1]), Math.floor(r[2]), Math.floor(r[3])];
    }
    const stub = input.stub === true;
    const actorId = resolveActorId(ctx);

    if (deps.bridge.hasExecutor(actorId)) {
      const remote = await deps.bridge.invoke(
        actorId,
        { task, maxSteps: maxSteps ?? 40, region: region ?? null, stub },
        desktopBridgeInvokeTimeoutMs(),
      );
      if (remote) {
        deps.bridge.recordTaskResult(actorId, remote);
        return { ...remote };
      }
      return { ok: false, error: "电脑端执行器在调度瞬间不可用，请重试" };
    }

    if (deps.localAgent.isEnabled()) {
      const out = await deps.localAgent.runTask({ task, maxSteps, region, stub });
      if (deps.bridge.isBridgeFeatureEnabled()) {
        deps.bridge.recordTaskResult(actorId, out);
      }
      return out;
    }

    return {
      ok: false,
      error:
        "电脑端未在线（请用与手机相同的 userId 运行桥接客户端，session.init 带 desktopBridge:true），且服务端未启用 DESKTOP_VISUAL_AGENT_ENABLED 本机执行。",
    };
  });
}
