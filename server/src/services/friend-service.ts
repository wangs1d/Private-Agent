import { randomUUID } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";

export type FriendRequestStatus = "pending" | "accepted" | "rejected" | "cancelled";

export type FriendRequestRecord = {
  requestId: string;
  fromActorId: string;
  toActorId: string;
  message?: string;
  status: FriendRequestStatus;
  createdAt: string;
  updatedAt: string;
};

export type FriendRecord = {
  actorId: string;
  friendActorId: string;
  addedAt: string;
  lastMessageAt?: string;
};

type PersistShape = {
  requests?: FriendRequestRecord[];
  friends?: FriendRecord[];
};

/**
 * Agent 好友系统服务：管理好友请求和好友关系
 */
export class FriendService {
  private readonly requests = new Map<string, FriendRequestRecord>();
  private readonly friendsByActor = new Map<string, FriendRecord[]>();

  private get persistPath(): string {
    return process.env.AGENT_FRIENDS_FILE ?? join(process.cwd(), "data", "agent-friends.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const data = JSON.parse(raw) as PersistShape;
      
      this.requests.clear();
      this.friendsByActor.clear();

      // 加载好友请求
      const reqList = data.requests ?? [];
      for (const r of reqList) {
        if (r?.requestId && r.fromActorId && r.toActorId) {
          this.requests.set(r.requestId, r);
        }
      }

      // 加载好友关系
      const friendList = data.friends ?? [];
      for (const f of friendList) {
        if (f?.actorId && f.friendActorId) {
          const list = this.friendsByActor.get(f.actorId) ?? [];
          list.push(f);
          this.friendsByActor.set(f.actorId, list);
        }
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return;
      throw e;
    }
  }

  async persist(): Promise<void> {
    const dir = dirname(this.persistPath);
    await mkdir(dir, { recursive: true });
    
    const requests = Array.from(this.requests.values());
    const friends: FriendRecord[] = [];
    for (const list of this.friendsByActor.values()) {
      friends.push(...list);
    }

    await writeFile(
      this.persistPath,
      JSON.stringify({ requests, friends }, null, 2),
      "utf8"
    );
  }

  /**
   * 发送好友请求
   */
  async sendFriendRequest(
    fromActorId: string,
    toActorId: string,
    message?: string
  ): Promise<{ ok: true; request: FriendRequestRecord } | { ok: false; reason: string }> {
    const from = fromActorId.trim();
    const to = toActorId.trim();

    if (!from || !to) {
      return { ok: false, reason: "用户ID不能为空" };
    }

    if (from === to) {
      return { ok: false, reason: "不能添加自己为好友" };
    }

    // 检查是否已经是好友
    if (this.areFriends(from, to)) {
      return { ok: false, reason: "已经是好友关系" };
    }

    // 检查是否有待处理的请求
    const existingRequest = this.getPendingRequest(from, to);
    if (existingRequest) {
      return { ok: false, reason: "已存在待处理的好友请求" };
    }

    const now = new Date().toISOString();
    const request: FriendRequestRecord = {
      requestId: `fr_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      fromActorId: from,
      toActorId: to,
      message: message?.trim() || undefined,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };

    this.requests.set(request.requestId, request);
    await this.persist();

    return { ok: true, request };
  }

  /**
   * 获取待处理的好友请求
   */
  getPendingRequest(fromActorId: string, toActorId: string): FriendRequestRecord | undefined {
    for (const request of this.requests.values()) {
      if (
        request.fromActorId === fromActorId &&
        request.toActorId === toActorId &&
        request.status === "pending"
      ) {
        return request;
      }
    }
    return undefined;
  }

  /**
   * 响应好友请求（接受或拒绝）
   */
  async respondToRequest(
    requestId: string,
    responderActorId: string,
    accept: boolean
  ): Promise<{ ok: true; request?: FriendRequestRecord } | { ok: false; reason: string }> {
    const request = this.requests.get(requestId);
    if (!request) {
      return { ok: false, reason: "好友请求不存在" };
    }

    if (request.toActorId !== responderActorId) {
      return { ok: false, reason: "无权响应该请求" };
    }

    if (request.status !== "pending") {
      return { ok: false, reason: "请求状态已变更" };
    }

    const now = new Date().toISOString();
    request.status = accept ? "accepted" : "rejected";
    request.updatedAt = now;

    if (accept) {
      // 建立双向好友关系
      await this.addFriendship(request.fromActorId, request.toActorId);
    }

    await this.persist();

    return { ok: true, request };
  }

  /**
   * 取消好友请求
   */
  async cancelRequest(
    requestId: string,
    requesterActorId: string
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const request = this.requests.get(requestId);
    if (!request) {
      return { ok: false, reason: "好友请求不存在" };
    }

    if (request.fromActorId !== requesterActorId) {
      return { ok: false, reason: "无权取消该请求" };
    }

    if (request.status !== "pending") {
      return { ok: false, reason: "请求状态已变更" };
    }

    request.status = "cancelled";
    request.updatedAt = new Date().toISOString();

    await this.persist();

    return { ok: true };
  }

  /**
   * 添加好友关系（双向）
   */
  private async addFriendship(actorId1: string, actorId2: string): Promise<void> {
    const now = new Date().toISOString();

    // actor1 -> actor2
    const friends1 = this.friendsByActor.get(actorId1) ?? [];
    if (!friends1.some((f) => f.friendActorId === actorId2)) {
      friends1.push({
        actorId: actorId1,
        friendActorId: actorId2,
        addedAt: now,
      });
      this.friendsByActor.set(actorId1, friends1);
    }

    // actor2 -> actor1
    const friends2 = this.friendsByActor.get(actorId2) ?? [];
    if (!friends2.some((f) => f.friendActorId === actorId1)) {
      friends2.push({
        actorId: actorId2,
        friendActorId: actorId1,
        addedAt: now,
      });
      this.friendsByActor.set(actorId2, friends2);
    }
  }

  /**
   * 检查两个用户是否是好友
   */
  areFriends(actorId1: string, actorId2: string): boolean {
    const friends = this.friendsByActor.get(actorId1);
    if (!friends) return false;
    return friends.some((f) => f.friendActorId === actorId2);
  }

  /**
   * 获取用户的好友列表
   */
  getFriends(actorId: string): FriendRecord[] {
    return this.friendsByActor.get(actorId) ?? [];
  }

  /**
   * 获取发送给某用户的待处理好友请求
   */
  getIncomingRequests(toActorId: string): FriendRequestRecord[] {
    const result: FriendRequestRecord[] = [];
    for (const request of this.requests.values()) {
      if (request.toActorId === toActorId && request.status === "pending") {
        result.push(request);
      }
    }
    return result;
  }

  /**
   * 获取某用户发出的待处理好友请求
   */
  getOutgoingRequests(fromActorId: string): FriendRequestRecord[] {
    const result: FriendRequestRecord[] = [];
    for (const request of this.requests.values()) {
      if (request.fromActorId === fromActorId && request.status === "pending") {
        result.push(request);
      }
    }
    return result;
  }

  /**
   * 获取用户的所有好友请求（包括已接受、已拒绝等）
   */
  getAllRequests(actorId: string): FriendRequestRecord[] {
    const result: FriendRequestRecord[] = [];
    for (const request of this.requests.values()) {
      if (request.fromActorId === actorId || request.toActorId === actorId) {
        result.push(request);
      }
    }
    // 按创建时间倒序排列
    return result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /**
   * 更新最后消息时间
   */
  async updateLastMessageTime(actorId: string, friendActorId: string): Promise<void> {
    const friends = this.friendsByActor.get(actorId);
    if (friends) {
      const friend = friends.find((f) => f.friendActorId === friendActorId);
      if (friend) {
        friend.lastMessageAt = new Date().toISOString();
        await this.persist();
      }
    }
  }
}
