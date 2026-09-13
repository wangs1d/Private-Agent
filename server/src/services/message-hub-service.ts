import { randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";

import {
  MessageHubSqliteStore,
  type MessageHubGlobalStats,
  type MessageHubPlatformStat,
  type MessageHubRecentMessage,
  type PlatformStat,
} from "./message-hub-sqlite-store.js";

export type MessageHubPlatform = "wechat" | "qq" | "feishu" | "sms" | "generic";
export type MessageHubDirection = "inbound" | "outbound";
export type MessageHubImportance = "high" | "normal";

export type MessageHubConversation = {
  conversationId: string;
  actorId: string;
  platform: MessageHubPlatform;
  channelId: string;
  title?: string;
  participantId?: string;
  participantName?: string;
  lastMessageAt: string;
  unreadCount: number;
  lastMessagePreview: string;
  createdAt: string;
  updatedAt: string;
};

export type MessageHubMessage = {
  messageId: string;
  actorId: string;
  conversationId: string;
  platform: MessageHubPlatform;
  channelId: string;
  direction: MessageHubDirection;
  senderId?: string;
  senderName?: string;
  text: string;
  createdAt: string;
  replyToMessageId?: string;
  externalMessageId?: string;
  meta?: Record<string, unknown>;
};

export type MessageHubInboundInput = {
  actorId: string;
  platform: MessageHubPlatform;
  channelId: string;
  text: string;
  participantId?: string;
  participantName?: string;
  title?: string;
  senderId?: string;
  senderName?: string;
  externalMessageId?: string;
  meta?: Record<string, unknown>;
};

export type MessageHubOutboundInput = {
  actorId: string;
  platform: MessageHubPlatform;
  channelId: string;
  text: string;
  participantId?: string;
  participantName?: string;
  title?: string;
  senderId?: string;
  senderName?: string;
  replyToMessageId?: string;
  externalMessageId?: string;
  meta?: Record<string, unknown>;
};

/** 旧 JSON 存储结构（一次性迁移用） */
type LegacyStore = {
  conversations?: MessageHubConversation[];
  messages?: MessageHubMessage[];
};

export type MessageHubOverview = {
  totalUnread: number;
  platforms: PlatformStat[];
};

/** 重要度最小关键词规则：命中即 high，供 MessageWatchTrigger 主动提醒用。 */
const IMPORTANCE_KEYWORDS =
  /改期|改时间|推迟|延期|取消|延误|停运|停飞|请尽快回复|尽快回复|马上回电|速回|紧急|重要通知|立刻| ASAP|asap/;

export function assessMessageImportance(text: string): MessageHubImportance {
  return IMPORTANCE_KEYWORDS.test(text) ? "high" : "normal";
}

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(limit as number)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(limit as number)));
}

function previewText(text: string): string {
  const v = text.replace(/\s+/g, " ").trim();
  return v.length <= 80 ? v : `${v.slice(0, 77)}...`;
}

export class MessageHubService {
  private store: MessageHubSqliteStore | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;

  /**
   * @param legacyJsonPath 旧 JSON 存储路径；load() 时若存在则一次性导入 SQLite
   *                       并改名 .migrated。之后不再读它。
   * @param dbPath         SQLite 库路径（缺省 data/message-hub/message-hub.db，
   *                       AGENT_MESSAGE_HUB_DB 覆盖）。
   */
  constructor(
    private readonly legacyJsonPath: string,
    private readonly dbPath?: string,
  ) {}

  /** 入站消息统一回调（bootstrap 装配 proactivity 消息监控触发器用）：
   * 每条 inbound 落库后同步触发；回调自身异常已在触发器内静默，不影响落库。 */
  onInbound?: (input: MessageHubInboundInput, message: MessageHubMessage) => void;

  async load(): Promise<void> {
    this.store = new MessageHubSqliteStore(this.dbPath ? this.dbPath : undefined);
    await this.migrateLegacyJsonIfNeeded();
    // prune：启动清一次 + 每日一次（unref 不阻止进程退出）
    this.prune();
    this.pruneTimer = setInterval(() => this.prune(), 24 * 3600_000);
    this.pruneTimer.unref?.();
  }

  stop(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  /** 全库消息统计（管理概览）；库未加载时返回 null。 */
  globalStats(days = 14): MessageHubGlobalStats | null {
    return this.store ? this.store.globalStats(days) : null;
  }

  /** 按平台聚合（管理后台站内信页）；库未加载时返回 null。 */
  platformStats(): MessageHubPlatformStat[] | null {
    return this.store ? this.store.platformStats() : null;
  }

  /** 跨身份最近消息（管理后台站内信页）；库未加载时返回 null。 */
  recentMessages(limit = 30): MessageHubRecentMessage[] | null {
    return this.store ? this.store.recentMessages(limit) : null;
  }

  private async migrateLegacyJsonIfNeeded(): Promise<void> {
    if (!this.legacyJsonPath) return;
    let raw: string;
    try {
      raw = await readFile(this.legacyJsonPath, "utf8");
    } catch {
      return; // 无旧文件，直接用空库
    }
    let legacy: LegacyStore;
    try {
      legacy = JSON.parse(raw) as LegacyStore;
    } catch {
      // 损坏文件：改名让用户可查，不阻塞启动
      await rename(this.legacyJsonPath, `${this.legacyJsonPath}.corrupt`).catch(() => {});
      return;
    }
    this.store?.importLegacy(legacy.conversations ?? [], legacy.messages ?? []);
    await rename(this.legacyJsonPath, `${this.legacyJsonPath}.migrated`).catch(() => {});
  }

  private requireStore(): MessageHubSqliteStore {
    if (!this.store) throw new Error("MessageHubService not loaded; call load() first");
    return this.store;
  }

  private prune(): void {
    try {
      const days = Number(process.env.MESSAGE_HUB_RETENTION_DAYS ?? "") || undefined;
      this.store?.prune(days);
    } catch {
      // 清理失败不影响主流程
    }
  }

  private makeConversationId(actorId: string, platform: MessageHubPlatform, channelId: string): string {
    return `${actorId}::${platform}::${channelId}`;
  }

  /**
   * 入站消息：落库 + 重要度打标（meta.importance）+ 触发 onInbound。
   * externalMessageId 命中去重时静默返回已存在消息（不重复计未读、不重复触发）。
   */
  async ingestInbound(input: MessageHubInboundInput): Promise<{ conversation: MessageHubConversation; message: MessageHubMessage; deduped: boolean }> {
    const store = this.requireStore();
    const now = new Date().toISOString();
    const conversationId = this.makeConversationId(input.actorId, input.platform, input.channelId);

    const importance = assessMessageImportance(input.text);
    const meta: Record<string, unknown> = {
      ...input.meta,
      importance,
      capturedAt: now,
    };

    const message: MessageHubMessage = {
      messageId: randomUUID(),
      actorId: input.actorId,
      conversationId,
      platform: input.platform,
      channelId: input.channelId,
      direction: "inbound",
      senderId: input.senderId ?? input.participantId,
      senderName: input.senderName ?? input.participantName,
      text: input.text,
      createdAt: now,
      externalMessageId: input.externalMessageId,
      meta,
    };

    // 先插消息：external_message_id 唯一索引判重，命中则不重复计未读/不触发
    const inserted = store.insertMessage({
      ...message,
      meta: meta as Record<string, unknown> | undefined,
    });
    if (!inserted) {
      const existing = input.externalMessageId
        ? store.getMessageByExternalId(input.actorId, input.platform, input.externalMessageId)
        : null;
      const conv = store.getConversation(input.actorId, conversationId);
      if (existing && conv) return { conversation: conv, message: existing, deduped: true };
      return { conversation: conv ?? this.reflectionConversation(input, conversationId), message, deduped: true };
    }

    const conversation = store.upsertConversation({
      actorId: input.actorId,
      conversationId,
      platform: input.platform,
      channelId: input.channelId,
      title: input.title,
      participantId: input.participantId,
      participantName: input.participantName,
      incrementUnread: true,
      lastMessageText: input.text,
      lastMessageAt: now,
    });
    this.onInbound?.(input, message);
    return { conversation, message, deduped: false };
  }

  /** 兜底：判重路径下会话行理论上必然存在；万一缺失则按输入重建（不计未读）。 */
  private reflectionConversation(input: MessageHubInboundInput, conversationId: string): MessageHubConversation {
    const now = new Date().toISOString();
    return {
      conversationId,
      actorId: input.actorId,
      platform: input.platform,
      channelId: input.channelId,
      title: input.title,
      participantId: input.participantId,
      participantName: input.participantName,
      lastMessageAt: now,
      unreadCount: 0,
      lastMessagePreview: previewText(input.text),
      createdAt: now,
      updatedAt: now,
    };
  }

  async createOutbound(input: MessageHubOutboundInput): Promise<{ conversation: MessageHubConversation; message: MessageHubMessage }> {
    const store = this.requireStore();
    const now = new Date().toISOString();
    const conversationId = this.makeConversationId(input.actorId, input.platform, input.channelId);
    const conversation = store.upsertConversation({
      actorId: input.actorId,
      conversationId,
      platform: input.platform,
      channelId: input.channelId,
      title: input.title,
      participantId: input.participantId,
      participantName: input.participantName,
      incrementUnread: false,
      lastMessageText: input.text,
      lastMessageAt: now,
    });
    const message: MessageHubMessage = {
      messageId: randomUUID(),
      actorId: input.actorId,
      conversationId,
      platform: input.platform,
      channelId: input.channelId,
      direction: "outbound",
      senderId: input.senderId,
      senderName: input.senderName,
      text: input.text,
      createdAt: now,
      replyToMessageId: input.replyToMessageId,
      externalMessageId: input.externalMessageId,
      meta: input.meta,
    };
    store.insertMessage({
      ...message,
      meta: message.meta as Record<string, unknown> | undefined,
    });
    return { conversation, message };
  }

  listConversations(actorId: string, opts?: { platform?: string; limit?: number }): MessageHubConversation[] {
    return this.requireStore().listConversations(actorId, {
      platform: opts?.platform,
      limit: clampLimit(opts?.limit, 50, 200),
    });
  }

  getConversation(actorId: string, conversationId: string): MessageHubConversation | null {
    return this.requireStore().getConversation(actorId, conversationId);
  }

  listMessages(actorId: string, conversationId: string, opts?: { limit?: number }): MessageHubMessage[] {
    return this.requireStore().listMessages(actorId, conversationId, {
      limit: clampLimit(opts?.limit, 50, 500),
    });
  }

  async markConversationRead(actorId: string, conversationId: string): Promise<boolean> {
    return this.requireStore().markConversationRead(actorId, conversationId);
  }

  getMessage(actorId: string, messageId: string): MessageHubMessage | null {
    return this.requireStore().getMessage(actorId, messageId);
  }

  /** 各平台未读/会话统计（messages.overview 工具用，纯计数不总结）。 */
  overview(actorId: string): MessageHubOverview {
    const platforms = this.requireStore().overviewStats(actorId);
    return {
      totalUnread: platforms.reduce((sum, p) => sum + p.unreadCount, 0),
      platforms,
    };
  }

  async draftReply(actorId: string, conversationId: string, text: string): Promise<MessageHubMessage | null> {
    const conversation = this.getConversation(actorId, conversationId);
    if (!conversation) return null;
    const created = await this.createOutbound({
      actorId,
      platform: conversation.platform,
      channelId: conversation.channelId,
      text,
      participantId: conversation.participantId,
      participantName: conversation.participantName,
      title: conversation.title,
      meta: { draft: true },
    });
    return created.message;
  }
}
