/**
 * 主 Agent 协调器：负责任务分解、智能路由和子 Agent 调度
 * - 使用最强大的模型进行任务分析和规划
 * - 根据任务类型智能分发给专业化子 Agent
 * - 支持并行执行和结果汇总
 */

import { randomUUID } from "node:crypto";
import type { ExternalChatProvider } from "../external-model/types.js";
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
        ...allTools.filter(t => t.includes("calendar") || t.includes("schedule")),
        ...allTools.filter(t => t.includes("weather")),
        ...allTools.filter(t => t.includes("reminder") || t.includes("alarm")),
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
      keywords: ["游戏", "斗地主", "五子棋", "炸金花", "音乐", "视频", "电影", "娱乐", "休闲", "玩"],
      tools: [
        ...allTools.filter(t => t.includes("game") || t.includes("doudizhu") || t.includes("gomoku")),
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
  ): Promise<string> {
    const startTime = Date.now();
    const taskId = `task-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    
    this.metrics.totalTasks++;
    this.log(`📨 Received task: ${taskId}`, { actorId, messageLength: userMessage.length });
    
    if (!this.config.enableSubAgents) {
      onProgress?.("使用单 Agent 模式处理");
      this.metrics.fallbackCount++;
      return this.executeWithMasterOnly(actorId, userMessage);
    }

    try {
      onProgress?.("🧠 主 Agent 分析任务中...");
      
      // 步骤 1: 任务分解
      const decompStartTime = Date.now();
      const decomposed = await this.decomposeTask(actorId, userMessage);
      const decompDuration = Date.now() - decompStartTime;
      
      this.updateMetric('avgDecompositionTime', decompDuration);
      
      // 如果任务简单，直接用主 Agent 处理
      if (decomposed.subTasks.length <= 1) {
        onProgress?.("任务较简单，直接处理");
        this.log(`⚡ Simple task, using single agent mode`, { taskId });
        return this.executeWithMasterOnly(actorId, userMessage);
      }

      this.metrics.decomposedTasks++;
      onProgress?.(`📋 任务已分解为 ${decomposed.subTasks.length} 个子任务`);
      this.log(`📋 Task decomposed`, { 
        taskId, 
        subTaskCount: decomposed.subTasks.length,
        strategy: decomposed.executionStrategy,
        decompositionTime: decompDuration,
      });
      
      // 步骤 2: 根据执行策略调度子 Agent
      let result: string;
      const execStartTime = Date.now();
      
      if (decomposed.executionStrategy === "parallel") {
        this.metrics.parallelExecutions++;
        result = await this.executeParallel(actorId, decomposed, onProgress);
      } else if (decomposed.executionStrategy === "sequential") {
        this.metrics.sequentialExecutions++;
        result = await this.executeSequential(actorId, decomposed, onProgress);
      } else {
        this.metrics.hybridExecutions++;
        result = await this.executeHybrid(actorId, decomposed, onProgress);
      }
      
      const execDuration = Date.now() - execStartTime;
      this.updateMetric('avgExecutionTime', execDuration);
      
      // 步骤 3: 结果汇总和优化
      onProgress?.("📝 汇总结果中...");
      const summaryStartTime = Date.now();
      const finalResult = await this.summarizeResults(
        actorId,
        userMessage,
        decomposed,
        result,
      );
      const summaryDuration = Date.now() - summaryStartTime;
      this.updateMetric('avgSummarizationTime', summaryDuration);
      
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
        onProgress?.("⚠️ 多 Agent 模式失败，降级到单 Agent 模式");
        this.metrics.fallbackCount++;
        this.log(`⚠️ Fallback to single agent`, { taskId, error: error instanceof Error ? error.message : String(error) });
        return this.executeWithMasterOnly(actorId, userMessage);
      }
      
      throw error;
    }
  }

  /**
   * 使用主 Agent 单独执行（不分解任务）
   */
  private async executeWithMasterOnly(
    actorId: string,
    userMessage: string,
  ): Promise<string> {
    // 调用外部模型提供商进行流式完成
    const sessionId = `master-${actorId}-${Date.now()}`;
    let fullText = "";
    
    try {
      await this.masterProvider.streamCompletion(
        sessionId,
        { text: userMessage },
        (delta) => {
          fullText += delta;
        },
        undefined,
        undefined,
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
      
      // 如果不需要分解，返回单个任务
      if (!parsed.subTasks || parsed.subTasks.length === 0) {
        return {
          id: randomUUID(),
          originalTask: userMessage,
          subTasks: [{
            id: "task-0",
            description: userMessage,
            assignedAgent: "general",
            priority: 5,
            dependencies: [],
            estimatedComplexity: "medium",
          }],
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
      // 降级：返回单个通用任务
      return {
        id: randomUUID(),
        originalTask: userMessage,
        subTasks: [{
          id: "task-0",
          description: userMessage,
          assignedAgent: "general",
          priority: 5,
          dependencies: [],
          estimatedComplexity: "medium",
        }],
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
  ): Promise<string> {
    onProgress?.("🚀 并行执行子任务...");
    
    const results: SubAgentResult[] = [];
    const tasks = decomposed.subTasks;
    
    // 分批并行执行（限制并发数）
    const batchSize = this.config.maxParallelTasks;
    for (let i = 0; i < tasks.length; i += batchSize) {
      const batch = tasks.slice(i, i + batchSize);
      onProgress?.(`执行批次 ${Math.floor(i / batchSize) + 1}/${Math.ceil(tasks.length / batchSize)}`);
      
      const batchPromises = batch.map(task => 
        this.executeSubTask(actorId, task, onProgress)
      );
      
      const batchResults = await Promise.allSettled(batchPromises);
      
      batchResults.forEach((result, idx) => {
        if (result.status === "fulfilled") {
          results.push(result.value);
        } else {
          console.error(`[MasterAgent] Task ${batch[idx].id} failed:`, result.reason);
          results.push({
            taskId: batch[idx].id,
            agentType: batch[idx].assignedAgent,
            success: false,
            result: `执行失败: ${result.reason}`,
          });
        }
      });
    }
    
    return this.formatParallelResults(results);
  }

  /**
   * 串行执行子任务
   */
  private async executeSequential(
    actorId: string,
    decomposed: DecomposedTask,
    onProgress?: (message: string) => void,
  ): Promise<string> {
    onProgress?.("📊 按顺序执行子任务...");
    
    const results: SubAgentResult[] = [];
    
    // 按优先级排序
    const sortedTasks = [...decomposed.subTasks].sort((a, b) => b.priority - a.priority);
    
    for (const task of sortedTasks) {
      onProgress?.(`执行: ${task.description.substring(0, 30)}...`);
      const result = await this.executeSubTask(actorId, task, onProgress);
      results.push(result);
      
      if (!result.success) {
        onProgress?.(`⚠️ 任务 ${task.id} 执行失败，继续执行下一个`);
      }
    }
    
    return this.formatSequentialResults(results);
  }

  /**
   * 混合执行（部分并行，部分串行）
   */
  private async executeHybrid(
    actorId: string,
    decomposed: DecomposedTask,
    onProgress?: (message: string) => void,
  ): Promise<string> {
    // 简化实现：先执行无依赖的任务（并行），再执行有依赖的任务（串行）
    const independentTasks = decomposed.subTasks.filter(t => t.dependencies.length === 0);
    const dependentTasks = decomposed.subTasks.filter(t => t.dependencies.length > 0);
    
    let result = "";
    
    if (independentTasks.length > 0) {
      onProgress?.("🚀 并行执行独立任务...");
      const parallelResult = await this.executeParallel(
        actorId,
        { ...decomposed, subTasks: independentTasks },
        onProgress,
      );
      result += parallelResult + "\n\n";
    }
    
    if (dependentTasks.length > 0) {
      onProgress?.("📊 串行执行依赖任务...");
      const sequentialResult = await this.executeSequential(
        actorId,
        { ...decomposed, subTasks: dependentTasks },
        onProgress,
      );
      result += sequentialResult;
    }
    
    return result;
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
      // 根据子 Agent 类型选择对应的工具执行
      const result = await this.executeTaskWithTools(actorId, task, capability);
      
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

  /**
   * 使用工具执行子任务
   */
  private async executeTaskWithTools(
    actorId: string,
    task: SubTask,
    capability: SubAgentCapability,
  ): Promise<string> {
    // 构建针对该子任务的提示
    const prompt = `
你是${capability.name}。请完成以下任务：

任务描述：${task.description}

可用工具：${capability.tools.join(", ") || "无专用工具"}

请使用合适的工具或直接回答来完成任务。如果需要调用工具，请说明要调用的工具和参数。
`;

    const sessionId = `subagent-${actorId}-${task.id}-${Date.now()}`;
    let fullText = "";
    
    try {
      await this.masterProvider.streamCompletion(
        sessionId,
        { text: prompt },
        (delta) => {
          fullText += delta;
        },
        undefined,
        undefined,
      );
      
      return fullText;
    } catch (error) {
      console.error(`[MasterAgent] executeTaskWithTools failed for ${task.id}:`, error);
      throw error;
    }
  }

  /**
   * 汇总结果
   */
  private async summarizeResults(
    actorId: string,
    originalTask: string,
    decomposed: DecomposedTask,
    rawResults: string,
  ): Promise<string> {
    const prompt = `
你是结果汇总专家。请将以下子任务的执行结果整合成一个连贯的回复。

原始任务：${originalTask}

子任务执行结果：
${rawResults}

请用自然语言总结所有结果，确保：
1. 回答完整覆盖原始任务的所有方面
2. 逻辑清晰，条理分明
3. 如果有失败的任务，说明原因和建议
4. 语气友好专业
`;

    const sessionId = `summarize-${actorId}-${Date.now()}`;
    let fullText = "";
    
    try {
      await this.masterProvider.streamCompletion(
        sessionId,
        { text: prompt },
        (delta) => {
          fullText += delta;
        },
        undefined,
        undefined,
      );
      
      return fullText;
    } catch (error) {
      console.error("[MasterAgent] summarizeResults failed:", error);
      // 降级：直接返回原始结果
      return rawResults;
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
  }  /** 格式化并行执行结果 */
  private formatParallelResults(results: SubAgentResult[]): string {
    return results.map(r => 
      `【${this.getAgentName(r.agentType)}】\n${r.result}\n`
    ).join("\n");
  }

  /** 格式化串行执行结果 */
  private formatSequentialResults(results: SubAgentResult[]): string {
    return results.map((r, i) => 
      `步骤 ${i + 1} 【${this.getAgentName(r.agentType)}】\n${r.result}\n`
    ).join("\n");
  }

  /** 获取子 Agent 名称 */
  private getAgentName(type: SubAgentType): string {
    return this.subAgentCapabilities.get(type)?.name || type;
  }



  /** 解析分解响应 */
  private parseDecompositionResponse(response: string): {
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
      return {
        executionStrategy: parsed.executionStrategy || "sequential",
        subTasks: parsed.subTasks || [],
      };
    } catch (error) {
      console.error("[MasterAgent] Failed to parse decomposition:", error);
      return {
        executionStrategy: "sequential",
        subTasks: [],
      };
    }
  }


}


