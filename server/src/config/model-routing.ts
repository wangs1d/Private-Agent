/**
 * 模型分级配置中心化（Token 效率优化 - Phase 6.1）
 *
 * 设计原则：
 * - 能规则不 LLM，能小模型不大模型
 * - routine 任务用 nano/mini，复杂决策才用 full
 * - 通过环境变量灵活覆盖
 *
 * 使用方式：
 *   import { getModelForTask, TASK_TIER } from "../config/model-routing.js";
 *   const model = getModelForTask(TASK_TIER.MINI); // "gpt-4.1-mini"
 *   provider.streamCompletion(sessionId, userTurn, onDelta, tools, { modelOverride: model });
 */

/** 任务分级：按复杂度从低到高 */
export enum TaskTier {
  /** Fast 模式：对话/轻量工具/简单查询 — 使用 DeepSeek Flash（deepseek-chat） */
  FAST = "fast",
  /** Complex 模式：深度推理/子 Agent 委派/多步计划 — 使用 DeepSeek Pro（deepseek-reasoner） */
  COMPLEX = "complex",
  /** 最简单：情绪识别 L2、技术扫描评估、简单分类 */
  NANO = "nano",
  /** 中等：EndToEndDecisionMaker、SkillGenerator、CodeRepairCortex、子 Agent */
  MINI = "mini",
  /** 最复杂：cognize、master_delegate、复杂推理 */
  FULL = "full",
}

/** 默认模型映射 */
const DEFAULT_MODELS: Record<TaskTier, string> = {
  [TaskTier.FAST]: "deepseek-chat",       // DeepSeek Flash（V3 快模型）
  [TaskTier.COMPLEX]: "deepseek-reasoner", // DeepSeek Pro（R1 推理模型）
  [TaskTier.NANO]: "gpt-4.1-nano",
  [TaskTier.MINI]: "gpt-4.1-mini",
  [TaskTier.FULL]: "", // 空字符串表示使用主模型（OPENAI_MODEL / MOONSHOT_MODEL）
};

/** 环境变量名前缀 */
const ENV_PREFIX: Record<TaskTier, string> = {
  [TaskTier.FAST]: "MODEL_FAST",
  [TaskTier.COMPLEX]: "MODEL_COMPLEX",
  [TaskTier.NANO]: "MODEL_NANO",
  [TaskTier.MINI]: "MODEL_MINI",
  [TaskTier.FULL]: "MODEL_FULL",
};

/** 缓存解析后的覆盖配置，避免每次调用都解析 JSON */
let cachedOverride: Record<string, string> | null = null;
let cachedOverrideTimestamp = 0;
const OVERRIDE_CACHE_TTL_MS = 60_000; // 1 分钟

/**
 * 解析 MODEL_ROUTING_OVERRIDE 环境变量（JSON 格式）
 * 示例：{"nano":"gpt-4.1-mini","mini":"kimi-k2.5"}
 */
function loadOverride(): Record<string, string> {
  const now = Date.now();
  if (cachedOverride && now - cachedOverrideTimestamp < OVERRIDE_CACHE_TTL_MS) {
    return cachedOverride;
  }

  const raw = process.env.MODEL_ROUTING_OVERRIDE?.trim();
  if (!raw) {
    cachedOverride = {};
  } else {
    try {
      const parsed = JSON.parse(raw);
      cachedOverride =
        typeof parsed === "object" && parsed && !Array.isArray(parsed)
          ? parsed
          : {};
    } catch {
      console.warn(
        `[model-routing] Failed to parse MODEL_ROUTING_OVERRIDE, using defaults.`,
      );
      cachedOverride = {};
    }
  }
  cachedOverrideTimestamp = now;
  return cachedOverride!;
}

/**
 * 获取指定任务分级的模型名
 *
 * 优先级：
 * 1. MODEL_ROUTING_OVERRIDE JSON 中的对应 tier
 * 2. 环境变量 MODEL_NANO / MODEL_MINI / MODEL_FULL
 * 3. 默认值（FULL 返回空字符串，表示用主模型）
 *
 * @param tier 任务分级
 * @returns 模型名（空字符串表示使用 provider 默认主模型）
 */
export function getModelForTask(tier: TaskTier): string {
  const override = loadOverride();

  // 1. JSON 覆盖
  const jsonOverride = override[tier];
  if (jsonOverride) return jsonOverride;

  // 2. 环境变量
  const envVar = ENV_PREFIX[tier];
  const envValue = process.env[envVar]?.trim();
  if (envValue) return envValue;

  // 3. 默认值
  return DEFAULT_MODELS[tier];
}

/**
 * 获取 AgentStreamOptions.modelOverride 用的模型名
 * 如果返回空字符串，调用方可不设置 modelOverride（使用 provider 默认）
 */
export function getModelOverrideForTask(
  tier: TaskTier,
): string | undefined {
  const model = getModelForTask(tier);
  return model || undefined;
}

/**
 * 便捷构造 AgentStreamOptions 的 modelOverride
 * 仅当模型与主模型不同时才设置（避免无意义的 override）
 */
export function buildModelOverrideOpts(
  tier: TaskTier,
): { modelOverride?: string } {
  const model = getModelOverrideForTask(tier);
  return model ? { modelOverride: model } : {};
}

/**
 * 输出当前模型路由配置（用于日志/调试）
 */
export function dumpModelRouting(): Record<string, string> {
  return {
    [TaskTier.FAST]: getModelForTask(TaskTier.FAST) || "(provider default)",
    [TaskTier.COMPLEX]: getModelForTask(TaskTier.COMPLEX) || "(provider default)",
    [TaskTier.NANO]: getModelForTask(TaskTier.NANO) || "(provider default)",
    [TaskTier.MINI]: getModelForTask(TaskTier.MINI) || "(provider default)",
    [TaskTier.FULL]: getModelForTask(TaskTier.FULL) || "(provider default)",
    overrideSource: process.env.MODEL_ROUTING_OVERRIDE ? "env" : "defaults",
  };
}
