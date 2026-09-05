import type { ExternalChatProvider } from "../external-model/types.js";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";
import { getAgentRuntimeConfig } from "../agent/agent-runtime-config.js";
import { resolvePrimaryChatSessionId } from "../agent/master-chat-session.js";
import { getHumanLikeMemoryService } from "./human-like-memory-service.js";
import { getAgenticMemoryRuntime, getMemoryComponents } from "../agentic-memory/index.js";
import { getDailyDigestService } from "./daily-digest-service.js";
import { getShortTermMemoryGatewayService } from "./short-term-memory-gateway.js";
import { getConversationTimelineService } from "./conversation-timeline.js";
import { getGlobalMemoryInventory } from "../brain/memory-inventory.js";

export type ClearAllMemoryResult = {
  chat: boolean;
  primarySessionId: string;
  humanMemoryNodes: number;
  structuredMemory: boolean;
  agenticMemory: number;
  dailyDigest: number;
  shortTermSessions: number;
};

/**
 * 清空某 actor 的全部聊天记录与 Agent 记忆（所有记忆来源，含内存态）。
 * HTTP 路由与 WS chat.clear_history 共用，保证两条清理路径行为一致。
 */
export async function clearAllMemoryForActor(
  actorId: string,
  deps: { externalChat?: ExternalChatProvider | null; agentMemorySyncService: AgentMemorySyncService },
): Promise<ClearAllMemoryResult> {
  const masterOn = getAgentRuntimeConfig().masterDelegation.enabled;
  const primarySessionId = resolvePrimaryChatSessionId(actorId, masterOn);

  // 1. 清空 Agent 主会话聊天线程（内存 + 持久层）
  let chatCleared = false;
  if (deps.externalChat?.clearSession) {
    deps.externalChat.clearSession(primarySessionId);
    deps.externalChat.clearSession(`notes:${actorId}`);
    chatCleared = true;
  }

  // 2. 记忆图谱（HumanLikeMemoryService）
  const humanMemory = getHumanLikeMemoryService();
  const nodesCleared = humanMemory?.clearActorMemory(actorId) ?? 0;

  // 3. 结构化记忆（agent-memory-sync）
  const syncCleared = deps.agentMemorySyncService.clearActor(actorId);

  // 4. Mem0 agentic 记忆（尽力而为：按 metadata.actorId 过滤后逐条删除）
  let mem0Cleared = 0;
  const mem0 = getAgenticMemoryRuntime();
  if (mem0?.memory) {
    try {
      type Mem0Record = { id: string; metadata?: { actorId?: string } };
      const allResult = (await mem0.memory.getAll({ topK: 10000 })) as {
        results?: Mem0Record[];
      };
      const toDelete = (allResult.results ?? []).filter(
        (m) => (m.metadata?.actorId ?? actorId) === actorId,
      );
      for (const m of toDelete) {
        await mem0.memory.delete(m.id).catch(() => {});
      }
      mem0Cleared = toDelete.length;
    } catch (e) {
      console.warn("[memory-clear] clear mem0 failed:", e instanceof Error ? e.message : e);
    }
  }

  // 5. 当日摘要（daily-digest，每轮会被 getRelevantPromptDigest 注入）
  const digestCleared = getDailyDigestService().clearActorDigests(actorId);

  // 6. 短期任务栈 + 情景记忆（STM）
  const stmCleared =
    getShortTermMemoryGatewayService()?.clearSessions([primarySessionId, `notes:${actorId}`]) ?? 0;

  // 7. 对话时间线内存态（首次对话/累计轮次）
  getConversationTimelineService()?.clearActor(actorId);

  // 8. 失效记忆目录缓存（MemoryInventory 60s TTL，避免旧缓存残留）
  const inventory = getGlobalMemoryInventory();
  if (inventory?.invalidate) {
    inventory.invalidate(actorId);
  }

  // 9. agentic-memory 四件套级联清理（P0-2 隐私闭环）：语义账本 / 承诺草稿板 /
  //    溯源依赖图 / bridge_links——此前清空 actor 后这些表的数据会残留。
  const components = getMemoryComponents();
  const ledgerCleared = components.ledger?.purgeActor(actorId) ?? 0;
  const commitmentsCleared = components.commitmentBoard?.purgeActor(actorId) ?? 0;
  const provenanceCleared = components.provenance?.purgeActor(actorId) ?? 0;
  const bridgeLinksCleared = components.bridge?.purgeActor(actorId) ?? 0;
  if (ledgerCleared + commitmentsCleared + provenanceCleared + bridgeLinksCleared > 0) {
    console.info(
      `[memory-clear] agentic-memory 级联清理：ledger=${ledgerCleared} commitments=${commitmentsCleared} ` +
        `provenance=${provenanceCleared} bridgeLinks=${bridgeLinksCleared}`,
    );
  }

  return {
    chat: chatCleared,
    primarySessionId,
    humanMemoryNodes: nodesCleared,
    structuredMemory: syncCleared,
    agenticMemory: mem0Cleared,
    dailyDigest: digestCleared,
    shortTermSessions: stmCleared,
  };
}