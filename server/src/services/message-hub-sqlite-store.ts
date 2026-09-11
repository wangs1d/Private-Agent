/**
 * 消息聚合中心 SQLite 存储内核（照 agentic-memory/sqlite-store.ts 模式）。
 *
 * 库文件缺省 data/message-hub/message-hub.db（AGENT_MESSAGE_HUB_DB 覆盖）。
 * 两张表：
 *   - mh_conversations 会话表（未读计数、最新预览）
 *   - mh_messages      消息表（append-only，external_message_id 唯一去重）
 *
 * 去重靠部分唯一索引 (actor_id, platform, external_message_id)（仅非 NULL 生效）：
 * 手机通知捕捉可能重复上报同一条通知，INSERT OR IGNORE + changes 即可判重，
 * 不需要应用层先查后插。
 *
 * better-sqlite3 为同步本地库：所有方法都是同步的，调用方 await 兼容。
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import type { Database as SqliteDatabase, Statement } from "better-sqlite3";

import type { MessageHubConversation, MessageHubMessage } from "./message-hub-service.js";

export function getMessageHubDbPath(): string {
  return (
    process.env.AGENT_MESSAGE_HUB_DB?.trim() ||
    join(process.cwd(), "data", "message-hub", "message-hub.db")
  );
}

/** 打开（或创建）消息聚合库：WAL + 外键。 */
export function openMessageHubSqlite(path?: string): SqliteDatabase {
  const file = path ?? getMessageHubDbPath();
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function toJsonColumn(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function fromJsonColumn<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

type ConversationRow = {
  conversation_id: string;
  actor_id: string;
  platform: string;
  channel_id: string;
  title: string | null;
  participant_id: string | null;
  participant_name: string | null;
  last_message_at: string;
  unread_count: number;
  last_message_preview: string;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  message_id: string;
  actor_id: string;
  conversation_id: string;
  platform: string;
  channel_id: string;
  direction: string;
  sender_id: string | null;
  sender_name: string | null;
  text: string;
  created_at: string;
  reply_to_message_id: string | null;
  external_message_id: string | null;
  meta: string | null;
};

function rowToConversation(row: ConversationRow): MessageHubConversation {
  return {
    conversationId: row.conversation_id,
    actorId: row.actor_id,
    platform: row.platform as MessageHubConversation["platform"],
    channelId: row.channel_id,
    title: row.title ?? undefined,
    participantId: row.participant_id ?? undefined,
    participantName: row.participant_name ?? undefined,
    lastMessageAt: row.last_message_at,
    unreadCount: row.unread_count,
    lastMessagePreview: row.last_message_preview,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMessage(row: MessageRow): MessageHubMessage {
  return {
    messageId: row.message_id,
    actorId: row.actor_id,
    conversationId: row.conversation_id,
    platform: row.platform as MessageHubMessage["platform"],
    channelId: row.channel_id,
    direction: row.direction as MessageHubMessage["direction"],
    senderId: row.sender_id ?? undefined,
    senderName: row.sender_name ?? undefined,
    text: row.text,
    createdAt: row.created_at,
    replyToMessageId: row.reply_to_message_id ?? undefined,
    externalMessageId: row.external_message_id ?? undefined,
    meta: fromJsonColumn<Record<string, unknown> | undefined>(row.meta, undefined),
  };
}

export type ConversationUpsertInput = {
  actorId: string;
  conversationId: string;
  platform: string;
  channelId: string;
  title?: string;
  participantId?: string;
  participantName?: string;
  incrementUnread: boolean;
  lastMessageText: string;
  lastMessageAt: string;
};

export type MessageInsertInput = {
  messageId: string;
  actorId: string;
  conversationId: string;
  platform: string;
  channelId: string;
  direction: "inbound" | "outbound";
  senderId?: string;
  senderName?: string;
  text: string;
  createdAt: string;
  replyToMessageId?: string;
  externalMessageId?: string;
  meta?: Record<string, unknown>;
};

export type PlatformStat = {
  platform: string;
  unreadCount: number;
  conversationCount: number;
  latest: Array<{
    conversationId: string;
    title?: string;
    participantName?: string;
    preview: string;
    lastMessageAt: string;
    unreadCount: number;
  }>;
};

const PRUNE_DEFAULT_RETENTION_DAYS = 7;
const PRUNE_PER_CONVERSATION_CAP = 500;

export class MessageHubSqliteStore {
  private readonly db: SqliteDatabase;
  private readonly insertMessageStmt: Statement;
  private readonly upsertConversationStmt: Statement;

  constructor(db?: SqliteDatabase | string) {
    // 支持传路径字符串（message-hub-service 持有 dbPath 配置）：按需打开，父目录不存在则创建
    if (typeof db === "string") {
      mkdirSync(dirname(db), { recursive: true });
      this.db = new Database(db);
    } else {
      this.db = db ?? openMessageHubSqlite();
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mh_conversations (
        conversation_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        title TEXT,
        participant_id TEXT,
        participant_name TEXT,
        last_message_at TEXT NOT NULL,
        unread_count INTEGER NOT NULL DEFAULT 0,
        last_message_preview TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (actor_id, conversation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_mh_conv_actor_platform
        ON mh_conversations(actor_id, platform, updated_at DESC);

      CREATE TABLE IF NOT EXISTS mh_messages (
        message_id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        sender_id TEXT,
        sender_name TEXT,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reply_to_message_id TEXT,
        external_message_id TEXT,
        meta TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mh_msg_conv_time
        ON mh_messages(actor_id, conversation_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mh_msg_external
        ON mh_messages(actor_id, platform, external_message_id)
        WHERE external_message_id IS NOT NULL;
    `);
    this.upsertConversationStmt = this.db.prepare(`
      INSERT INTO mh_conversations (
        conversation_id, actor_id, platform, channel_id, title,
        participant_id, participant_name, last_message_at,
        unread_count, last_message_preview, created_at, updated_at
      ) VALUES (
        @conversation_id, @actor_id, @platform, @channel_id, @title,
        @participant_id, @participant_name, @last_message_at,
        @unread_delta, @last_message_preview, @now, @now
      )
      ON CONFLICT(actor_id, conversation_id) DO UPDATE SET
        title = COALESCE(excluded.title, mh_conversations.title),
        participant_id = COALESCE(excluded.participant_id, mh_conversations.participant_id),
        participant_name = COALESCE(excluded.participant_name, mh_conversations.participant_name),
        last_message_at = excluded.last_message_at,
        last_message_preview = excluded.last_message_preview,
        updated_at = excluded.updated_at,
        unread_count = mh_conversations.unread_count + excluded.unread_count
    `);
    this.insertMessageStmt = this.db.prepare(`
      INSERT OR IGNORE INTO mh_messages (
        message_id, actor_id, conversation_id, platform, channel_id,
        direction, sender_id, sender_name, text, created_at,
        reply_to_message_id, external_message_id, meta
      ) VALUES (
        @message_id, @actor_id, @conversation_id, @platform, @channel_id,
        @direction, @sender_id, @sender_name, @text, @created_at,
        @reply_to_message_id, @external_message_id, @meta
      )
    `);
  }

  upsertConversation(input: ConversationUpsertInput): MessageHubConversation {
    this.upsertConversationStmt.run({
      conversation_id: input.conversationId,
      actor_id: input.actorId,
      platform: input.platform,
      channel_id: input.channelId,
      title: input.title ?? null,
      participant_id: input.participantId ?? null,
      participant_name: input.participantName ?? null,
      last_message_at: input.lastMessageAt,
      unread_delta: input.incrementUnread ? 1 : 0,
      last_message_preview: input.lastMessageText,
      now: new Date().toISOString(),
    });
    return this.getConversation(input.actorId, input.conversationId)!;
  }

  /** @returns true=新插入；false=externalMessageId 命中唯一索引判重跳过 */
  insertMessage(input: MessageInsertInput): boolean {
    const result = this.insertMessageStmt.run({
      message_id: input.messageId,
      actor_id: input.actorId,
      conversation_id: input.conversationId,
      platform: input.platform,
      channel_id: input.channelId,
      direction: input.direction,
      sender_id: input.senderId ?? null,
      sender_name: input.senderName ?? null,
      text: input.text,
      created_at: input.createdAt,
      reply_to_message_id: input.replyToMessageId ?? null,
      external_message_id: input.externalMessageId ?? null,
      meta: toJsonColumn(input.meta),
    });
    return result.changes > 0;
  }

  listConversations(
    actorId: string,
    opts?: { platform?: string; limit?: number },
  ): MessageHubConversation[] {
    const limit = Math.max(1, Math.min(200, Math.trunc(opts?.limit ?? 50)));
    const rows = (opts?.platform
      ? this.db.prepare(`
          SELECT * FROM mh_conversations
          WHERE actor_id = ? AND platform = ?
          ORDER BY updated_at DESC LIMIT ?
        `)
      : this.db.prepare(`
          SELECT * FROM mh_conversations
          WHERE actor_id = ?
          ORDER BY updated_at DESC LIMIT ?
        `)
    ).all(...(opts?.platform ? [actorId, opts.platform, limit] : [actorId, limit])) as ConversationRow[];
    return rows.map(rowToConversation);
  }

  getConversation(actorId: string, conversationId: string): MessageHubConversation | null {
    const row = this.db
      .prepare(`SELECT * FROM mh_conversations WHERE actor_id = ? AND conversation_id = ?`)
      .get(actorId, conversationId) as ConversationRow | undefined;
    return row ? rowToConversation(row) : null;
  }

  listMessages(
    actorId: string,
    conversationId: string,
    opts?: { limit?: number },
  ): MessageHubMessage[] {
    const limit = Math.max(1, Math.min(500, Math.trunc(opts?.limit ?? 50)));
    const rows = this.db
      .prepare(`
        SELECT * FROM (
          SELECT * FROM mh_messages
          WHERE actor_id = ? AND conversation_id = ?
          ORDER BY created_at DESC LIMIT ?
        ) ORDER BY created_at ASC
      `)
      .all(actorId, conversationId, limit) as MessageRow[];
    return rows.map(rowToMessage);
  }

  getMessage(actorId: string, messageId: string): MessageHubMessage | null {
    const row = this.db
      .prepare(`SELECT * FROM mh_messages WHERE actor_id = ? AND message_id = ?`)
      .get(actorId, messageId) as MessageRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  getMessageByExternalId(
    actorId: string,
    platform: string,
    externalMessageId: string,
  ): MessageHubMessage | null {
    const row = this.db
      .prepare(`
        SELECT * FROM mh_messages
        WHERE actor_id = ? AND platform = ? AND external_message_id = ?
        LIMIT 1
      `)
      .get(actorId, platform, externalMessageId) as MessageRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  markConversationRead(actorId: string, conversationId: string): boolean {
    const result = this.db
      .prepare(`
        UPDATE mh_conversations
        SET unread_count = 0, updated_at = ?
        WHERE actor_id = ? AND conversation_id = ?
      `)
      .run(new Date().toISOString(), actorId, conversationId);
    return result.changes > 0;
  }

  /** 各平台统计（messages.overview 用）：未读数 / 会话数 / 最近 3 条会话预览。 */
  overviewStats(actorId: string, latestPerPlatform = 3): PlatformStat[] {
    const platforms = this.db
      .prepare(`SELECT DISTINCT platform FROM mh_conversations WHERE actor_id = ?`)
      .all(actorId) as Array<{ platform: string }>;
    const unreadStmt = this.db.prepare(`
      SELECT COALESCE(SUM(unread_count), 0) AS unread, COUNT(*) AS convs
      FROM mh_conversations WHERE actor_id = ? AND platform = ?
    `);
    const latestStmt = this.db.prepare(`
      SELECT * FROM mh_conversations
      WHERE actor_id = ? AND platform = ?
      ORDER BY updated_at DESC LIMIT ?
    `);
    const stats: PlatformStat[] = [];
    for (const { platform } of platforms) {
      const agg = unreadStmt.get(actorId, platform) as { unread: number; convs: number };
      const latestRows = latestStmt.all(actorId, platform, latestPerPlatform) as ConversationRow[];
      stats.push({
        platform,
        unreadCount: agg.unread,
        conversationCount: agg.convs,
        latest: latestRows.map((row) => ({
          conversationId: row.conversation_id,
          title: row.title ?? undefined,
          participantName: row.participant_name ?? undefined,
          preview: row.last_message_preview,
          lastMessageAt: row.last_message_at,
          unreadCount: row.unread_count,
        })),
      });
    }
    return stats;
  }

  /**
   * 清理：删除 created_at 早于保留期的消息 + 每会话只留最近 cap 条。
   * SQLite 窗口函数做每会话保留（better-sqlite3 内置现代 SQLite 支持窗口函数）。
   */
  prune(retentionDays?: number, perConversationCap = PRUNE_PER_CONVERSATION_CAP): void {
    const days = Math.max(1, Math.trunc(retentionDays ?? PRUNE_DEFAULT_RETENTION_DAYS));
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    this.db.prepare(`DELETE FROM mh_messages WHERE created_at < ?`).run(cutoff);
    this.db.prepare(`
      DELETE FROM mh_messages WHERE message_id IN (
        SELECT message_id FROM (
          SELECT message_id,
                 ROW_NUMBER() OVER (PARTITION BY actor_id, conversation_id ORDER BY created_at DESC) AS rn
          FROM mh_messages
        ) WHERE rn > ?
      )
    `).run(perConversationCap);
  }

  /** 旧 JSON 全量导入（一次性迁移）：INSERT OR IGNORE 尊重去重索引。 */
  importLegacy(conversations: MessageHubConversation[], messages: MessageHubMessage[]): void {
    const tx = this.db.transaction(() => {
      for (const c of conversations) {
        this.upsertConversation({
          actorId: c.actorId,
          conversationId: c.conversationId,
          platform: c.platform,
          channelId: c.channelId,
          title: c.title,
          participantId: c.participantId,
          participantName: c.participantName,
          incrementUnread: false,
          lastMessageText: c.lastMessagePreview,
          lastMessageAt: c.lastMessageAt,
        });
        // 保留原未读数与创建时间（upsert 的 ON CONFLICT 分支会重置预览时间，
        // 这里直接补一条精确 UPDATE 兜底）
        this.db.prepare(`
          UPDATE mh_conversations
          SET unread_count = ?, created_at = ?, updated_at = ?, last_message_at = ?
          WHERE actor_id = ? AND conversation_id = ?
        `).run(c.unreadCount, c.createdAt, c.updatedAt, c.lastMessageAt, c.actorId, c.conversationId);
      }
      for (const m of messages) {
        this.insertMessage({
          messageId: m.messageId,
          actorId: m.actorId,
          conversationId: m.conversationId,
          platform: m.platform,
          channelId: m.channelId,
          direction: m.direction,
          senderId: m.senderId,
          senderName: m.senderName,
          text: m.text,
          createdAt: m.createdAt,
          replyToMessageId: m.replyToMessageId,
          externalMessageId: m.externalMessageId,
          meta: m.meta,
        });
      }
    });
    tx();
  }
}
