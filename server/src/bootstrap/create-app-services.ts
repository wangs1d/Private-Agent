import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import {
  A2aOutsourcingService,
  BlackjackService,
  DoudizhuService,
  GameCenterCoordinator,
  GomokuService,
  loadPersistedCommunitySkills,
  registerGameCenterRoutes,
  registerWorldDoudizhuTools,
  registerWorldGomokuTools,
  registerWorldBlackjackTools,
  registerWorldFreeMarketTools,
  registerWorldOpenRegistryTools,
  registerWorldRoomTools,
  registerWorldSocialTools,
  registerWorldZhajinhuaTools,
  SocialFeedService,
  ZhaJinHuaService,
  AgentWorldServerEventType,
  WorldPartitionWsRegistry,
  WorldService,
  type WorldRevisionEvent,
} from "@private-ai-agent/agent-world";
import { createExternalChatProviderFromEnv } from "../external-model/index.js";
import { getChatThreadPersistence } from "../external-model/chat-thread-persist.js";
import { registerHttpRoutes } from "../routes/http/index.js";
import { AgentAccountService } from "../services/agent-account-service.js";
import { AgentMemorySyncService } from "../services/agent-memory-sync-service.js";
import { FriendService } from "../services/friend-service.js";
import { createAgentCore } from "../agent/agent-runtime.js";
import { PromptContextBuilder } from "../agent/prompt-context-builder.js";
import {
  formatAgentRuntimeConfigSummary,
  getAgentRuntimeConfig,
} from "../agent/agent-runtime-config.js";
import { AgentEvolutionMemoryService } from "../services/agent-evolution-memory-service.js";
import { HermesEvolutionLoopService } from "../services/hermes-evolution-loop-service.js";
import { UserPersonalizationService } from "../services/user-personalization/user-personalization-service.js";
import { createNarrativeMemoryPort } from "../services/narrative-memory-port.js";
import { initMemoryManagerService } from "../services/memory-manager-service.js";
import { getAgenticMemoryRuntime } from "../agentic-memory/index.js";
import { getDailyDigestService } from "../services/daily-digest-service.js";
import { getShortTermMemoryConfig } from "../services/short-term-memory-config.js";
import {
  initNightlyMemoryTaskService,
  getNightlyMemoryTaskService,
} from "../services/nightly-memory-task-service.js";
import { 
  initDailyChatSyncService,
  getDailyChatSyncService,
} from "../services/daily-chat-sync-service.js";
import { compactObserveLine } from "../tokenjuice/compactor.js";
import { TrajectoryPromotionPipeline, parseSkillPromotionPipelineMode } from "../services/skill-promotion-pipeline.js";
import { SkillPromotionQueueService } from "../services/skill-promotion-queue-service.js";
import { TrajectorySkillPromotionService } from "../services/trajectory-skill-promotion-service.js";
import { GomokuAgentTurnService } from "../services/gomoku-agent-turn-service.js";
import { ProactiveAgentCenter } from "../services/proactive-agent-center.js";
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
import { registerAgentLinkTools } from "../tools/agent-link-tools.js";
import { registerAgentRelayTools } from "../tools/agent-relay-tools.js";
import { registerCalendarTools } from "../tools/calendar-tools.js";
import { registerClockTools } from "../tools/clock-tools.js";
import { registerEmbodimentTools } from "../tools/embodiment-tools.js";
import {
  EmbodimentAutonomyService,
  initEmbodimentAutonomy,
} from "../services/embodiment-autonomy-service.js";
import { registerLifeTools } from "../tools/life-tools.js";
import { registerSmartHomeTools } from "../tools/smart-home-tools.js";
import { SmartHomeService } from "../services/smart-home-service.js";
import { registerWeatherTools } from "../tools/weather-tools.js";
import { registerCareReminderTools } from "../tools/care-reminder-tools.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { DesktopBridgeCoordinator } from "../services/desktop-bridge-coordinator.js";
import { createDesktopVisualFromEnv } from "../services/desktop-visual-subprocess.js";
import { registerDesktopVisualTools } from "../tools/desktop-visual-tools.js";
import { registerVisionTools } from "../tools/vision-tools.js";
import { registerWebTools } from "../tools/web-tools.js";
import { registerSelfProgrammingTools } from "../tools/self-programming-tools.js";
import { registerAISkillGenerationTools } from "../tools/ai-skill-generation-tools.js";
import { registerSelfLearningTools } from "../tools/self-learning-tools.js";
import { registerCapabilityQueryTools } from "../tools/agent-capability-query-tools.js";
import { ServerEventType } from "../protocol.js";
import { embodimentAlert, embodimentThinking } from "../services/agent-embodiment.js";
import { formatReminderDisplayMessage } from "../tools/schedule-user-reply.js";
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
import { CompanionService } from "../services/companion-service.js";

export async function createAppServices(): Promise<AppServices> {
  const app = Fastify({ logger: true });
  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  });
  await registerHttpRateLimit(app, getHttpRateLimitRuntime());
  await app.register(websocket);
  await app.register(multipart, { limits: { fileSize: 12 * 1024 * 1024 } });

  const sessionService = new SessionService();
  await getChatThreadPersistence().load();
  const scheduleTaskService = new ScheduleTaskService();
  const weatherService = new WeatherService();
  const weatherPrefsService = new WeatherPrefsService();
  const infoHubService = new InfoHubService();
  const upstreamSearchService = new UpstreamSearchService(infoHubService);
  const realFundsWallet = new RealFundsWalletService();
  const auditService = new AuditService();
  const computeQuotaService = new ComputeQuotaService();
  const companionService = new CompanionService();
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
  const embodimentAutonomy = new EmbodimentAutonomyService(wsConnectionRegistry);
  initEmbodimentAutonomy(embodimentAutonomy);

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

  scheduleTaskService.setReminderHandler(async (task, message) => {
    const displayMessage = formatReminderDisplayMessage(message);
    wsConnectionRegistry.trySend(
      task.sessionId,
      JSON.stringify({
        type: ServerEventType.ScheduleReminderFired,
        payload: {
          taskId: task.taskId,
          title: task.title,
          message: displayMessage,
          reminderMessage: message,
          recurrence: task.recurrence,
          status: task.status,
          nextRunAt: task.nextRunAt,
        },
      }),
    );
    embodimentAlert(
      task.sessionId,
      (json) => wsConnectionRegistry.trySend(task.sessionId, json),
      displayMessage,
      "schedule.reminder_fired",
    );
    const wakeLike = /起床|叫醒|喊我|叫我/.test(message) || /起床|叫醒|喊我/.test(task.description);
    if (wakeLike) {
      const phone = virtualPhoneService.getPhoneForActor(task.sessionId);
      if (phone) {
        void virtualPhoneService.placeCall({
          fromActorId: task.sessionId,
          toPhone: phone,
          transcript: displayMessage,
          ringStyle: "reminder",
          initiatedBy: "agent",
        });
      }
    }
  });

  const aipService = new AipService(agentRelayService, wsConnectionRegistry, agentPairingService, auditService);
  const agentAccountService = new AgentAccountService();
  const emailRegistrationService = new EmailRegistrationService();
  const friendService = new FriendService();
  
  // 加载持久化数据
  await Promise.all([
    scheduleTaskService.load(),
    companionService.load(),
    agentPairingService.load(),
    agentAccountService.load(),
    emailRegistrationService.load(),
    friendService.load(),
    virtualPhoneService.load(),
  ]).catch((err) => {
    app.log.error({ err }, "Failed to load persisted data");
  });
  
  registerAgentAccountTools(toolRegistry, agentAccountService);
  registerWalletTools(toolRegistry, friendService);
  registerAgentLinkTools(toolRegistry, friendService, agentAccountService);
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
  const blackjackService = new BlackjackService(worldService);
  const gameCenterCoordinator = new GameCenterCoordinator(
    worldService,
    gomokuService,
    zhaJinHuaService,
    doudizhuService,
    blackjackService,
  );
  const socialFeedService = new SocialFeedService(worldService);
  socialFeedService.attachWebSocketRegistry(wsConnectionRegistry);
  registerWorldOpenRegistryTools(toolRegistry, worldService);
  registerWorldRoomTools(toolRegistry, worldService);
  registerWorldGomokuTools(toolRegistry, gomokuService);
  registerWorldDoudizhuTools(toolRegistry, doudizhuService);
  registerWorldZhajinhuaTools(toolRegistry, zhaJinHuaService);
  registerWorldBlackjackTools(toolRegistry, blackjackService);
  registerWorldSocialTools(toolRegistry, socialFeedService);
  registerWorldFreeMarketTools(toolRegistry, worldService, a2aOutsourcingService, skillManager);
  toolRegistry.setWorldService(worldService);
  registerCapabilityQueryTools(toolRegistry, { skillManager, worldService, virtualPhoneService });

  const evolutionMemory = new AgentEvolutionMemoryService(agentMemorySyncService);
  const agenticMemoryRuntime = getAgenticMemoryRuntime();
  const narrativeMemory = createNarrativeMemoryPort({
    agenticIngest: agenticMemoryRuntime?.ingest ?? null,
    agenticRetrieval: agenticMemoryRuntime?.retrieval ?? null,
    compressor: agenticMemoryRuntime?.compressor ?? null,
  });

  const dailyDigestService = getDailyDigestService();
  dailyDigestService.setNarrativeMemory(narrativeMemory);
  await dailyDigestService.load();
  dailyDigestService.startScheduler();

  initMemoryManagerService(narrativeMemory, agentMemorySyncService);
  const stmConfig = getShortTermMemoryConfig();
  
  const nightlyMemoryService = initNightlyMemoryTaskService({
    timezone: stmConfig.digestTimezone,
  });
  if (nightlyMemoryService) {
    const memoryManager = (await import("../services/memory-manager-service.js")).getMemoryManagerService();
    nightlyMemoryService.setDependencies(memoryManager, dailyDigestService, agentMemorySyncService);
    nightlyMemoryService.startScheduler();
    app.log.info(
      `[NightlyMemory] Night mode: ${nightlyMemoryService.isInNightMode() ? "🌙 ON" : "☀️ OFF"} (${stmConfig.digestTimezone})`,
    );
  }
  
  const chatSyncService = initDailyChatSyncService();
  if (chatSyncService) {
    chatSyncService.setDependencies(dailyDigestService, agentMemorySyncService);
    app.log.info(`[DailyChatSync] Service initialized and ready`);
  }
  
  app.log.info(
    `[ShortTermMemory] mode=${stmConfig.mode}, wal=${stmConfig.walEnabled ? "on" : "off"}, digest=${stmConfig.digestEnabled ? "on" : "off"}, deferArchive=${stmConfig.deferTurnArchive ? "on" : "off"}, tz=${stmConfig.digestTimezone}`,
  );

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
      void (async () => {
        const compacted = await compactObserveLine("hermes.observe", line);
        await narrativeMemory?.ingest(actorId, compacted, "hermes:observe");
      })().catch(() => {});
    },
  });
  worldService.setEvolutionHooks({
    onWorldCreditsCredited: (ev) => {
      evolutionMemory.appendWorldCreditLine(ev.actorSessionId, ev);
      void narrativeMemory
        ?.ingest(
          ev.actorSessionId,
          `世界入账 +${ev.amount}（${ev.reason}），余额 ${ev.balanceAfter}`,
          "world:credits",
        )
        .catch(() => {});
    },
    onSkillPurchased: (ev) => {
      const m = skillManager.get(ev.skillId);
      evolutionMemory.appendSkillPurchaseLine(ev.actorSessionId, {
        skillId: ev.skillId,
        displayName: m?.displayName ?? ev.skillId,
        pricePaid: ev.pricePaid,
        balanceAfter: ev.balanceAfter,
      });
      void narrativeMemory
        ?.ingest(
          ev.actorSessionId,
          `购买技能「${m?.displayName ?? ev.skillId}」（${ev.skillId}）花费 ${ev.pricePaid} 点，余额 ${ev.balanceAfter}`,
          "world:skill_purchase",
        )
        .catch(() => {});
    },
  });

  const externalChat = createExternalChatProviderFromEnv();
  const userPersonalizationService = new UserPersonalizationService(
    agentMemorySyncService,
    externalChat,
  );
  const scheduleIntentService = new ScheduleIntentService(externalChat);
  registerLifeTools(toolRegistry, scheduleTaskService, scheduleIntentService);
  registerCalendarTools(toolRegistry, scheduleTaskService, scheduleIntentService);
  const smartHomeService = new SmartHomeService();
  registerSmartHomeTools(toolRegistry, smartHomeService);
  const promptContextBuilder = new PromptContextBuilder({
    agentMemorySyncService,
    worldService,
    skillManager,
    virtualPhoneService,
    scheduleTaskService,
  });
  const agentCore = createAgentCore({
    toolRegistry,
    externalChat,
    computeQuotaService,
    agentMemorySyncService,
    hermesEvolutionLoopService,
    userPersonalizationService,
    worldService,
    skillManager,
    narrativeMemory,
    trajectorySkillPromotion,
    virtualPhoneService,
    scheduleTaskService,
  });
  scheduleTaskService.setAgentTaskHandler(async (task) => {
    const prompt = task.agentTask?.prompt?.trim();
    if (!prompt) {
      throw new Error("Agent 自动化任务缺少 prompt");
    }
    const accessMode = task.agentTask?.accessMode ?? "sandbox";
    wsConnectionRegistry.trySend(
      task.sessionId,
      JSON.stringify({
        type: ServerEventType.ScheduleAgentTaskFired,
        payload: {
          taskId: task.taskId,
          title: task.title,
          status: "started",
          prompt,
        },
      }),
    );
    embodimentThinking(
      task.sessionId,
      (json) => wsConnectionRegistry.trySend(task.sessionId, json),
      task.title || "自动化任务执行中",
      { phase: "agent_task", source: "schedule.agent_task_fired" },
    );
    const reply = await agentCore.handleUserMessage(task.sessionId, prompt, {
      chatUserMessageId: `schedule:${task.taskId}:${Date.now()}`,
      agentAccessMode: accessMode,
      onAssistantDelta: (delta) => {
        wsConnectionRegistry.trySend(
          task.sessionId,
          JSON.stringify({
            type: ServerEventType.ChatAssistantChunk,
            payload: {
              messageId: task.taskId,
              delta,
              source: "schedule.agent_task",
            },
          }),
        );
      },
    });
    const toolRun = await agentCore.runToolIfNeeded(task.sessionId, reply, {
      chatUserMessageId: `schedule:${task.taskId}:tool`,
      agentAccessMode: accessMode,
    });
    const result = {
      type: "agent_task",
      ok: toolRun.ok,
      title: task.title,
      prompt,
      text: reply.text,
      toolName: reply.toolName,
      toolResult: toolRun.result,
    };
    wsConnectionRegistry.trySend(
      task.sessionId,
      JSON.stringify({
        type: ServerEventType.ScheduleAgentTaskFired,
        payload: {
          taskId: task.taskId,
          title: task.title,
          status: toolRun.ok ? "completed" : "failed",
          result,
        },
      }),
    );
    return result;
  });
  new GomokuAgentTurnService(gomokuService, toolRegistry, externalChat, promptContextBuilder);

  const proactiveCenter = new ProactiveAgentCenter(externalChat, promptContextBuilder);
  proactiveCenter.start();

  app.log.info(`[AgentRuntime] ${formatAgentRuntimeConfigSummary(getAgentRuntimeConfig())}`);

  const visionPeriodicScheduler = new VisionPeriodicScheduler({
    agentCore,
    wsRegistry: wsConnectionRegistry,
  });
  registerVisionTools(toolRegistry, visionPeriodicScheduler);

  const desktopVisual = createDesktopVisualFromEnv();
  const desktopBridgeCoordinator = new DesktopBridgeCoordinator({
    onSync: (actorId, payload) => {
      wsConnectionRegistry.trySend(
        actorId,
        JSON.stringify({ type: ServerEventType.DesktopBridgeSync, payload }),
      );
    },
  });
  registerDesktopVisualTools(toolRegistry, {
    localVisual: desktopVisual,
    bridge: desktopBridgeCoordinator,
  });
  agentCore.setDesktopBridgeCoordinator(desktopBridgeCoordinator);

  registerEmbodimentTools(toolRegistry, {
    wsRegistry: wsConnectionRegistry,
    localVisual: desktopVisual,
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
    gameCenterCoordinator,
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
    companionService,
    agentCore,
    wsConnectionRegistry,
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
    gomokuService,
    socialFeedService,
    computeQuotaService,
    agentMemorySyncService,
    unifiedIdempotencyService,
    desktopBridgeCoordinator,
    virtualPhoneService,
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
