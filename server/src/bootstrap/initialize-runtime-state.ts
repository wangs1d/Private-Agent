import { reconcileWorldA2aEscrows, restorePurchasedSkillsFromWorldState } from "@private-ai-agent/agent-world";
import type { AppServices } from "./types.js";

export async function initializeRuntimeState(services: AppServices): Promise<void> {
  await services.agentMemorySyncService.load();
  await services.agentPairingService.load();
  await services.aipService.load();
  await services.agentAccountService.load();
  await services.emailRegistrationService.load();
  await services.infoHubService.load();
  await services.scheduleTaskService.load();
  await services.weatherPrefsService.load();
  await services.virtualPhoneService.load();
  services.scheduleTaskService.startScheduler();
  // 重启后自动恢复未完成的自主任务（状态机任务：pending/planning/executing/verifying，
  // 跳过 paused 与 awaiting_approval），从持久化断点继续执行
  try {
    const restored = services.agentCore.resumeAutonomousTasks();
    if (restored > 0) {
      console.log(`[initialize-runtime-state] 已自动恢复 ${restored} 个未完成的自主任务`);
    }
  } catch (e) {
    console.error("[initialize-runtime-state] 自动恢复自主任务失败:", e);
  }
  await services.worldService.load();
  await services.socialFeedService.load();
  await restorePurchasedSkillsFromWorldState(
    services.worldService,
    services.skillManager,
    services.auditService,
  );
  services.skillManager.loadEnabledFromDisk();
  // 跨重启恢复"越用越强"的技能：procedural（经验文档）+ 自我进化 code（handlerCode）
  services.skillManager.loadProceduralSkillsFromDisk();
  services.skillManager.loadEvolvedSkillsFromDisk();
  await services.a2aOutsourcingService.load();
  await reconcileWorldA2aEscrows(
    services.worldService,
    services.a2aOutsourcingService,
    services.auditService,
  );
  await services.worldService.flushPersist();
  await services.socialFeedService.flushPersist();
}
