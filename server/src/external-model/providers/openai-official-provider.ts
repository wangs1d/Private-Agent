import OpenAI from "openai";
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";

import {
  buildLayeredSystemPrompt,
  finalizeChatSystemPrompt,
} from "../../agent/prompt-builder.js";
import { preparePromptCachePlan } from "../prefix-cache.js";
import {
  AbstractChatProvider,
  type SystemAndPlanContext,
  type SystemAndPlanResult,
} from "../abstract-chat-provider.js";
import type { AgentStreamOptions } from "../types.js";

const SYSTEM_PROMPT =
  "You are a helpful, safe assistant. Respond in the same language the user uses when appropriate (Chinese or English). Refuse requests involving illegal or harmful content.";

/**
 * OpenAI 官方 Chat Completions（流式）。
 * 环境变量：`OPENAI_API_KEY`（必填以启用）、`OPENAI_MODEL`、`OPENAI_BASE_URL`（可选，默认官方端点）。
 *
 * 继承 {@link AbstractChatProvider}：防串台（foldCompletedToolChains 根源折叠）、时间戳注入、
 * thread 维护等公共逻辑由基类模板方法固化，本类只实现 OpenAI 特有的 system prompt 缓存、
 * 智能模型路由与 extraBody 构造。
 */
export class OpenAiOfficialProvider extends AbstractChatProvider {
  readonly id = "openai";
  readonly displayLabel = "OpenAI";
  readonly capabilities = {
    toolCallingProtocol: "openai" as const,
    supportsParallelToolCalls: true,
    supportsVision: true,
    supportsThinking: false,
    supportsStreaming: true,
  };

  protected readonly systemPrompt = SYSTEM_PROMPT;
  protected readonly notEnabledErrorMessage = "OPENAI_API_KEY is not set";
  protected readonly client: OpenAI | null;
  protected readonly model: string;

  /**
   * System Prompt 缓存：避免重复构建相同的 System Prompt
   * 预期效果：System prompt 构建时间减少 90%
   */
  private systemPromptCache = new Map<string, { content: string; timestamp: number }>();

  private static readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5分钟缓存
  private static readonly MAX_CACHE_SIZE = 100; // 最大缓存条目数

  constructor() {
    super();
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    const baseURL = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").trim();
    this.model = (process.env.OPENAI_MODEL ?? "gpt-4o-mini").trim();
    this.client = apiKey
      ? new OpenAI({ apiKey, baseURL, timeout: 180_000, maxRetries: 2 })
      : null;

    // 定期清理过期缓存（每10分钟）
    setInterval(() => this.cleanupCache(), 10 * 60 * 1000).unref();
  }

  /**
   * 清理过期的 System Prompt 缓存
   */
  private cleanupCache(): void {
    const now = Date.now();
    for (const [key, value] of this.systemPromptCache) {
      if (now - value.timestamp > OpenAiOfficialProvider.CACHE_TTL_MS) {
        this.systemPromptCache.delete(key);
      }
    }
    // 如果缓存仍然过大，删除最旧的条目
    if (this.systemPromptCache.size > OpenAiOfficialProvider.MAX_CACHE_SIZE) {
      const entries = [...this.systemPromptCache.entries()]
        .sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toDelete = entries.slice(0, this.systemPromptCache.size - OpenAiOfficialProvider.MAX_CACHE_SIZE);
      toDelete.forEach(([key]) => this.systemPromptCache.delete(key));
    }
  }

  /**
   * 获取或构建缓存的 System Prompt
   */
  private getCachedOrBuildSystemPrompt(
    baseContent: string,
    finalizeOptions: NonNullable<Parameters<typeof finalizeChatSystemPrompt>[1]>,
  ): string {
    const cacheKey = JSON.stringify({
      // 修复：不能只取 baseContent 前 500 字符——narrativeRecall 等动态记忆块排在
      // buildLayeredSystemPrompt 渲染顺序的靠后位置，若被前 500 字符覆盖到，记忆变化
      // 不会使缓存失效，导致每轮都命中旧的"无记忆" system prompt（对话中长期记忆永不生效）。
      // 改用完整 baseContent 的 sha1 指纹，动态记忆一变缓存即失效。
      baseContent: createHash("sha1").update(baseContent).digest("hex"),
      tools: finalizeOptions.tools,
      masterSubAgentDelegate: finalizeOptions.masterSubAgentDelegate,
      agentAccessMode: finalizeOptions.agentAccessMode,
      desktopBridgeOnline: finalizeOptions.desktopBridgeOnline,
      phoneBridgeOnline: finalizeOptions.phoneBridgeOnline,
      suppressRuntimeSuffixes: finalizeOptions.suppressRuntimeSuffixes,
      functionalSuffixes: finalizeOptions.functionalSuffixes,
    });

    const cached = this.systemPromptCache.get(cacheKey);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < OpenAiOfficialProvider.CACHE_TTL_MS) {
      return cached.content;
    }

    const sysContent = finalizeChatSystemPrompt(baseContent, finalizeOptions);

    this.systemPromptCache.set(cacheKey, {
      content: sysContent,
      timestamp: now,
    });

    return sysContent;
  }

  /** 手动清除所有缓存（用于配置变更等场景） */
  clearSystemPromptCache(): void {
    this.systemPromptCache.clear();
  }

  /**
   * 智能模型路由：根据任务复杂度和上下文选择最优模型
   * 预期效果：成本 -40%, 简单任务速度 +50%
   */
  selectOptimalModel(userText: string, messageCount: number): string {
    // 如果配置了强制使用特定模型，直接返回
    const forceModel = process.env.FORCE_MODEL?.trim();
    if (forceModel) return forceModel;

    // 分析任务复杂度
    const complexity = this.analyzeTaskComplexityForModel(userText, messageCount);

    // 可用模型池（按成本从低到高排序）
    const modelPool = [
      { name: process.env.FAST_MODEL || 'gpt-4o-mini', maxComplexity: 0.3 },
      { name: process.env.STANDARD_MODEL || 'gpt-4o', maxComplexity: 0.7 },
      { name: process.env.POWER_MODEL || 'gpt-4-turbo', maxComplexity: 1.0 },
    ];

    // 选择最适合的模型
    for (const modelConfig of modelPool) {
      if (complexity <= modelConfig.maxComplexity) {
        return modelConfig.name;
      }
    }

    // 默认返回标准模型
    return this.model;
  }

  /**
   * 分析任务复杂度（用于模型选择）
   * 返回值范围：0.0（最简单）到 1.0（最复杂）
   */
  private analyzeTaskComplexityForModel(userText: string, messageCount: number): number {
    let score = 0;

    // 1. 文本长度评分 (0 - 0.25)
    if (userText.length > 1000) score += 0.25;
    else if (userText.length > 500) score += 0.18;
    else if (userText.length > 200) score += 0.12;
    else if (userText.length > 50) score += 0.06;

    // 2. 问题数量评分 (0 - 0.15)
    const questionCount = (userText.match(/[？?。]/g) || []).length;
    score += Math.min(questionCount * 0.05, 0.15);

    // 3. 关键词复杂度评分 (0 - 0.25)
    const complexKeywords = [
      '分析', 'analyze', '比较', 'compare', '总结', 'summarize',
      '优化', 'optimize', '设计', 'design', '实现', 'implement',
      '架构', 'architecture', '算法', 'algorithm', '推理', 'reasoning'
    ];
    const matchedKeywords = complexKeywords.filter(kw =>
      userText.toLowerCase().includes(kw)
    ).length;
    score += Math.min(matchedKeywords * 0.05, 0.25);

    // 4. 上下文长度评分 (0 - 0.20)
    if (messageCount > 10) score += 0.20;
    else if (messageCount > 6) score += 0.15;
    else if (messageCount > 3) score += 0.08;

    // 5. 特殊模式检测 (0 - 0.15)
    const hasCodeBlock = userText.includes('```') || userText.includes('code');
    const hasMathExpression = /[\+\-\*\/\=\<\>\{\}]/.test(userText);
    const hasStructuredData = userText.includes('{') && userText.includes('}');

    if (hasCodeBlock) score += 0.08;
    if (hasMathExpression) score += 0.04;
    if (hasStructuredData) score += 0.03;

    return Math.min(score, 1.0);
  }

  // ── 基类钩子实现 ──────────────────────────────────────────────

  /** 智能模型路由：override 优先，否则按任务复杂度选择。 */
  protected resolveModel(
    streamOpts: AgentStreamOptions | undefined,
    userText: string,
    msgCount: number,
  ): string {
    const override = streamOpts?.modelOverride?.trim();
    if (override) return override;
    return this.selectOptimalModel(userText, msgCount);
  }

  /**
   * 构造 extraBody：thinking 开关 + fastProfile（Fast 模式跳过强制 tool_choice）。
   * 仅用于工具分支（applyExtraBodyToPlainRequest 默认 false，非工具分支不 spread）。
   */
  protected buildExtraBody(effectiveStreamOpts: AgentStreamOptions): Record<string, unknown> | undefined {
    const out: Record<string, unknown> = {};
    if (effectiveStreamOpts.disableThinking) {
      out.thinking = { type: "disabled" };
    }
    if (effectiveStreamOpts.toolExposureProfile === "contextual" || effectiveStreamOpts.toolExposureProfile === "light") {
      out.fastProfile = true;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /**
   * 构建 system 内容（走 5 分钟 LRU 缓存 + 分层 prompt）与 prompt cache plan。
   */
  protected buildSystemAndPlan(ctx: SystemAndPlanContext): SystemAndPlanResult {
    const finalizeOptions = {
      tools: Boolean(ctx.tools && !ctx.overrideSys),
      masterSubAgentDelegate: ctx.streamOpts?.masterSubAgentDelegate,
      agentAccessMode: ctx.streamOpts?.agentAccessMode,
      desktopBridgeOnline: ctx.streamOpts?.desktopBridgeOnline,
      phoneBridgeOnline: ctx.streamOpts?.phoneBridgeOnline,
      ...(ctx.suppressSuffixes ? {
        suppressRuntimeSuffixes: true,
        functionalSuffixes: ctx.streamOpts?.functionalSuffixes !== false,
      } : {}),
    };

    const baseContent = ctx.overrideSys
      ? // 修复：overrideSys（minimal/fast 模式的身份 prompt）不能直接跳过记忆分层——
        // 否则 promptMemory（narrativeRecall 等）永远不注入，对话中长期记忆失忆。
        // 把 overrideSys 作为 baseSystem 传入 buildLayeredSystemPrompt，memory 为空时
        // 原样返回 overrideSys（行为兼容），memory 非空时正常附加记忆块。
        buildLayeredSystemPrompt(ctx.overrideSys, ctx.promptMemory)
      : buildLayeredSystemPrompt(SYSTEM_PROMPT, ctx.promptMemory);
    const sysContent = this.getCachedOrBuildSystemPrompt(baseContent, finalizeOptions);

    // TEMP DEBUG（记忆注入诊断 4：最终 system prompt 是否含记忆）
    try {
      appendFileSync(
        ".memory-inject-debug.log",
        JSON.stringify({
          t: new Date().toISOString(),
          phase: "sysContent",
          memoryInSystem: sysContent.includes("记忆图联想检索"),
          memoryBlock: sysContent.slice(sysContent.indexOf("记忆图联想检索"), sysContent.indexOf("记忆图联想检索") + 300),
          hasOverride: Boolean(ctx.overrideSys),
          promptMemoryNarrative: Boolean(ctx.promptMemory?.narrativeRecall),
          baseContentHasNarrative: baseContent.includes("记忆图联想检索"),
          baseContentHead: baseContent.slice(0, 200),
        }) + "\n",
      );
    } catch {
      /* ignore */
    }

    const promptPlan = preparePromptCachePlan({
      providerId: this.id,
      model: ctx.model,
      baseSystemPrompt: ctx.overrideSys || SYSTEM_PROMPT,
      // 修复：之前 overrideSys 时 memory 传 undefined，导致 promptPlan.requestSystemMessages
      // 只含稳定 system（无记忆）。而发送阶段 applyPromptCacheMessages 会用
      // requestSystemMessages 覆盖 msgs[0]（带记忆的 sysContent），
      // 于是 overrideSys（fast/minimal）实际发给 LLM 的请求里记忆被丢弃，
      // 表现为"记忆已注入但 LLM 失忆"。改为始终传入 memory。
      memory: ctx.promptMemory,
      finalizeOptions,
      tools: ctx.toolSearchPrepared?.visibleTools,
      variant: ctx.tools ? "chat-tools" : "chat",
    });

    return { sysContent, promptPlan };
  }
}
