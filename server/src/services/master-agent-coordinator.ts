/**
 * 主 Agent 协调器：负责任务分解、智能路由和子 Agent 调度
 * - 使用最强大的模型进行任务分析和规划
 * - 根据任务类型智能分发给专业化子 Agent
 * - 支持并行执行和结果汇总
 */

import { randomUUID } from "node:crypto";
import { isSimpleDirectTask, requiresTaskDecomposition } from "../agent/simple-task.js";
import { buildSubAgentChatTools } from "./master-agent-tool-filter.js";
import type {
  AgentStreamOptions,
  ChatToolExecutionContext,
  ExternalChatProvider,
} from "../external-model/types.js";
import { buildSessionSkillChatTools } from "../skills/skill-openai-bridge.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { WorldService } from "@private-ai-agent/agent-world";
import type { SkillManager } from "../skills/index.js";

/** 子 Agent 类型定义 - 按生活场景分类 */
export type SubAgentType = 
  | "life"          // 生活助手（天气、日程、提醒、个人事务）
  | "work"          // 工作助手（文档、邮件、会议、项目管理）
  | "social"        // 社交助手（消息、动态、朋友圈、联系人）
  | "entertainment" // 娱乐助手（游戏、音乐、视频、休闲）
  | "finance"       // 金融助手（钱包、支付、交易、投资）
  | "tech"          // 技术助手（代码、桌面控制、视觉、开发）
  | "info"          // 信息助手（搜索、查询、翻译、知识）
  | "general";      // 通用助手（其他未分类任务）

/** 子 Agent 能力描述 */
export interface SubAgentCapability {
  type: SubAgentType;
  name: string;
  description: string;
  keywords: string[];  // 用于匹配任务的关键词
  tools: string[];     // 该子 Agent 可使用的工具列表
}

/** 任务分解结果 */
export interface DecomposedTask {
  id: string;
  originalTask: string;
  subTasks: SubTask[];
  executionStrategy: "sequential" | "parallel" | "hybrid";
}

/** 子任务 */
export interface SubTask {
  id: string;
  description: string;
  assignedAgent: SubAgentType;
  priority: number;  // 1-10，优先级
  dependencies: string[];  // 依赖的子任务 ID
  estimatedComplexity: "low" | "medium" | "high";
}

/** 子 Agent 执行结果 */
export interface SubAgentResult {
  taskId: string;
  agentType: SubAgentType;
  success: boolean;
  result: string;
  metadata?: Record<string, unknown>;
  executionTime?: number;
}

/** 主 Agent 配置 */
export interface MasterAgentConfig {
  /** 是否启用子 Agent 分发 */
  enableSubAgents: boolean;
  /** 最大并行子任务数 */
  maxParallelTasks: number;
  /** 任务超时时间（毫秒） */
  taskTimeoutMs: number;
  /** 是否允许降级到单 Agent 模式 */
  allowFallback: boolean;
  /** 是否显示详细日志 */
  verbose: boolean;
  /** 是否启用性能监控 */
  enableMetrics: boolean;
}

/** 性能指标 */
export interface PerformanceMetrics {
  totalTasks: number;
  decomposedTasks: number;
  parallelExecutions: number;
  sequentialExecutions: number;
  hybridExecutions: number;
  fallbackCount: number;
  avgDecompositionTime: number;
  avgExecutionTime: number;
  avgSummarizationTime: number;
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
  }>;
  
  constructor(
    private readonly masterProvider: ExternalChatProvider,
    private readonly toolRegistry: ToolRegistry,
    private readonly worldService: WorldService | null = null,
    private readonly skillManager: SkillManager | null = null,
    config?: Partial<MasterAgentConfig>,
  ) {
    this.config = {
      enableSubAgents: true,
      maxParallelTasks: 5,
      taskTimeoutMs: 60000,
      allowFallback: true,
      verbose: process.env.MULTI_AGENT_VERBOSE === "true" || process.env.MULTI_AGENT_VERBOSE === "1",
      enableMetrics: true,
      ...config,
    };
    
    this.subAgentCapabilities = this.initializeSubAgentCapabilities();
    
    // 初始化性能指标
    this.metrics = {
      totalTasks: 0,
      decomposedTasks: 0,
      parallelExecutions: 0,
      sequentialExecutions: 0,
      hybridExecutions: 0,
      fallbackCount: 0,
      avgDecompositionTime: 0,
      avgExecutionTime: 0,
      avgSummarizationTime: 0,
      successRate: 100,
      lastUpdated: new Date().toISOString(),
    };
    
    this.executionHistory = [];
    
    this.log("✅ MasterAgentCoordinator initialized", {
      enableSubAgents: this.config.enableSubAgents,
      maxParallelTasks: this.config.maxParallelTasks,
      verbose: this.config.verbose,
    });
  }

  /** 初始化子 Agent 能力映射 */
  private initializeSubAgentCapabilities(): Map<SubAgentType, SubAgentCapability> {
    const capabilities = new Map<SubAgentType, SubAgentCapability>();
    
    // 从工具注册表中获取所有可用工具
    const allTools = this.toolRegistry.list();
    
    // 1. 生活助手 - 覆盖个人日常事务
    capabilities.set("life", {
      type: "life",
      name: "生活助手",
      description: "处理个人生活事务：天气查询、日程安排、提醒设置、闹钟、个人健康管理等",
      keywords: ["天气", "日程", "提醒", "闹钟", "约会", "健身", "健康", "日历", "预约", "备忘录"],
      tools: [
        ...allTools.filter((t) => t.startsWith("clock.")),
        ...allTools.filter((t) => t.includes("calendar") || t.includes("schedule")),
        ...allTools.filter((t) => t.includes("weather")),
        ...allTools.filter((t) => t.includes("reminder") || t.includes("alarm")),
      ],
    });
    
    // 2. 工作助手 - 覆盖办公和职业相关
    capabilities.set("work", {
      type: "work",
      name: "工作助手",
      description: "处理工作相关任务：文档处理、邮件管理、会议安排、项目管理、报告生成等",
      keywords: ["文档", "邮件", "会议", "报告", "项目", "office", "word", "excel", "pdf", "工作", "办公"],
      tools: [
        ...allTools.filter(t => t.includes("email") || t.includes("mail")),
        ...allTools.filter(t => t.includes("document") || t.includes("doc")),
        ...allTools.filter(t => t.includes("meeting") || t.includes("conference")),
      ],
    });
    
    // 3. 社交助手 - 覆盖人际互动
    capabilities.set("social", {
      type: "social",
      name: "社交助手",
      description: "处理社交互动：消息发送、朋友圈动态、联系人管理、社交网络互动等",
      keywords: ["消息", "朋友", "聊天", "动态", "分享", "社交", "联系人", "微信", "朋友圈"],
      tools: [
        ...allTools.filter(t => t.includes("social") || t.includes("relay")),
        ...allTools.filter(t => t.includes("message") || t.includes("chat")),
      ],
    });
    
    // 4. 娱乐助手 - 覆盖休闲娱乐
    capabilities.set("entertainment", {
      type: "entertainment",
      name: "娱乐助手",
      description: "处理娱乐活动：游戏、音乐、视频、休闲活动等",
      keywords: ["游戏", "五子棋", "下棋", "音乐", "视频", "电影", "娱乐", "休闲", "玩"],
      tools: [
        ...allTools.filter(t => t.includes("gomoku")),
        ...allTools.filter(t => t.includes("music") || t.includes("video")),
      ],
    });
    
    // 5. 金融助手 - 覆盖财务相关
    capabilities.set("finance", {
      type: "finance",
      name: "金融助手",
      description: "处理金融事务：钱包管理、支付、转账、交易、投资、预算等",
      keywords: ["钱包", "余额", "转账", "支付", "资金", "账户", "交易", "投资", "理财", "购买"],
      tools: [
        ...allTools.filter(t => t.includes("wallet") || t.includes("fund")),
        ...allTools.filter(t => t.includes("market") || t.includes("shop") || t.includes("purchase")),
        ...allTools.filter(t => t.includes("a2a") || t.includes("trade")),
      ],
    });
    
    // 6. 技术助手 - 覆盖技术开发和桌面控制
    capabilities.set("tech", {
      type: "tech",
      name: "技术助手",
      description: "处理技术相关任务：代码生成、调试、桌面控制、截图、视觉识别、开发辅助等",
      keywords: ["代码", "编程", "debug", "函数", "算法", "开发", "桌面", "截图", "电脑", "自动化", "图片", "视觉"],
      tools: [
        ...allTools.filter(t => t.includes("code") || t.includes("dev")),
        ...allTools.filter(t => t.includes("desktop") || t.includes("visual")),
        ...allTools.filter(t => t.includes("vision")),
      ],
    });
    
    // 7. 信息助手 - 覆盖信息查询和处理
    capabilities.set("info", {
      type: "info",
      name: "信息助手",
      description: "处理信息查询：网络搜索、知识问答、翻译、资料收集、新闻等",
      keywords: ["搜索", "查询", "网页", "信息", "新闻", "资料", "翻译", "translate", "英文", "中文", "语言", "知识"],
      tools: [
        ...allTools.filter(t => t.includes("web") || t.includes("search")),
        ...allTools.filter(t => t.includes("translat")),
        ...allTools.filter(t => t.includes("info") || t.includes("query")),
      ],
    });
    
    // 8. 通用助手 - 兜底类型
    capabilities.set("general", {
      type: "general",
      name: "通用助手",
      description: "处理其他未分类的通用对话和任务",
      keywords: [],
      tools: allTools,
    });
    
    return capabilities;
  }

  /**
   * 主入口：分析任务并决定执行策略
   */
  async orchestrateTask(
    actorId: string,
    userMessage: string,
    onProgress?: (message: string) => void,
    onAssistantDelta?: (delta: string) => void,
  ): Promise<string> {
    const startTime = Date.now();
    const taskId = `task-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    
    this.metrics.totalTasks++;
    this.log(`📨 Received task: ${taskId}`, { actorId, messageLength: userMessage.length });
    
    if (!this.config.enableSubAgents) {
      onProgress?.("使用单 Agent 模式处理");
      this.metrics.fallbackCount++;
      return this.executeWithMasterOnly(actorId, userMessage, onAssistantDelta);
    }

    if (isSimpleDirectTask(userMessage)) {
      this.log(`⚡ Simple direct task (heuristic), master only`, { taskId });
      return this.executeWithMasterOnly(actorId, userMessage, onAssistantDelta);
    }

    if (!requiresTaskDecomposition(userMessage)) {
      this.log(`⚡ Single-scope task, master only (no decomposition)`, { taskId });
      return this.executeWithMasterOnly(actorId, userMessage, onAssistantDelta);
    }

    try {
      // 不显示进度消息给用户
      
      // 步骤 1: 任务分解
      const decompStartTime = Date.now();
      const decomposed = await this.decomposeTask(actorId, userMessage);
      const decompDuration = Date.now() - decompStartTime;
      
      this.updateMetric('avgDecompositionTime', decompDuration);
      
      // 无需子 Agent：0 个子任务或仅 1 个整体任务 → 主 Agent + 工具
      if (decomposed.subTasks.length < 2) {
        this.log(`⚡ No multi sub-agent dispatch`, {
          taskId,
          subTaskCount: decomposed.subTasks.length,
        });
        return this.executeWithMasterOnly(actorId, userMessage, onAssistantDelta);
      }

      this.metrics.decomposedTasks++;
      this.log(`📋 Task decomposed`, { 
        taskId, 
        subTaskCount: decomposed.subTasks.length,
        strategy: decomposed.executionStrategy,
        decompositionTime: decompDuration,
      });
      
      // 步骤 2: 子 Agent 执行，结构化报告回传主 Agent
      let subResults: SubAgentResult[];
      const execStartTime = Date.now();

      if (decomposed.executionStrategy === "parallel") {
        this.metrics.parallelExecutions++;
        subResults = await this.executeParallel(actorId, decomposed, onProgress);
      } else if (decomposed.executionStrategy === "sequential") {
        this.metrics.sequentialExecutions++;
        subResults = await this.executeSequential(actorId, decomposed, onProgress);
      } else {
        this.metrics.hybridExecutions++;
        subResults = await this.executeHybrid(actorId, decomposed, onProgress);
      }

      const execDuration = Date.now() - execStartTime;
      this.updateMetric("avgExecutionTime", execDuration);

      // 步骤 3: 主 Agent 根据子 Agent 报告生成对用户的最终回复（可跳过额外 LLM）
      const summaryStartTime = Date.now();
      const finalResult = await this.deliverSubAgentReportsToUser(
        actorId,
        userMessage,
        subResults,
        onAssistantDelta,
      );
      const summaryDuration = Date.now() - summaryStartTime;
      this.updateMetric("avgSummarizationTime", summaryDuration);
      
      const totalDuration = Date.now() - startTime;
      
      // 记录执行历史
      this.executionHistory.push({
        timestamp: new Date().toISOString(),
        taskId,
        duration: totalDuration,
        success: true,
        strategy: decomposed.executionStrategy,
        subTaskCount: decomposed.subTasks.length,
      });
      
      // 保留最近 100 条记录
      if (this.executionHistory.length > 100) {
        this.executionHistory.shift();
      }
      
      this.log(`✅ Task completed`, {
        taskId,
        totalDuration,
        decompositionTime: decompDuration,
        executionTime: execDuration,
        summarizationTime: summaryDuration,
      });
      
      return finalResult;
    } catch (error) {
      console.error("[MasterAgent]  orchestration failed:", error);
      
      // 记录失败
      this.executionHistory.push({
        timestamp: new Date().toISOString(),
        taskId,
        duration: Date.now() - startTime,
        success: false,
        strategy: "fallback",
        subTaskCount: 0,
      });
      
      this.metrics.successRate = this.calculateSuccessRate();
      
      if (this.config.allowFallback) {
        this.metrics.fallbackCount++;
        this.log(`️ Fallback to single agent`, { taskId, error: error instanceof Error ? error.message : String(error) });
        return this.executeWithMasterOnly(actorId, userMessage, onAssistantDelta);
      }
      
      throw error;
    }
  }

  private buildToolContext(actorId: string): ChatToolExecutionContext {
    return {
      executeTool: (name, args) =>
        this.toolRegistry.execute(name, args, { sessionId: actorId }),
    };
  }

  private buildStreamOptions(actorId: string): AgentStreamOptions | undefined {
    if (!this.worldService || !this.skillManager) return undefined;
    const chatToolsExtra = buildSessionSkillChatTools(
      actorId,
      this.worldService,
      this.skillManager,
    );
    if (!chatToolsExtra.length) return undefined;
    return { chatToolsExtra };
  }

  /**
   * 使用主 Agent 单独执行（不分解任务，启用与聊天一致的 function calling）
   */
  private async executeWithMasterOnly(
    actorId: string,
    userMessage: string,
    onAssistantDelta?: (delta: string) => void,
  ): Promise<string> {
    const sessionId = `master-${actorId}-${Date.now()}`;
    let fullText = "";
    const toolCtx = this.buildToolContext(actorId);
    const streamOpts = this.buildStreamOptions(actorId);

    try {
      await this.masterProvider.streamCompletion(
        sessionId,
        { text: userMessage },
        (delta) => {
          fullText += delta;
          onAssistantDelta?.(delta);
        },
        toolCtx,
        streamOpts,
      );

      return fullText;
    } catch (error) {
      console.error("[MasterAgent] executeWithMasterOnly failed:", error);
      throw error;
    }
  }

  /**
   * 任务分解：使用最强的模型分析任务复杂度并拆分子任务
   */
  private async decomposeTask(
    actorId: string,
    userMessage: string,
  ): Promise<DecomposedTask> {
    const prompt = `
你是一个超级智能的任务分解专家。请分析以下用户任务，判断是否需要分解为多个子任务。

用户任务：${userMessage}

请输出 JSON 格式（不要 Markdown 围栏）：
{
  "needsDecomposition": true/false,
  "executionStrategy": "sequential" | "parallel" | "hybrid",
  "subTasks": [
    {
      "description": "子任务描述",
      "assignedAgent": "life" | "work" | "social" | "entertainment" | "finance" | "tech" | "info" | "general",
      "priority": 1-10,
      "dependencies": [],
      "estimatedComplexity": "low" | "medium" | "high"
    }
  ]
}

分配原则（按生活场景分类）：
- life: 个人生活事务（天气、日程、提醒、闹钟、健康、约会等）
- work: 工作办公相关（文档、邮件、会议、报告、项目管理等）
- social: 社交互动（消息、朋友圈、联系人、聊天、分享等）
- entertainment: 娱乐休闲（游戏、音乐、视频、电影、休闲活动等）
- finance: 金融财务（钱包、支付、转账、交易、投资、购买等）
- tech: 技术开发（代码、编程、桌面控制、截图、视觉识别等）
- info: 信息查询（搜索、翻译、知识问答、新闻、资料收集等）
- general: 其他未分类任务

如果任务简单，设置 needsDecomposition 为 false，subTasks 为空数组。
`;

    const sessionId = `decompose-${actorId}-${Date.now()}`;
    
    try {
      let response = "";
      await this.masterProvider.streamCompletion(
        sessionId,
        { text: prompt },
        (delta) => {
          response += delta;
        },
        undefined,
        undefined,
      );
      
      const parsed = this.parseDecompositionResponse(response);

      if (parsed.needsDecomposition === false) {
        return {
          id: randomUUID(),
          originalTask: userMessage,
          subTasks: [],
          executionStrategy: "sequential",
        };
      }

      if (!parsed.subTasks || parsed.subTasks.length === 0) {
        return {
          id: randomUUID(),
          originalTask: userMessage,
          subTasks: [],
          executionStrategy: "sequential",
        };
      }
      
      return {
        id: randomUUID(),
        originalTask: userMessage,
        subTasks: parsed.subTasks.map((t, i) => ({
          id: `task-${i}`,
          ...t,
        })),
        executionStrategy: parsed.executionStrategy,
      };
    } catch (error) {
      console.error("[MasterAgent] decomposition failed:", error);
      // 降级：不拆子任务，由主 Agent 直答
      return {
        id: randomUUID(),
        originalTask: userMessage,
        subTasks: [],
        executionStrategy: "sequential",
      };
    }
  }

  /**
   * 并行执行子任务
   */
  private async executeParallel(
    actorId: string,
    decomposed: DecomposedTask,
    onProgress?: (message: string) => void,
  ): Promise<SubAgentResult[]> {
    onProgress?.("🚀 并行执行子任务...");

    const results: SubAgentResult[] = [];
    const tasks = decomposed.subTasks;
    const batchSize = Math.max(1, this.config.maxParallelTasks);

    for (let i = 0; i < tasks.length; i += batchSize) {
      const batch = tasks.slice(i, i + batchSize);
      onProgress?.(
        `执行批次 ${Math.floor(i / batchSize) + 1}/${Math.ceil(tasks.length / batchSize)}`,
      );

      const batchResults = await Promise.allSettled(
        batch.map((task) => this.executeSubTask(actorId, task, onProgress)),
      );

      batchResults.forEach((result, idx) => {
        if (result.status === "fulfilled") {
          results.push(result.value);
        } else {
          console.error(`[MasterAgent] Task ${batch[idx].id} failed:`, result.reason);
          results.push({
            taskId: batch[idx].id,
            agentType: batch[idx].assignedAgent,
            success: false,
            result: `执行失败: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
          });
        }
      });
    }

    return results;
  }

  /**
   * 串行执行子任务
   */
  private async executeSequential(
    actorId: string,
    decomposed: DecomposedTask,
    onProgress?: (message: string) => void,
  ): Promise<SubAgentResult[]> {
    onProgress?.("📊 按顺序执行子任务...");

    const results: SubAgentResult[] = [];
    const sortedTasks = [...decomposed.subTasks].sort((a, b) => b.priority - a.priority);

    for (const task of sortedTasks) {
      onProgress?.(`执行: ${task.description.substring(0, 30)}...`);
      const result = await this.executeSubTask(actorId, task, onProgress);
      results.push(result);
      if (!result.success) {
        onProgress?.(`⚠️ 任务 ${task.id} 执行失败，继续执行下一个`);
      }
    }

    return results;
  }

  /**
   * 混合执行（部分并行，部分串行）
   */
  private async executeHybrid(
    actorId: string,
    decomposed: DecomposedTask,
    onProgress?: (message: string) => void,
  ): Promise<SubAgentResult[]> {
    const independentTasks = decomposed.subTasks.filter((t) => t.dependencies.length === 0);
    const dependentTasks = decomposed.subTasks.filter((t) => t.dependencies.length > 0);

    const results: SubAgentResult[] = [];

    if (independentTasks.length > 0) {
      onProgress?.("🚀 并行执行独立任务...");
      results.push(
        ...(await this.executeParallel(
          actorId,
          { ...decomposed, subTasks: independentTasks },
          onProgress,
        )),
      );
    }

    if (dependentTasks.length > 0) {
      onProgress?.("📊 串行执行依赖任务...");
      results.push(
        ...(await this.executeSequential(
          actorId,
          { ...decomposed, subTasks: dependentTasks },
          onProgress,
        )),
      );
    }

    return results;
  }

  /**
   * 执行单个子任务
   */
  private async executeSubTask(
    actorId: string,
    task: SubTask,
    onProgress?: (message: string) => void,
  ): Promise<SubAgentResult> {
    const startTime = Date.now();
    const capability = this.subAgentCapabilities.get(task.assignedAgent);
    
    if (!capability) {
      return {
        taskId: task.id,
        agentType: task.assignedAgent,
        success: false,
        result: `未知的子 Agent 类型: ${task.assignedAgent}`,
      };
    }
    
    onProgress?.(`[${capability.name}] 处理: ${task.description.substring(0, 40)}...`);
    
    try {
      const result = await this.withSubTaskTimeout(
        this.executeTaskWithTools(actorId, task, capability),
        this.config.taskTimeoutMs,
        task.id,
      );

      return {
        taskId: task.id,
        agentType: task.assignedAgent,
        success: true,
        result,
        executionTime: Date.now() - startTime,
      };
    } catch (error) {
      return {
        taskId: task.id,
        agentType: task.assignedAgent,
        success: false,
        result: `执行错误: ${error instanceof Error ? error.message : String(error)}`,
        executionTime: Date.now() - startTime,
      };
    }
  }

  private withSubTaskTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    taskId: string,
  ): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`子任务 ${taskId} 超时（>${timeoutMs}ms）`));
      }, timeoutMs);
      promise.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  /**
   * 使用工具执行子任务
   */
  private async executeTaskWithTools(
    actorId: string,
    task: SubTask,
    capability: SubAgentCapability,
  ): Promise<string> {
    const baseStreamOpts = this.buildStreamOptions(actorId);
    const scopedBuiltin = buildSubAgentChatTools(
      capability.tools,
      baseStreamOpts?.chatToolsExtra,
    );
    const streamOpts: AgentStreamOptions = {
      ...(baseStreamOpts ?? {}),
      chatToolsBuiltin: scopedBuiltin,
      chatToolsExtra: [],
    };

    const allowedList =
      scopedBuiltin
        .map((t) => (t.type === "function" ? t.function?.name : ""))
        .filter(Boolean)
        .join(", ") || "（无）";

    const prompt = `你是「${capability.name}」子 Agent，向主 Agent 汇报，不要对用户寒暄。

子任务：${task.description}

你只能使用以下工具（API 名为下划线形式，对应注册名中的点号）：
${allowedList}

请调用必要工具完成任务，最后用 3～8 句话给出【子Agent执行报告】：结论、关键数据、是否成功。不要编造未工具验证的信息。`;

    const sessionId = `subagent-${actorId}-${task.id}-${Date.now()}`;
    let fullText = "";
    const toolCtx = this.buildToolContext(actorId);

    await this.masterProvider.streamCompletion(
      sessionId,
      { text: prompt },
      (delta) => {
        fullText += delta;
      },
      toolCtx,
      streamOpts,
    );

    return fullText.trim();
  }

  /**
   * 主 Agent 根据子 Agent 结构化报告生成对用户的回复（流式）。
   */
  private async deliverSubAgentReportsToUser(
    actorId: string,
    originalTask: string,
    subResults: SubAgentResult[],
    onAssistantDelta?: (delta: string) => void,
  ): Promise<string> {
    const reports = this.formatSubAgentReportsForMaster(subResults);

    if (this.shouldSkipMasterSynthesis(subResults)) {
      const direct = this.formatResultsForUser(subResults);
      this.streamTextToUser(direct, onAssistantDelta);
      return direct;
    }

    const prompt = `你是主 Agent。用户问题是：
${originalTask}

以下是各专业子 Agent 向你提交的执行报告（请据此回答用户，勿重复寒暄）：
${reports}

请整合成一段直接给用户的回复：覆盖所有子任务结论；若有失败则说明原因；条理清晰、语气自然。`;

    const sessionId = `master-present-${actorId}-${Date.now()}`;
    let fullText = "";

    await this.masterProvider.streamCompletion(
      sessionId,
      { text: prompt },
      (delta) => {
        fullText += delta;
        onAssistantDelta?.(delta);
      },
      undefined,
      undefined,
    );

    return fullText.trim() || this.formatResultsForUser(subResults);
  }

  private shouldSkipMasterSynthesis(results: SubAgentResult[]): boolean {
    if (process.env.MASTER_AGENT_FORCE_SYNTHESIS === "1") return false;
    if (results.length === 0) return true;
    if (results.length === 1 && results[0].success) return true;
    if (
      results.length <= 2 &&
      results.every((r) => r.success) &&
      new Set(results.map((r) => r.agentType)).size === 1
    ) {
      return true;
    }
    return false;
  }

  private formatSubAgentReportsForMaster(results: SubAgentResult[]): string {
    return results
      .map(
        (r) =>
          `[报告 taskId=${r.taskId} agent=${r.agentType} success=${r.success}${r.executionTime != null ? ` ms=${r.executionTime}` : ""}]\n${r.result}`,
      )
      .join("\n\n---\n\n");
  }

  private formatResultsForUser(results: SubAgentResult[]): string {
    return results
      .map((r) => {
        const head = `【${this.getAgentName(r.agentType)}】${r.success ? "" : "（未完成）"}`;
        return `${head}\n${r.result}`;
      })
      .join("\n\n");
  }

  private streamTextToUser(text: string, onAssistantDelta?: (delta: string) => void): void {
    if (!onAssistantDelta || !text) return;
    const chunkSize = 24;
    for (let i = 0; i < text.length; i += chunkSize) {
      onAssistantDelta(text.slice(i, i + chunkSize));
    }
  }

  // ==================== 监控和日志方法 ====================

  /**
   * 记录日志（根据 verbose 配置）
   */
  private log(message: string, data?: any): void {
    if (this.config.verbose) {
      const timestamp = new Date().toISOString();
      console.log(`[MasterAgent] [${timestamp}] ${message}`, data ? JSON.stringify(data) : "");
    }
  }

  /**
   * 更新性能指标
   */
  private updateMetric(metricName: keyof PerformanceMetrics, value: number): void {
    if (!this.config.enableMetrics) return;
    
    const current = this.metrics[metricName];
    if (typeof current === 'number') {
      // 计算移动平均值
      (this.metrics as any)[metricName] = current === 0 ? value : (current * 0.7 + value * 0.3);
    }
    this.metrics.lastUpdated = new Date().toISOString();
  }

  /**
   * 计算成功率
   */
  private calculateSuccessRate(): number {
    if (this.executionHistory.length === 0) return 100;
    
    const recentHistory = this.executionHistory.slice(-50); // 最近 50 条
    const successCount = recentHistory.filter(h => h.success).length;
    return Math.round((successCount / recentHistory.length) * 100);
  }

  /**
   * 获取性能指标快照
   */
  public getMetricsSnapshot(): PerformanceMetrics {
    this.metrics.successRate = this.calculateSuccessRate();
    return { ...this.metrics };
  }

  /**
   * 获取执行历史
   */
  public getExecutionHistory(limit: number = 10): Array<any> {
    return this.executionHistory.slice(-limit).reverse();
  }

  /**
   * 动态调整并发度
   */
  public adjustConcurrency(newMaxParallel: number): void {
    const old = this.config.maxParallelTasks;
    this.config.maxParallelTasks = Math.max(1, Math.min(20, newMaxParallel));
    this.log(`🔄 Concurrency adjusted`, { from: old, to: this.config.maxParallelTasks });
  }

  /**
   * 获取优化建议
   */
  public getOptimizationSuggestions(): string[] {
    const suggestions: string[] = [];
    const metrics = this.getMetricsSnapshot();
    
    // 基于成功率建议
    if (metrics.successRate < 80) {
      suggestions.push("⚠️ 成功率较低，建议检查子 Agent 配置或降低并发度");
    }
    
    // 基于执行时间建议
    if (metrics.avgExecutionTime > 30000) {
      suggestions.push("⏱️ 平均执行时间较长，考虑增加超时时间或优化子任务");
    }
    
    // 基于降级次数建议
    if (metrics.fallbackCount > metrics.totalTasks * 0.2) {
      suggestions.push("📉 降级频率较高，可能需要简化任务分解策略");
    }
    
    // 并发度建议
    if (metrics.parallelExecutions > 0 && metrics.avgExecutionTime < 5000) {
      suggestions.push("✅ 执行速度快，可以尝试增加并发度以提升吞吐量");
    }
    
    return suggestions;
  }

  /** 获取子 Agent 名称 */
  private getAgentName(type: SubAgentType): string {
    return this.subAgentCapabilities.get(type)?.name || type;
  }



  /** 解析分解响应 */
  private parseDecompositionResponse(response: string): {
    needsDecomposition: boolean;
    executionStrategy: "sequential" | "parallel" | "hybrid";
    subTasks: Array<{
      description: string;
      assignedAgent: SubAgentType;
      priority: number;
      dependencies: string[];
      estimatedComplexity: "low" | "medium" | "high";
    }>;
  } {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No JSON found in response");
      }
      const parsed = JSON.parse(jsonMatch[0]);
      const subTasks = Array.isArray(parsed.subTasks) ? parsed.subTasks : [];
      const needsDecomposition =
        parsed.needsDecomposition === true ||
        (parsed.needsDecomposition !== false && subTasks.length >= 2);
      return {
        needsDecomposition,
        executionStrategy: parsed.executionStrategy || "sequential",
        subTasks,
      };
    } catch (error) {
      console.error("[MasterAgent] Failed to parse decomposition:", error);
      return {
        needsDecomposition: false,
        executionStrategy: "sequential",
        subTasks: [],
      };
    }
  }


}


