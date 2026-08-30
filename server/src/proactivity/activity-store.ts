// 助手动态台账：Agent 主动代办结果的唯一落库点（右侧面板「助手动态」卡数据源）。
//
// 记录的是「代办结果」而非消息摘要——消息摘要仍走对话流（proactive_pipeline 的
// fan-out 直推），台账只负责可回溯：用户稍后想查"助手到底帮我订了什么/交了哪笔钱"。
// 写入方：
//  1. ProactiveDeliveryService 投递成功后，kind 以 "action." 开头的提案自动落库；
//  2. POST /agent/activities（Agent 工具链在完成代办后手动上报，可携带结构化 detail）。
// 持久化：单 JSON 文件（persist-file 原子替换），每个 actor 最多保留 MAX_PER_ACTOR 条。
import { readJson, writeJson } from "./persist-file.js";

export type AgentActivityStatus = "pending" | "done" | "failed" | "changed";

export type AgentActivity = {
  id: string;
  actorId: string;
  /** 动作类型：action.purchase / action.payment / action.schedule / ... */
  kind: string;
  /** 展示分类（由 kind 推导）：purchase / payment / schedule / generic，客户端据此选图标 */
  category: string;
  title: string;
  summary: string;
  status: AgentActivityStatus;
  /** 状态文案（配送中 / 已完成 / 已改期...）；缺省时客户端按 status 推导 */
  statusLabel?: string;
  /** 详情键值对（商品 / 金额 / 渠道...），点击条目的详情浮层展示 */
  detail?: Record<string, string>;
  createdAt: number;
  readAt: number | null;
  /** 指纹键：与提案 dedupKey 对齐，避免重连重投导致重复记录 */
  dedupKey?: string;
};

export type RecordActivityInput = {
  actorId: string;
  kind: string;
  title: string;
  summary: string;
  status?: AgentActivityStatus;
  statusLabel?: string;
  detail?: Record<string, string>;
  dedupKey?: string;
};

const MAX_PER_ACTOR = 200;
/** 同一 dedupKey 在该窗口内不重复记录（重连重投保护） */
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

export class AgentActivityStore {
  private activities: AgentActivity[];
  private seq = 0;

  constructor(private readonly filePath: string) {
    this.activities = readJson<AgentActivity[]>(filePath, []);
  }

  private persist(): void {
    writeJson(this.filePath, this.activities);
  }

  /** 由动作类提案推导展示分类：action.payment -> payment */
  static categoryOf(kind: string): string {
    const rest = kind.startsWith("action.") ? kind.slice("action.".length) : kind;
    const head = rest.split(/[._-]/)[0]?.trim().toLowerCase() ?? "";
    return head.length > 0 ? head : "generic";
  }

  /** 未显式给 status 时按 kind 推导：schedule_change 类是「已调整」而非「已完成」 */
  static statusFromKind(kind: string): AgentActivityStatus {
    if (/(change|reschedule|cancel|delay)/i.test(kind)) return "changed";
    if (/fail|error/i.test(kind)) return "failed";
    if (/pending|progress|shipping|deliver/i.test(kind)) return "pending";
    return "done";
  }

  record(input: RecordActivityInput): AgentActivity | null {
    if (input.dedupKey) {
      const cutoff = Date.now() - DEDUP_WINDOW_MS;
      const dup = this.activities.some(
        (a) =>
          a.dedupKey === input.dedupKey &&
          a.actorId === input.actorId &&
          a.createdAt > cutoff,
      );
      if (dup) return null;
    }
    const activity: AgentActivity = {
      id: `act_${Date.now().toString(36)}_${(this.seq++).toString(36)}`,
      actorId: input.actorId,
      kind: input.kind,
      category: AgentActivityStore.categoryOf(input.kind),
      title: input.title,
      summary: input.summary,
      status: input.status ?? AgentActivityStore.statusFromKind(input.kind),
      ...(input.statusLabel ? { statusLabel: input.statusLabel } : {}),
      ...(input.detail && Object.keys(input.detail).length > 0
        ? { detail: input.detail }
        : {}),
      createdAt: Date.now(),
      readAt: null,
      ...(input.dedupKey ? { dedupKey: input.dedupKey } : {}),
    };
    this.activities.push(activity);
    this.trim();
    this.persist();
    return activity;
  }

  /** 每个 actor 只保留最近 MAX_PER_ACTOR 条（原地裁剪，旧的先丢） */
  private trim(): void {
    const byActor = new Map<string, number>();
    for (let i = this.activities.length - 1; i >= 0; i--) {
      const actor = this.activities[i]!.actorId;
      const count = (byActor.get(actor) ?? 0) + 1;
      byActor.set(actor, count);
      if (count > MAX_PER_ACTOR) this.activities.splice(i, 1);
    }
  }

  list(actorId?: string, limit?: number): AgentActivity[] {
    const filtered = actorId
      ? this.activities.filter((a) => a.actorId === actorId)
      : this.activities;
    const sorted = [...filtered].sort((a, b) => b.createdAt - a.createdAt);
    return limit && limit > 0 ? sorted.slice(0, limit) : sorted;
  }

  unreadCount(actorId?: string): number {
    return this.list(actorId).filter((a) => a.readAt == null).length;
  }

  /** 批量置已读；ids 缺省时全量标记。返回实际标记条数。 */
  markRead(actorId: string | undefined, ids?: string[]): number {
    const now = Date.now();
    let marked = 0;
    for (const activity of this.activities) {
      if (actorId && activity.actorId !== actorId) continue;
      if (activity.readAt != null) continue;
      if (ids && !ids.includes(activity.id)) continue;
      activity.readAt = now;
      marked++;
    }
    if (marked > 0) this.persist();
    return marked;
  }
}
