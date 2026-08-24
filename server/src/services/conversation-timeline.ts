/**
 * 对话时间线记忆（Conversation Timeline Memory）
 *
 * 参照扣子（Coze）的记忆设计：对话记忆不仅要"全量入库 + 压缩归档"，还要
 * 把对话的**时间线事实**显式记住：
 *   - 首次对话时间（第一次认识用户是什么时候）
 *   - 累计对话轮次 / 最近一次对话时间（认识多久了、上次聊是什么时候）
 *
 * 这些是"对话历史能否被回答"的元事实。此前系统只把对话写入过程性日志
 * （HermesLoop / EvolutionLoop 节点、session recap），缺少显式的首次对话
 * 事实，导致用户问"我们第一次对话是在什么时候"时 recall 无法命中确定答案。
 *
 * 设计：
 *   - 首次遇到某 actor 时，把"第一次对话"作为 highSignal 事实写入 human-like
 *     长期记忆图（source=conversation:timeline:first），recall 可直接命中；
 *   - 每轮对话更新内存态（first/last 时间 + 轮次），并惰性写回时间线事实；
 *   - 对已有长期记忆的老 actor（无时间线记录），用其记忆图中最早节点时间
 *     回填首次对话时间，避免把"今天"误记为首次。
 *   - getTimelineForPrompt 生成时间线摘要注入 prompt，回答
 *     "第一次对话/认识多久/上次聊天"类问题时 LLM 有确定信息可用。
 */

import { getHumanLikeMemoryService } from "./human-like-memory-service.js";

/** 时间戳 → 本地可读文本（Asia/Shanghai），用于时间线事实与 prompt 注入 */
function formatTimelineTimestamp(ts: number): string {
  const d = new Date(ts);
  const p = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return p.format(d);
}

/** 时间线事实写入 long-term 记忆时使用的 source 标识（用于幂等查找） */
export const CONVERSATION_TIMELINE_SOURCE = "conversation:timeline:first";

export interface ConversationTimelineState {
  firstConversationAt: number | null;
  lastConversationAt: number | null;
  turnCount: number;
  /** 首次事实是否已写入长期记忆图（避免重复 appendVersion） */
  firstFactPersisted: boolean;
}

export class ConversationTimelineService {
  private readonly timelines = new Map<string, ConversationTimelineState>();

  /**
   * 每轮对话完成后调用：更新时间线状态，首次对话时把"第一次对话"写成真实记忆。
   * 幂等且同步快（写图走 fire-and-forget）。
   */
  recordTurn(actorId: string, now = Date.now()): void {
    if (!actorId) return;

    let state = this.timelines.get(actorId);
    if (!state) {
      state = this.initialize(actorId, now);
      this.timelines.set(actorId, state);
    }

    state.turnCount += 1;
    state.lastConversationAt = now;

    // 首次事实未持久化（含新 actor 初始化 / 老 actor 回填）→ 写入长期记忆
    if (!state.firstFactPersisted && state.firstConversationAt !== null) {
      state.firstFactPersisted = true;
      const firstDate = formatTimelineTimestamp(state.firstConversationAt);
      const narrative = getHumanLikeMemoryService();
      void narrative
        ?.ingest(
          actorId,
          `[对话时间线] 用户与助手于 ${firstDate} 开始第一次对话。`,
          CONVERSATION_TIMELINE_SOURCE,
          { metadata: { highSignal: true } },
        )
        .catch((err: unknown) =>
          console.warn(`[conversation-timeline] 首次对话事实写入失败(actor=${actorId}): ${String(err)}`),
        );
    }
  }

  /** 生成注入 prompt 的时间线摘要（无记录时返回 null，零注入） */
  getTimelineForPrompt(actorId: string): string | null {
    const state = this.timelines.get(actorId);
    if (!state || state.firstConversationAt === null) return null;

    const first = formatTimelineTimestamp(state.firstConversationAt);
    const parts = [`【对话时间线】用户与你的第一次对话开始于 ${first}`, `累计对话 ${state.turnCount} 轮`];
    if (state.lastConversationAt) {
      parts.push(`最近一次对话：${formatTimelineTimestamp(state.lastConversationAt)}`);
    }
    return parts.join("；") + "。";
  }

  /**
   * 初始化时间线状态。
   * 老 actor（长期记忆图中已有最早节点）→ 以最早节点时间回填首次对话时间；
   * 全新 actor → 以当前时间为首次对话时间。
   */
  private initialize(actorId: string, now: number): ConversationTimelineState {
    const { earliest, factExists } = this.findEarliestMemoryTs(actorId);
    return {
      firstConversationAt: earliest ?? now,
      lastConversationAt: null,
      turnCount: 0,
      // 已有时间线事实节点 → 无需再写；老 actor 仅回填时间、但事实尚未落图 → 需要写
      firstFactPersisted: factExists,
    };
  }

  /**
   * 从 human-like 记忆图探测该 actor 的时间线事实：
   * - 返回最早节点写入时间（老用户回填用）与"是否已存在时间线事实节点"
   */
  private findEarliestMemoryTs(
    actorId: string,
  ): { earliest: number | null; factExists: boolean } {
    const svc = getHumanLikeMemoryService();
    if (!svc) return { earliest: null, factExists: false };
    try {
      const nodes = svc.getAllNodes(actorId);
      let earliest: number | null = null;
      let factExists = false;
      for (const node of nodes) {
        if (node.source === CONVERSATION_TIMELINE_SOURCE) factExists = true;
        const ts = Date.parse(node.timestamp);
        if (Number.isFinite(ts) && (earliest === null || ts < earliest)) {
          earliest = ts;
        }
      }
      return { earliest, factExists };
    } catch {
      return { earliest: null, factExists: false };
    }
  }
}

// ─── 全局单例（装配处注入，turn-lifecycle / prompt-context-builder 同步使用）───
let globalTimeline: ConversationTimelineService | null = null;

export function setConversationTimelineService(svc: ConversationTimelineService | null): void {
  globalTimeline = svc;
}

export function getConversationTimelineService(): ConversationTimelineService | null {
  return globalTimeline;
}