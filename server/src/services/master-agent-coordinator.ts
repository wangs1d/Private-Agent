/**
 * Master Agent coordinator.
 * The only sub-agent path is dynamic function-calling delegation via
 * `master_invoke_sub_agent`.
 */

import { randomUUID } from "node:crypto";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { isMasterAgentDelegationVerbose } from "../agent/master-agent-delegate-env.js";
import { getAgentRuntimeConfig } from "../agent/agent-runtime-config.js";
import type { PromptContextBuilder } from "../agent/prompt-context-builder.js";
import type { PersonalizationPromptSlice } from "./user-personalization/user-personalization-service.js";
import { routeLlmExecution } from "../agent/task-router.js";
import {
  pickSubAgentDoneLine,
  USER_VISIBLE_PROGRESS_MARKER,
} from "../agent/delegate-status.js";
import { parseSubAgentType, SUBAGENT_ASK_PEER_REGISTRY } from "../agent/master-subagent-delegate-tools.js";
import { shouldAllowBackgroundSubAgentTask } from "../agent/background-task-policy.js";
import { resolveUserLocationPrompt } from "./user-location-service.js";
import type {
  AgentRole,
  BackgroundSubAgentAction,
  BackgroundSubAgentJob,
  BackgroundSubAgentUpdate,
  InterAgentMessage,
  MessageRecipient,
  SubAgentCapability,
  SubAgentResult,
  SubAgentType,
  SubTask,
} from "./master-agent-types.js";
import {
  buildAgentAccessModePromptLine,
  parseAgentAccessMode,
  type AgentAccessMode,
} from "../agent/agent-access-mode.js";
import { resolveActorId } from "../agent/actor-id.js";
import { masterChatSessionId } from "../agent/master-chat-session.js";
import type { ToolContext } from "../tools/tool-registry.js";
import type {
  AgentStreamOptions,
  ChatToolExecutionContext,
  ChatUserTurn,
  ExternalChatProvider,
  ToolExecutedInfo,
  ToolExecuteStartInfo,
  ToolLoopAfterBatchInfo,
  VisionFrame,
} from "../external-model/types.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import { buildMasterAgentChatTools } from "./master-agent-tool-filter.js";
import {
  parseSubAgentReport,
  buildSubAgentReportForMaster,
} from "../agent/subagent-system-prompts.js";
import {
  SubAgentCapabilityRegistry,
  createDefaultSubAgentRegistry,
  type SubAgentDefinition,
  type ToolNameResolver,
} from "../agent/subagent-capability-registry.js";

export type { SubAgentCapability, SubAgentResult, SubAgentType, SubTask } from "./master-agent-types.ts";

type SubAgentInvokeContext = {
  userMessage: string;
  priorResults: SubAgentResult[];
  /** 上次失败的工具调用摘要（重试时传入，帮助子 Agent 不重复相同错误） */
  priorToolCallSummary?: string;
  /** 工具调用历史收集器（引用传递，外部可读，用于失败重试时序列化为摘要） */
  toolCallHistory?: ToolExecutedInfo[];
  /** 主 Agent 直接指令：该怎么做（执行策略/约束），体现主→子直接通信 */
  directive?: string;
};

type TurnDelegationState = {
  reports: SubAgentResult[];
  seenFingerprints: Map<string, SubAgentResult>;
  interAgentMessages: InterAgentMessage[];
  retryAttempts: Map<string, number>;
  /** 已启动尚未写入 reports 的委派（含后台任务） */
  inFlightCount: number;
  backgroundJobs: Map<string, BackgroundSubAgentJob>;
};

type BackgroundJobLookup = {
  turnKey: string;
  turnState: TurnDelegationState;
  job: BackgroundSubAgentJob;
};

export type OrchestrateTaskOptions = {
  sessionId?: string;
  chatUserMessageId?: string;
  userId?: string;
  clientIp?: string;
  clientLocation?: import("../types/client-location.js").ClientLocationWire;
  userLocation?: string;
  visionFrames?: VisionFrame[];
  interruptedContext?: string;
  narrativeRecall?: string;
  personalization?: PersonalizationPromptSlice;
  onToolExecuteStart?: (info: ToolExecuteStartInfo) => void;
  onToolExecuted?: (info: ToolExecutedInfo) => void;
  onToolLoopAfterBatch?: (info: ToolLoopAfterBatchInfo) => void;
  /** 主 Agent 流式口语化进度（工具轮次，由模型实时生成） */
  onAgentStatusLine?: (line: string) => void;
  agentAccessMode?: import("../agent/agent-access-mode.js").AgentAccessMode;
  desktopBridgeOnline?: boolean;
  phoneBridgeOnline?: boolean;
  toolRankingHint?: AgentStreamOptions["toolRankingHint"];
};

export interface MasterAgentConfig {
  enableSubAgents: boolean;
  maxParallelTasks: number;
  taskTimeoutMs: number;
  techSubtaskTimeoutMs: number;
  /** info 子 Agent 专用超时（多轮 search_web + fetch_web 通常更长） */
  infoSubtaskTimeoutMs: number;
  allowFallback: boolean;
  verbose: boolean;
  enableMetrics: boolean;
  onBackgroundJobUpdate?: (update: BackgroundSubAgentUpdate) => void;
}

export interface PerformanceMetrics {
  totalTasks: number;
  sequentialExecutions: number;
  parallelExecutions: number;
  fallbackCount: number;
  avgExecutionTime: number;
  successRate: number;
  lastUpdated: string;
}

export interface SubAgentPerformanceMetrics {
  invocations: number;
  failures: number;
  timeouts: number;
  avgExecutionTime: number;
  lastExecutionTime?: number;
}

export class MasterAgentCoordinator {
  private readonly config: MasterAgentConfig;
  /** 子 Agent 能力注册中心（配置驱动 + 运行时可注册） */
  private readonly capabilityRegistry: SubAgentCapabilityRegistry;
  private readonly subAgentCapabilities: Map<SubAgentType, SubAgentCapability>;
  private readonly metrics: PerformanceMetrics;
  private readonly executionHistory: Array<{
    timestamp: string;
    taskId: string;
    duration: number;
    success: boolean;
    strategy: string;
    subTaskCount: number;
  }> = [];

  private readonly turnDelegationStates = new Map<string, TurnDelegationState>();
  private readonly turnLocks = new Map<string, Promise<void>>();
  private readonly subAgentMetrics = new Map<SubAgentType, SubAgentPerformanceMetrics>();
  private activeSubAgentSlots = 0;
  private readonly subAgentSlotWaiters: Array<() => void> = [];
  private currentTurnUserMessage: string | null = null;
  private currentTurnOrchestrateOpts: OrchestrateTaskOptions | null = null;

  constructor(
    private readonly masterProvider: ExternalChatProvider,
    private readonly toolRegistry: ToolRegistry,
    private readonly promptContextBuilder: PromptContextBuilder | null = null,
    config?: Partial<MasterAgentConfig>,
  ) {
    this.config = {
      enableSubAgents: true,
      maxParallelTasks: 1,
      taskTimeoutMs: 60_000,
      techSubtaskTimeoutMs: 120_000,
      infoSubtaskTimeoutMs: 90_000,
      allowFallback: true,
      verbose: isMasterAgentDelegationVerbose(),
      enableMetrics: true,
      ...config,
    };
    const rtConfig = getAgentRuntimeConfig();
    this.config.maxParallelTasks = rtConfig.masterDelegation.maxParallelSubAgents;

    // 工具名解析器：从 toolRegistry.list() 按关键词匹配（life 的 tools 需动态解析）
    const toolResolver: ToolNameResolver = (...keywords) => {
      const all = this.toolRegistry.list();
      return all.filter((t) => keywords.some((p) => t.includes(p)));
    };
    this.capabilityRegistry = createDefaultSubAgentRegistry(toolResolver);
    this.subAgentCapabilities = this.capabilityRegistry.capabilityMap();
    this.metrics = {
      totalTasks: 0,
      sequentialExecutions: 0,
      parallelExecutions: 0,
      fallbackCount: 0,
      avgExecutionTime: 0,
      successRate: 100,
      lastUpdated: new Date().toISOString(),
    };

    this.registerDelegateTools();
    this.log("MasterAgentCoordinator initialized", {
      enableSubAgents: this.config.enableSubAgents,
      maxParallelTasks: this.config.maxParallelTasks,
      verbose: this.config.verbose,
    });
  }

  private emitBackgroundJobUpdate(update: BackgroundSubAgentUpdate): void {
    try {
      this.config.onBackgroundJobUpdate?.(update);
    } catch (error) {
      this.log("Background job update callback failed", {
        taskId: update.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private registerDelegateTools(): void {
    this.toolRegistry.register("master.invoke_sub_agent", async (input, context) => {
      const out = await this.handleInvokeSubAgentTool(input, context);
      if (out.ok === false) {
        throw new Error(String(out.error ?? "子 Agent 委派失败"));
      }
      return out;
    });
    this.toolRegistry.register("master.list_sub_agents", async (_input, context) =>
      this.handleListSubAgentsTool(context),
    );
    this.toolRegistry.register("master.poll_sub_agent_tasks", async (_input, context) =>
      this.handlePollSubAgentTasksTool(context),
    );
    // subagent.ask_peer 全局兜底：直接调用时拒绝（只能在子 Agent 执行中通过拦截器调用）
    this.toolRegistry.register(SUBAGENT_ASK_PEER_REGISTRY, async () => {
      throw new Error("subagent.ask_peer 只能在子 Agent 执行中调用，不可直接调用");
    });
  }

  /** 供验收测试 / 监控读取子 Agent 能力表。 */
  getSubAgentCapabilities(): ReadonlyMap<SubAgentType, SubAgentCapability> {
    return this.subAgentCapabilities;
  }

  /**
   * 子 Agent 能力定义已迁移至 `SubAgentCapabilityRegistry`（配置驱动）。
   *
   * 内置 3 个核心子 Agent（由 createDefaultSubAgentRegistry 注册）：
   * - life  → 复杂生活操作：钱包写操作(转帐/消费50+类/充值) + 视觉操控(电脑)
   * - tech  → 技术操控：深度RPA自动化 + 代码开发 + 系统运维 + 视觉操控(深度)
   * - info  → 信息检索：深度搜索比价调研（只查不买）
   *
   * ⚠️ 主 agent 拥有基本能力（查天气/查余额/设日程/好友管理/搜信息），自己先处理。
   * 只有涉及以上子 agent 专属能力时才委派。
   *
   * 视觉操控（desktop.visual.run_task）仅 life / tech 子 Agent 拥有：
   * - life: 偶尔用（订酒店时顺手操作网站）
   * - tech: 深度用（复杂自动化流程、批量操作、长时间运行）
   *
   * 外部项目可通过 {@link registerSubAgentCapability} 注册自定义子 Agent 或覆盖内置配置。
   */

  /**
   * 注册（或覆盖）一个子 Agent 能力定义。
   *
   * 适配层用途：外部项目可注入自定义子 Agent（如专属业务 Agent），
   * 或覆盖内置 life/tech/info 的 maxRounds / systemPrompt / 模型配置，
   * 无需改动本项目源码。注册后立即生效于后续委派。
   */
  registerSubAgentCapability(def: SubAgentDefinition): void {
    this.capabilityRegistry.registerCapability(def);
    // 同步刷新 subAgentCapabilities 快照（供 getSubAgentCapabilities() 读取）
    this.subAgentCapabilities.clear();
    for (const [k, v] of this.capabilityRegistry.capabilityMap()) {
      this.subAgentCapabilities.set(k, v);
    }
    this.log("Sub-agent capability registered/overridden", {
      type: def.capability.type,
      name: def.capability.name,
      maxRounds: def.maxRounds,
    });
  }

  /** 获取能力注册中心（供高级用法：查询/遍历所有已注册定义） */
  getCapabilityRegistry(): SubAgentCapabilityRegistry {
    return this.capabilityRegistry;
  }

  private turnReportKey(actorId: string, chatUserMessageId?: string): string {
    return `${actorId}:${chatUserMessageId ?? "no-message-id"}`;
  }

  private emptyTurnDelegationState(): TurnDelegationState {
    return {
      reports: [],
      seenFingerprints: new Map(),
      interAgentMessages: [],
      retryAttempts: new Map(),
      inFlightCount: 0,
      backgroundJobs: new Map(),
    };
  }

  private resetTurnReports(actorId: string, chatUserMessageId?: string): void {
    this.turnDelegationStates.set(this.turnReportKey(actorId, chatUserMessageId), this.emptyTurnDelegationState());
  }

  private getTurnDelegationState(actorId: string, chatUserMessageId?: string): TurnDelegationState {
    const key = this.turnReportKey(actorId, chatUserMessageId);
    let state = this.turnDelegationStates.get(key);
    if (!state) {
      state = this.emptyTurnDelegationState();
      this.turnDelegationStates.set(key, state);
    }
    return state;
  }

  private listTurnStatesForActor(actorId: string): Array<[string, TurnDelegationState]> {
    const prefix = `${actorId}:`;
    return [...this.turnDelegationStates.entries()].filter(([key]) => key.startsWith(prefix));
  }

  private findBackgroundJob(actorId: string, taskId: string): BackgroundJobLookup | null {
    for (const [turnKey, turnState] of this.listTurnStatesForActor(actorId)) {
      const job = turnState.backgroundJobs.get(taskId);
      if (job) {
        return { turnKey, turnState, job };
      }
    }
    return null;
  }

  private computeAvailableActions(job: BackgroundSubAgentJob): BackgroundSubAgentAction[] {
    if (job.status === "running") return [];
    if (job.status === "failed") return ["retry", "confirm"];
    if (job.status === "awaiting_confirmation") return ["continue_processing", "confirm"];
    return [];
  }

  private async withTurnLock<T>(turnKey: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.turnLocks.get(turnKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.turnLocks.set(
      turnKey,
      prev.then(() => gate),
    );
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.turnLocks.get(turnKey) === gate) {
        this.turnLocks.delete(turnKey);
      }
    }
  }

  private async acquireSubAgentSlot(): Promise<() => void> {
    const max = Math.max(1, this.config.maxParallelTasks);
    while (this.activeSubAgentSlots >= max) {
      await new Promise<void>((resolve) => {
        this.subAgentSlotWaiters.push(resolve);
      });
    }
    if (this.activeSubAgentSlots >= 1) {
      this.metrics.parallelExecutions += 1;
    }
    this.activeSubAgentSlots += 1;
    return () => {
      this.activeSubAgentSlots = Math.max(0, this.activeSubAgentSlots - 1);
      const next = this.subAgentSlotWaiters.shift();
      if (next) next();
    };
  }

  private parseRunInBackground(raw: unknown): boolean {
    const v = String(raw ?? "")
      .trim()
      .toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "on";
  }

  private buildDelegationFingerprint(agentType: SubAgentType, taskDescription: string, priorContext: string): string {
    const normalized = `${taskDescription}\n${priorContext}`
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1000);
    return `${agentType}:${normalized}`;
  }

  private tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^\w\u4e00-\u9fff\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 1),
    );
  }

  private computeSemanticSimilarity(a: string, b: string): number {
    const tokensA = this.tokenize(a);
    const tokensB = this.tokenize(b);
    if (tokensA.size === 0 || tokensB.size === 0) return 0;
    const intersection = new Set([...tokensA].filter((x) => tokensB.has(x)));
    const union = new Set([...tokensA, ...tokensB]);
    return intersection.size / union.size;
  }

  private findSimilarExistingFingerprint(
    turnState: TurnDelegationState,
    agentType: SubAgentType,
    taskDescription: string,
    priorContext: string,
    threshold: number,
  ): SubAgentResult | null {
    const rtConfig = getAgentRuntimeConfig();
    const effectiveThreshold = rtConfig.masterDelegation.semanticDedupEnabled ? (rtConfig.masterDelegation.semanticDedupThreshold || threshold) : 1.0;
    if (effectiveThreshold >= 1.0) return null;

    const candidate = `${taskDescription}\n${priorContext}`.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 1000);
    for (const [fp, result] of turnState.seenFingerprints) {
      if (!fp.startsWith(`${agentType}:`)) continue;
      const existingText = fp.slice(`${agentType}:`.length);
      if (this.computeSemanticSimilarity(candidate, existingText) >= effectiveThreshold) {
        return result;
      }
    }
    return null;
  }

  /**
   * 向共享消息总线写入一条消息。
   * - from/to 支持 "master"（主 Agent）和 SubAgentType
   * - to 支持 "broadcast"（所有 Agent 可见）
   * - kind 标注消息类型（handoff/ask_peer/notice/directive）
   */
  private sendInterAgentMessage(
    turnState: TurnDelegationState,
    from: AgentRole,
    to: MessageRecipient,
    content: string,
    kind: InterAgentMessage["kind"] = "notice",
    relatedTaskId?: string,
  ): InterAgentMessage {
    const msg: InterAgentMessage = {
      id: randomUUID(),
      fromAgent: from,
      toAgent: to,
      content,
      timestamp: Date.now(),
      relatedTaskId,
      kind,
    };
    turnState.interAgentMessages.push(msg);
    return msg;
  }

  /**
   * 读取某角色可见的消息。
   * - 子 Agent：看到发给它的点对点消息 + broadcast 广播
   * - master：看到所有消息（监督视角）
   */
  private getInterAgentMessagesForAgent(turnState: TurnDelegationState, role: AgentRole): InterAgentMessage[] {
    return turnState.interAgentMessages.filter((m) => {
      if (role === "master") return true;
      return m.toAgent === role || m.toAgent === "broadcast";
    });
  }

  /** 主 Agent 监督视角：读取所有协作消息（handoff/ask_peer/notice） */
  private getInterAgentMessagesForMaster(turnState: TurnDelegationState): InterAgentMessage[] {
    return turnState.interAgentMessages;
  }

  private formatInterAgentMessagesForPrompt(messages: InterAgentMessage[]): string {
    if (messages.length === 0) return "";
    return (
      "\n\n【共享消息总线】\n" +
        messages
          .map((m) => {
            const kindLabel = m.kind ? `[${m.kind}]` : "";
            const toLabel = m.toAgent === "broadcast" ? "广播" : `→${m.toAgent}`;
            return `- 来自 ${m.fromAgent} ${toLabel} ${kindLabel}（${new Date(m.timestamp).toLocaleTimeString("zh-CN")}）：\n  ${m.content}`;
          })
          .join("\n\n")
    );
  }

  private buildRetryHint(errorMsg: string, attempt: number, agentType: SubAgentType): string {
    const isTimeout = errorMsg.includes("timed out");
    if (isTimeout) {
      return `[重试提示 #${attempt}] 上次执行超时。请简化操作步骤，聚焦核心目标，减少不必要的工具调用。如果任务过于复杂，请分阶段汇报中间结果。`;
    }
    if (errorMsg.toLowerCase().includes("error") || errorMsg.toLowerCase().includes("fail")) {
      return `[重试提示 #${attempt}] 上次执行失败：${errorMsg.slice(0, 200)}。请调整策略后重试，考虑使用替代工具或简化任务范围。`;
    }
    return `[重试提示 #${attempt}] 上次执行异常，请换一种方式完成任务。`;
  }

  async handleInvokeSubAgentTool(input: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>> {
    const actorId = resolveActorId(context);
    // 用 registry 动态类型校验，支持外部注册的自定义子 Agent
    const agentType = parseSubAgentType(input.agentType, this.capabilityRegistry.types());
    const taskDescription = String(input.taskDescription ?? "").trim();
    const priorContext = String(input.priorContext ?? "").trim();
    // 主 Agent 直接指令：该怎么做（执行策略/约束），体现主→子直接通信
    const directive = String(input.directive ?? "").trim() || undefined;
    const targetAgent = String(input.forwardToAgent ?? "").trim();
    const requestedBackground = this.parseRunInBackground(input.runInBackground ?? input.background);

    if (!agentType) return { ok: false, error: "Invalid agentType. Use master_list_sub_agents to inspect options." };
    if (!taskDescription) return { ok: false, error: "taskDescription is required." };

    const capability = this.subAgentCapabilities.get(agentType);
    if (!capability) return { ok: false, error: `Unknown sub-agent type: ${agentType}` };
    const runInBackground = shouldAllowBackgroundSubAgentTask({
      userMessage: this.currentTurnUserMessage ?? taskDescription,
      taskDescription,
      agentType,
      explicitlyRequested: requestedBackground,
    });

    const rtConfig = getAgentRuntimeConfig();
    const turnKey = this.turnReportKey(actorId, context.chatUserMessageId);
    const turnState = this.getTurnDelegationState(actorId, context.chatUserMessageId);
    const maxInvocations = Math.max(1, rtConfig.masterDelegation.maxSubAgentInvocationsPerTurn);

    const limitError = await this.withTurnLock(turnKey, async () => {
      if (turnState.reports.length + turnState.inFlightCount >= maxInvocations) {
        return {
          ok: false,
          agentType,
          agentName: capability.name,
          error: `Sub-agent delegation limit reached for this turn (${maxInvocations}). Synthesize from prior reports instead of delegating again.`,
          priorInvocationsInTurn: turnState.reports.length,
          inFlightInTurn: turnState.inFlightCount,
        } as Record<string, unknown>;
      }
      return null;
    });
    if (limitError) return limitError;

    const fingerprint = this.buildDelegationFingerprint(agentType, taskDescription, priorContext);

    const exactPrevious = turnState.seenFingerprints.get(fingerprint);
    if (exactPrevious) {
      return {
        ok: exactPrevious.success,
        agentType,
        agentName: capability.name,
        taskId: exactPrevious.taskId,
        report: exactPrevious.result,
        deduplicated: true,
        priorInvocationsInTurn: turnState.reports.length,
        message: "Duplicate sub-agent delegation skipped; reuse the existing report.",
      };
    }

    const similarPrevious = this.findSimilarExistingFingerprint(turnState, agentType, taskDescription, priorContext, 0.75);
    if (similarPrevious) {
      return {
        ok: similarPrevious.success,
        agentType,
        agentName: capability.name,
        taskId: similarPrevious.taskId,
        report: similarPrevious.result,
        deduplicated: true,
        semanticallyDeduplicated: true,
        priorInvocationsInTurn: turnState.reports.length,
        message: "Semantically similar sub-agent delegation skipped; reuse the existing report.",
      };
    }

    // 创建任务（含主 Agent 直接指令 directive）
    const task: SubTask = {
      id: `delegate-${randomUUID()}`,
      description: priorContext ? `${taskDescription}\n\n补充背景：${priorContext}` : taskDescription,
      assignedAgent: agentType,
      priority: 5,
      dependencies: [],
      estimatedComplexity: "medium",
      // 主 Agent 直接指令（该怎么做），透传到子 Agent prompt
      directive,
    };

    // 写入共享消息总线：记录主 Agent 的委派指令（广播，监督 + 其他子 Agent 感知任务上下文）
    this.sendInterAgentMessage(
      turnState,
      "master",
      "broadcast",
      `[directive] master→${agentType}：${taskDescription.slice(0, 200)}${directive ? ` | 策略：${directive.slice(0, 150)}` : ""}`,
      "directive",
      task.id,
    );

    if (targetAgent) {
      const targetType = parseSubAgentType(targetAgent, this.capabilityRegistry.types());
      if (targetType && targetType !== agentType) {
        // 真正的 Agent-to-Agent 协作：先执行 A，再把 A 的产出交给 B 接力处理
        // （旧实现只是把消息塞进消息池就返回，A/B 都不执行 —— 不是真实协作）
        const aResult = await this.runSubAgentDelegation({
          actorId,
          turnKey,
          turnState,
          task,
          capability,
          agentType,
          fingerprint,
          taskDescription,
          priorContext,
          context,
          maxRetries: rtConfig.masterDelegation.retryEnabled
            ? Math.min(rtConfig.masterDelegation.maxRetryAttempts, 3)
            : 0,
          background: false,
        });
        // A 执行失败则不接力 B，直接返回 A 的结果
        if (aResult.ok === false) return aResult;
        const aReport = String(aResult.report ?? aResult.result ?? "").trim();
        // 构造 B 的接力任务：A 的报告作为核心输入
        const bCapability = this.subAgentCapabilities.get(targetType);
        if (!bCapability) {
          return { ok: false, error: `Unknown forward target sub-agent type: ${targetType}` };
        }
        const bTask: SubTask = {
          id: `delegate-${randomUUID()}`,
          description:
            `接力处理来自 ${capability.name}（${agentType}）的产出。原始任务：${taskDescription}\n\n【${agentType} Agent 的报告】\n${aReport || "(A 未产出有效报告)"}`,
          assignedAgent: targetType,
          priority: 5,
          dependencies: [task.id],
          estimatedComplexity: "medium",
          directive: `你是 ${targetType} Agent，${capability.name}（${agentType}）已完成上游工作并产出报告。请基于它的报告继续处理：${directive ? `主 Agent 要求的策略：${directive}；` : ""}若上游报告缺失关键信息，在 [MISSING] 中说明需要 ${agentType} 补充什么。`,
        };
        const bFingerprint = this.buildDelegationFingerprint(targetType, bTask.description, `handoff-from-${agentType}`);
        const bResult = await this.runSubAgentDelegation({
          actorId,
          turnKey,
          turnState,
          task: bTask,
          capability: bCapability,
          agentType: targetType,
          fingerprint: bFingerprint,
          taskDescription: bTask.description,
          priorContext: priorContext ? `上游 ${agentType} 已完成。${priorContext}` : `上游 ${agentType} 已完成。`,
          context,
          maxRetries: 0, // 接力任务不重试，避免链路过长
          background: false,
        });
        // 记录 A→B 的协作消息（广播到共享总线，供主 Agent 监督 + 其他子 Agent 感知）
        this.sendInterAgentMessage(
          turnState,
          agentType,
          "broadcast",
          `[handoff] ${agentType}→${targetType}：${taskDescription.slice(0, 120)}… A报告摘要：${aReport.slice(0, 200)}`,
          "handoff",
          task.id,
        );
        return {
          ...bResult,
          handoffFrom: agentType,
          handoffTo: targetType,
          upstreamReport: aReport,
        } as Record<string, unknown>;
      }
    }

    if (runInBackground) {
      const startedAt = Date.now();
      const reserved = await this.withTurnLock(turnKey, async () => {
        if (turnState.reports.length + turnState.inFlightCount >= maxInvocations) {
          return false;
        }
        turnState.inFlightCount += 1;
        turnState.backgroundJobs.set(task.id, {
          taskId: task.id,
          agentType,
          agentName: capability.name,
          sessionId: actorId,
          chatUserMessageId: context.chatUserMessageId,
          status: "running",
          startedAt,
          taskDescription,
          priorContext,
          accessMode:
            parseAgentAccessMode(context.agentAccessMode ?? this.currentTurnOrchestrateOpts?.agentAccessMode) ===
            "full"
                ? "full"
                : "sandbox",
          availableActions: [],
        });
        return true;
      });
      if (!reserved) {
        return {
          ok: false,
          agentType,
          agentName: capability.name,
          error: `Sub-agent delegation limit reached for this turn (${maxInvocations}).`,
        };
      }
      this.emitBackgroundJobUpdate({
        taskId: task.id,
        agentType,
        agentName: capability.name,
        status: "running",
        sessionId: actorId,
        chatUserMessageId: context.chatUserMessageId,
        startedAt,
        userFacingText: `${capability.name}已转到后台处理中，完成后我会主动告诉你。`,
      });
      void this.runSubAgentDelegation({
        actorId,
        turnKey,
        turnState,
        task,
        capability,
        agentType,
        fingerprint,
        taskDescription,
        priorContext,
        context,
        maxRetries: rtConfig.masterDelegation.retryEnabled
          ? Math.min(rtConfig.masterDelegation.maxRetryAttempts, 3)
          : 0,
        background: true,
      });
      return {
        ok: true,
        agentType,
        agentName: capability.name,
        taskId: task.id,
        background: true,
        status: "running",
        maxParallelTasks: this.config.maxParallelTasks,
        priorInvocationsInTurn: turnState.reports.length,
        inFlightInTurn: turnState.inFlightCount,
        message: `${capability.name} 已在后台执行；可继续对话或调用 master_poll_sub_agent_tasks 查看进度。`,
      };
    }

    if (requestedBackground && !runInBackground) {
      this.log("Background execution suppressed for non-long-running task", {
        agentType,
        taskDescription: taskDescription.slice(0, 160),
      });
    }

    return await this.runSubAgentDelegation({
      actorId,
      turnKey,
      turnState,
      task,
      capability,
      agentType,
      fingerprint,
      taskDescription,
      priorContext,
      context,
      maxRetries: rtConfig.masterDelegation.retryEnabled
        ? Math.min(rtConfig.masterDelegation.maxRetryAttempts, 3)
        : 0,
      background: false,
    });
  }

  private async runSubAgentDelegation(params: {
    actorId: string;
    turnKey: string;
    turnState: TurnDelegationState;
    task: SubTask;
    capability: SubAgentCapability;
    agentType: SubAgentType;
    fingerprint: string;
    taskDescription: string;
    priorContext: string;
    context: ToolContext;
    maxRetries: number;
    background: boolean;
  }): Promise<Record<string, unknown>> {
    const {
      actorId,
      turnKey,
      turnState,
      task,
      capability,
      agentType,
      fingerprint,
      taskDescription,
      priorContext,
      context,
      maxRetries,
      background,
    } = params;

    if (!background) {
      await this.withTurnLock(turnKey, async () => {
        turnState.inFlightCount += 1;
      });
    }

    const releaseSlot = await this.acquireSubAgentSlot();
    let lastError = "";
    let report: string | null = null;
    // 上次失败的工具调用摘要（重试时传入，避免子 Agent 重复相同错误）
    let priorToolCallSummary: string | undefined = undefined;

    try {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const priorResults = await this.withTurnLock(turnKey, async () => [...turnState.reports]);
        // 每次循环新建 toolCallHistory，由 executeTaskWithTools 内部 push 填充
        const toolCallHistory: ToolExecutedInfo[] = [];
        const invokeCtx: SubAgentInvokeContext = {
          userMessage: this.currentTurnUserMessage?.trim() || taskDescription,
          priorResults,
          priorToolCallSummary,
          toolCallHistory,
          // 透传主 Agent 直接指令到子 Agent
          directive: task.directive,
        };

        if (attempt > 0) {
          const hint = this.buildRetryHint(lastError, attempt, agentType);
          task.description = `${taskDescription}\n\n${hint}${priorContext ? `\n补充背景：${priorContext}` : ""}`;
          this.log(`Retry attempt ${attempt}/${maxRetries} for ${agentType}`, { taskId: task.id });
        }

        const started = Date.now();
        const timeoutMs = this.resolveSubAgentTimeout(agentType);
        try {
          const result = await this.withSubTaskTimeout(
            this.executeTaskWithTools(
              actorId,
              task,
              capability,
              invokeCtx,
              parseAgentAccessMode(context.agentAccessMode ?? this.currentTurnOrchestrateOpts?.agentAccessMode),
            ),
            timeoutMs,
            task.id,
          );
          const executionTime = Date.now() - started;
          report = result;

          // 解析子 Agent 报告的结构化标记，判定真实 success
          // - 若 parseSubAgentReport 返回 null（无 [REPORT] 块），保持向后兼容默认 success=true
          // - 若 [SUCCESS]=false，记为 success=false（子 Agent 自主声明失败，不算异常抛错）
          const parsedReport = parseSubAgentReport(report);
          const actualSuccess = parsedReport ? parsedReport.success : true;
          // 给主 Agent 的报告：若有结构化标记，用 buildSubAgentReportForMaster 重组（更易读）
          const reportForMaster = parsedReport ? buildSubAgentReportForMaster(parsedReport, report) : report;

          const subResult: SubAgentResult = {
            taskId: task.id,
            agentType,
            success: actualSuccess,
            result: reportForMaster,
            executionTime,
          };
          await this.withTurnLock(turnKey, async () => {
            turnState.reports.push(subResult);
            turnState.seenFingerprints.set(fingerprint, subResult);
            // 写入共享消息总线：子 Agent 报告就绪（广播，主 Agent 监督 + 其他子 Agent 感知）
            this.sendInterAgentMessage(
              turnState,
              agentType,
              "broadcast",
              `[report] ${agentType}：任务完成（${actualSuccess ? "成功" : "失败"}，${executionTime}ms）。摘要：${(reportForMaster ?? "").trim().slice(0, 200)}`,
              "notice",
              task.id,
            );
            const job = turnState.backgroundJobs.get(task.id);
            if (job) {
              job.status = "awaiting_confirmation";
              job.completedAt = Date.now();
              job.report = reportForMaster;
              job.availableActions = this.computeAvailableActions(job);
              this.emitBackgroundJobUpdate({
                taskId: job.taskId,
                agentType: job.agentType,
                agentName: job.agentName,
                status: job.status,
                sessionId: actorId,
                chatUserMessageId: context.chatUserMessageId,
                startedAt: job.startedAt,
                completedAt: job.completedAt,
                availableActions: job.availableActions,
                report: job.report,
                userFacingText: `${job.agentName}后台任务已完成：${(reportForMaster ?? "").trim().slice(0, 180) || "结果已就绪"}`,
              });
            }
          });
          this.metrics.sequentialExecutions += 1;
          this.recordSubAgentMetrics(agentType, true, executionTime, false);

          const uiDoneLine =
            parsedReport?.userVisibleLine ??
            pickSubAgentDoneLine(report) ??
            `${capability.name}已交差，正在汇总结果…`;
          return {
            ok: true,
            agentType,
            agentName: capability.name,
            taskId: task.id,
            report: reportForMaster,
            // 透传结构化解析结果，便于主 Agent 做后续决策
            ...(parsedReport ? {
              success: parsedReport.success,
              conclusion: parsedReport.conclusion,
              confidence: parsedReport.confidence,
              evidence: parsedReport.evidence,
              missing: parsedReport.missing,
            } : {}),
            ...(attempt > 0 ? { retryAttempt: attempt } : {}),
            priorInvocationsInTurn: turnState.reports.length,
            uiDoneLine,
            message: `${capability.name} completed${attempt > 0 ? ` (retry #${attempt})` : ""}; read the report field.`,
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          const executionTime = Date.now() - started;
          lastError = msg;
          const timedOut = msg.includes("timed out");
          this.recordSubAgentMetrics(agentType, false, executionTime, timedOut);

          // 失败时把 toolCallHistory 序列化为摘要，供下次重试传入 priorToolCallSummary
          if (toolCallHistory.length > 0) {
            priorToolCallSummary = this.summarizeToolCallHistory(toolCallHistory);
          }

          if (attempt < maxRetries) {
            this.log(`Sub-agent ${agentType} failed, will retry (${attempt + 1}/${maxRetries})`, { error: msg });
            continue;
          }

          const failResult: SubAgentResult = {
            taskId: task.id,
            agentType,
            success: false,
            result: msg,
            executionTime,
          };
          await this.withTurnLock(turnKey, async () => {
            turnState.reports.push(failResult);
            turnState.seenFingerprints.set(fingerprint, failResult);
            // 写入共享消息总线：子 Agent 失败（广播，主 Agent 监督 + 其他子 Agent 感知）
            this.sendInterAgentMessage(
              turnState,
              agentType,
              "broadcast",
              `[report] ${agentType}：任务失败（${executionTime}ms）。错误：${msg.slice(0, 200)}`,
              "notice",
              task.id,
            );
            const job = turnState.backgroundJobs.get(task.id);
            if (job) {
              job.status = "failed";
              job.completedAt = Date.now();
              job.error = msg;
              job.availableActions = this.computeAvailableActions(job);
              this.emitBackgroundJobUpdate({
                taskId: job.taskId,
                agentType: job.agentType,
                agentName: job.agentName,
                status: job.status,
                sessionId: actorId,
                chatUserMessageId: context.chatUserMessageId,
                startedAt: job.startedAt,
                completedAt: job.completedAt,
                availableActions: job.availableActions,
                error: msg,
                userFacingText: `${job.agentName}后台任务失败：${msg.slice(0, 180)}`,
              });
            }
          });
          return {
            ok: false,
            agentType,
            agentName: capability.name,
            error: msg,
            retriesExhausted: maxRetries > 0,
            retryAttempts: attempt,
            priorInvocationsInTurn: turnState.reports.length,
          };
        }
      }
      return { ok: false, agentType, agentName: capability.name, error: "Unexpected exit from retry loop." };
    } finally {
      releaseSlot();
      await this.withTurnLock(turnKey, async () => {
        turnState.inFlightCount = Math.max(0, turnState.inFlightCount - 1);
      });
    }
  }

  /** 序列化工具调用历史为人类可读摘要，供失败重试时传入 priorToolCallSummary */
  private summarizeToolCallHistory(history: ToolExecutedInfo[]): string {
    if (history.length === 0) return "(无工具调用记录)";
    return history
      .map((h, i) => {
        const argsStr = JSON.stringify(h.input).slice(0, 120);
        const resultStr = JSON.stringify(h.result).slice(0, 200);
        return `${i + 1}. ${h.toolName}(${argsStr}) → ${h.ok ? "成功" : "失败"}: ${resultStr}`;
      })
      .join("\n");
  }

  /** HTTP / 客户端：查询子 Agent 后台任务与本轮报告（可按 messageId 或聚合会话内全部回合）。 */
  getSubAgentTasksSnapshot(actorId: string, chatUserMessageId?: string): Record<string, unknown> {
    if (chatUserMessageId?.trim()) {
      return this.buildSubAgentTasksPollPayload(actorId, chatUserMessageId.trim());
    }
    return this.buildSubAgentTasksPollPayloadAggregated(actorId);
  }

  private buildSubAgentTasksPollPayload(actorId: string, chatUserMessageId: string): Record<string, unknown> {
    const turnState = this.getTurnDelegationState(actorId, chatUserMessageId);
    return this.formatSubAgentTasksPoll(turnState);
  }

  private buildSubAgentTasksPollPayloadAggregated(actorId: string): Record<string, unknown> {
    const prefix = `${actorId}:`;
    const merged: TurnDelegationState = this.emptyTurnDelegationState();
    for (const [key, state] of this.turnDelegationStates) {
      if (!key.startsWith(prefix)) continue;
      merged.reports.push(...state.reports);
      merged.inFlightCount += state.inFlightCount;
      merged.interAgentMessages.push(...state.interAgentMessages);
      for (const [fp, result] of state.seenFingerprints) {
        merged.seenFingerprints.set(fp, result);
      }
      for (const job of state.backgroundJobs.values()) {
        merged.backgroundJobs.set(job.taskId, job);
      }
    }
    return this.formatSubAgentTasksPoll(merged);
  }

  private formatSubAgentTasksPoll(turnState: TurnDelegationState): Record<string, unknown> {
    const running = [...turnState.backgroundJobs.values()].filter((j) => j.status === "running");
    const awaitingConfirmation = [...turnState.backgroundJobs.values()].filter(
      (j) => j.status === "awaiting_confirmation" || j.status === "failed",
    );
    const completed = [...turnState.backgroundJobs.values()].filter((j) => j.status === "completed");
    return {
      ok: true,
      maxParallelTasks: this.config.maxParallelTasks,
      activeSubAgentSlots: this.activeSubAgentSlots,
      inFlightInTurn: turnState.inFlightCount,
      completedReportsInTurn: turnState.reports.length,
      running,
      awaitingConfirmation,
      backgroundCompleted: completed,
      reports: turnState.reports.map((r) => ({
        taskId: r.taskId,
        agentType: r.agentType,
        success: r.success,
        executionTime: r.executionTime,
        reportPreview: r.result.slice(0, 500),
      })),
      // 共享消息总线：主 Agent 监督视角，看到本轮所有 Agent 间协作
      // （主→子 directive、子→子 ask_peer/handoff、子→主 report notice）
      sharedMessages: this.getInterAgentMessagesForMaster(turnState).map((m) => ({
        id: m.id,
        from: m.fromAgent,
        to: m.toAgent,
        kind: m.kind ?? "notice",
        content: m.content,
        timestamp: m.timestamp,
        relatedTaskId: m.relatedTaskId,
      })),
      hint:
        running.length > 0
          ? "仍有后台子任务执行中，可稍后再 poll 或继续与用户对话。"
          : awaitingConfirmation.length > 0
              ? "存在待确认的后台结果，可确认归档、继续处理或重试。"
              : "无运行中后台任务；可基于 reports 合成回复。",
    };
  }

  async handlePollSubAgentTasksTool(context: ToolContext): Promise<Record<string, unknown>> {
    const actorId = resolveActorId(context);
    return this.getSubAgentTasksSnapshot(actorId, context.chatUserMessageId);
  }

  async handleBackgroundTaskAction(
    actorId: string,
    taskId: string,
    action: "confirm" | "retry" | "continue_processing",
  ): Promise<Record<string, unknown>> {
    const found = this.findBackgroundJob(actorId, taskId);
    if (!found) {
      return { ok: false, error: "Background task not found." };
    }
    const { job } = found;
    if (action === "confirm") {
      job.status = "completed";
      job.availableActions = [];
      this.emitBackgroundJobUpdate({
        taskId: job.taskId,
        agentType: job.agentType,
        agentName: job.agentName,
        status: job.status,
        sessionId: job.sessionId,
        chatUserMessageId: job.chatUserMessageId,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        availableActions: job.availableActions,
        report: job.report,
        error: job.error,
        userFacingText: `${job.agentName}结果已确认归档。`,
      });
      return { ok: true, taskId: job.taskId, status: job.status };
    }

    const capability = this.subAgentCapabilities.get(job.agentType);
    if (!capability) {
      return { ok: false, error: `Unknown sub-agent type: ${job.agentType}` };
    }
    const baseTaskDescription = job.taskDescription?.trim() || job.report?.trim() || job.error?.trim();
    if (!baseTaskDescription) {
      return { ok: false, error: "No source context available to resume this task." };
    }
    const nextTaskDescription =
      action === "retry"
        ? baseTaskDescription
        : `${baseTaskDescription}\n\nContinue processing from the previous result and push the work forward.`;
    const nextPriorContext = [
      job.priorContext?.trim(),
      job.report ? `Previous report:\n${job.report}` : "",
      job.error ? `Previous error:\n${job.error}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const context: ToolContext = {
      sessionId: actorId,
      userId: actorId,
      chatUserMessageId: job.chatUserMessageId,
      agentAccessMode: "full",
    };
    job.status = "completed";
    job.availableActions = [];
    return this.handleInvokeSubAgentTool(
      {
        agentType: job.agentType,
        taskDescription: nextTaskDescription,
        priorContext: nextPriorContext,
        runInBackground: true,
        userStatusLine:
          action === "retry"
            ? `正在重试 ${job.agentName}`
            : `正在继续处理 ${job.agentName} 的后台任务`,
      },
      context,
    );
  }

  async handleListSubAgentsTool(_context: ToolContext): Promise<Record<string, unknown>> {
    const agents = [...this.subAgentCapabilities.values()].map((c) => ({
      type: c.type,
      name: c.name,
      description: c.description,
      keywords: c.keywords,
      capabilities: c.capabilities,
      toolCount: c.tools.length,
    }));
    return {
      ok: true,
      agents,
      maxParallelTasks: this.config.maxParallelTasks,
      hint:
        "独立子任务可在同一轮并行委派（受 MAX_PARALLEL_SUB_AGENTS 限制）；耗时任务可设 runInBackground=true，再用 master_poll_sub_agent_tasks 查看进度。",
    };
  }

  async orchestrateTask(
    actorId: string,
    userMessage: string,
    onAgentStatusLine?: (line: string) => void,
    onAssistantDelta?: (delta: string) => void,
    opts?: OrchestrateTaskOptions,
  ): Promise<string> {
    const started = Date.now();
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    this.metrics.totalTasks += 1;

    const userLocation =
      opts?.userLocation ??
      (await resolveUserLocationPrompt({
        clientIp: opts?.clientIp,
        clientLocation: opts?.clientLocation,
      }));
    const enrichedOpts: OrchestrateTaskOptions = {
      ...opts,
      userLocation,
      onAgentStatusLine: opts?.onAgentStatusLine ?? onAgentStatusLine,
    };

    this.currentTurnUserMessage = userMessage;
    this.currentTurnOrchestrateOpts = enrichedOpts;
    this.resetTurnReports(actorId, enrichedOpts.chatUserMessageId);

    let assistantResult = "";
    try {
      const route = routeLlmExecution(userMessage);
      this.log("Route selected", { taskId, mode: route.mode, reasons: route.reasons });

      // 只要启用子 Agent，主 Agent 每轮都注入「有小弟、可并行委派」说明 + 委派工具（不限于 master_delegate 路由）
      const useDelegatePrompt = this.config.enableSubAgents;

      assistantResult = await this.executeMasterTurn(
        actorId,
        userMessage,
        onAssistantDelta,
        enrichedOpts,
        useDelegatePrompt,
      );
      return assistantResult;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.log("Orchestration failed, evaluating fallback", { taskId, error: errMsg });
      console.error("[MasterAgentCoordinator] delegate path failed:", error);

      this.executionHistory.push({
        timestamp: new Date().toISOString(),
        taskId,
        duration: Date.now() - started,
        success: false,
        strategy: "fallback",
        subTaskCount: 0,
      });
      this.metrics.successRate = this.calculateSuccessRate();

      if (this.config.allowFallback) {
        this.metrics.fallbackCount += 1;
        assistantResult = await this.executeMasterTurn(
          actorId,
          userMessage,
          onAssistantDelta,
          enrichedOpts,
          false,
        );
        return assistantResult;
      }
      throw error;
    } finally {
      this.currentTurnUserMessage = null;
      this.currentTurnOrchestrateOpts = null;
      if (this.executionHistory.length > 100) this.executionHistory.shift();
    }
  }

  private streamAccessFromOpts(opts?: OrchestrateTaskOptions): {
    agentAccessMode: ReturnType<typeof parseAgentAccessMode>;
    desktopBridgeOnline: boolean;
    phoneBridgeOnline: boolean;
  } {
    return {
      agentAccessMode: parseAgentAccessMode(opts?.agentAccessMode),
      desktopBridgeOnline: opts?.desktopBridgeOnline === true,
      phoneBridgeOnline: opts?.phoneBridgeOnline === true,
    };
  }

  private buildToolContext(actorId: string, opts?: OrchestrateTaskOptions): ChatToolExecutionContext {
    const access = this.streamAccessFromOpts(opts);
    return {
      executeTool: (name, args) =>
        this.toolRegistry.execute(name, args, {
          sessionId: actorId,
          userId: opts?.userId,
          chatUserMessageId: opts?.chatUserMessageId,
          clientIp: opts?.clientIp,
          clientLocation: opts?.clientLocation,
          agentAccessMode: access.agentAccessMode,
          desktopBridgeOnline: access.desktopBridgeOnline,
          phoneBridgeOnline: access.phoneBridgeOnline,
        }),
      onToolExecuteStart: opts?.onToolExecuteStart,
      onToolExecuted: opts?.onToolExecuted,
      onAgentStatusLine: opts?.onAgentStatusLine,
    };
  }

  private buildPromptInput(actorId: string, opts?: OrchestrateTaskOptions) {
    return {
      actorId,
      sessionId: opts?.sessionId,
      userText: this.currentTurnUserMessage ?? undefined,
      narrativeRecall: opts?.narrativeRecall,
      personalization: opts?.personalization,
      interruptedContext: opts?.interruptedContext,
      userLocation: opts?.userLocation,
      onToolLoopAfterBatch: opts?.onToolLoopAfterBatch,
    };
  }

  private buildUserTurn(userMessage: string, opts?: OrchestrateTaskOptions): ChatUserTurn {
    return {
      text: userMessage,
      ...(opts?.visionFrames?.length ? { visionFrames: opts.visionFrames } : {}),
    };
  }

  private listSubAgentCapabilities(): SubAgentCapability[] {
    return [...this.subAgentCapabilities.values()];
  }

  private buildMasterStreamOptions(
    actorId: string,
    opts?: OrchestrateTaskOptions,
    delegatePrompt = false,
  ): AgentStreamOptions {
    const access = this.streamAccessFromOpts(opts);
    const perf: AgentStreamOptions = {
      ...access,
      disableThinking: true,
      toolRankingHint: opts?.toolRankingHint,
    };
    const capabilities = this.listSubAgentCapabilities();

    if (this.promptContextBuilder) {
      if (delegatePrompt) {
        return {
          ...this.promptContextBuilder.buildForMasterDelegate({
            ...this.buildPromptInput(actorId, opts),
            subAgentCapabilities: capabilities,
          }),
          ...perf,
          toolExposureProfile: "delegate",
        };
      }
      const base = this.promptContextBuilder.build(this.buildPromptInput(actorId, opts));
      const chatToolsExtra: ChatCompletionTool[] = base?.chatToolsExtra?.length
        ? [...base.chatToolsExtra]
        : [];
      return {
        ...(base ?? {}),
        chatToolsBuiltin: buildMasterAgentChatTools(capabilities, chatToolsExtra),
        chatToolsExtra: [],
        ...perf,
        toolExposureProfile: "contextual",
      };
    }

    return {
      ...(delegatePrompt ? { masterSubAgentDelegate: true } : {}),
      chatToolsBuiltin: buildMasterAgentChatTools(capabilities),
      ...perf,
      toolExposureProfile: delegatePrompt ? "delegate" : "contextual",
    };
  }

  private async executeMasterTurn(
    actorId: string,
    userMessage: string,
    onAssistantDelta?: (delta: string) => void,
    opts?: OrchestrateTaskOptions,
    delegatePrompt = false,
  ): Promise<string> {
    const sessionId = masterChatSessionId(actorId);
    let fullText = "";
    await this.masterProvider.streamCompletion(
      sessionId,
      this.buildUserTurn(userMessage, opts),
      (delta) => {
        fullText += delta;
        onAssistantDelta?.(delta);
      },
      this.buildToolContext(actorId, opts),
      this.buildMasterStreamOptions(actorId, opts, delegatePrompt),
    );
    const subTaskCount = delegatePrompt
      ? this.getTurnDelegationState(actorId, opts?.chatUserMessageId).reports.length
      : 0;
    this.recordSuccess(delegatePrompt ? "master-delegate-tools" : "master-only", subTaskCount);
    return fullText;
  }

  /**
   * 处理子 Agent 运行中的 `subagent.ask_peer` 调用：向另一类型子 Agent 发起同步咨询。
   *
   * 轻量路径：不经过 `runSubAgentDelegation`（无重试/后台/fingerprint），直接调
   * `executeTaskWithTools` 且 `allowAskPeer=false` 防嵌套。
   * peer 完成后返回 report 作为工具结果，主调子 Agent 基于它继续执行。
   */
  private async handleAskPeer(
    input: Record<string, unknown>,
    currentAgentType: SubAgentType,
    actorId: string,
  ): Promise<{ ok: boolean; result: Record<string, unknown> }> {
    const peerType = parseSubAgentType(input.peerType, this.capabilityRegistry.types());
    const question = String(input.question ?? "").trim();
    if (!question) {
      return { ok: false, result: { error: "question 不能为空" } };
    }
    if (!peerType) {
      return { ok: false, result: { error: `无效的 peer 类型: ${String(input.peerType)}` } };
    }
    if (peerType === currentAgentType) {
      return { ok: false, result: { error: `不能向自己（${currentAgentType}）咨询，请换一个类型` } };
    }
    const peerCapability = this.subAgentCapabilities.get(peerType);
    if (!peerCapability) {
      return { ok: false, result: { error: `${peerType} 子 Agent 未注册` } };
    }

    const peerTask: SubTask = {
      id: `ask-peer-${randomUUID()}`,
      description: question,
      assignedAgent: peerType,
      priority: 5,
      dependencies: [],
      estimatedComplexity: "low",
      directive: `你是 ${peerType} Agent，正在响应 ${currentAgentType} Agent 的同步咨询。直接回答问题，不可再调 subagent.ask_peer（不可嵌套）。`,
    };

    this.log(`ask_peer: ${currentAgentType} → ${peerType}`, { question: question.slice(0, 120) });
    console.log(`[SubAgent] ask_peer ${currentAgentType}→${peerType}: ${question.slice(0, 80)}`);

    // 写入共享消息总线：记录咨询发起（广播，主 Agent 监督 + 其他子 Agent 感知）
    const turnState = this.currentTurnUserMessage
      ? this.getTurnDelegationState(actorId, this.currentTurnOrchestrateOpts?.chatUserMessageId)
      : null;
    if (turnState) {
      this.sendInterAgentMessage(
        turnState,
        currentAgentType,
        "broadcast",
        `[ask_peer] ${currentAgentType}→${peerType}：${question.slice(0, 200)}`,
        "ask_peer",
        peerTask.id,
      );
    }

    try {
      const accessMode = parseAgentAccessMode(
        this.currentTurnOrchestrateOpts?.agentAccessMode,
      );
      const report = await this.executeTaskWithTools(
        actorId,
        peerTask,
        peerCapability,
        { userMessage: question, priorResults: [] },
        accessMode,
        false, // allowAskPeer=false：防嵌套
      );
      // 写入共享消息总线：记录 peer 回复（广播，让主 Agent 看到完整协作链）
      if (turnState) {
        this.sendInterAgentMessage(
          turnState,
          peerType,
          "broadcast",
          `[ask_peer reply] ${peerType}→${currentAgentType}：${report.trim().slice(0, 300)}`,
          "ask_peer",
          peerTask.id,
        );
      }
      return {
        ok: true,
        result: {
          peerType,
          question,
          report: report.trim(),
          message: `${peerCapability.name}（${peerType}）已回复咨询`,
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log(`ask_peer 失败: ${currentAgentType}→${peerType}`, { error: msg });
      return { ok: false, result: { error: `ask_peer 执行失败: ${msg}` } };
    }
  }

  private async executeTaskWithTools(
    actorId: string,
    task: SubTask,
    capability: SubAgentCapability,
    invokeCtx?: SubAgentInvokeContext,
    agentAccessMode?: AgentAccessMode,
    /** 是否允许当前子 Agent 调用 subagent.ask_peer（peer 咨询时设为 false 防嵌套） */
    allowAskPeer = true,
  ): Promise<string> {
    const accessMode = parseAgentAccessMode(agentAccessMode);
    const bridgeCtx = {
      desktopBridgeOnline: this.currentTurnOrchestrateOpts?.desktopBridgeOnline === true,
      phoneBridgeOnline: this.currentTurnOrchestrateOpts?.phoneBridgeOnline === true,
    };

    // 子 Agent 专属 system prompt（身份/推理框架/工具最佳实践/失败处理/报告格式）
    // 优先用 registry 中注册的 builder；回退到内置 life prompt
    const systemPromptOverride =
      this.capabilityRegistry.getSystemPrompt(capability.type) ??
      this.capabilityRegistry.getSystemPrompt("life") ??
      undefined;
    // 子 Agent 专属模型：优先 registry.modelConfig，否则 registry 内部回退到环境变量
    const modelConfig = this.capabilityRegistry.getModelConfig(capability.type);
    // 子 Agent 专属工具循环轮次（覆盖 analyzeTaskComplexity 动态推断）
    const maxRounds = this.capabilityRegistry.getMaxRounds(capability.type);

    const baseStreamOpts: AgentStreamOptions = {
      ...(this.promptContextBuilder?.buildForSubAgent({
        ...this.buildPromptInput(actorId, this.currentTurnOrchestrateOpts ?? undefined),
        capability,
        taskDescription: task.description,
      }) ?? {}),
      agentAccessMode: accessMode,
      desktopBridgeOnline: bridgeCtx.desktopBridgeOnline,
      phoneBridgeOnline: bridgeCtx.phoneBridgeOnline,
      disableThinking: true,
      toolExposureProfile: "scoped",
      toolRankingHint: this.currentTurnOrchestrateOpts?.toolRankingHint,
      // 子 Agent 智能化关键注入：
      systemPromptOverride,
      toolLoop: { maxRounds },
      ...(modelConfig.modelOverride ? { modelOverride: modelConfig.modelOverride } : {}),
      // sessionId 复用：限制 thread 长度避免无限累积
      // 收敛到 4（最小化 token 消耗），配合 sessionId 复用仍能跨轮保留关键上下文
      maxThreadMessages: 4,
    };

    // peer 咨询时从工具列表移除 ask_peer，防止 peer 误调（allowAskPeer=false 时）
    if (!allowAskPeer && baseStreamOpts.chatToolsBuiltin?.length) {
      baseStreamOpts.chatToolsBuiltin = baseStreamOpts.chatToolsBuiltin.filter(
        (t) => t.type !== "function" || t.function?.name !== SUBAGENT_ASK_PEER_REGISTRY,
      );
    }

    const allowedList =
      (baseStreamOpts.chatToolsBuiltin ?? [])
        .map((t) => (t.type === "function" ? t.function?.name : ""))
        .filter(Boolean)
        .join(", ") || "(none)";
    const priorBlock = invokeCtx?.priorResults.length
      ? `\n\nPrior sub-agent reports for reference; do not repeat work:\n${this.formatSubAgentReportsForMaster(invokeCtx.priorResults)}`
      : "";
    // 用户原始需求降级为参考上下文（主 Agent 已基于它拆解出指令，子 Agent 无需重新解读）
    const userGoalRef = invokeCtx?.userMessage ? `\n\n【用户原始需求（参考）】\n${invokeCtx.userMessage}` : "";
    // 上次失败的工具调用摘要（重试时传入，避免子 Agent 重复相同错误）
    const priorToolCallBlock = invokeCtx?.priorToolCallSummary
      ? `\n\n[上次失败的工具调用记录]\n${invokeCtx.priorToolCallSummary}\n请避免重复相同的调用，必须改变策略（换 query/换工具/换参数）。`
      : "";

    const turnState = this.currentTurnUserMessage
      ? this.getTurnDelegationState(actorId, this.currentTurnOrchestrateOpts?.chatUserMessageId)
      : null;
    const agentMessages = turnState
      ? this.getInterAgentMessagesForAgent(turnState, capability.type)
      : [];
    const interAgentBlock = this.formatInterAgentMessagesForPrompt(agentMessages);

    // 主 Agent 直接通信：把任务目标和执行策略作为直接指令传给子 Agent（而非塞进通用 prompt 字段）
    // - description = 做什么（任务目标）
    // - directive  = 怎么做（执行策略/约束，主 Agent 显式告诉子 Agent 该怎么做）
    const directiveBlock = task.directive
      ? `\n\n【主 Agent 指令】\n任务：${task.description}\n执行策略：${task.directive}`
      : `\n\n【主 Agent 指令】\n${task.description}`;

    // 简化 user message：身份说明和报告格式已移入 system prompt，避免重复
    const prompt = [
      directiveBlock,
      userGoalRef,
      priorBlock,
      priorToolCallBlock,
      interAgentBlock,
      buildAgentAccessModePromptLine(accessMode, bridgeCtx),
      `Available tools:\n${allowedList}`,
      `The final line must be: ${USER_VISIBLE_PROGRESS_MARKER} followed by one short user-visible completion line.`,
    ]
      .filter(Boolean)
      .join("\n\n");

    // sessionId 复用：跨轮保留子 Agent 上下文（subagent-${actorId}-${agentType}）
    // 同一 actorId + 同一 agentType 的委派共享会话历史，避免冷启动
    const sessionId = `subagent-${actorId}-${capability.type}`;
    let fullText = "";
    const subAgentToolCtx = this.buildToolContext(actorId, this.currentTurnOrchestrateOpts ?? undefined);
    // 子 Agent 内部的 search_web 等工具不应覆盖主会话的委派进度 UI
    subAgentToolCtx.onToolExecuteStart = undefined;
    // 收集工具调用历史，用于失败重试时序列化为摘要传入下次
    const toolCallHistory = invokeCtx?.toolCallHistory ?? [];
    subAgentToolCtx.onToolExecuted = (info) => {
      toolCallHistory.push(info);
    };
    // 拦截 subagent.ask_peer：子 Agent 运行中向其他类型子 Agent 发起同步咨询
    // peer 咨询执行时 allowAskPeer=false，防嵌套（peer 不可再 ask_peer）
    if (allowAskPeer) {
      const originalExecuteTool = subAgentToolCtx.executeTool;
      subAgentToolCtx.executeTool = async (name: string, args: Record<string, unknown>) => {
        if (name === SUBAGENT_ASK_PEER_REGISTRY) {
          return this.handleAskPeer(args, capability.type, actorId);
        }
        return originalExecuteTool(name, args);
      };
    }
    // 调试日志：子 Agent 执行前
    console.log(
      `[SubAgent] ${capability.type} 开始执行: sessionId=${sessionId}, maxRounds=${maxRounds}, ` +
        `systemPromptLen=${systemPromptOverride?.length ?? 0}, promptLen=${prompt.length}, ` +
        `modelOverride=${modelConfig.modelOverride ?? "default"}, tools=${allowedList.split(", ").length}`,
    );
    let streamReturnText = "";
    try {
      streamReturnText = await this.masterProvider.streamCompletion(
        sessionId,
        { text: prompt },
        (delta) => {
          fullText += delta;
        },
        subAgentToolCtx,
        baseStreamOpts,
      );
    } catch (err) {
      console.log(
        `[SubAgent] ${capability.type} streamCompletion 异常: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
    // streamCompletion 返回值是最终完整文本（含工具循环后的最终回复），
    // fullText（delta 累加）在工具循环期间可能为空（LLM 只返回 tool_calls 没有文本 delta）
    let finalReport = (streamReturnText || fullText).trim();

    // 如果工具循环结束后没有输出结构化报告（[REPORT] 块），
    // 说明 maxRounds 用完时 LLM 还在调工具，streamCompletion 返回的是工具输出兜底。
    // 此时加一次"总结" LLM 调用，让 LLM 基于工具调用历史生成结构化报告。
    if (finalReport && !finalReport.includes("[REPORT]") && toolCallHistory.length > 0) {
      console.log(
        `[SubAgent] ${capability.type} 工具循环结束但无结构化报告，触发总结调用: toolCalls=${toolCallHistory.length}`,
      );
      const toolSummary = toolCallHistory
        .slice(-8) // 只取最后 8 次工具调用，避免历史过长
        .map((h, i) => {
          const argsStr = JSON.stringify(h.input).slice(0, 100);
          const resultStr = JSON.stringify(h.result).slice(0, 200);
          return `${i + 1}. ${h.toolName}(${argsStr}) → ${h.ok ? "成功" : "失败"}: ${resultStr}`;
        })
        .join("\n");
      const summaryPrompt =
        `你刚才作为 ${capability.name} 执行了多个工具调用，但未输出最终报告。` +
        `请基于以下工具调用历史，按报告格式输出最终结构化报告。\n\n` +
        `子任务：${task.description}\n\n` +
        `工具调用历史：\n${toolSummary}\n\n` +
        `请输出 [REPORT] 块（含 [SUCCESS][CONCLUSION][EVIDENCE][CONFIDENCE][MISSING]）和 [DONE] 行。`;
      try {
        let summaryText = "";
        await this.masterProvider.streamCompletion(
          `${sessionId}:summary`,
          { text: summaryPrompt },
          (delta) => { summaryText += delta; },
          undefined,
          { ephemeralTurn: true, disableThinking: true, maxThreadMessages: 0, systemPromptOverride },
        );
        if (summaryText.trim()) {
          finalReport = summaryText.trim();
        }
      } catch (summaryErr) {
        console.log(
          `[SubAgent] ${capability.type} 总结调用失败: ${summaryErr instanceof Error ? summaryErr.message : String(summaryErr)}`,
        );
      }
    }

    // 调试日志：子 Agent 执行后
    console.log(
      `[SubAgent] ${capability.type} 执行完成: fullTextLen=${fullText.length}, streamReturnLen=${streamReturnText.length}, ` +
        `toolCalls=${toolCallHistory.length}, reportPreview=${finalReport.slice(0, 200)}`,
    );
    return finalReport;
  }

  private resolveSubAgentTimeout(agentType: SubAgentType): number {
    // 专用超时直接覆盖默认超时——info 可能比默认更短（快速收敛），tech 可能更长（深度 RPA）
    if (agentType === "tech") return this.config.techSubtaskTimeoutMs;
    if (agentType === "info") return this.config.infoSubtaskTimeoutMs;
    return this.config.taskTimeoutMs;
  }

  private emptySubAgentMetrics(): SubAgentPerformanceMetrics {
    return { invocations: 0, failures: 0, timeouts: 0, avgExecutionTime: 0 };
  }

  private recordSubAgentMetrics(
    agentType: SubAgentType,
    success: boolean,
    executionTime: number,
    timedOut: boolean,
  ): void {
    const prev = this.subAgentMetrics.get(agentType) ?? this.emptySubAgentMetrics();
    const invocations = prev.invocations + 1;
    const failures = prev.failures + (success ? 0 : 1);
    const timeouts = prev.timeouts + (timedOut ? 1 : 0);
    const avgExecutionTime = Math.round(
      (prev.avgExecutionTime * prev.invocations + executionTime) / invocations,
    );
    this.subAgentMetrics.set(agentType, {
      invocations,
      failures,
      timeouts,
      avgExecutionTime,
      lastExecutionTime: executionTime,
    });
  }

  private withSubTaskTimeout<T>(promise: Promise<T>, timeoutMs: number, taskId: string): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Sub-task ${taskId} timed out after ${timeoutMs}ms`)), timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private formatSubAgentReportsForMaster(results: SubAgentResult[]): string {
    return results
      .map(
        (r) =>
          `[report taskId=${r.taskId} agent=${r.agentType} success=${r.success}${r.executionTime != null ? ` ms=${r.executionTime}` : ""}]\n${r.result}`,
      )
      .join("\n\n---\n\n");
  }

  private recordSuccess(strategy: string, subTaskCount: number): void {
    this.executionHistory.push({
      timestamp: new Date().toISOString(),
      taskId: `turn-${Date.now()}`,
      duration: 0,
      success: true,
      strategy,
      subTaskCount,
    });
    this.metrics.successRate = this.calculateSuccessRate();
  }

  private log(message: string, data?: unknown): void {
    if (this.config.verbose) {
      console.log(`[MasterAgent] [${new Date().toISOString()}] ${message}`, data ? JSON.stringify(data) : "");
    }
  }

  private calculateSuccessRate(): number {
    if (this.executionHistory.length === 0) return 100;
    const recentHistory = this.executionHistory.slice(-50);
    const successCount = recentHistory.filter((h) => h.success).length;
    return Math.round((successCount / recentHistory.length) * 100);
  }

  public getMetricsSnapshot(): PerformanceMetrics {
    this.metrics.successRate = this.calculateSuccessRate();
    return { ...this.metrics };
  }

  public getExecutionHistory(limit = 10): Array<unknown> {
    return this.executionHistory.slice(-limit).reverse();
  }

  public getMaxParallelTasks(): number {
    return this.config.maxParallelTasks;
  }

  public adjustConcurrency(newMaxParallel: number): void {
    const rtConfig = getAgentRuntimeConfig();
    const maxAllowed = rtConfig.masterDelegation.maxParallelSubAgents;
    this.config.maxParallelTasks = Math.min(Math.max(1, newMaxParallel), maxAllowed);
    this.log("Concurrency adjusted", { maxParallelTasks: this.config.maxParallelTasks, maxAllowed });
  }

  public getSubAgentMetricsSnapshot(): Record<SubAgentType, SubAgentPerformanceMetrics> {
    // 从 registry 动态获取已注册类型（支持外部注册的自定义子 Agent）
    const types = this.capabilityRegistry.types();
    const out = {} as Record<SubAgentType, SubAgentPerformanceMetrics>;
    for (const t of types) {
      out[t] = this.subAgentMetrics.get(t) ?? this.emptySubAgentMetrics();
    }
    return out;
  }

  public getOptimizationSuggestions(): string[] {
    const suggestions: string[] = [];
    const metrics = this.getMetricsSnapshot();
    if (metrics.successRate < 80) {
      suggestions.push("成功率较低，建议检查子 Agent 工具权限、超时和失败报告。");
    }
    if (metrics.fallbackCount > metrics.totalTasks * 0.2) {
      suggestions.push("降级频率较高，建议检查主 Agent 委派工具链路。");
    }

    const subMetrics = this.getSubAgentMetricsSnapshot();
    for (const [type, sm] of Object.entries(subMetrics) as [SubAgentType, SubAgentPerformanceMetrics][]) {
      if (sm.invocations === 0) continue;
      const failRate = sm.failures / sm.invocations;
      if (failRate > 0.25) {
        suggestions.push(`${type} 子 Agent 失败率 ${Math.round(failRate * 100)}%，建议优化 taskDescription 或工具白名单。`);
      }
      if (type === "tech" && sm.timeouts > 0 && sm.timeouts / sm.invocations > 0.15) {
        suggestions.push(
          `tech 子 Agent 超时 ${sm.timeouts}/${sm.invocations} 次，可提高 TECH_SUBTASK_TIMEOUT_MS（当前 ${this.config.techSubtaskTimeoutMs}ms）。`,
        );
      }
      if (type === "life" && sm.avgExecutionTime > 45_000) {
        suggestions.push("life 子 Agent 平均耗时偏高，确认主 Agent 在 taskDescription 中写明消费类别以减少工具扫描。");
      }
      if (type === "info" && sm.avgExecutionTime > 30_000) {
        suggestions.push("info 子 Agent 平均耗时偏高，建议主 Agent 委派时缩小检索范围。");
      }
    }

    return suggestions;
  }
}
