import type { AgentWorldCreditReason } from "@private-ai-agent/agent-world";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";

export function isEvolutionMemoryAutopatchEnabled(): boolean {
  const r = process.env.AGENT_EVOLUTION_MEMORY_AUTOPATCH?.trim().toLowerCase();
  if (r === "0" || r === "off" || r === "false") return false;
  return true;
}

/**

 * 世界入账 / 购技能时自动追加 UAP `memory_summary` 一行（养成叙事）。

 */

export class AgentEvolutionMemoryService {

  constructor(private readonly memory: AgentMemorySyncService) {}



  appendWorldCreditLine(

    actorId: string,

    ev: {

      amount: number;

      reason: AgentWorldCreditReason;

      balanceAfter: number;

    },

  ): void {

    if (!isEvolutionMemoryAutopatchEnabled()) return;

    const line = `世界入账 +${ev.amount}（${ev.reason}），余额 ${ev.balanceAfter}`;

    this.memory.appendMemorySummaryLine(actorId, line);

  }



  appendSkillPurchaseLine(

    actorId: string,

    ev: { skillId: string; displayName: string; pricePaid: number; balanceAfter: number },

  ): void {

    if (!isEvolutionMemoryAutopatchEnabled()) return;

    const line = `购买技能「${ev.displayName}」（${ev.skillId}）花费 ${ev.pricePaid} 点，余额 ${ev.balanceAfter}`;

    this.memory.appendMemorySummaryLine(actorId, line);

  }

}

