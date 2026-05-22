import { resolveActorId } from "../agent/actor-id.js";
import type { AgentAccountService } from "../services/agent-account-service.js";
import type { FriendService } from "../services/friend-service.js";
import type { ToolRegistry } from "./tool-registry.js";

/**
 * Agent Link（好友/联络）工具：与客户端 MailboxPage、HTTP /friends/* 对齐。
 */
export function registerAgentLinkTools(
  registry: ToolRegistry,
  friendService: FriendService,
  agentAccountService: AgentAccountService,
): void {
  registry.register("agent.link.list_friends", async (_input, context) => {
    const actorId = resolveActorId(context);
    const friends = friendService.getFriends(actorId);
    return {
      ok: true,
      count: friends.length,
      friends: friends.map((f) => ({
        friendActorId: f.friendActorId,
        addedAt: f.addedAt,
        lastMessageAt: f.lastMessageAt,
      })),
    };
  });

  registry.register("agent.link.list_friend_requests", async (input, context) => {
    const actorId = resolveActorId(context);
    const scope = String(input.scope ?? "all").trim().toLowerCase();
    let requests;
    if (scope === "incoming") requests = friendService.getIncomingRequests(actorId);
    else if (scope === "outgoing") requests = friendService.getOutgoingRequests(actorId);
    else requests = friendService.getAllRequests(actorId);
    return { ok: true, scope, count: requests.length, requests };
  });

  registry.register("agent.link.send_friend_request", async (input, context) => {
    const actorId = resolveActorId(context);
    const toActorId = String(input.toActorId ?? "").trim();
    const message = input.message !== undefined ? String(input.message).trim() : undefined;
    if (!toActorId) throw new Error("缺少 toActorId");
    if (toActorId === actorId) throw new Error("不能添加自己为好友");
    if (!agentAccountService.getByActorId(toActorId)) {
      throw new Error("目标用户不存在");
    }
    const result = await friendService.sendFriendRequest(actorId, toActorId, message);
    if (!result.ok) throw new Error(result.reason);
    return { ok: true, request: result.request };
  });

  registry.register("agent.link.respond_friend_request", async (input, context) => {
    const actorId = resolveActorId(context);
    const requestId = String(input.requestId ?? "").trim();
    const accept = input.accept === true;
    if (!requestId) throw new Error("缺少 requestId");
    const result = await friendService.respondToRequest(requestId, actorId, accept);
    if (!result.ok) throw new Error(result.reason);
    return { ok: true, request: result.request };
  });
}
