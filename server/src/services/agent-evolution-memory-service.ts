import type { AgentWorldCreditReason } from "@private-ai-agent/agent-world";

import { getKvSummaryAppendMode } from "../config/memory-env.js";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";

export function isEvolutionMemoryAutopatchEnabled(): boolean {
  const r = process.env.AGENT_EVOLUTION_MEMORY_AUTOPATCH?.trim().toLowerCase();
  if (r === "0" || r === "off" || r === "false") return false;
  return true;
}

/**
 * 世界入账 / 购技能时自动追加 UAP `memory_summary` 一行（养成叙事）。
 * `AGENT_KV_SUMMARY_APPEND_MODE=minimal` 时跳过 KV 流水（细节由 Mem0 记忆图承担）。
 */
export class AgentEvolutionMemoryService {
  constructor(private readonly memory: AgentMemorySyncService) {}

  private shouldAppendKvSummary(): boolean {
    if (!isEvolutionMemoryAutopatchEnabled()) return false;
    return getKvSummaryAppendMode() !== "minimal";
  }

  appendWorldCreditLine(
    actorId: string,
    ev: {
      amount: number;
      reason: AgentWorldCreditReason;
      balanceAfter: number;
    },
  ): void {
    if (!this.shouldAppendKvSummary()) return;
    const line = `世界入账 +${ev.amount}（${ev.reason}），余额 ${ev.balanceAfter}`;
    this.memory.appendMemorySummaryLine(actorId, line);
  }

  appendSkillPurchaseLine(
    actorId: string,
    ev: { skillId: string; displayName: string; pricePaid: number; balanceAfter: number },
  ): void {
    if (!this.shouldAppendKvSummary()) return;
    const line = `购买技能「${ev.displayName}」（${ev.skillId}）花费 ${ev.pricePaid} 点，余额 ${ev.balanceAfter}`;
    this.memory.appendMemorySummaryLine(actorId, line);
  }
}
