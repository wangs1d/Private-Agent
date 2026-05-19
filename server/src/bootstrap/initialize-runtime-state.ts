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
  await services.worldService.load();
  await services.socialFeedService.load();
  await restorePurchasedSkillsFromWorldState(
    services.worldService,
    services.skillManager,
    services.auditService,
  );
  services.skillManager.loadEnabledFromDisk();
  await services.a2aOutsourcingService.load();
  await reconcileWorldA2aEscrows(
    services.worldService,
    services.a2aOutsourcingService,
    services.auditService,
  );
  await services.worldService.flushPersist();
  await services.socialFeedService.flushPersist();
}
