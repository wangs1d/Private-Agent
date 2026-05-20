import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import {
  A2aOutsourcingService,
  DoudizhuService,
  GomokuService,
  loadPersistedCommunitySkills,
  registerWorldDoudizhuTools,
  registerWorldGomokuTools,
  registerWorldFreeMarketTools,
  registerWorldOpenRegistryTools,
  registerWorldRoomTools,
  registerWorldZhajinhuaTools,
  registerWorldSocialTools,
  SocialFeedService,
  AgentWorldServerEventType,
  WorldPartitionWsRegistry,
  WorldService,
  type WorldRevisionEvent,
  ZhaJinHuaService,
} from "@private-ai-agent/agent-world";
import { createExternalChatProviderFromEnv } from "../external-model/index.js";
import { registerHttpRoutes } from "../routes/http/index.js";
import { AgentAccountService } from "../services/agent-account-service.js";
import { AgentMemorySyncService } from "../services/agent-memory-sync-service.js";
import { FriendService } from "../services/friend-service.js";
import { createAgentCore } from "../agent/agent-runtime.js";
import { AgentEvolutionMemoryService } from "../services/agent-evolution-memory-service.js";
import { HermesEvolutionLoopService } from "../services/hermes-evolution-loop-service.js";
import { createNarrativeHybridRetrievalDefault } from "../services/narrative-hybrid-retrieval-service.js";
import { TrajectoryPromotionPipeline, parseSkillPromotionPipelineMode } from "../services/skill-promotion-pipeline.js";
import { SkillPromotionQueueService } from "../services/skill-promotion-queue-service.js";
import { TrajectorySkillPromotionService } from "../services/trajectory-skill-promotion-service.js";
import { AgentPairingService } from "../services/agent-pairing-service.js";
import { AgentRelayService } from "../services/agent-relay-service.js";
import { AuditService } from "../services/audit-service.js";
import { EmailRegistrationService } from "../services/email-registration-service.js";
import { InfoHubService } from "../services/info-hub-service.js";
import { RealFundsWalletService } from "../services/real-funds-wallet-service.js";
import { ScheduleIntentService } from "../services/schedule-intent-service.js";
import { ScheduleTaskService } from "../services/schedule-task-service.js";
import { SessionService } from "../services/session-service.js";
import { TtsService } from "../services/tts-service.js";
import { VirtualPhoneService } from "../services/virtual-phone-service.js";
import { UpstreamSearchService } from "../services/upstream-search-service.js";
import { WsConnectionRegistry } from "../services/ws-connection-registry.js";
import { SkillManager } from "../skills/index.js";
import { registerAgentWorldIdentityBuiltinSkills } from "../skills/builtin/agent-world-identity-skills.js";
import { registerVirtualPhoneBuiltinSkills } from "../skills/builtin/virtual-phone-skills.js";
import { SkillValidator } from "../skills/skill-validator.js";
import type { SkillMetadata } from "../skills/types.js";
import { registerAgentAccountTools } from "../tools/agent-account-tools.js";
import { registerWalletTools } from "../tools/wallet-tools.js";
import { registerAgentPhoneTools } from "../tools/agent-phone-tools.js";
import { registerAgentRelayTools } from "../tools/agent-relay-tools.js";
import { registerCalendarTools } from "../tools/calendar-tools.js";
import { registerClockTools } from "../tools/clock-tools.js";
import { registerLifeTools } from "../tools/life-tools.js";
import { registerWeatherTools } from "../tools/weather-tools.js";
import { registerCareReminderTools } from "../tools/care-reminder-tools.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { DesktopBridgeCoordinator } from "../services/desktop-bridge-coordinator.js";
import { createDesktopVisualAgentFromEnv } from "../services/desktop-visual-agent-subprocess.js";
import { registerDesktopVisualTools } from "../tools/desktop-visual-tools.js";
import { registerVisionTools } from "../tools/vision-tools.js";
import { registerWebTools } from "../tools/web-tools.js";
import { registerSelfProgrammingTools } from "../tools/self-programming-tools.js";
import { registerAISkillGenerationTools } from "../tools/ai-skill-generation-tools.js";
import { registerSelfLearningTools } from "../tools/self-learning-tools.js";
import { ServerEventType } from "../protocol.js";
import { WeatherPrefsService } from "../services/weather-prefs-service.js";
import { WeatherService } from "../services/weather-service.js";
import { ComputeQuotaService } from "../services/compute-quota-service.js";
import { AipService } from "../aip/aip-service.js";
import { registerAipTools } from "../tools/aip-tools.js";
import { registerProtocolUnifiedTools } from "../tools/protocol-unified-tools.js";
import { registerWebSocketRoute } from "../ws/connection.js";
import { UnifiedIdempotencyService } from "../services/unified-idempotency-service.js";
import { join } from "path";
import { getHttpRateLimitRuntime } from "../config/env.js";
import { registerHttpRateLimit } from "../http-rate-limit/http-rate-limit.js";
import type { AppServices } from "./types.js";
import { VisionPeriodicScheduler } from "../vision/vision-periodic-scheduler.js";

export async function createAppServices(): Promise<AppServices> {
  const app = Fastify({ logger: true });
  await app.register(cors, {
    origin: true,
    credentials: true,
  });
  await registerHttpRateLimit(app, getHttpRateLimitRuntime());
  await app.register(websocket);
  await app.register(multipart, { limits: { fileSize: 12 * 1024 * 1024 } });

  const sessionService = new SessionService();
  const scheduleTaskService = new ScheduleTaskService();
  const weatherService = new WeatherService();
  const weatherPrefsService = new WeatherPrefsService();
  const infoHubService = new InfoHubService();
  const upstreamSearchService = new UpstreamSearchService(infoHubService);
  const realFundsWallet = new RealFundsWalletService();
  const auditService = new AuditService();
  const computeQuotaService = new ComputeQuotaService();
  const agentMemorySyncService = new AgentMemorySyncService();
  const unifiedIdempotencyService = new UnifiedIdempotencyService();
  const toolRegistry = new ToolRegistry();

  const skillManager = new SkillManager();
  skillManager.configureEnabledPersistence(join(process.cwd(), "data", "skill-enabled.json"));
  const skillMetadataValidator = {
    validateMetadata(metadata: unknown) {
      return SkillValidator.validateMetadata(metadata as SkillMetadata);
    },
  };
  await loadPersistedCommunitySkills(skillManager);
  toolRegistry.setSkillManager(skillManager);

  registerWebTools(toolRegistry, infoHubService, upstreamSearchService);
  registerClockTools(toolRegistry);
  registerWeatherTools(toolRegistry, weatherService);
  registerCareReminderTools(toolRegistry, {
    agentMemorySyncService,
    scheduleTaskService,
  });

  const agentRelayService = new AgentRelayService();
  const wsConnectionRegistry = new WsConnectionRegistry();

  scheduleTaskService.setWeatherBriefHandler(async (task) => {
    const prefs = weatherPrefsService.get(task.sessionId);
    if (!prefs) {
      return { type: "weather_brief", ok: false, error: "未保存天气位置偏好，请在客户端保存定位后再试" };
    }
    const brief = await weatherService.getBrief(
      prefs.latitude,
      prefs.longitude,
      prefs.timezone || task.timezone,
      prefs.label,
    );
    const message = `${brief.summaryLine} 穿衣建议：${brief.clothingAdvice}`;
    wsConnectionRegistry.trySend(
      task.sessionId,
      JSON.stringify({
        type: ServerEventType.WeatherBrief,
        payload: { taskId: task.taskId, message, brief },
      }),
    );
    return {
      type: "weather_brief",
      ok: true,
      title: task.title,
      message,
      brief,
    };
  });
  const agentPairingService = new AgentPairingService();
  const ttsService = new TtsService();
  const virtualPhoneService = new VirtualPhoneService(ttsService, wsConnectionRegistry, agentPairingService);

  const aipService = new AipService(agentRelayService, wsConnectionRegistry, agentPairingService, auditService);
  const agentAccountService = new AgentAccountService();
  const emailRegistrationService = new EmailRegistrationService();
  const friendService = new FriendService();
  
  // 加载持久化数据
  await Promise.all([
    scheduleTaskService.load(),
    agentPairingService.load(),
    agentAccountService.load(),
    emailRegistrationService.load(),
    friendService.load(),
    virtualPhoneService.load(),
  ]).catch((err) => {
    app.log.error({ err }, "Failed to load persisted data");
  });
  
  registerAgentAccountTools(toolRegistry, agentAccountService);
  registerWalletTools(toolRegistry);
  registerAgentRelayTools(
    toolRegistry,
    agentRelayService,
    wsConnectionRegistry,
    agentPairingService,
  );
  registerAgentPhoneTools(toolRegistry, virtualPhoneService);
  registerAipTools(toolRegistry, aipService);
  registerProtocolUnifiedTools(toolRegistry, {
    computeQuotaService,
    agentMemorySyncService,
    auditService,
    unifiedIdempotencyService,
  });

  const worldService = new WorldService();
  registerAgentWorldIdentityBuiltinSkills((skill) => skillManager.register(skill), {
    worldService,
    agentAccountService,
  });
  
  // 注册虚拟电话内置Skills
  registerVirtualPhoneBuiltinSkills((skill) => skillManager.register(skill), {
    virtualPhoneService,
  });
  
  const worldPartitionWsRegistry = new WorldPartitionWsRegistry();
  worldService.onWorldRevision((ev: WorldRevisionEvent) => {
    worldPartitionWsRegistry.broadcastToPartition(
      ev.partitionId,
      JSON.stringify({
        type: AgentWorldServerEventType.WorldPartitionDelta,
        payload: {
          partitionId: ev.partitionId,
          revision: ev.revision,
          state: ev.state,
        },
      }),
    );
  });
  const a2aOutsourcingService = new A2aOutsourcingService(worldService);
  const doudizhuService = new DoudizhuService(worldService);
  doudizhuService.attachWebSocketRegistry(wsConnectionRegistry);
  const zhaJinHuaService = new ZhaJinHuaService(worldService);
  zhaJinHuaService.attachWebSocketRegistry(wsConnectionRegistry);
  const gomokuService = new GomokuService(worldService);
  gomokuService.attachWebSocketRegistry(wsConnectionRegistry);
  const socialFeedService = new SocialFeedService(worldService);
  socialFeedService.attachWebSocketRegistry(wsConnectionRegistry);
  registerWorldOpenRegistryTools(toolRegistry, worldService);
  registerWorldRoomTools(toolRegistry, worldService);
  registerWorldDoudizhuTools(toolRegistry, doudizhuService);
  registerWorldZhajinhuaTools(toolRegistry, zhaJinHuaService);
  registerWorldGomokuTools(toolRegistry, gomokuService);
  registerWorldSocialTools(toolRegistry, socialFeedService);
  registerWorldFreeMarketTools(toolRegistry, worldService, a2aOutsourcingService, skillManager);
  toolRegistry.setWorldService(worldService);

  const evolutionMemory = new AgentEvolutionMemoryService(agentMemorySyncService);
  const narrativeHybrid = createNarrativeHybridRetrievalDefault();

  const pipelineMode = parseSkillPromotionPipelineMode();
  const skillPromoValidateDeps = { skillManager, skillMetadataValidator };
  let skillPromotionQueue: SkillPromotionQueueService | null = null;
  if (pipelineMode === "queue") {
    skillPromotionQueue = new SkillPromotionQueueService(skillPromoValidateDeps);
    skillPromotionQueue.start();
  }
  const trajectoryPromotionPipeline =
    pipelineMode === "off" ?
      null
    : new TrajectoryPromotionPipeline(pipelineMode, skillPromoValidateDeps, skillPromotionQueue);

  const trajectorySkillPromotion = new TrajectorySkillPromotionService(trajectoryPromotionPipeline);

  const hermesEvolutionLoopService = new HermesEvolutionLoopService(agentMemorySyncService, {
    onObserveForNarrative: (actorId, line) => {
      void narrativeHybrid?.ingest(actorId, line, "hermes_observe").catch(() => {});
    },
  });
  worldService.setEvolutionHooks({
    onWorldCreditsCredited: (ev) => {
      evolutionMemory.appendWorldCreditLine(ev.actorSessionId, ev);
    },
    onSkillPurchased: (ev) => {
      const m = skillManager.get(ev.skillId);
      evolutionMemory.appendSkillPurchaseLine(ev.actorSessionId, {
        skillId: ev.skillId,
        displayName: m?.displayName ?? ev.skillId,
        pricePaid: ev.pricePaid,
        balanceAfter: ev.balanceAfter,
      });
    },
  });

  const externalChat = createExternalChatProviderFromEnv();
  const scheduleIntentService = new ScheduleIntentService(externalChat);
  registerLifeTools(toolRegistry, scheduleTaskService, scheduleIntentService);
  registerCalendarTools(toolRegistry, scheduleTaskService, scheduleIntentService);
  const agentCore = createAgentCore({
    toolRegistry,
    externalChat,
    computeQuotaService,
    agentMemorySyncService,
    hermesEvolutionLoopService,
    worldService,
    skillManager,
    narrativeHybrid,
    trajectorySkillPromotion,
    virtualPhoneService,
  });

  const visionPeriodicScheduler = new VisionPeriodicScheduler({
    agentCore,
    wsRegistry: wsConnectionRegistry,
  });
  registerVisionTools(toolRegistry, visionPeriodicScheduler);

  const desktopVisualAgent = createDesktopVisualAgentFromEnv();
  const desktopBridgeCoordinator = new DesktopBridgeCoordinator({
    onSync: (actorId, payload) => {
      wsConnectionRegistry.trySend(
        actorId,
        JSON.stringify({ type: ServerEventType.DesktopBridgeSync, payload }),
      );
    },
  });
  registerDesktopVisualTools(toolRegistry, {
    localAgent: desktopVisualAgent,
    bridge: desktopBridgeCoordinator,
  });

  // ========== 注册自我编程和智能生成工具 ==========
  registerSelfProgrammingTools(toolRegistry, skillManager);
  registerAISkillGenerationTools(toolRegistry, externalChat, skillManager);
  registerSelfLearningTools(toolRegistry, externalChat, skillManager);

  registerHttpRoutes(app, {
    toolRegistry,
    skillManager,
    skillMetadataValidator,
    realFundsWallet,
    scheduleTaskService,
    scheduleIntentService,
    infoHubService,
    upstreamSearchService,
    worldService,
    a2aOutsourcingService,
    doudizhuService,
    zhaJinHuaService,
    gomokuService,
    socialFeedService,
    agentRelayService,
    agentPairingService,
    aipService,
    agentAccountService,
    emailRegistrationService,
    computeQuotaService,
    agentMemorySyncService,
    weatherService,
    weatherPrefsService,
    virtualPhoneService,
    ttsService,
    desktopBridgeCoordinator,
    friendService,
  });

  registerWebSocketRoute(app, {
    sessionService,
    realFundsWallet,
    worldService,
    auditService,
    wsConnectionRegistry,
    agentPairingService,
    aipService,
    worldPartitionWsRegistry,
    agentCore,
    doudizhuService,
    zhaJinHuaService,
    gomokuService,
    socialFeedService,
    computeQuotaService,
    agentMemorySyncService,
    unifiedIdempotencyService,
    desktopBridgeCoordinator,
  });

  return {
    app,
    sessionService,
    scheduleTaskService,
    scheduleIntentService,
    infoHubService,
    realFundsWallet,
    auditService,
    toolRegistry,
    skillManager,
    skillMetadataValidator,
    agentRelayService,
    wsConnectionRegistry,
    agentPairingService,
    aipService,
    agentAccountService,
    emailRegistrationService,
    agentCore,
    worldService,
    a2aOutsourcingService,
    doudizhuService,
    zhaJinHuaService,
    socialFeedService,
    computeQuotaService,
    agentMemorySyncService,
    unifiedIdempotencyService,
    weatherService,
    weatherPrefsService,
    ttsService,
    virtualPhoneService,
    friendService,
  };
}
