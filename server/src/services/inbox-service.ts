/**
 * 站内信服务：平台/运营侧 → 用户收件箱。
 *
 * 与邻近链路的边界：
 * - message-hub：外部平台（wechat/qq/feishu）消息聚合，不是站内信；
 * - proactive pipeline：Agent 自主触达（频控/仲裁/升级推送），不经本服务。
 *
 * 必达语义：先落盘再实时——每条消息先写入 data/inbox/{actorId}.json
 * （离线用户重连/打开邮箱时经 GET /api/inbox/messages 拉到），随后对在线设备
 * 经 WS 直推 `inbox.message` 事件做即时提醒。已读状态（readAt）服务端记账，
 * 多端共享；同一 messageId 幂等，调用方重试不会产生重复消息。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { writeJsonAtomic } from "../storage/atomic-json.js";
import type { WsConnectionRegistry } from "./ws-connection-registry.js";

export type InboxImportance = "low" | "normal" | "high" | "critical";

export type InboxMessage = {
  messageId: string;
  actorId: string;
  /** 发送方（平台身份/另一 actor）；系统消息可缺省 */
  fromActorId?: string;
  /** 消息分类：system / announcement / friend / ... 客户端据此选图标 */
  kind: string;
  title: string;
  body: string;
  importance: InboxImportance;
  /** ISO 时间戳 */
  createdAt: string;
  /** 已读时间（ISO）；null = 未读 */
  readAt: string | null;
};

export type InboxSendInput = {
  actorId: string;
  title: string;
  body: string;
  kind?: string;
  importance?: InboxImportance;
  fromActorId?: string;
  /** 幂等键：调用方自带消息 id 时，重复投递同一 id 不会产生第二条 */
  messageId?: string;
};

export type InboxSendResult = {
  message: InboxMessage;
  /** WS 实时直推是否送达（至少一台在线设备）；false = 当前离线，已落盘待拉取 */
  deliveredLive: boolean;
};

/** 每 actor 最多保留条数（超出丢最旧） */
const MAX_PER_ACTOR = 500;

export class InboxService {
  /** actorId → 收件箱（懒加载自磁盘，写穿） */
  private readonly buckets = new Map<string, InboxMessage[]>();
  private readonly loading = new Map<string, Promise<InboxMessage[]>>();
  private seq = 0;

  constructor(
    private readonly deps: {
      rootDir: string;
      wsRegistry?: WsConnectionRegistry | null;
    },
  ) {}

  private filePathFor(actorId: string): string {
    // actorId 一般是安全标识；防御性替换路径分隔符等字符
    const safe = actorId.replace(/[^A-Za-z0-9._-]/g, "_");
    return join(this.deps.rootDir, `${safe}.json`);
  }

  private async loadBucket(actorId: string): Promise<InboxMessage[]> {
    const cached = this.buckets.get(actorId);
    if (cached) return cached;
    const inflight = this.loading.get(actorId);
    if (inflight) return inflight;
    const task = (async () => {
      let bucket: InboxMessage[] = [];
      try {
        const parsed: unknown = JSON.parse(await readFile(this.filePathFor(actorId), "utf8"));
        if (Array.isArray(parsed)) bucket = parsed as InboxMessage[];
      } catch {
        /* 首次无文件：空箱 */
      }
      this.buckets.set(actorId, bucket);
      this.loading.delete(actorId);
      return bucket;
    })();
    this.loading.set(actorId, task);
    return task;
  }

  private async persist(actorId: string): Promise<void> {
    try {
      await writeJsonAtomic(this.filePathFor(actorId), this.buckets.get(actorId) ?? []);
    } catch (err) {
      console.warn(`[inbox] persist failed for ${actorId}:`, err);
    }
  }

  private wsPayload(m: InboxMessage): Record<string, unknown> {
    return {
      messageId: m.messageId,
      title: m.title,
      body: m.body,
      kind: m.kind,
      importance: m.importance,
      ...(m.fromActorId ? { fromActorId: m.fromActorId } : {}),
      createdAt: m.createdAt,
    };
  }

  /** 发送一条站内信：先落盘（必达），再对在线设备 WS 实时直推 */
  async send(input: InboxSendInput): Promise<InboxSendResult> {
    const bucket = await this.loadBucket(input.actorId);
    const pushLive = (m: InboxMessage): boolean =>
      this.deps.wsRegistry?.trySend(
        input.actorId,
        JSON.stringify({ type: "inbox.message", payload: this.wsPayload(m) }),
      ) ?? false;
    if (input.messageId) {
      const existing = bucket.find((m) => m.messageId === input.messageId);
      if (existing) return { message: existing, deliveredLive: pushLive(existing) };
    }
    const message: InboxMessage = {
      messageId:
        input.messageId ?? `inbox_${Date.now().toString(36)}_${(this.seq++).toString(36)}`,
      actorId: input.actorId,
      ...(input.fromActorId ? { fromActorId: input.fromActorId } : {}),
      kind: input.kind ?? "system",
      title: input.title,
      body: input.body,
      importance: input.importance ?? "normal",
      createdAt: new Date().toISOString(),
      readAt: null,
    };
    bucket.push(message);
    if (bucket.length > MAX_PER_ACTOR) {
      bucket.splice(0, bucket.length - MAX_PER_ACTOR);
    }
    await this.persist(input.actorId);
    return { message, deliveredLive: pushLive(message) };
  }

  /** 按时间倒序列出收件箱（unreadOnly=true 只看未读） */
  async list(
    actorId: string,
    opts?: { limit?: number; unreadOnly?: boolean },
  ): Promise<InboxMessage[]> {
    const bucket = await this.loadBucket(actorId);
    const filtered = opts?.unreadOnly
      ? bucket.filter((m) => m.readAt == null)
      : bucket;
    const sorted = [...filtered].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const limit = opts?.limit;
    return limit && limit > 0 ? sorted.slice(0, limit) : sorted;
  }

  async unreadCount(actorId: string): Promise<number> {
    const bucket = await this.loadBucket(actorId);
    return bucket.filter((m) => m.readAt == null).length;
  }

  /** 批量置已读；ids 缺省 = 全部未读。返回实际标记条数。 */
  async markRead(actorId: string, ids?: string[]): Promise<number> {
    const bucket = await this.loadBucket(actorId);
    const now = new Date().toISOString();
    let marked = 0;
    for (const message of bucket) {
      if (message.readAt != null) continue;
      if (ids && !ids.includes(message.messageId)) continue;
      message.readAt = now;
      marked++;
    }
    if (marked > 0) await this.persist(actorId);
    return marked;
  }
}
