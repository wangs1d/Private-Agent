/**
 * Hook 总线 — 对外入口
 *
 * 提供：
 * 1. 类导出：HookBus（用于 DI 注入）
 * 2. 单例：getHookBus()（用于无 DI 上下文的场景）
 * 3. 便捷函数：emitHook()（一次性发射）
 * 4. 声明式：defineFeatureHooks()（新功能批量声明）
 *
 * ─── 新功能接入范式（推荐） ───────────────────────────────
 *
 * 1) 即发即用（最小）：
 *    import { emitHook } from "@/services/hooks";
 *    emitHook("agent.task_completed", { taskId: "t-001" });
 *
 * 2) 集中声明（推荐用于新功能模块）：
 *    // src/features/<feature>/hooks.ts
 *    import { defineFeatureHooks } from "@/services/hooks";
 *    export const featureHooks = defineFeatureHooks("my-feature", [
 *      { type: "agent.task_completed", description: "任务完成时触发" },
 *      { type: "custom", description: "自定义事件", dataShape: { msg: "string" } },
 *    ]);
 *
 *    // 业务代码中：
 *    featureHooks.emit("agent.task_completed", { taskId });
 *
 * 3) DI 注入（推荐用于长生命周期 service）：
 *    constructor(private readonly hookBus: HookBus) {}
 *    this.hookBus.emit("agent.online", { ... });
 */
import { HookBus } from "./hook-bus.js";
import type {
  FeatureHookManifest,
  FeatureHookSpec,
  HookEmitOptions,
  HookEvent,
  HookEventType,
  HookHandler,
} from "./hook-types.js";

export { HookBus };
export type {
  FeatureHookManifest,
  FeatureHookSpec,
  HookEmitOptions,
  HookEvent,
  HookEventType,
  HookHandler,
};

// ─── 进程级单例（可选） ───────────────────────────────

let _instance: HookBus | null = null;

/** 获取或懒创建单例 HookBus（无 DI 上下文时使用） */
export function getHookBus(): HookBus {
  if (!_instance) {
    _instance = new HookBus();
  }
  return _instance;
}

/** 在 bootstrap 阶段用真实实例替换单例（典型用法） */
export function setHookBus(bus: HookBus): void {
  _instance = bus;
}

// ─── 便捷发射 ───

/** 直接 emit（走单例）。生产环境推荐走 DI 的 hookBus.emit；此函数主要用于脚本/工具。 */
export function emitHook(
  type: HookEventType,
  data: Record<string, unknown>,
  opts?: HookEmitOptions,
): HookEvent {
  return getHookBus().emit(type, data, opts);
}

// ─── Feature 声明式注册 ───

/**
 * 声明一个 feature 的全部 hook 触发点。
 * 返回的对象自带 emit() 方法，自动带上 feature 名称作为 source，
 * 便于在 hook 历史/webhook payload 中追溯来源。
 *
 * @example
 *   const userFeature = defineFeatureHooks("user-management", [
 *     { type: "agent.message_received", description: "收到用户消息" },
 *     { type: "custom", description: "用户注册" },
 *   ]);
 *   userFeature.emit("custom", { userId: "u-001" });
 */
export function defineFeatureHooks(
  feature: string,
  specs: FeatureHookSpec[],
): {
  feature: string;
  specs: FeatureHookSpec[];
  emit: (
    type: HookEventType,
    data: Record<string, unknown>,
    extra?: HookEmitOptions,
  ) => HookEvent;
} {
  const specTypes = new Set(specs.map((s) => s.type));
  return {
    feature,
    specs,
    emit(type, data, extra) {
      if (!specTypes.has(type)) {
        // 不阻断运行，但提示开发者：未声明的 hook 类型
        console.warn(
          `[hooks] feature "${feature}" emit undeclared hook type "${type}"`,
        );
      }
      return getHookBus().emit(type, data, {
        source: feature,
        ...(extra?.actorId && { actorId: extra.actorId }),
        ...(extra?.version && { version: extra.version }),
      });
    },
  };
}
