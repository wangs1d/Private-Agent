// 顺嘴搭车队列（P1，2026-10-01）：low 级主动意图不再即时推送，
// 挂起等用户下一轮对话，以受控方式织进回复末尾（括号旁注形态，P2 定稿）。
//
// 动机：低打扰主动消息单独推一条气泡本身就打断（为一句轻关怀弹一条消息，
// 打扰成本 > 信息价值）；用户正在聊天时，「顺着当前回复末尾带一句」才是
// 低打扰的正确形态。队列只做挂起/限频/过期三件事，不做任何判断——
// 该不该说、怎么说由两端的既有闸门与主模型负责。
//
// 治理参数：
//   - TTL：挂起 6 小时无人接话即作废（低价值消息不值得隔夜补刀）
//   - 同 kind 最小间隔 4 小时（同一类关怀一天最多顺嘴一次）
//   - 每 actor 队列上限 3 条（防堆积后一轮连塞多条）
//   - 每轮最多取 1 条（回复尾巴只挂一个旁注）
//
// 仅内存态：低优先级挂起消息重启丢失可接受（少提一句无感知，
// 与 pending 确认/提醒等必达语义不同，不落盘）。
//
// 回滚开关：PROACTIVITY_TURN_ASIDE=0 全局关闭，两条挂起点（hub.speakFeedback /
// proactive-outreach-executor）回退为即时推送的旧行为。

/** 挂起条目 TTL（毫秒） */
const ASIDE_TTL_MS = 6 * 60 * 60_000;
/** 同 kind 两次顺嘴投递的最小间隔（毫秒） */
const ASIDE_KIND_GAP_MS = 4 * 60 * 60_000;
/** 每 actor 挂起上限 */
const ASIDE_QUEUE_CAP = 3;

export type TurnAsideItem = {
  id: string;
  actorId: string;
  kind: string;
  title: string;
  /** 织入提示：给主模型的事实依据（来自意图 summary，确定性数据） */
  hint: string;
  createdAt: number;
  expiresAt: number;
};

/** 搭车通道全局开关（默认开；PROACTIVITY_TURN_ASIDE=0 回退即时推送旧行为） */
export function isTurnAsideEnabled(): boolean {
  const raw = process.env.PROACTIVITY_TURN_ASIDE?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

/** 旁注形态定稿（P2）：块正文给主模型的织入指令与事实 */
export function formatTurnAsidePrompt(item: TurnAsideItem): string {
  return [
    `【顺嘴机会】`,
    `（后台攒下的一件小事。值得提就在回复末尾顺嘴一句，形态=括号旁注，如「（顺嘴一句：…）」，一句话即可；与本轮话题不搭就别提，绝不硬塞）`,
    item.hint || item.title,
  ].join("\n");
}

let seq = 0;

export class TurnAsideQueue {
  private readonly queue = new Map<string, TurnAsideItem[]>();
  /** 最近一次实际织入（take 交付）的时间：actorId → kind → at */
  private readonly lastDelivered = new Map<string, Map<string, number>>();
  private readonly nowFn: () => number;

  constructor(opts?: { nowFn?: () => number }) {
    this.nowFn = opts?.nowFn ?? Date.now;
  }

  /**
   * 挂起一条 low 主动意图。同 kind 已在挂起中、或距上次织入不足间隔时拒绝
   * （返回 false，调用方回退原有即时推送路径——不静默吞消息）。
   */
  tryEnqueue(intent: {
    actorId: string;
    kind: string;
    title: string;
    summary?: string;
  }): boolean {
    const now = this.nowFn();
    const list = this.queue.get(intent.actorId) ?? [];
    if (list.some((x) => x.kind === intent.kind)) return false;
    const last = this.lastDelivered.get(intent.actorId)?.get(intent.kind);
    if (last != null && now - last < ASIDE_KIND_GAP_MS) return false;
    list.unshift({
      id: `aside-${now.toString(36)}-${seq++}`,
      actorId: intent.actorId,
      kind: intent.kind,
      title: intent.title,
      hint: (intent.summary ?? "").slice(0, 160),
      createdAt: now,
      expiresAt: now + ASIDE_TTL_MS,
    });
    if (list.length > ASIDE_QUEUE_CAP) list.length = ASIDE_QUEUE_CAP;
    this.queue.set(intent.actorId, list);
    return true;
  }

  /**
   * 取一条织入本轮回复（每轮至多一条，取走即视为已交付——主模型是否真的
   * 顺嘴由它自行裁量，队列不校验文本）。无可用条目返回 null。
   */
  takeForTurn(actorId: string): TurnAsideItem | null {
    const now = this.nowFn();
    const list = this.queue.get(actorId);
    if (!list || list.length === 0) return null;
    // 越靠前越新，取第一条未过期的；过期的就地作废
    while (list.length > 0) {
      const item = list.shift()!;
      if (now > item.expiresAt) continue;
      const byKind = this.lastDelivered.get(actorId) ?? new Map<string, number>();
      byKind.set(item.kind, now);
      this.lastDelivered.set(actorId, byKind);
      return item;
    }
    return null;
  }

  /** 诊断用：仍挂起的条目（过期未清理的也算，展示原始队列） */
  pending(actorId?: string): TurnAsideItem[] {
    if (actorId) return [...(this.queue.get(actorId) ?? [])];
    return [...this.queue.values()].flat();
  }

  /** 清理全部过期条目（诊断/测试用；takeForTurn 自身已惰性过期） */
  prune(): number {
    const now = this.nowFn();
    let removed = 0;
    for (const [actorId, list] of this.queue) {
      const kept = list.filter((x) => now <= x.expiresAt);
      removed += list.length - kept.length;
      if (kept.length === 0) this.queue.delete(actorId);
      else this.queue.set(actorId, kept);
    }
    return removed;
  }
}
