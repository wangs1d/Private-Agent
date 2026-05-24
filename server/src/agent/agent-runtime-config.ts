/**
 * 统一 Agent 运行时配置：启动时从环境变量加载一次，避免散落 process.env 读取。
 */

import { resolvePromptMemoryKeys } from "./prompt-builder.js";

function envTruthy(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  if (!v || v === "0" || v === "off" || v === "false" || v === "no") return false;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function envPositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type MasterDelegationConfig = {
  enabled: boolean;
  verbose: boolean;
  subtaskTimeoutMs: number;
  /** tech 子 Agent 专用超时（深度 RPA / 代码任务通常更长） */
  techSubtaskTimeoutMs: number;
  maxSubAgentInvocationsPerTurn: number;
  forceSynthesis: boolean;
  directReplyMaxChars: number;
  maxParallelSubAgents: number;
  retryEnabled: boolean;
  maxRetryAttempts: number;
  semanticDedupEnabled: boolean;
  semanticDedupThreshold: number;
};

export type PlanExecuteConfig = {
  enabled: boolean;
  verboseStream: boolean;
};

export type MemoryPromptConfig = {
  narrativeRecallTimeoutMs: number;
  worldCapsInPrompt: boolean;
  promptMemoryKeys: string[] | null;
  taskContextInPrompt: boolean;
};

export type QuotaConfig = {
  unitsPerModelCall: number;
};

export type MessageBatchConfig = {
  enabled: boolean;
  debounceMs: number;
  maxWaitMs: number;
};

export type AgentRuntimeConfig = {
  masterDelegation: MasterDelegationConfig;
  planExecute: PlanExecuteConfig;
  memoryPrompt: MemoryPromptConfig;
  quota: QuotaConfig;
  messageBatch: MessageBatchConfig;
};

function loadMasterDelegationConfig(): MasterDelegationConfig {
  const primary = process.env.ENABLE_MASTER_AGENT_DELEGATION;
  const legacy = process.env.ENABLE_MULTI_AGENT_COORDINATION;
  const hasExplicit =
    (primary !== undefined && primary.trim() !== "") ||
    (legacy !== undefined && legacy.trim() !== "");
  const hasExternalModel = Boolean(
    process.env.MOONSHOT_API_KEY?.trim() ||
      process.env.OPENAI_API_KEY?.trim() ||
      process.env.EXTERNAL_MODEL_PROVIDER?.trim(),
  );
  const enabled = hasExplicit
    ? envTruthy(primary ?? legacy)
    : hasExternalModel;

  const verbosePrimary = process.env.MASTER_AGENT_DELEGATION_VERBOSE;
  const verbose =
    verbosePrimary !== undefined && verbosePrimary.trim() !== ""
      ? envTruthy(verbosePrimary)
      : envTruthy(process.env.MULTI_AGENT_VERBOSE);

  const subtaskTimeoutMs = envPositiveInt(process.env.SUBTASK_TIMEOUT_MS, 60_000);
  return {
    enabled,
    verbose,
    subtaskTimeoutMs,
    techSubtaskTimeoutMs: envPositiveInt(process.env.TECH_SUBTASK_TIMEOUT_MS, 120_000),
    maxSubAgentInvocationsPerTurn: envPositiveInt(process.env.MASTER_AGENT_MAX_SUB_AGENT_INVOCATIONS, 6),
    forceSynthesis: process.env.MASTER_AGENT_FORCE_SYNTHESIS === "1",
    directReplyMaxChars: envPositiveInt(process.env.MASTER_AGENT_DIRECT_REPLY_MAX_CHARS, 2800),
    maxParallelSubAgents: envPositiveInt(process.env.MAX_PARALLEL_SUB_AGENTS, 3),
    retryEnabled: envTruthy(process.env.SUBAGENT_RETRY_ENABLED),
    maxRetryAttempts: envPositiveInt(process.env.SUBAGENT_MAX_RETRY_ATTEMPTS, 2),
    semanticDedupEnabled: envTruthy(process.env.SEMANTIC_DEDUP_ENABLED),
    semanticDedupThreshold: Number.parseFloat(process.env.SEMANTIC_DEDUP_THRESHOLD ?? "0.75"),
  };
}

function loadPlanExecuteConfig(): PlanExecuteConfig {
  return {
    enabled: envTruthy(process.env.AGENT_PLAN_EXECUTE_LOOP),
    verboseStream: envTruthy(process.env.AGENT_PE_VERBOSE_STREAM),
  };
}

function loadMemoryPromptConfig(): MemoryPromptConfig {
  const promptMemoryKeys = resolvePromptMemoryKeys();

  const capsRaw = process.env.AGENT_PROMPT_WORLD_CAPS?.trim().toLowerCase();
  const worldCapsInPrompt =
    capsRaw === undefined || capsRaw === ""
      ? true
      : !(capsRaw === "0" || capsRaw === "off" || capsRaw === "false" || capsRaw === "no");

  return {
    narrativeRecallTimeoutMs: Math.min(
      3000,
      Math.max(200, envPositiveInt(process.env.AGENT_NARRATIVE_RECALL_TIMEOUT_MS, 600)),
    ),
    worldCapsInPrompt,
    promptMemoryKeys,
    taskContextInPrompt: process.env.AGENT_TASK_CONTEXT_PROMPT !== "0",
  };
}

function loadQuotaConfig(): QuotaConfig {
  return {
    unitsPerModelCall: envPositiveInt(process.env.COMPUTE_QUOTA_UNITS_PER_MODEL_CALL, 0),
  };
}

function loadMessageBatchConfig(): MessageBatchConfig {
  return {
    enabled: envTruthy(process.env.MESSAGE_BATCH_ENABLED),
    debounceMs: envPositiveInt(process.env.MESSAGE_BATCH_DEBOUNCE_MS, 1200),
    maxWaitMs: envPositiveInt(process.env.MESSAGE_BATCH_MAX_WAIT_MS, 5000),
  };
}

export function loadAgentRuntimeConfig(): AgentRuntimeConfig {
  return {
    masterDelegation: loadMasterDelegationConfig(),
    planExecute: loadPlanExecuteConfig(),
    memoryPrompt: loadMemoryPromptConfig(),
    quota: loadQuotaConfig(),
    messageBatch: loadMessageBatchConfig(),
  };
}

let cached: AgentRuntimeConfig | null = null;

export function getAgentRuntimeConfig(): AgentRuntimeConfig {
  if (!cached) cached = loadAgentRuntimeConfig();
  return cached;
}

/** 单元测试重置缓存 */
export function resetAgentRuntimeConfigForTests(): void {
  cached = null;
}

/** 启动日志用：人类可读摘要 */
export function formatAgentRuntimeConfigSummary(config: AgentRuntimeConfig): string {
  const m = config.masterDelegation;
  const pe = config.planExecute;
  const mb = config.messageBatch;
  return [
    `masterDelegation=${m.enabled ? "on" : "off"}`,
    m.enabled ? `maxSubAgentInvocations=${m.maxSubAgentInvocationsPerTurn}` : null,
    m.enabled ? `parallelSubAgents=${m.maxParallelSubAgents}` : null,
    m.enabled ? `retry=${m.retryEnabled ? "on" : "off"}` : null,
    `planExecute=${pe.enabled ? "on" : "off"}`,
    `worldCapsPrompt=${config.memoryPrompt.worldCapsInPrompt ? "on" : "off"}`,
    config.memoryPrompt.promptMemoryKeys
      ? `uapMemoryKeys=${config.memoryPrompt.promptMemoryKeys.length}`
      : "uapMemoryKeys=off",
    `taskContext=${config.memoryPrompt.taskContextInPrompt ? "on" : "off"}`,
    config.quota.unitsPerModelCall > 0 ? `quotaUnitsPerCall=${config.quota.unitsPerModelCall}` : null,
    `messageBatch=${mb.enabled ? "on" : "off"}`,
    mb.enabled ? `batchDebounceMs=${mb.debounceMs}` : null,
    mb.enabled ? `batchMaxWaitMs=${mb.maxWaitMs}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}
