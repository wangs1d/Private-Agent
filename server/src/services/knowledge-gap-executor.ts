/**
 * 知识缺口执行器（学知识层）—— 仿人自我学习的"学知识"闭环。
 *
 * 与普通联网能力的根本区别（用户强调的关键设计）：
 *
 *  联网 = 临时拉取，未经验证，有真有假
 *  学知识 = 沉淀 → 验证 → 反馈修正 → 置信度收敛，得到 Agent 自己的知识库
 *
 * 三阶段闭环 + 三道验证闸门：
 *
 *  1. **RAG 召回（带置信度过滤）**：先查本地已沉淀的知识
 *     - 优先返回 verified / verified_strong 高置信度知识
 *     - pending_verification 知识仅在无高置信度命中时返回，且标记"可能不准确"
 *     - disputed / rejected 知识不返回
 *
 *  2. **联网兜底 + LLM 摘要**：若 RAG 召回不足
 *     - 调 desktop.http_get 拉取网页内容
 *     - 调轻量 LLM 做摘要（去除噪音、提炼核心事实）→ 提升 RAG 命中率
 *     - 不调 LLM 时降级为 HTML 粗去标签（保持向后兼容）
 *
 *  3. **记忆沉淀 + 注册验证**：
 *     - 写入 NarrativeMemoryPort（向量库）+ memory_facts（KV，带验证状态标签）
 *     - 调 KnowledgeVerificationService.registerPendingKnowledge 注册待验证条目
 *       初始置信度 0.3，等用户反馈累积后通过 observeInteraction 收敛
 *
 * 反馈回路（由 EvolutionCortex.recordToolInteraction 触发）：
 *  - 用户基于知识回答后不再追问同类 → 隐式正反馈 → verified（置信度 0.7）
 *  - 用户明确确认（"对的"/"谢谢"）→ 强正反馈 → verified_strong（置信度 0.9）
 *  - 用户继续追问同类 → 负反馈 → disputed → rejected（多次累积后）
 *
 * 设计原则：
 *  - 知识不是危险操作，不需要用户审批装载
 *  - 但写入需可审计：日志 + source 字段 + verificationId
 *  - 联网内容必须经验证才能升级为"可信知识"
 *  - 验证状态机由外部反馈驱动，不依赖 LLM 自评
 */
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { NarrativeMemoryPort } from "./narrative-memory-port.js";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";
import type { KnowledgeVerificationService, KnowledgeStatus } from "./knowledge-verification-service.js";
import type { ExternalChatProvider } from "../external-model/types.js";

/** RAG 召回视为"命中"的最小内容长度（过短视为召回失败） */
const RAG_HIT_MIN_LENGTH = 80;

/** 联网查询结果沉淀到记忆时的最大长度（避免噪音 + token 浪费） */
const WEB_SNIPPET_MAX_LENGTH = 1500;

/** LLM 摘要目标长度（字符） */
const LLM_SUMMARY_TARGET_LENGTH = 400;

/** 知识沉淀时给 NarrativeMemoryPort 的 source 标识 */
const KNOWLEDGE_SOURCE_WEB = "knowledge-gap:web";
const KNOWLEDGE_SOURCE_RAG = "knowledge-gap:rag";

/** 默认联网查询 URL 模板（可用环境变量 KNOWLEDGE_GAP_SEARCH_URL 覆盖） */
const DEFAULT_SEARCH_URL_TEMPLATE =
  "https://www.bing.com/search?q={query}&format=rss";

/** 验证状态 → memory_facts 标签映射 */
const STATUS_LABEL: Record<KnowledgeStatus, string> = {
  pending_verification: "待验证",
  verified: "已验证",
  verified_strong: "强验证",
  disputed: "有争议",
  rejected: "已拒绝",
};

export interface KnowledgeGapExecutorDeps {
  /** 用于调 desktop.http_get 联网查询 */
  toolRegistry: ToolRegistry;
  /** RAG 召回 + 叙事记忆写入入口 */
  narrativeMemory: NarrativeMemoryPort | null;
  /** 结构化 KV facts 写入入口（memory_facts 字段） */
  memorySync: AgentMemorySyncService | null;
  /** 知识验证服务（跟踪置信度 + 反馈累积） */
  verification: KnowledgeVerificationService | null;
  /** 外部 LLM provider（用于摘要网页内容）；null 时降级为 HTML 粗去标签 */
  chatProvider?: ExternalChatProvider | null;
  /** 联网搜索 URL 模板，必须含 {query} 占位符 */
  searchUrlTemplate?: string;
}

export class KnowledgeGapExecutor {
  constructor(private readonly deps: KnowledgeGapExecutorDeps) {}

  /**
   * 执行知识缺口闭环：RAG 召回 → 联网兜底 + LLM 摘要 → 记忆沉淀 + 注册验证。
   *
   * 返回值：
   *  - ok=true + ragHit=true：本地知识库已命中（仅返回高置信度知识）
   *  - ok=true + ragHit=false：联网查询成功 + LLM 摘要 + 已沉淀并注册待验证
   *  - ok=false：联网查询失败（错误原因在 error 中），等下轮重试
   */
  async executeKnowledgeGap(params: {
    actorId: string;
    query: string;
    rationale: string;
  }): Promise<{
    ok: boolean;
    knowledge?: string;
    source?: string;
    ragHit?: boolean;
    verificationId?: string;
    confidence?: number;
    error?: string;
  }> {
    const { actorId, query } = params;
    console.log(
      `[KnowledgeGapExecutor] 启动知识闭环 query="${query}" actorId=${actorId}`,
    );

    // === 阶段 1：RAG 召回（带置信度过滤）===
    const ragResult = await this.recallFromRag(actorId, query);
    if (ragResult.hit) {
      console.log(
        `[KnowledgeGapExecutor] RAG 命中（${ragResult.text.length} 字符，置信度=${ragResult.confidence ?? "unknown"}），无需联网`,
      );
      return {
        ok: true,
        knowledge: ragResult.text,
        source: KNOWLEDGE_SOURCE_RAG,
        ragHit: true,
        confidence: ragResult.confidence,
        verificationId: ragResult.verificationId,
      };
    }
    console.log(
      `[KnowledgeGapExecutor] RAG 召回不足（${ragResult.text.length} 字符 < ${RAG_HIT_MIN_LENGTH}），转联网兜底`,
    );

    // === 阶段 2：联网兜底 ===
    const webResult = await this.fetchFromWeb(query);
    if (!webResult.ok) {
      return {
        ok: false,
        error: webResult.error ?? "联网查询失败",
      };
    }
    const rawSnippet = this.extractSnippet(webResult.body ?? "", query);
    if (!rawSnippet) {
      return {
        ok: false,
        error: "联网查询返回内容为空或无法提取有效片段",
      };
    }
    console.log(
      `[KnowledgeGapExecutor] 联网查询成功（${rawSnippet.length} 字符原始片段），进入摘要阶段`,
    );

    // === 阶段 2.5：LLM 摘要（去噪 + 提炼核心事实）===
    const summarized = await this.summarize(rawSnippet, query);
    console.log(
      `[KnowledgeGapExecutor] 摘要完成（${summarized.length} 字符），开始沉淀记忆`,
    );

    // === 阶段 3：记忆沉淀 + 注册验证 ===
    const verificationId = await this.ingestKnowledge(actorId, query, summarized);

    return {
      ok: true,
      knowledge: summarized,
      source: KNOWLEDGE_SOURCE_WEB,
      ragHit: false,
      verificationId,
      confidence: 0.3, // 初始置信度
    };
  }

  // ---- 阶段 1：RAG 召回（带置信度过滤）---------------------------------

  /**
   * 先从 verification service 取已沉淀的高置信度知识，
   * 若无则降级查 NarrativeMemoryPort（兼容旧数据）。
   */
  private async recallFromRag(
    actorId: string,
    query: string,
  ): Promise<{ hit: boolean; text: string; confidence?: number; verificationId?: string }> {
    // 优先：从 verification service 查已沉淀知识
    if (this.deps.verification) {
      const entries = this.deps.verification.queryByTopic(query);
      // 过滤：仅返回 verified / verified_strong / pending_verification（按置信度降序）
      const usable = entries.filter(
        (e) => e.status === "verified" || e.status === "verified_strong" || e.status === "pending_verification",
      );
      if (usable.length > 0 && usable[0].content.length >= RAG_HIT_MIN_LENGTH) {
        const best = usable[0];
        const tag =
          best.status === "pending_verification" ? "【可能不准确·待验证】" : "";
        return {
          hit: true,
          text: `${tag}${best.content}`,
          confidence: best.confidence,
          verificationId: best.id,
        };
      }
    }

    // 兼容：NarrativeMemoryPort（若 verification 未命中）
    if (!this.deps.narrativeMemory) {
      return { hit: false, text: "" };
    }
    try {
      const text = await this.deps.narrativeMemory.buildNarrativeRecall(actorId, query);
      return {
        hit: text.length >= RAG_HIT_MIN_LENGTH,
        text,
      };
    } catch (err) {
      console.warn(
        `[KnowledgeGapExecutor] RAG 召回异常：${err instanceof Error ? err.message : String(err)}`,
      );
      return { hit: false, text: "" };
    }
  }

  // ---- 阶段 2：联网查询 ------------------------------------------------

  private async fetchFromWeb(
    query: string,
  ): Promise<{ ok: boolean; body?: string; error?: string }> {
    const template =
      this.deps.searchUrlTemplate ??
      process.env.KNOWLEDGE_GAP_SEARCH_URL ??
      DEFAULT_SEARCH_URL_TEMPLATE;

    if (!template.includes("{query}")) {
      return { ok: false, error: "searchUrlTemplate 缺少 {query} 占位符" };
    }
    const url = template.replace("{query}", encodeURIComponent(query));

    try {
      // 通过 toolRegistry.execute 复用 desktop.http_get 的 URL 白名单 + 超时 + 审计
      // ToolContext 用最小化字段（仅审计必需的 sessionId）
      const result = await this.deps.toolRegistry.execute(
        "desktop.http_get",
        { url, timeoutMs: 15000 },
        { sessionId: `knowledge-gap-${Date.now()}` },
      );
      if (!result.ok) {
        return {
          ok: false,
          error:
            typeof result.result?.error === "string"
              ? String(result.result.error).slice(0, 200)
              : "desktop.http_get 返回失败",
        };
      }
      const body =
        typeof result.result?.body === "string"
          ? (result.result.body as string)
          : typeof result.result?.text === "string"
            ? (result.result.text as string)
            : result.result
              ? JSON.stringify(result.result).slice(0, WEB_SNIPPET_MAX_LENGTH)
              : "";
      return { ok: true, body };
    } catch (err) {
      return {
        ok: false,
        error: `desktop.http_get 调用异常：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 从 HTML/RSS/JSON 文本中提取有效片段。
   *
   * 策略：去除 HTML 标签 + 去除多余空白 + 截取前 WEB_SNIPPET_MAX_LENGTH 字符
   */
  private extractSnippet(rawBody: string, query: string): string {
    if (!rawBody) return "";
    const text = rawBody
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return "";
    const snippet = text.slice(0, WEB_SNIPPET_MAX_LENGTH);
    return `[${query}] ${snippet}`;
  }

  // ---- 阶段 2.5：LLM 摘要（去噪 + 提炼核心事实）-----------------------

  /**
   * 用 LLM 把网页内容压缩成 200-400 字的事实摘要。
   *
   * 价值：
   *  - 去除导航/广告/脚本噪音，沉淀到向量库后 RAG 命中率显著提升
   *  - 提炼核心事实而非原文片段，避免 token 浪费
   *  - LLM 失败时降级为原始 snippet 截断（保持向后兼容）
   */
  private async summarize(snippet: string, query: string): Promise<string> {
    // 不配置 LLM 时直接降级
    if (!this.deps.chatProvider || !this.deps.chatProvider.isEnabled()) {
      console.log("[KnowledgeGapExecutor] 未配置 chatProvider，降级为原始 snippet");
      return snippet.slice(0, LLM_SUMMARY_TARGET_LENGTH);
    }

    const systemPrompt =
      "你是知识摘要器。把网页内容提炼成 200-400 字的事实摘要，" +
      "去除导航/广告/脚本噪音，只保留与查询关键词相关的核心事实（数据、定义、结论）。" +
      "禁止任何对话式回复（如\"好的\"、\"稍等\"、\"我来帮你\"等）。" +
      "直接输出摘要文本，不要加任何前缀或代码块包裹。";

    const userPrompt =
      `查询关键词：${query}\n\n` +
      `网页内容（已去 HTML 标签）：\n${snippet.slice(0, 2000)}\n\n` +
      `请提炼出与"${query}"相关的核心事实摘要（200-400 字）：`;

    try {
      let summary = "";
      await this.deps.chatProvider.streamCompletion(
        `knowledge-summary-${Date.now()}`,
        { text: userPrompt },
        (delta) => { summary += delta; },
        undefined,
        {
          systemPromptOverride: systemPrompt,
          ephemeralTurn: true,
          maxThreadMessages: 2,
        },
      );
      const trimmed = summary.trim();
      if (trimmed.length < 50) {
        console.warn(
          `[KnowledgeGapExecutor] LLM 摘要过短（${trimmed.length} 字符），降级为原始 snippet`,
        );
        return snippet.slice(0, LLM_SUMMARY_TARGET_LENGTH);
      }
      return trimmed.slice(0, LLM_SUMMARY_TARGET_LENGTH);
    } catch (err) {
      console.warn(
        `[KnowledgeGapExecutor] LLM 摘要异常：${err instanceof Error ? err.message : String(err)}，降级为原始 snippet`,
      );
      return snippet.slice(0, LLM_SUMMARY_TARGET_LENGTH);
    }
  }

  // ---- 阶段 3：记忆沉淀 + 注册验证 --------------------------------------

  /**
   * 沉淀到三个载体：
   *  1. NarrativeMemoryPort.ingest（向量库 + Mem0）
   *  2. memory_facts KV（带验证状态标签）
   *  3. KnowledgeVerificationService.registerPendingKnowledge（验证状态机入口）
   */
  private async ingestKnowledge(
    actorId: string,
    query: string,
    summary: string,
  ): Promise<string | undefined> {
    const ingestText = `[${query}] ${summary}`;

    // 写入向量库 + 叙事记忆
    if (this.deps.narrativeMemory) {
      try {
        await this.deps.narrativeMemory.ingest(
          actorId,
          ingestText,
          KNOWLEDGE_SOURCE_WEB,
          { highSignal: true, context: "main" },
        );
        console.log(
          `[KnowledgeGapExecutor] 已写入叙事记忆（NarrativeMemoryPort.ingest）`,
        );
      } catch (err) {
        console.warn(
          `[KnowledgeGapExecutor] 叙事记忆写入失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 注册到验证服务（初始 pending_verification, 置信度 0.3）
    let verificationId: string | undefined;
    if (this.deps.verification) {
      try {
        verificationId = this.deps.verification.registerPendingKnowledge({
          topic: query,
          content: summary,
          source: KNOWLEDGE_SOURCE_WEB,
        });
      } catch (err) {
        console.warn(
          `[KnowledgeGapExecutor] 注册验证失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 写入结构化 KV facts（带验证状态标签，区别于联网事实）
    if (this.deps.memorySync) {
      try {
        const statusLabel = verificationId ? STATUS_LABEL.pending_verification : "未验证";
        const factLine =
          `【知识·${statusLabel}·置信度0.3】${query}：${summary.slice(0, 200)}...`;
        this.deps.memorySync.appendMemorySummaryLine(actorId, factLine, "knowledge");
        console.log(
          `[KnowledgeGapExecutor] 已写入 memory_facts（标签：知识·${statusLabel}）`,
        );
      } catch (err) {
        console.warn(
          `[KnowledgeGapExecutor] KV facts 写入失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return verificationId;
  }
}
