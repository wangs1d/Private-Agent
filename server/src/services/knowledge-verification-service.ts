/**
 * 知识验证服务 —— 学知识闭环的"真实性"保证。
 *
 * 与普通联网能力的根本区别：
 *  - 联网：临时拉取信息，未经验证，有真有假
 *  - 学知识：沉淀 → 验证 → 反馈修正 → 置信度收敛，得到 Agent 自己的知识库
 *
 * 三道闸门 + 置信度收敛：
 *
 *  1. **采集闸门（pending_verification）**：联网拉取的内容首次沉淀时标记为
 *     "待验证"，初始置信度 0.3。此时知识已在库中但不会被高优先级召回。
 *
 *  2. **正反馈闸门（verified）**：用户基于该知识回答后**不再追问同类问题**，
 *     视为通过验证，置信度提升至 0.7。若用户明确表达确认（"对的"、"谢谢"、
 *     "好的"），升级为 verified_strong，置信度 0.9。
 *
 *  3. **负反馈闸门（disputed）**：用户继续追问同类问题，视为验证失败
 *     （知识有问题 / 不准确 / 已过时），置信度降至 0.1，标记 disputed。
 *     多次负反馈后状态冻结为 rejected，从 active 集合移除。
 *
 * 召回差异化：
 *  - RAG 召回时优先返回 verified / verified_strong 知识
 *  - pending_verification 知识仅在无 verified 命中时返回（且标记"可能不准确"）
 *  - disputed / rejected 不返回
 *
 * 持久化：data/knowledge-verification.json
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

// ---- 类型定义 --------------------------------------------------------

/** 知识验证状态 */
export type KnowledgeStatus =
  | "pending_verification" // 待验证（刚联网沉淀）
  | "verified"             // 已验证（用户不追问，通过）
  | "verified_strong"      // 强验证（用户明确确认）
  | "disputed"             // 有争议（用户追问同类，置信度下降）
  | "rejected";            // 已拒绝（多次负反馈，从 active 集合移除）

/** 知识条目 */
export interface KnowledgeEntry {
  id: string;
  /** 主题词（用于匹配用户后续请求） */
  topic: string;
  /** 知识正文（联网拉取并摘要后的内容） */
  content: string;
  /** 来源 URL 或 RAG 标识 */
  source: string;
  status: KnowledgeStatus;
  /** 置信度 0~1，随验证反馈动态收敛 */
  confidence: number;
  /** 沉淀时间 */
  createdAt: string;
  /** 最近一次验证状态更新时间 */
  lastVerifiedAt: string;
  /** 验证历史轨迹 */
  verificationHistory: Array<{
    timestamp: string;
    action: "created" | "positive_feedback" | "negative_feedback" | "explicit_confirm" | "rejected";
    confidenceDelta: number;
    reason: string;
  }>;
  /** 负反馈累积次数（达到阈值转 rejected） */
  negativeFeedbackCount: number;
}

/** 持久化结构 */
interface PersistEnvelope {
  version: 1;
  entries: KnowledgeEntry[];
}

// ---- 阈值常量 --------------------------------------------------------

/** 初始置信度：联网拉取后未验证 */
const INITIAL_CONFIDENCE = 0.3;
/** 用户不追问 → 通过验证的置信度 */
const VERIFIED_CONFIDENCE = 0.7;
/** 用户明确确认 → 强验证的置信度 */
const VERIFIED_STRONG_CONFIDENCE = 0.9;
/** 用户追问同类 → 争议状态的置信度 */
const DISPUTED_CONFIDENCE = 0.1;
/** 单次正反馈置信度增量 */
const POSITIVE_DELTA = 0.1;
/** 单次负反馈置信度减量 */
const NEGATIVE_DELTA = 0.15;
/** 负反馈次数达到此阈值 → rejected */
const REJECTED_NEGATIVE_THRESHOLD = 3;

/** 用户确认/感谢关键词（强正反馈） */
const EXPLICIT_CONFIRM_KEYWORDS = [
  "对的", "是的", "没错", "正确", "准确", "好的", "谢谢", "感谢",
  "thanks", "thank you", "correct", "right", "exactly",
];

// ---- KnowledgeVerificationService -----------------------------------

export class KnowledgeVerificationService {
  private readonly entries = new Map<string, KnowledgeEntry>();
  /** topic → entryId[] 反向索引，加速反馈匹配 */
  private readonly topicIndex = new Map<string, Set<string>>();

  private readonly persistPath: string;
  private persistTimer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(opts?: { persistPath?: string }) {
    this.persistPath =
      opts?.persistPath ??
      process.env.KNOWLEDGE_VERIFICATION_PERSIST_PATH?.trim() ??
      join(process.cwd(), "data", "knowledge-verification.json");
  }

  // ---- 生命周期 --------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) {
      console.log("[KnowledgeVerification] 已启动，跳过重复 start");
      return;
    }
    await this.load();
    this.started = true;
    console.log(
      `[KnowledgeVerification] 启动完成（已加载 ${this.entries.size} 条知识条目）`,
    );
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.flush();
    this.started = false;
    console.log("[KnowledgeVerification] 已停止");
  }

  // ---- 采集闸门：注册待验证知识 -----------------------------------------

  /**
   * 注册一条新沉淀的知识（联网拉取后调用）。
   *
   * 初始状态：pending_verification，置信度 0.3
   * 后续通过 observeInteraction 累积反馈，状态会动态演进。
   *
   * @returns entryId（用于后续验证状态查询）
   */
  registerPendingKnowledge(params: {
    topic: string;
    content: string;
    source: string;
  }): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    const entry: KnowledgeEntry = {
      id,
      topic: params.topic,
      content: params.content,
      source: params.source,
      status: "pending_verification",
      confidence: INITIAL_CONFIDENCE,
      createdAt: now,
      lastVerifiedAt: now,
      verificationHistory: [
        {
          timestamp: now,
          action: "created",
          confidenceDelta: INITIAL_CONFIDENCE,
          reason: `联网拉取并沉淀，来源=${params.source}`,
        },
      ],
      negativeFeedbackCount: 0,
    };

    this.entries.set(id, entry);
    this.indexTopic(params.topic, id);
    this.schedulePersist();
    console.log(
      `[KnowledgeVerification] 注册待验证知识 id=${id.slice(0, 8)} topic="${params.topic}" 置信度=${INITIAL_CONFIDENCE}`,
    );
    return id;
  }

  // ---- 反馈闸门：观察用户交互，更新置信度 --------------------------------

  /**
   * 观察一次用户交互，匹配已沉淀知识的主题，触发验证状态演进。
   *
   * 反馈识别规则：
   *  1. 用户消息含确认/感谢关键词 → 强正反馈 → verified_strong
   *  2. 用户消息命中某已沉淀主题 + 工具调用成功 → 负反馈（用户还在追问同类）
   *     → 置信度下降，累积达阈值转 disputed → rejected
   *  3. 用户消息未命中任何已沉淀主题 → 隐式正反馈（不再追问 = 通过）
   *     → pending_verification 升级为 verified
   *
   * @param params.userRequest 用户当前请求文本
   * @param params.toolSuccess 工具调用是否成功
   * @param params.matchedTopics 本次请求涉及的已沉淀主题（由调用方匹配后传入）
   */
  observeInteraction(params: {
    userRequest: string;
    toolSuccess: boolean;
    /** 调用方已匹配到的 topic 列表（命中已沉淀知识） */
    matchedTopics?: string[];
  }): void {
    if (this.entries.size === 0) return;

    const { userRequest, toolSuccess } = params;
    const lowerReq = userRequest.toLowerCase();
    const matchedTopics = params.matchedTopics ?? this.matchTopics(userRequest);

    // 规则 1：强正反馈（用户明确确认）
    if (EXPLICIT_CONFIRM_KEYWORDS.some((kw) => lowerReq.includes(kw.toLowerCase()))) {
      for (const topic of matchedTopics) {
        this.applyStrongPositiveFeedback(topic, "用户明确确认");
      }
      return;
    }

    // 规则 2：负反馈（用户追问同类 + 工具调用成功）
    // 语义：工具能用，但用户还在问同类 → 沉淀的知识有问题
    if (matchedTopics.length > 0 && toolSuccess) {
      for (const topic of matchedTopics) {
        this.applyNegativeFeedback(topic, "用户继续追问同类问题");
      }
      return;
    }

    // 规则 3：隐式正反馈（用户切换话题 = 上次回答满足了需求）
    // 把所有 pending_verification 状态的知识升级为 verified
    this.applyImplicitPositiveFeedback(matchedTopics);
  }

  // ---- 查询接口 --------------------------------------------------------

  /** 按 topic 查询已沉淀知识（按置信度降序） */
  queryByTopic(topic: string): KnowledgeEntry[] {
    const ids = this.topicIndex.get(topic);
    if (!ids) return [];
    return [...ids]
      .map((id) => this.entries.get(id))
      .filter((e): e is KnowledgeEntry => !!e && e.status !== "rejected")
      .sort((a, b) => b.confidence - a.confidence);
  }

  /** 查询所有 active 知识（非 rejected） */
  queryActive(): KnowledgeEntry[] {
    return [...this.entries.values()]
      .filter((e) => e.status !== "rejected")
      .sort((a, b) => b.confidence - a.confidence);
  }

  /** 按 ID 查询 */
  getById(id: string): KnowledgeEntry | null {
    return this.entries.get(id) ?? null;
  }

  /** 获取统计快照（用于 UI 展示 / 日志） */
  getStats(): {
    total: number;
    pending: number;
    verified: number;
    verifiedStrong: number;
    disputed: number;
    rejected: number;
  } {
    const stats = {
      total: this.entries.size,
      pending: 0,
      verified: 0,
      verifiedStrong: 0,
      disputed: 0,
      rejected: 0,
    };
    for (const e of this.entries.values()) {
      switch (e.status) {
        case "pending_verification": stats.pending++; break;
        case "verified": stats.verified++; break;
        case "verified_strong": stats.verifiedStrong++; break;
        case "disputed": stats.disputed++; break;
        case "rejected": stats.rejected++; break;
      }
    }
    return stats;
  }

  // ---- 内部：状态演进 ---------------------------------------------------

  /** 匹配用户请求命中的已沉淀主题 */
  private matchTopics(userRequest: string): string[] {
    const matched: string[] = [];
    for (const topic of this.topicIndex.keys()) {
      if (userRequest.includes(topic)) {
        matched.push(topic);
      }
    }
    return matched;
  }

  /** 强正反馈：用户明确确认 → verified_strong */
  private applyStrongPositiveFeedback(topic: string, reason: string): void {
    const ids = this.topicIndex.get(topic);
    if (!ids) return;
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      if (entry.status === "rejected") continue;

      const oldStatus = entry.status;
      entry.status = "verified_strong";
      entry.confidence = VERIFIED_STRONG_CONFIDENCE;
      entry.lastVerifiedAt = new Date().toISOString();
      entry.verificationHistory.push({
        timestamp: entry.lastVerifiedAt,
        action: "explicit_confirm",
        confidenceDelta: VERIFIED_STRONG_CONFIDENCE - entry.confidence,
        reason,
      });
      console.log(
        `[KnowledgeVerification] 强正反馈 topic="${topic}" ${oldStatus}→verified_strong 置信度=${entry.confidence}`,
      );
    }
    this.schedulePersist();
  }

  /** 负反馈：用户追问同类 → 置信度下降，累积达阈值转 rejected */
  private applyNegativeFeedback(topic: string, reason: string): void {
    const ids = this.topicIndex.get(topic);
    if (!ids) return;
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      if (entry.status === "rejected") continue;

      const oldStatus = entry.status;
      const oldConfidence = entry.confidence;
      entry.negativeFeedbackCount++;
      entry.confidence = Math.max(0, oldConfidence - NEGATIVE_DELTA);

      if (entry.negativeFeedbackCount >= REJECTED_NEGATIVE_THRESHOLD) {
        entry.status = "rejected";
        entry.verificationHistory.push({
          timestamp: new Date().toISOString(),
          action: "rejected",
          confidenceDelta: -oldConfidence,
          reason: `${reason}（累积 ${entry.negativeFeedbackCount} 次负反馈）`,
        });
        console.log(
          `[KnowledgeVerification] 知识被拒绝 topic="${topic}" 累积负反馈=${entry.negativeFeedbackCount}`,
        );
      } else {
        entry.status = "disputed";
        entry.verificationHistory.push({
          timestamp: new Date().toISOString(),
          action: "negative_feedback",
          confidenceDelta: -NEGATIVE_DELTA,
          reason,
        });
        console.log(
          `[KnowledgeVerification] 负反馈 topic="${topic}" ${oldStatus}→disputed 置信度=${oldConfidence}→${entry.confidence}`,
        );
      }
      entry.lastVerifiedAt = new Date().toISOString();
    }
    this.schedulePersist();
  }

  /** 隐式正反馈：用户不再追问同类 → pending_verification 升级为 verified */
  private applyImplicitPositiveFeedback(matchedTopics: string[]): void {
    const now = new Date().toISOString();
    for (const entry of this.entries.values()) {
      if (entry.status !== "pending_verification") continue;
      // 若本次用户请求没有命中该 entry 的主题（说明用户切换话题了）
      if (matchedTopics.includes(entry.topic)) continue;

      // 状态升级为 verified，置信度直接设为 VERIFIED_CONFIDENCE
      // （pending_verification 初始 0.3，升级时一次性跳到 0.7，不增量累积）
      const oldConfidence = entry.confidence;
      entry.status = "verified";
      entry.confidence = VERIFIED_CONFIDENCE;
      entry.lastVerifiedAt = now;
      entry.verificationHistory.push({
        timestamp: now,
        action: "positive_feedback",
        confidenceDelta: VERIFIED_CONFIDENCE - oldConfidence,
        reason: "用户不再追问同类问题（隐式正反馈）",
      });
      console.log(
        `[KnowledgeVerification] 隐式正反馈 topic="${entry.topic}" pending→verified 置信度=${oldConfidence}→${entry.confidence}`,
      );
    }
    this.schedulePersist();
  }

  private indexTopic(topic: string, entryId: string): void {
    if (!this.topicIndex.has(topic)) {
      this.topicIndex.set(topic, new Set());
    }
    this.topicIndex.get(topic)!.add(entryId);
  }

  // ---- 持久化 ----------------------------------------------------------

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      void this.flush().catch((err) => {
        console.warn("[KnowledgeVerification] 持久化失败:", err);
      });
    }, 1000);
    if (typeof this.persistTimer.unref === "function") {
      this.persistTimer.unref();
    }
  }

  private async flush(): Promise<void> {
    const envelope: PersistEnvelope = {
      version: 1,
      entries: [...this.entries.values()],
    };
    try {
      await mkdir(dirname(this.persistPath), { recursive: true });
      await writeFile(this.persistPath, JSON.stringify(envelope, null, 2), "utf8");
    } catch (err) {
      console.warn("[KnowledgeVerification] flush 写入失败:", err);
    }
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const envelope = JSON.parse(raw) as PersistEnvelope;
      if (envelope.version !== 1) return;
      for (const entry of envelope.entries ?? []) {
        this.entries.set(entry.id, entry);
        this.indexTopic(entry.topic, entry.id);
      }
    } catch {
      // 文件不存在或解析失败 → 空库启动
    }
  }
}
