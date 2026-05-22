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
import { routeLlmExecution } from "../agent/task-router.js";
import {
  pickSubAgentDoneLine,
  USER_VISIBLE_PROGRESS_MARKER,
} from "../agent/delegate-status.js";
import { parseSubAgentType } from "../agent/master-subagent-delegate-tools.js";
import { resolveUserLocationPrompt } from "./user-location-service.js";
import type {
  SubAgentCapability,
  SubAgentResult,
  SubAgentType,
  SubTask,
} from "./master-agent-types.js";
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

export type { SubAgentCapability, SubAgentResult, SubAgentType, SubTask } from "./master-agent-types.js";

type SubAgentInvokeContext = {
  userMessage: string;
  priorResults: SubAgentResult[];
};

type TurnDelegationState = {
  reports: SubAgentResult[];
  seenFingerprints: Map<string, SubAgentResult>;
};

export type OrchestrateTaskOptions = {
  chatUserMessageId?: string;
  userId?: string;
  clientIp?: string;
  clientLocation?: import("../types/client-location.js").ClientLocationWire;
  userLocation?: string;
  visionFrames?: VisionFrame[];
  interruptedContext?: string;
  narrativeRecall?: string;
  onToolExecuteStart?: (info: ToolExecuteStartInfo) => void;
  onToolExecuted?: (info: ToolExecutedInfo) => void;
  onToolLoopAfterBatch?: (info: ToolLoopAfterBatchInfo) => void;
  agentAccessMode?: import("../agent/agent-access-mode.js").AgentAccessMode;
};

export interface MasterAgentConfig {
  enableSubAgents: boolean;
  /** @deprecated Parallel sub-agents are disabled; kept for config compatibility. */
  maxParallelTasks: number;
  taskTimeoutMs: number;
  allowFallback: boolean;
  verbose: boolean;
  enableMetrics: boolean;
}

export interface PerformanceMetrics {
  totalTasks: number;
  sequentialExecutions: number;
  fallbackCount: number;
  avgExecutionTime: number;
  successRate: number;
  lastUpdated: string;
}

export class MasterAgentCoordinator {
  private readonly config: MasterAgentConfig;
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
      allowFallback: true,
      verbose: isMasterAgentDelegationVerbose(),
      enableMetrics: true,
      ...config,
    };
    this.config.maxParallelTasks = 1;

    this.subAgentCapabilities = this.initializeSubAgentCapabilities();
    this.metrics = {
      totalTasks: 0,
      sequentialExecutions: 0,
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

  private registerDelegateTools(): void {
    this.toolRegistry.register("master.invoke_sub_agent", async (input, context) =>
      this.handleInvokeSubAgentTool(input, context),
    );
    this.toolRegistry.register("master.list_sub_agents", async (_input, context) =>
      this.handleListSubAgentsTool(context),
    );
  }

  private initializeSubAgentCapabilities(): Map<SubAgentType, SubAgentCapability> {
    const allTools = this.toolRegistry.list();
    const by = (...parts: string[]) => allTools.filter((t) => parts.some((p) => t.includes(p)));
    const map = new Map<SubAgentType, SubAgentCapability>();
    map.set("life", {
      type: "life",
      name: "生活助手",
      description: "处理天气、日程、提醒、闹钟、个人生活事务。",
      keywords: ["天气", "日程", "提醒", "闹钟"],
      tools: [...allTools.filter((t) => t.startsWith("clock.")), ...by("calendar", "schedule", "weather", "reminder", "alarm")],
    });
    map.set("work", {
      type: "work",
      name: "工作助手",
      description: "处理办公、文档、会议、项目和报告相关任务。",
      keywords: ["文档", "会议", "报告", "项目"],
      tools: by("email", "mail", "document", "doc", "meeting", "conference"),
    });
    map.set("social", {
      type: "social",
      name: "社交助手",
      description: "处理消息、联系人、社交互动和 Agent 间通信。",
      keywords: ["消息", "朋友", "社交", "聊天"],
      tools: by("social", "relay", "message", "chat"),
    });
    map.set("entertainment", {
      type: "entertainment",
      name: "娱乐助手",
      description: "处理游戏、音乐、视频和休闲任务。",
      keywords: ["游戏", "音乐", "视频"],
      tools: by("gomoku", "music", "video"),
    });
    map.set("finance", {
      type: "finance",
      name: "金融助手",
      description: "复杂财务规划、预算分析、多步对账；简单查用户钱包余额/流水由主 Agent 直接 wallet.*。",
      keywords: ["预算", "理财", "对账", "财务规划"],
      tools: by("wallet", "fund", "market", "shop", "purchase", "a2a", "trade"),
    });
    map.set("tech", {
      type: "tech",
      name: "技术助手",
      description: "处理代码、调试、桌面控制、视觉识别和开发辅助。",
      keywords: ["代码", "调试", "桌面", "视觉"],
      tools: by("code", "dev", "desktop", "visual", "vision"),
    });
    map.set("info", {
      type: "info",
      name: "信息助手",
      description: "处理搜索、查询、翻译、知识问答和资料收集。",
      keywords: ["搜索", "查询", "新闻", "资料"],
      tools: by("web", "search", "translat", "info", "query"),
    });
    map.set("general", {
      type: "general",
      name: "通用助手",
      description: "处理其他未分类任务。",
      keywords: [],
      tools: allTools,
    });
    return map;
  }

  private turnReportKey(actorId: string, chatUserMessageId?: string): string {
    return `${actorId}:${chatUserMessageId ?? "no-message-id"}`;
  }

  private resetTurnReports(actorId: string, chatUserMessageId?: string): void {
    this.turnDelegationStates.set(this.turnReportKey(actorId, chatUserMessageId), {
      reports: [],
      seenFingerprints: new Map(),
    });
  }

  private getTurnDelegationState(actorId: string, chatUserMessageId?: string): TurnDelegationState {
    const key = this.turnReportKey(actorId, chatUserMessageId);
    let state = this.turnDelegationStates.get(key);
    if (!state) {
      state = { reports: [], seenFingerprints: new Map() };
      this.turnDelegationStates.set(key, state);
    }
    return state;
  }

  private buildDelegationFingerprint(agentType: SubAgentType, taskDescription: string, priorContext: string): string {
    const normalized = `${taskDescription}\n${priorContext}`
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1000);
    return `${agentType}:${normalized}`;
  }

  async handleInvokeSubAgentTool(input: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>> {
    const actorId = resolveActorId(context);
    const agentType = parseSubAgentType(input.agentType);
    const taskDescription = String(input.taskDescription ?? "").trim();
    const priorContext = String(input.priorContext ?? "").trim();

    if (!agentType) return { ok: false, error: "Invalid agentType. Use master_list_sub_agents to inspect options." };
    if (!taskDescription) return { ok: false, error: "taskDescription is required." };

    const capability = this.subAgentCapabilities.get(agentType);
    if (!capability) return { ok: false, error: `Unknown sub-agent type: ${agentType}` };

    const turnState = this.getTurnDelegationState(actorId, context.chatUserMessageId);
    const maxInvocations = Math.max(1, getAgentRuntimeConfig().masterDelegation.maxSubAgentInvocationsPerTurn);
    if (turnState.reports.length >= maxInvocations) {
      return {
        ok: false,
        agentType,
        agentName: capability.name,
        error: `Sub-agent delegation limit reached for this turn (${maxInvocations}). Synthesize from prior reports instead of delegating again.`,
        priorInvocationsInTurn: turnState.reports.length,
      };
    }

    const fingerprint = this.buildDelegationFingerprint(agentType, taskDescription, priorContext);
    const previous = turnState.seenFingerprints.get(fingerprint);
    if (previous) {
      return {
        ok: previous.success,
        agentType,
        agentName: capability.name,
        taskId: previous.taskId,
        report: previous.result,
        deduplicated: true,
        priorInvocationsInTurn: turnState.reports.length,
        message: "Duplicate sub-agent delegation skipped; reuse the existing report.",
      };
    }

    const task: SubTask = {
      id: `delegate-${randomUUID()}`,
      description: priorContext ? `${taskDescription}\n\n补充背景：${priorContext}` : taskDescription,
      assignedAgent: agentType,
      priority: 5,
      dependencies: [],
      estimatedComplexity: "medium",
    };
    const invokeCtx: SubAgentInvokeContext = {
      userMessage: this.currentTurnUserMessage?.trim() || taskDescription,
      priorResults: [...turnState.reports],
    };

    const started = Date.now();
    try {
      const report = await this.withSubTaskTimeout(
        this.executeTaskWithTools(actorId, task, capability, invokeCtx),
        this.config.taskTimeoutMs,
        task.id,
      );
      const result: SubAgentResult = {
        taskId: task.id,
        agentType,
        success: true,
        result: report,
        executionTime: Date.now() - started,
      };
      turnState.reports.push(result);
      turnState.seenFingerprints.set(fingerprint, result);
      this.metrics.sequentialExecutions += 1;
      const uiDoneLine = pickSubAgentDoneLine(report);
      return {
        ok: true,
        agentType,
        agentName: capability.name,
        taskId: task.id,
        report,
        priorInvocationsInTurn: turnState.reports.length,
        ...(uiDoneLine ? { uiDoneLine } : {}),
        message: `${capability.name} completed; read the report field.`,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const result: SubAgentResult = {
        taskId: task.id,
        agentType,
        success: false,
        result: msg,
        executionTime: Date.now() - started,
      };
      turnState.reports.push(result);
      turnState.seenFingerprints.set(fingerprint, result);
      return {
        ok: false,
        agentType,
        agentName: capability.name,
        error: msg,
        priorInvocationsInTurn: turnState.reports.length,
      };
    }
  }

  async handleListSubAgentsTool(_context: ToolContext): Promise<Record<string, unknown>> {
    const agents = [...this.subAgentCapabilities.values()].map((c) => ({
      type: c.type,
      name: c.name,
      description: c.description,
    }));
    return { ok: true, agents, hint: "Use master_invoke_sub_agent for one distinct sub-task at a time." };
  }

  async orchestrateTask(
    actorId: string,
    userMessage: string,
    onProgress?: (message: string) => void,
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
    const enrichedOpts: OrchestrateTaskOptions = { ...opts, userLocation };

    this.currentTurnUserMessage = userMessage;
    this.currentTurnOrchestrateOpts = enrichedOpts;
    this.resetTurnReports(actorId, enrichedOpts.chatUserMessageId);

    try {
      const route = routeLlmExecution(userMessage);
      this.log("Route selected", { taskId, mode: route.mode, reasons: route.reasons });

      if (!this.config.enableSubAgents || route.mode === "master_only") {
        if (!this.config.enableSubAgents) {
          onProgress?.("使用单 Agent 模式处理");
          this.metrics.fallbackCount += 1;
        }
        return await this.executeWithMasterOnly(actorId, userMessage, onAssistantDelta, enrichedOpts);
      }

      return await this.executeWithMasterDelegateTools(actorId, userMessage, onAssistantDelta, enrichedOpts);
    } catch (error) {
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
        return await this.executeWithMasterOnly(actorId, userMessage, onAssistantDelta, enrichedOpts);
      }
      throw error;
    } finally {
      this.currentTurnUserMessage = null;
      this.currentTurnOrchestrateOpts = null;
      if (this.executionHistory.length > 100) this.executionHistory.shift();
    }
  }

  private buildToolContext(actorId: string, opts?: OrchestrateTaskOptions): ChatToolExecutionContext {
    return {
      executeTool: (name, args) =>
        this.toolRegistry.execute(name, args, {
          sessionId: actorId,
          userId: opts?.userId,
          chatUserMessageId: opts?.chatUserMessageId,
          clientIp: opts?.clientIp,
          clientLocation: opts?.clientLocation,
          agentAccessMode: opts?.agentAccessMode,
        }),
      onToolExecuteStart: opts?.onToolExecuteStart,
      onToolExecuted: opts?.onToolExecuted,
    };
  }

  private buildPromptInput(actorId: string, opts?: OrchestrateTaskOptions) {
    return {
      actorId,
      userText: this.currentTurnUserMessage ?? undefined,
      narrativeRecall: opts?.narrativeRecall,
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

  private buildMasterDelegateStreamOptions(actorId: string, opts?: OrchestrateTaskOptions): AgentStreamOptions {
    if (!this.promptContextBuilder) {
      return {
        masterSubAgentDelegate: true,
        chatToolsBuiltin: buildMasterAgentChatTools(this.subAgentCapabilities),
        ...(opts?.agentAccessMode ? { agentAccessMode: opts.agentAccessMode } : {}),
      };
    }
    return {
      ...this.promptContextBuilder.buildForMasterDelegate({
        ...this.buildPromptInput(actorId, opts),
        subAgentCapabilities: this.subAgentCapabilities.values(),
      }),
      ...(opts?.agentAccessMode ? { agentAccessMode: opts.agentAccessMode } : {}),
    };
  }

  private buildMasterStreamOptions(actorId: string, opts?: OrchestrateTaskOptions): AgentStreamOptions | undefined {
    const chatToolsExtra: ChatCompletionTool[] = [];
    if (this.promptContextBuilder) {
      const base = this.promptContextBuilder.build(this.buildPromptInput(actorId, opts));
      if (base?.chatToolsExtra?.length) chatToolsExtra.push(...base.chatToolsExtra);
      return {
        ...(base ?? {}),
        chatToolsBuiltin: buildMasterAgentChatTools(this.subAgentCapabilities, chatToolsExtra),
        chatToolsExtra: [],
        ...(opts?.agentAccessMode ? { agentAccessMode: opts.agentAccessMode } : {}),
      };
    }
    return {
      chatToolsBuiltin: buildMasterAgentChatTools(this.subAgentCapabilities, chatToolsExtra),
      ...(opts?.agentAccessMode ? { agentAccessMode: opts.agentAccessMode } : {}),
    };
  }

  private async executeWithMasterDelegateTools(
    actorId: string,
    userMessage: string,
    onAssistantDelta?: (delta: string) => void,
    opts?: OrchestrateTaskOptions,
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
      this.buildMasterDelegateStreamOptions(actorId, opts),
    );
    this.recordSuccess("master-delegate-tools", this.getTurnDelegationState(actorId, opts?.chatUserMessageId).reports.length);
    return fullText;
  }

  private async executeWithMasterOnly(
    actorId: string,
    userMessage: string,
    onAssistantDelta?: (delta: string) => void,
    opts?: OrchestrateTaskOptions,
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
      this.buildMasterStreamOptions(actorId, opts),
    );
    this.recordSuccess("master-only", 0);
    return fullText;
  }

  private async executeTaskWithTools(
    actorId: string,
    task: SubTask,
    capability: SubAgentCapability,
    invokeCtx?: SubAgentInvokeContext,
  ): Promise<string> {
    const baseStreamOpts =
      this.promptContextBuilder?.buildForSubAgent({
        ...this.buildPromptInput(actorId, this.currentTurnOrchestrateOpts ?? undefined),
        capability,
      }) ?? {};

    const allowedList =
      (baseStreamOpts.chatToolsBuiltin ?? [])
        .map((t) => (t.type === "function" ? t.function?.name : ""))
        .filter(Boolean)
        .join(", ") || "(none)";
    const priorBlock = invokeCtx?.priorResults.length
      ? `\n\nPrior sub-agent reports for reference; do not repeat work:\n${this.formatSubAgentReportsForMaster(invokeCtx.priorResults)}`
      : "";
    const userGoal = invokeCtx?.userMessage ? `\n\nOriginal user request:\n${invokeCtx.userMessage}` : "";
    const prompt = [
      `You are the ${capability.name} sub-agent, invoked by the master Agent. Report to the master Agent only.`,
      userGoal,
      `Current sub-task:\n${task.description}`,
      priorBlock,
      `Available tools:\n${allowedList}`,
      "Use necessary tools. Then return a concise sub-agent report with conclusion, evidence, and success/failure.",
      `The final line must be: ${USER_VISIBLE_PROGRESS_MARKER} followed by one short user-visible completion line.`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const sessionId = `subagent-${actorId}-${task.id}-${Date.now()}`;
    let fullText = "";
    await this.masterProvider.streamCompletion(
      sessionId,
      { text: prompt },
      (delta) => {
        fullText += delta;
      },
      this.buildToolContext(actorId, this.currentTurnOrchestrateOpts ?? undefined),
      baseStreamOpts,
    );
    return fullText.trim();
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

  public adjustConcurrency(_newMaxParallel: number): void {
    this.config.maxParallelTasks = 1;
    this.log("Parallel sub-agents are disabled; master invokes sub-agents through tools only.");
  }

  public getOptimizationSuggestions(): string[] {
    const suggestions: string[] = [];
    const metrics = this.getMetricsSnapshot();
    if (metrics.successRate < 80) suggestions.push("成功率较低，建议检查子 Agent 工具权限、超时和失败报告。");
    if (metrics.fallbackCount > metrics.totalTasks * 0.2) suggestions.push("降级频率较高，建议检查主 Agent 委派工具链路。");
    return suggestions;
  }
}
