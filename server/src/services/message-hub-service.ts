import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type MessageHubPlatform = "wechat" | "qq" | "feishu" | "generic";
export type MessageHubDirection = "inbound" | "outbound";

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

type MessageHubStore = {
  conversations: MessageHubConversation[];
  messages: MessageHubMessage[];
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

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(limit as number)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(limit as number)));
}

function byTimeDesc<T extends { createdAt?: string; updatedAt?: string; lastMessageAt?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const av = a.updatedAt ?? a.lastMessageAt ?? a.createdAt ?? "";
    const bv = b.updatedAt ?? b.lastMessageAt ?? b.createdAt ?? "";
    return bv.localeCompare(av);
  });
}

function previewText(text: string): string {
  const v = text.replace(/\s+/g, " ").trim();
  return v.length <= 80 ? v : `${v.slice(0, 77)}...`;
}

export class MessageHubService {
  private store: MessageHubStore = { conversations: [], messages: [] };

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<MessageHubStore>;
      this.store = {
        conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      };
    } catch {
      this.store = { conversations: [], messages: [] };
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.store, null, 2), "utf8");
  }

  private makeConversationId(actorId: string, platform: MessageHubPlatform, channelId: string): string {
    return `${actorId}::${platform}::${channelId}`;
  }

  private upsertConversation(params: {
    actorId: string;
    platform: MessageHubPlatform;
    channelId: string;
    title?: string;
    participantId?: string;
    participantName?: string;
    incrementUnread: boolean;
    lastMessageText: string;
    lastMessageAt: string;
  }): MessageHubConversation {
    const conversationId = this.makeConversationId(params.actorId, params.platform, params.channelId);
    const now = new Date().toISOString();
    const existing = this.store.conversations.find((c) => c.conversationId === conversationId);
    if (existing) {
      existing.title = params.title ?? existing.title;
      existing.participantId = params.participantId ?? existing.participantId;
      existing.participantName = params.participantName ?? existing.participantName;
      existing.lastMessageAt = params.lastMessageAt;
      existing.lastMessagePreview = previewText(params.lastMessageText);
      existing.updatedAt = now;
      existing.unreadCount = params.incrementUnread ? existing.unreadCount + 1 : existing.unreadCount;
      return existing;
    }

    const created: MessageHubConversation = {
      conversationId,
      actorId: params.actorId,
      platform: params.platform,
      channelId: params.channelId,
      title: params.title,
      participantId: params.participantId,
      participantName: params.participantName,
      lastMessageAt: params.lastMessageAt,
      unreadCount: params.incrementUnread ? 1 : 0,
      lastMessagePreview: previewText(params.lastMessageText),
      createdAt: now,
      updatedAt: now,
    };
    this.store.conversations.push(created);
    return created;
  }

  async ingestInbound(input: MessageHubInboundInput): Promise<{ conversation: MessageHubConversation; message: MessageHubMessage }> {
    const now = new Date().toISOString();
    const conversation = this.upsertConversation({
      actorId: input.actorId,
      platform: input.platform,
      channelId: input.channelId,
      title: input.title,
      participantId: input.participantId,
      participantName: input.participantName,
      incrementUnread: true,
      lastMessageText: input.text,
      lastMessageAt: now,
    });
    const message: MessageHubMessage = {
      messageId: randomUUID(),
      actorId: input.actorId,
      conversationId: conversation.conversationId,
      platform: input.platform,
      channelId: input.channelId,
      direction: "inbound",
      senderId: input.senderId ?? input.participantId,
      senderName: input.senderName ?? input.participantName,
      text: input.text,
      createdAt: now,
      externalMessageId: input.externalMessageId,
      meta: input.meta,
    };
    this.store.messages.push(message);
    await this.persist();
    return { conversation, message };
  }

  async createOutbound(input: MessageHubOutboundInput): Promise<{ conversation: MessageHubConversation; message: MessageHubMessage }> {
    const now = new Date().toISOString();
    const conversation = this.upsertConversation({
      actorId: input.actorId,
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
      conversationId: conversation.conversationId,
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
    this.store.messages.push(message);
    await this.persist();
    return { conversation, message };
  }

  listConversations(actorId: string, opts?: { platform?: string; limit?: number }): MessageHubConversation[] {
    const limit = clampLimit(opts?.limit, 50, 200);
    return byTimeDesc(
      this.store.conversations.filter((c) => c.actorId === actorId && (!opts?.platform || c.platform === opts.platform)),
    ).slice(0, limit);
  }

  getConversation(actorId: string, conversationId: string): MessageHubConversation | null {
    return this.store.conversations.find((c) => c.actorId === actorId && c.conversationId === conversationId) ?? null;
  }

  listMessages(actorId: string, conversationId: string, opts?: { limit?: number }): MessageHubMessage[] {
    const limit = clampLimit(opts?.limit, 50, 500);
    return byTimeDesc(
      this.store.messages.filter((m) => m.actorId === actorId && m.conversationId === conversationId),
    )
      .slice(0, limit)
      .reverse();
  }

  async markConversationRead(actorId: string, conversationId: string): Promise<boolean> {
    const conversation = this.getConversation(actorId, conversationId);
    if (!conversation) return false;
    conversation.unreadCount = 0;
    conversation.updatedAt = new Date().toISOString();
    await this.persist();
    return true;
  }

  getMessage(actorId: string, messageId: string): MessageHubMessage | null {
    return this.store.messages.find((m) => m.actorId === actorId && m.messageId === messageId) ?? null;
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
