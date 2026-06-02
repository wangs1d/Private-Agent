import type { WorldService } from "@private-ai-agent/agent-world";
import type { AgentMemorySyncService } from "../services/agent-memory-sync-service.js";
import type { ComputeQuotaService } from "../services/compute-quota-service.js";
import type { HermesEvolutionLoopService } from "../services/hermes-evolution-loop-service.js";
import type { UserPersonalizationService } from "../services/user-personalization/user-personalization-service.js";
import { AgentCore } from "../services/agent-core.js";
import type { SkillManager } from "../skills/index.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { ExternalChatProvider } from "../external-model/types.js";
import type { NarrativeMemoryPort } from "../services/narrative-memory-port.js";
import type { TrajectorySkillPromotionService } from "../services/trajectory-skill-promotion-service.js";
import type { VirtualPhoneService } from "../services/virtual-phone-service.js";
import type { ScheduleTaskService } from "../services/schedule-task-service.js";

/**
 * Agent「大脑」装配依赖（对齐 Hermes：CLI/网关等多入口共用同一 AIAgent 核心，本仓库为 AgentCore）。
 * @see https://github.com/NousResearch/hermes-agent — Entry Points → AIAgent
 */
export type AgentCoreDependencies = {
  toolRegistry: ToolRegistry;
  externalChat: ExternalChatProvider | null;
  computeQuotaService: ComputeQuotaService | null;
  agentMemorySyncService?: AgentMemorySyncService | null;
  hermesEvolutionLoopService?: HermesEvolutionLoopService | null;
  userPersonalizationService?: UserPersonalizationService | null;
  worldService?: WorldService | null;
  skillManager?: SkillManager | null;
  narrativeMemory?: NarrativeMemoryPort | null;
  trajectorySkillPromotion?: TrajectorySkillPromotionService | null;
  virtualPhoneService?: VirtualPhoneService | null;
  scheduleTaskService?: ScheduleTaskService | null;
};

/**
 * 构造平台无关的 Agent 编排核心，供 WebSocket、HTTP 或后续批任务入口复用。
 */
export function createAgentCore(deps: AgentCoreDependencies): AgentCore {
  return new AgentCore(
    deps.toolRegistry,
    deps.externalChat,
    deps.computeQuotaService,
    deps.agentMemorySyncService ?? null,
    deps.hermesEvolutionLoopService ?? null,
    deps.userPersonalizationService ?? null,
    deps.worldService ?? null,
    deps.skillManager ?? null,
    deps.narrativeMemory ?? null,
    deps.trajectorySkillPromotion ?? null,
    deps.virtualPhoneService ?? null,
    deps.scheduleTaskService ?? null,
  );
}
