import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import {
  A2aOutsourcingService,
  loadPersistedCommunitySkills,
  registerWorldFreeMarketTools,
  registerWorldOpenRegistryTools,
  registerWorldRoomTools,
  registerWorldSocialTools,
  SocialFeedService,
  AgentWorldServerEventType,
  WorldPartitionWsRegistry,
  WorldService,
  type WorldRevisionEvent,
} from "@private-ai-agent/agent-world";
import { createExternalChatProviderFromEnv } from "../external-model/index.js";
import type { ChatToolExecutionContext } from "../external-model/types.js";
import { getChatThreadPersistence } from "../external-model/chat-thread-persist.js";
import { LivingInterimController, interimAckMessageId } from "../agent/interim-ack.js";
import {
  formatAgentStylePrompt,
  loadAgentStyleProfile,
  validateStyleConsistency,
} from "../agent/agent-style-profile.js";
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
import { HermesEvolutionLoopService } from "../services/hermes-evolution-loop-service.js";
import { UserPersonalizationService } from "../services/user-personalization/user-personalization-service.js";
import { createNarrativeMemoryPort } from "../services/narrative-memory-port.js";
import { initMemoryManagerService, getMemoryManagerService } from "../services/memory-manager-service.js";
import { initHumanLikeMemoryService } from "../services/human-like-memory-service.js";
import { getAgenticMemoryRuntime } from "../agentic-memory/index.js";
import { getDailyDigestService } from "../services/daily-digest-service.js";
import { getShortTermMemoryConfig } from "../services/short-term-memory-config.js";
import { initShortTermMemoryGatewayService } from "../services/short-term-memory-gateway.js";
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
import { AgentSelfLearningService } from "../services/agent-self-learning-service.js";
import { SkillGenerator } from "../services/skill-generator.js";
import { ProactiveAgentCenter } from "../services/proactive-agent-center.js";
import { ProactiveOutboundMessageService, type ProactiveOutboundChannel } from "../services/proactive-outbound-message-service.js";
import { LifeSignalHubService } from "../services/life-signal-hub-service.js";
import { AnticipationEngineService } from "../services/anticipation-engine-service.js";
import { ProactiveLifeRuntimeService } from "../services/proactive-life-runtime-service.js";
import { DesktopPresenceSignalService } from "../services/desktop-presence-signal-service.js";
import { HookBus, setHookBus } from "../services/hooks/index.js";
import { WebhookService } from "../services/webhook/index.js";
import { AgentPairingService } from "../services/agent-pairing-service.js";
import { AgentRelayService } from "../services/agent-relay-service.js";
import { AuditService } from "../services/audit-service.js";
import { EmailRegistrationService } from "../services/email-registration-service.js";
import { InfoHubService } from "../services/info-hub-service.js";
import { RealFundsWalletService } from "../services/real-funds-wallet-service.js";
import { PaymentService } from "../services/payment-service.js";
import { MeituanService } from "../services/meituan-service.js";
import { ScheduleIntentService } from "../services/schedule-intent-service.js";
import { ScheduleTaskService } from "../services/schedule-task-service.js";
import { SessionService } from "../services/session-service.js";
import { TtsService } from "../services/tts-service.js";
import { VirtualPhoneService } from "../services/virtual-phone-service.js";
import { VirtualPhoneIncomingCoordinator } from "../services/virtual-phone-incoming-coordinator.js";
import { VoiceCapabilityService } from "../services/voice-capability-service.js";
import { VoiceMessageService } from "../services/voice-message-service.js";
import { ImageGenerationService } from "../services/image-generation-service.js";
import { FileProcessingService } from "../services/file-processing-service.js";
import { EmailSmsService } from "../services/email-sms-service.js";
import { MediaMusicService } from "../services/media-music-service.js";
import { HealthFitnessService } from "../services/health-fitness-service.js";
import { FinanceDeepService } from "../services/finance-deep-service.js";
import { SocialOutreachService } from "../services/social-outreach-service.js";
import { CodeSandboxService } from "../services/code-sandbox-service.js";
import { ShoppingOrderService } from "../services/shopping-order-service.js";
import { AgentBrowserService } from "../services/agent-browser-service.js";
import { VoiceDialogueService } from "../services/voice-dialogue/voice-dialogue-service.js";
import type { ASRProvider } from "../services/voice-dialogue/types.js";
import { OpenAITTSAdapter } from "../services/voice-dialogue/adapters/openai-tts-adapter.js";
import { SiliconFlowTTSAdapter } from "../services/voice-dialogue/adapters/siliconflow-tts-adapter.js";
import { OpenAILLMAdapter } from "../services/voice-dialogue/adapters/openai-llm-adapter.js";
import { OpenAIASRAdapter } from "../services/voice-dialogue/adapters/openai-asr-adapter.js";
import { FunAsrAdapter } from "../services/voice-dialogue/adapters/funasr-asr-adapter.js";
import { createIntelligentReminderSystem } from "../services/intelligent-reminder/index.js";
import { UpstreamSearchService } from "../services/upstream-search-service.js";
import { WsConnectionRegistry } from "../services/ws-connection-registry.js";
import { SkillManager } from "../skills/index.js";
import { registerAgentWorldIdentityBuiltinSkills } from "../skills/builtin/agent-world-identity-skills.js";
import { registerVirtualPhoneBuiltinSkills } from "../skills/builtin/virtual-phone-skills.js";
import { SkillValidator } from "../skills/skill-validator.js";
import type { SkillMetadata } from "../skills/types.js";
import { registerAgentAccountTools } from "../tools/agent-account-tools.js";
import { registerWalletTools } from "../tools/wallet-tools.js";
import { registerPaymentTools } from "../tools/payment-tools.js";
import { registerMeituanTools } from "../tools/meituan-tools.js";
import { registerAgentPhoneTools } from "../tools/agent-phone-tools.js";
import { registerAgentVoiceTools } from "../tools/agent-voice-tools.js";
import {
  getAllCapabilityModuleIntentRules,
  registerAllCapabilityModules,
  type CapabilityModuleDeps,
} from "../tools/capability-modules/index.js";
import { setExtraIntentRules } from "../tools/tool-search/intent-metadata.js";
import { setCapabilityModuleDeps } from "../external-model/openai-compatible-tool-loop.js";
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
import { registerDeviceTools } from "../tools/device-tools.js";
import { SmartHomeService } from "../services/smart-home-service.js";
import { DeviceRegistry } from "../device-bus/device-registry.js";
import { createHomeAdapterFactory } from "../device-bus/adapters/home-adapter.js";
import { createPhoneAdapterFactory } from "../device-bus/adapters/phone-adapter.js";
import { createDesktopAdapterFactory } from "../device-bus/adapters/desktop-adapter.js";
import { createTabletAdapterFactory } from "../device-bus/adapters/tablet-adapter.js";
import { createGlassesAdapterFactory } from "../device-bus/adapters/glasses-adapter.js";
import { createCameraAdapterFactory } from "../device-bus/adapters/camera-adapter.js";
import { DevicePairingService } from "../services/device-pairing-service.js";
import { registerWeatherTools } from "../tools/weather-tools.js";
import { registerCareReminderTools } from "../tools/care-reminder-tools.js";
import { registerLifeSignalTools } from "../tools/life-signal-tools.js";
import { registerMarketSignalTools } from "../tools/market-signal-tools.js";
import { ToolRegistry, type ToolContext } from "../tools/tool-registry.js";
import { DesktopBridgeCoordinator } from "../services/desktop-bridge-coordinator.js";
import { WechatClawBindingService } from "../services/wechat-claw-binding-service.js";
import { WechatClawBridgeService } from "../services/wechat-claw-bridge-service.js";
import { MessageHubService } from "../services/message-hub-service.js";
import { MessagePlatformGateway } from "../services/message-platform-gateway.js";
import { MessageBridgeService } from "../services/message-bridge-service.js";
import { createDesktopVisualFromEnv } from "../services/desktop-visual-subprocess.js";
import { registerDesktopVisualTools } from "../tools/desktop-visual-tools.js";
import { registerPhoneBridgeTools } from "../tools/phone-bridge-tools.js";
import { registerMessageHubTools } from "../tools/message-hub-tools.js";
import { PhoneBridgeCoordinator } from "../services/phone-bridge-coordinator.js";
import { registerVisionTools } from "../tools/vision-tools.js";
import { registerWebTools } from "../tools/web-tools.js";
import { registerHttpTools } from "../tools/http-tools.js";
import { registerMcpTools } from "../tools/mcp-tools.js";
import { buildMcpChatTools } from "../tools/mcp-tools.js";
import { McpClientService } from "../services/mcp-client-service.js";
import { setMcpChatTools, setBrainChatTools } from "../external-model/openai-compatible-tool-loop.js";
import { registerBrainTools, BRAIN_TOOLS } from "../tools/brain-tools.js";
import { registerBrowserTools } from "../tools/browser-tools.js";
import { BrowserSessionService } from "../services/browser-session-service.js";
import { registerSelfProgrammingTools } from "../tools/self-programming-tools.js";
import { registerAISkillGenerationTools } from "../tools/ai-skill-generation-tools.js";
import { registerSelfLearningTools } from "../tools/self-learning-tools.js";
import { registerNotesTools } from "../tools/notes-tools.js";
import { NotesService } from "../services/notes-service.js";
import { MorningBriefingService } from "../services/morning-briefing-service.js";
import { MorningBriefingScheduler } from "../services/morning-briefing-scheduler.js";
import { markMorningBriefingDelivered } from "../routes/http/user-preferences.js";
import { getUserPreferences } from "../routes/http/user-preferences.js";
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
import { MarketSignalService } from "../services/market-signal-service.js";
import { MoodInferenceService } from "../services/mood-inference-service.js";
import {
  notifyScheduleTasksChanged,
  scheduleWsPayloadDeleted,
  scheduleWsPayloadFromTask,
} from "../services/schedule-ws-notify.js";
import {
  BrainCenter,
  CapabilityCortex,
  AwarenessCortex,
  ProactionCortex,
  EvolutionCortex,
  SensoryCortex,
  MemoryCortex,
  SynapseBus,
  LimbicCortex,
  PlannerCortex,
  BrainStem,
  Cerebellum,
  type BrainSignalInput,
  type BrainDecision,
  type MemoryRecallItem,
  type CognitiveEngine,
  type CognitiveInput,
  type CognitiveContext,
  type EndToEndDecisionMaker,
  type MemoryCortexLike,
} from "../brain/index.js";
import { getAgentTaskSafety } from "../services/agent-task-safety.js";
import { detectAssistantToneMode } from "../services/assistant-tone-policy.js";
import {
  detectEmotionFromText,
  detectPreferredToneFromText,
  buildToneGuidance,
  type EmotionState,
} from "../services/user-personalization/emotion-tone.js";
import { routeLlmExecution } from "../agent/task-router.js";
import { runPlanExecuteLoop, type PlanExecuteLoopResult } from "../agent/plan-execute-loop.js";
import { ProactiveContactPolicyService } from "../services/proactive-contact-policy.js";
import { setCapabilityCortex } from "../agent/agent-capabilities.js";

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
  await app.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } });

  const sessionService = new SessionService();
  await getChatThreadPersistence().load();
  const scheduleTaskService = new ScheduleTaskService();
  const weatherService = new WeatherService();
  const weatherPrefsService = new WeatherPrefsService();
  const infoHubService = new InfoHubService();
  const browserSessionService = new BrowserSessionService();
  const upstreamSearchService = new UpstreamSearchService(infoHubService);
  const realFundsWallet = new RealFundsWalletService();
  const paymentService = new PaymentService();
  const meituanService = new MeituanService();
  const auditService = new AuditService();
  const computeQuotaService = new ComputeQuotaService();
  const companionService = new CompanionService();
  const agentMemorySyncService = new AgentMemorySyncService();
  const unifiedIdempotencyService = new UnifiedIdempotencyService();
  const toolRegistry = new ToolRegistry();
  const lifeSignalHubService = new LifeSignalHubService(
    join(process.cwd(), "data", "life-signals.json"),
  );
  await lifeSignalHubService.load();
  const anticipationEngineService = new AnticipationEngineService(
    join(process.cwd(), "data", "anticipation-candidates.json"),
  );
  await anticipationEngineService.load();
  const marketSignalService = new MarketSignalService(lifeSignalHubService);
  const desktopPresenceSignalService = new DesktopPresenceSignalService(lifeSignalHubService);
  const messageHubService = new MessageHubService(join(process.cwd(), "data", "message-hub.json"));
  await messageHubService.load();
  const messagePlatformGateway = new MessagePlatformGateway();

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
  registerHttpTools(toolRegistry);

  // ========== MCP 客户端服务 ==========
  const mcpClientService = new McpClientService();
  if (mcpClientService.listServers().length > 0) {
    await mcpClientService.discoverTools();
    const mcpToolCount = mcpClientService.listTools().length;
    if (mcpToolCount > 0) {
      registerMcpTools(toolRegistry, mcpClientService);
      setMcpChatTools(buildMcpChatTools(mcpClientService));
      app.log.info(`[MCP] 已发现并注册 ${mcpToolCount} 个 MCP 工具（${mcpClientService.listServers().map(s => s.alias).join(", ")}）`);
    } else {
      app.log.info("[MCP] 已配置 server 但未发现可用工具，请确认 mcporter 中已正确配置 server alias");
    }
  } else {
    app.log.info("[MCP] 未配置 MCP Server（可通过 data/mcp-servers.json 或 MCP_SERVERS 环境变量配置）");
  }

  registerBrowserTools(toolRegistry, browserSessionService);
  registerClockTools(toolRegistry);
  registerWeatherTools(toolRegistry, weatherService);
  registerCareReminderTools(toolRegistry, {
    agentMemorySyncService,
    scheduleTaskService,
  });
  registerLifeSignalTools(toolRegistry, lifeSignalHubService);
  registerMarketSignalTools(toolRegistry, marketSignalService);
  let messageBridgeService: MessageBridgeService;

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

  // 初始化语音对话服务（ASR + LLM + TTS 抽象层）
  const voiceDialogueService = new VoiceDialogueService();

  // ASR Adapter 优先级：FunASR（自托管，中文最佳）→ OpenAI Whisper（兜底）
  const funasrAdapter = new FunAsrAdapter();
  const openaiAsrAdapter = new OpenAIASRAdapter();
  const defaultAsr: ASRProvider = funasrAdapter.isEnabled() ? funasrAdapter : openaiAsrAdapter;

  // 注册 OpenAI provider（默认）
  // ASR 走 defaultAsr（FunASR 优先，否则 OpenAI Whisper 兜底）。
  // 注意：不能硬编码 openaiAsrAdapter，否则当 siliconflow TTS 未配置、
  // 默认 provider 回退到 "openai" 时，ASR 会绕过 FunASR 直接打 OpenAI 端点（如 DeepSeek，404）。
  voiceDialogueService.registerProvider("openai", {
    asr: defaultAsr,
    tts: new OpenAITTSAdapter(ttsService),
    llm: new OpenAILLMAdapter(),
  });

  // 注册硅基流动 TTS provider（中文语音质量更佳，优先使用）
  const siliconflowTTS = new SiliconFlowTTSAdapter();
  if (siliconflowTTS.isEnabled()) {
    voiceDialogueService.registerProvider("siliconflow", {
      asr: defaultAsr, // ASR 走 FunASR（如已配置），否则 OpenAI
      tts: siliconflowTTS,
      llm: new OpenAILLMAdapter(),
    });
    voiceDialogueService.setDefaultProvider("siliconflow");
    app.log.info(
      `[VoiceDialogue] 硅基流动 TTS 已启用，设为默认提供商（ASR：${defaultAsr.name}）`,
    );
  } else {
    app.log.info("[VoiceDialogue] 硅基流动 TTS 未配置或凭证不完整，使用 OpenAI 作为默认提供商");
    voiceDialogueService.setDefaultProvider("openai");
  }

  // FunASR 自托管 ASR 优先（中文识别效果优于 whisper）
  if (funasrAdapter.isEnabled()) {
    app.log.info(
      `[VoiceDialogue] FunASR 已启用（${process.env.FUNASR_BASE_URL}），中文 ASR 走 FunASR`,
    );
  }

  // 初始化 Agent 底层语音能力中枢（TTS + ASR + WS 推送）。
  // 作为 Agent 的底层能力，被 voice.speak 工具、智能提醒、主动消息等场景统一调度。
  const voiceMessageService = new VoiceMessageService();
  voiceMessageService.setTtsService(ttsService);
  // 初始化图像生成能力服务（硅基流动 text-to-image，下载到本地静态目录）。
  // 与语音消息同模式：独立目录 data/images/{actorId}/{imageId}.png，HTTP 走 /agent/images。
  const imageGenerationService = new ImageGenerationService();
  // 初始化文件/文档处理能力服务（read/write/parse_pdf/parse_office/export_format）。
  // 独立目录 data/user-files/{actorId}/{fileName}，HTTP 走 /agent/files。
  const fileProcessingService = new FileProcessingService();
  // 初始化邮件/短信主动发送服务（SMTP + 阿里云短信，凭证从环境变量读取）。
  const emailSmsService = new EmailSmsService();
  // 初始化媒体音乐服务（搜索 + WS 推送播放控制事件）。
  const mediaMusicService = new MediaMusicService(wsConnectionRegistry);
  // 初始化健康/运动数据服务（data/health/{actorId}.json，1s 防抖落盘）。
  const healthFitnessService = new HealthFitnessService(join(process.cwd(), "data", "health"));
  // 初始化财务深度服务（data/finance/{actorId}/{transactions,budgets}.json + reports/）。
  const financeDeepService = new FinanceDeepService(join(process.cwd(), "data", "finance"));
  // 初始化社交主动出击服务（Twitter OAuth 1.0a + 微博 + 小红书/朋友圈占位，凭证从环境变量读取）。
  const socialOutreachService = new SocialOutreachService();
  // 初始化代码执行沙盒服务（python/node 子进程，独立工作目录 data/sandbox/{actorId}/{workspaceId}/）。
  const codeSandboxService = new CodeSandboxService();
  // 初始化购物/下单服务（后台 Playwright 无头浏览器，注入用户 Cookie 代用户下单）。
  const shoppingOrderService = new ShoppingOrderService({
    browserSessionService,
    audit: auditService,
  });
  // 初始化 Agent 虚拟浏览器服务（有状态会话池，通用网页多步操作：open/click/type/scroll/screenshot/extract_text/wait_for/close）。
  const agentBrowserService = new AgentBrowserService({
    browserSessionService,
    audit: auditService,
  });
  const voiceCapabilityService = new VoiceCapabilityService({
    ttsService,
    voiceDialogueService,
    wsRegistry: wsConnectionRegistry,
    voiceMessageService,
    logger: app.log,
  });
  if (voiceCapabilityService.getCapabilityInfo().ttsEnabled) {
    app.log.info(
      `[VoiceCapability] 已启用（TTS 提供商：${voiceCapabilityService.getCapabilityInfo().ttsProvider}）`,
    );
  } else {
    app.log.warn("[VoiceCapability] TTS 未启用，voice.speak 工具将仅推送文本兜底");
  }

  // 初始化手机桥接协调器（须在智能提醒系统之前，供其调度 phone.ring）
  const phoneBridgeCoordinator = new PhoneBridgeCoordinator({
    onSync: (actorId, payload) => {
      wsConnectionRegistry.trySend(
        actorId,
        JSON.stringify({ type: ServerEventType.PhoneBridgeSync, payload }),
      );
    },
  });
  registerPhoneBridgeTools(toolRegistry, { bridge: phoneBridgeCoordinator });

  // 初始化智能提醒系统（弹窗 → TTS闹钟 → 电话呼叫 三级升级链）
  const intelligentReminder = createIntelligentReminderSystem({
    toolRegistry,
    virtualPhoneService,
    phoneBridgeCoordinator,
    voiceDialogueService,
    voiceCapabilityService,
    sendToClient: async (userId, payload) => {
      await wsConnectionRegistry.trySend(userId, JSON.stringify(payload));
    },
    onContactOutcome: (params) => {
      const channel =
        params.channel === "popup"
          ? "websocket"
          : params.channel === "tts_alarm"
            ? "voice"
            : "phone_call";
      userPersonalizationService.observeContactOutcome(params.userId, {
        channel,
        responded: params.responded,
        responseTimeMs: params.responseTimeMs,
        feedback: params.feedback,
        quietHours: params.quietHours,
      });
    },
    logger: app.log,
  });
  await intelligentReminder.userResponsePersistence.load();

  scheduleTaskService.setTaskChangeHandler(async (action, task) => {
    notifyScheduleTasksChanged(
      wsConnectionRegistry,
      action === "deleted"
        ? scheduleWsPayloadDeleted(task.sessionId, task.taskId)
        : scheduleWsPayloadFromTask(task, action),
    );
  });

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
    // 不再根据"起床/叫醒"等关键词自动拨打电话
    // 日程提醒应仅通过 WebSocket 推送 + embodimentAlert 通知用户
    // 如需电话提醒，用户应显式使用 phone.call_user 工具
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
  registerPaymentTools(toolRegistry, paymentService);
  registerMeituanTools(toolRegistry, meituanService);
  registerAgentLinkTools(toolRegistry, friendService, agentAccountService);
  registerAgentRelayTools(
    toolRegistry,
    agentRelayService,
    wsConnectionRegistry,
    agentPairingService,
  );
  registerAgentPhoneTools(toolRegistry, virtualPhoneService);
  registerAgentVoiceTools(toolRegistry, voiceCapabilityService, voiceMessageService);
  // 注册能力模块（image-gen / file-doc / email-sms / ...）
  // 通过 setCapabilityModuleDeps 让 getBuiltinAgentChatTools 自动合并 ChatCompletionTool；
  // 通过 setExtraIntentRules 把模块意图元数据合并到 BM25 调权；
  // registerAllCapabilityModules 把 handler 注册到 ToolRegistry。
  const capabilityModuleDeps: CapabilityModuleDeps = {
    imageGenerationService,
    fileProcessingService,
    emailSmsService,
    mediaMusicService,
    wsConnectionRegistry,
    healthFitnessService,
    financeDeepService,
    socialOutreachService,
    codeSandboxService,
    shoppingOrderService,
    agentBrowserService,
  };
  setCapabilityModuleDeps(capabilityModuleDeps);
  setExtraIntentRules(getAllCapabilityModuleIntentRules(capabilityModuleDeps));
  registerAllCapabilityModules(toolRegistry, capabilityModuleDeps);
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
  const socialFeedService = new SocialFeedService(worldService);
  socialFeedService.attachWebSocketRegistry(wsConnectionRegistry);
  registerWorldOpenRegistryTools(toolRegistry, worldService);
  registerWorldRoomTools(toolRegistry, worldService);
  registerWorldSocialTools(toolRegistry, socialFeedService);
  registerWorldFreeMarketTools(toolRegistry, worldService, a2aOutsourcingService, skillManager);
  toolRegistry.setWorldService(worldService);
  registerCapabilityQueryTools(toolRegistry, { skillManager, worldService, virtualPhoneService });

  const agenticMemoryRuntime = getAgenticMemoryRuntime();
  const humanLikeMemory = await initHumanLikeMemoryService();
  const shortTermMemoryGateway = await initShortTermMemoryGatewayService();
  const narrativeMemory = createNarrativeMemoryPort({
    agenticIngest: agenticMemoryRuntime?.ingest ?? null,
    agenticRetrieval: agenticMemoryRuntime?.retrieval ?? null,
    compressor: agenticMemoryRuntime?.compressor ?? null,
    humanLikeMemory,
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
    nightlyMemoryService.setDependencies(
      memoryManager,
      dailyDigestService,
      agentMemorySyncService,
      narrativeMemory,
    );
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
      agentMemorySyncService.appendMemorySummaryLine(
        ev.actorSessionId,
        `世界入账 +${ev.amount}（${ev.reason}），余额 ${ev.balanceAfter}`,
        "world",
      );
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
      agentMemorySyncService.appendMemorySummaryLine(
        ev.actorSessionId,
        `购买技能「${m?.displayName ?? ev.skillId}」（${ev.skillId}）花费 ${ev.pricePaid} 点，余额 ${ev.balanceAfter}`,
        "world",
      );
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
  const moodInferenceService = new MoodInferenceService({
    externalChat,
    persistFilePath: join(process.cwd(), "data", "mood-inferences.jsonl"),
    logger: {
      info: (msg) => app.log.info(msg),
      warn: (msg) => app.log.warn(msg),
      error: (msg) => app.log.error(msg),
    },
  });
  await moodInferenceService.load();
  app.log.info("[MoodInference] 服务已初始化并加载历史数据");

  const notesService = new NotesService(join(process.cwd(), "data"));
  await notesService.load().catch((err) => {
    app.log.error({ err }, "NotesService 加载失败");
  });
  const userPersonalizationService = new UserPersonalizationService(
    agentMemorySyncService,
    externalChat,
  );
  const morningBriefingService = new MorningBriefingService({
    weatherService,
    weatherPrefsService,
    scheduleTaskService,
    notesService,
    getSessionPrefs: (sessionId) => getUserPreferences(sessionId),
  });

  const morningBriefingScheduler = new MorningBriefingScheduler({
    briefingService: morningBriefingService,
    getSessionPrefs: (sessionId) => getUserPreferences(sessionId),
    onBriefingTriggered: async (sessionId, payload) => {
      const sent = wsConnectionRegistry.trySend(
        sessionId,
        JSON.stringify({
          type: ServerEventType.MorningBriefing,
          payload: {
            sessionId,
            mode: payload.mode,
            narrationText: payload.narrationText,
            briefing: payload.briefing,
          },
        }),
      );
      if (sent) {
        markMorningBriefingDelivered(sessionId, "scheduled");
      }
    },
  });
  morningBriefingScheduler.start();
  app.log.info("[MorningBriefing] 调度器已启动");

  const scheduleIntentService = new ScheduleIntentService(externalChat);
  registerLifeTools(toolRegistry, scheduleTaskService, scheduleIntentService);
  registerCalendarTools(toolRegistry, scheduleTaskService, scheduleIntentService);
  const smartHomeService = new SmartHomeService();
  registerSmartHomeTools(toolRegistry, smartHomeService);
  // 启动智能家居设备状态轮询（若 HA 已配置），将状态变化发布为 smart_home 信号
  if (smartHomeService.isEnabled()) {
    smartHomeService.startStatePolling(lifeSignalHubService);
  }

  // ========== 终端互连平台 device-bus ==========
  // 统一抽象手机 / 桌面 / 家居 / 摄像头 / 眼镜等终端，按 deviceId 多设备并存。
  // 与现有 wsConnectionRegistry（单 session 单连接）共存，互不依赖。
  const deviceRegistry = new DeviceRegistry();
  deviceRegistry.registerFactory(createHomeAdapterFactory(smartHomeService));
  deviceRegistry.registerFactory(createPhoneAdapterFactory());
  deviceRegistry.registerFactory(createDesktopAdapterFactory());
  deviceRegistry.registerFactory(createTabletAdapterFactory());
  deviceRegistry.registerFactory(createGlassesAdapterFactory());
  deviceRegistry.registerFactory(createCameraAdapterFactory());
  // 家居是本地服务（无 WS），若 HA 已配置则主动注册一个全局 home 设备
  if (smartHomeService.isEnabled()) {
    void deviceRegistry.register({
      deviceId: "home:default",
      kind: "home",
      name: "HomeAssistant",
      ownerUserId: "system",
      capabilities: [],
      status: "online",
      lastSeenAt: Date.now(),
      connectionKind: "local_service",
      metadata: { baseUrl: process.env.HA_BASE_URL },
    }).catch((err) => {
      app.log.warn({ err }, "[DeviceBus] home:default 注册失败");
    });
  }
  app.log.info(
    `[DeviceBus] 已注册适配器工厂: ${deviceRegistry.getRegisteredKinds().join(", ")}`,
  );

  // 设备配对服务：用户生成配对码 → 设备端提交配对码完成绑定
  const devicePairingService = new DevicePairingService();
  await devicePairingService.load();
  // 设备上下线广播：订阅 DeviceRegistry，推送给 ownerUserId 的 WS session
  deviceRegistry.subscribe((event) => {
    let ownerUserId: string | undefined;
    let payload: { type: string; payload: Record<string, unknown> } | undefined;
    if (event.kind === "online") {
      ownerUserId = event.descriptor.ownerUserId;
      payload = {
        type: ServerEventType.DeviceOnline,
        payload: {
          deviceId: event.descriptor.deviceId,
          kind: event.descriptor.kind,
          name: event.descriptor.name,
          ownerUserId: event.descriptor.ownerUserId,
          capabilities: event.descriptor.capabilities,
          status: event.descriptor.status,
        },
      };
    } else if (event.kind === "offline") {
      ownerUserId = event.ownerUserId;
      payload = {
        type: ServerEventType.DeviceOffline,
        payload: {
          deviceId: event.deviceId,
          ownerUserId: event.ownerUserId,
          reason: event.reason,
        },
      };
    } else if (event.kind === "status_changed") {
      ownerUserId = event.ownerUserId;
      payload = {
        type: ServerEventType.DeviceListChanged,
        payload: {
          deviceId: event.deviceId,
          ownerUserId: event.ownerUserId,
          status: event.status,
        },
      };
    } else if (event.kind === "capability_changed") {
      ownerUserId = event.ownerUserId;
      payload = {
        type: ServerEventType.DeviceListChanged,
        payload: {
          deviceId: event.deviceId,
          ownerUserId: event.ownerUserId,
          capabilities: event.capabilities,
        },
      };
    }
    if (ownerUserId && payload) {
      wsConnectionRegistry.trySend(ownerUserId, JSON.stringify(payload));
    }
  });

  registerDeviceTools(toolRegistry, deviceRegistry, devicePairingService);
  const promptContextBuilder = new PromptContextBuilder({
    agentMemorySyncService,
    worldService,
    skillManager,
    virtualPhoneService,
    scheduleTaskService,
    shortTermMemoryGateway,
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
    shortTermMemoryGateway,
    moodInferenceService,
    lifeSignalHubService,
  });
  agentCore.setPhoneBridgeCoordinator(phoneBridgeCoordinator);
  agentCore.setMoodInferenceService(moodInferenceService);
  agentCore.setLifeSignalHubService(lifeSignalHubService);
  agentCore.setWsRegistry(wsConnectionRegistry);

  const virtualPhoneIncomingCoordinator = new VirtualPhoneIncomingCoordinator(
    agentCore,
    wsConnectionRegistry,
  );
  virtualPhoneService.setIncomingCoordinator(virtualPhoneIncomingCoordinator);
  scheduleTaskService.setAgentTaskHandler(async (task) => {
    const prompt = task.agentTask?.prompt?.trim();
    if (!prompt) {
      throw new Error("Agent 自动化任务缺少 prompt");
    }
    const accessMode = task.agentTask?.accessMode ?? "full";
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

  const proactiveOutbound = new ProactiveOutboundMessageService(async (userId, payload) => {
    const proactivePayload =
      payload && typeof payload.payload === "object" && payload.payload
        ? (payload.payload as Record<string, unknown>)
        : null;
    const title = String(proactivePayload?.title ?? "Agent 主动联系");
    const text = String(proactivePayload?.text ?? "");
    const channel = String(proactivePayload?.channel ?? "websocket");

    if (channel === "phone_call") {
      const result = await virtualPhoneService.callUserWithRinging({
        fromActorId: userId,
        toUserId: userId,
        transcript: `${title}。${text}`,
        ringStyle: "reminder",
      });
      if (result.ok && result.pushed) return true;
    }

    if (channel === "voice") {
      // 委托给 VoiceCapabilityService 统一推送主动语音（合成 + WS 一站式）
      return voiceCapabilityService.pushProactiveVoice(userId, title, text);
    }

    return wsConnectionRegistry.trySend(userId, JSON.stringify(payload));
  });

  // ─── Brain Center 开关 ───
  // BRAIN_CENTER_ENABLED 未设置或非 "0"/"false"/"off" → 默认启用 brain
  // 启用 brain 时：旧 ProactiveAgentCenter.start() / ProactiveLifeRuntimeService.start()
  //   默认不调用（由 ProactionCortex 接管），除非 BRAIN_PROACTION_LEGACY=1
  // 关闭 brain 时：旧路径完全保持现状
  const brainEnabled = !["0", "false", "off"].includes(
    (process.env.BRAIN_CENTER_ENABLED ?? "").trim().toLowerCase(),
  );
  const brainNeuroEnabled = !["0", "false", "off"].includes(
    (process.env.BRAIN_NEURO_ENABLED ?? "").trim().toLowerCase(),
  );
  const legacyProaction = ["1", "true", "on"].includes(
    (process.env.BRAIN_PROACTION_LEGACY ?? "").trim().toLowerCase(),
  );

  const proactiveLifeRuntimeService = new ProactiveLifeRuntimeService(
    lifeSignalHubService,
    anticipationEngineService,
    proactiveOutbound,
    userPersonalizationService,
    (actorId) => Boolean(wsConnectionRegistry.get(actorId)),
    moodInferenceService,
  );
  if (!brainEnabled) {
    proactiveLifeRuntimeService.start();
  }
  const proactiveCenter = new ProactiveAgentCenter(
    externalChat,
    promptContextBuilder,
    proactiveOutbound,
    userPersonalizationService,
    (actorId) => Boolean(wsConnectionRegistry.get(actorId)),
  );
  if (!brainEnabled) {
    proactiveCenter.start();
  }

  // ─── Brain Center 装配 ───
  // 启用 brain 时：实例化四皮层、注册子系统、注入 prompt builder、启动。
  // 关闭 brain 时（BRAIN_CENTER_ENABLED=0）：整个 brain/ 模块不实例化、不启动，
  //   旧路径完全保留（proactiveCenter / proactiveLifeRuntimeService 已在上面 start）。
  // 共享实例：供 brain EvolutionCortex 与 agent 工具共用同一份状态
  const skillGenerator = new SkillGenerator(externalChat);
  const agentSelfLearningService = new AgentSelfLearningService(
    externalChat,
    toolRegistry,
    skillManager,
  );

  let brainCenter: BrainCenter | null = null;
  // synapseBus 在 brainNeuroEnabled 块内创建；此处预先声明，
  // 供 brainEnabled 块内的主动决策闭环在 neuro 未启用时降级为 null。
  let synapseBus: SynapseBus | null = null;
  // proactionCortex / memoryCortex 外层声明：端到端认知装配需要同时访问两者
  // （proactionCortex 在 brainEnabled 块创建，memoryCortex 在 brainNeuroEnabled 块创建）
  let proactionCortex: ProactionCortex | null = null;
  let memoryCortex: MemoryCortex | null = null;
  // awarenessCortex 外层声明：brainNeuroEnabled 块内 BrainStem/Cerebellum 需注入 observe()
  let awarenessCortex: AwarenessCortex | null = null;
  if (brainEnabled) {
    brainCenter = new BrainCenter();
    const capabilityCortex = new CapabilityCortex();
    awarenessCortex = new AwarenessCortex();
    proactionCortex = new ProactionCortex();
    const evolutionCortex = new EvolutionCortex();

    // CapabilityCortex：注入回 prompt builder（让能力域出现在 prompt 中）
    setCapabilityCortex(capabilityCortex);

    // AwarenessCortex：注册生命信号子系统
    awarenessCortex.registerLifeSignalHub(lifeSignalHubService);
    awarenessCortex.registerDesktopPresence(desktopPresenceSignalService);
    awarenessCortex.registerMoodInference(moodInferenceService);
    awarenessCortex.registerAnticipation(anticipationEngineService);
    // Stage 3 Task 4：注入 schedule-task-service，用于 meeting 状态识别
    awarenessCortex.registerScheduleTask(scheduleTaskService);

    // ProactionCortex：注册 contact policy + awareness + legacy 主动服务（仅 BRAIN_PROACTION_LEGACY=1）
    const proactiveContactPolicyService = new ProactiveContactPolicyService();
    proactionCortex.registerContactPolicy(proactiveContactPolicyService);
    // B3: 注入 AwarenessCortex，让 disturb 评分感知用户活动状态（busy/sleeping/just_off_work）
    proactionCortex.registerAwareness(awarenessCortex);
    // Stage 3 Task 4：反向注入 ProactionCortex，让 AwarenessCortex 查询 recentDecisions
    // 识别 in_focus 状态（持续 busy > 25min 且无 speak 打断）
    awarenessCortex.registerProaction(proactionCortex);
    // Stage 4 Task 3：注入 AgentSelfLearningService，让 assessConfidence 读取历史失败率
    // 作为元认知置信度评估的因子之一（失败率 > 0.3 → -0.2）。
    awarenessCortex.registerSelfLearning(agentSelfLearningService);
    // 端到端认知装配（registerMemory + registerEndToEndMaker + registerCognitiveEngine）
    // 已移到 memoryCortex 声明之后（见 brainNeuroEnabled 块内），避免作用域问题
    if (legacyProaction) {
      proactionCortex.registerLegacyProactiveAgentCenter(proactiveCenter);
      proactionCortex.registerLegacyProactiveLifeRuntime(proactiveLifeRuntimeService);
      proactionCortex.setShadowMode(true);
    }

    // EvolutionCortex：注册四个子系统（自学习 / 技能生成 / 晋升管道 / Hermes 循环）
    evolutionCortex.registerSelfLearning(agentSelfLearningService);
    evolutionCortex.registerSkillGenerator(skillGenerator);
    if (trajectoryPromotionPipeline) {
      evolutionCortex.registerPromotionPipeline(trajectoryPromotionPipeline);
    }
    evolutionCortex.registerHermesLoop(hermesEvolutionLoopService);

    // 注册 WS 审批推送器：自主进化闭环的关键依赖
    // EvolutionCortex 自动生成 Skill 后，通过此推送器向用户发送审批请求 WS 事件
    evolutionCortex.registerApprovalEmitter({
      emitApprovalRequest: (sessionId, request) => {
        try {
          const payload = {
            type: "evolution.approval_request" as const,
            payload: { sessionId, ...request, timestamp: new Date().toISOString() },
          };
          // 推送给所有活跃连接（自主进化不绑定特定 session）
          wsConnectionRegistry.trySend(sessionId, JSON.stringify(payload));
        } catch {
          // 静默失败
        }
      },
      emitApprovalResult: (sessionId, result) => {
        try {
          const payload = {
            type: "evolution.approval_result" as const,
            payload: { sessionId, ...result, timestamp: new Date().toISOString() },
          };
          wsConnectionRegistry.trySend(sessionId, JSON.stringify(payload));
        } catch {
          // 静默失败
        }
      },
    });

    // 注册皮层到 BrainCenter
    brainCenter.registerCapability(capabilityCortex);
    brainCenter.registerAwareness(awarenessCortex);
    brainCenter.registerProaction(proactionCortex);
    brainCenter.registerEvolution(evolutionCortex);

    // 注：BrainCenter.start() / registerBrainTools / setBrainChatTools
    // 已移至 5 个神经解剖分区装配完成之后调用，确保 9 分区均注册后再启动。

    // ─── 主动决策闭环：LifeSignalHub → BrainCenter.decide → 投递 ───
    // 通用路径：任何 LifeSignal 都直接转为 BrainSignalInput，喂给 ProactionCortex
    // 的 value/disturbance 双轨评分。不依赖 AwarenessCortex 的活动类型枚举，
    // 也不需要为新场景扩建关键词——信号自身的 importance/source/kind/metrics
    // 已足够驱动通用决策。AwarenessCortex 的活动推断仅用于 observe() 查询
    // 和（未来）打扰评分上下文，不再是主动决策的瓶颈入口。
    lifeSignalHubService.subscribe((signal) => {
      if (!brainCenter) return;
      // const 本地引用：let brainCenter 在 .then 闭包内会被还原为可空，
      // 用 const bc 锁定窄化，使 scheduleProactive 可直接调用。
      const bc = brainCenter;
      const brainSignal: BrainSignalInput = {
        actorId: signal.actorId,
        kind: signal.kind,
        title: signal.title,
        summary: signal.summary,
        importance: signal.importance,
        metadata: {
          source: signal.source,
          tags: signal.tags,
          metrics: signal.metrics,
          occurredAt: signal.occurredAt,
          description: signal.description,
        },
      };
      // 异步触发决策，不阻塞信号分发
      void bc.decide(brainSignal).then((decision) => {
        if (decision.outcome !== "speak") return;
        // 交小脑调度时机：busy/sleeping → defer 待复查；抑制窗口内 → defer 不抢话；
        // 否则犹豫 0.8-2.5s 后执行（执行前再查抑制窗口，犹豫期被打断则取消）。
        // 小脑未注册时（neuro 关闭）BrainCenter.scheduleProactive 直接 fire。
        void bc
          .scheduleProactive(decision, brainSignal, () =>
            executeProactiveDecision(decision, brainSignal),
          )
          .catch((err) => {
            console.log(`[BrainCenter] 主动决策执行失败: ${err}`);
          });
      }).catch((err) => {
        console.log(`[BrainCenter] decide 调用失败: ${err}`);
      });
    });

    // ─── 主动决策执行器：主动做事 + LLM 话术生成 + SynapseBus 投递 ───
    // 通用实现：基于 BrainSignalInput（kind/title/summary/importance）驱动。
    // 职责分离：ProactionCortex 的 value/disturbance 评分是唯一 speak/silent 决策源；
    // LLM 负责「主动做事 + 生成话术」——可以自主调用工具（查天气/搜新闻/列日程/
    // 查行情等）把结果融入话术，实现"类人主动性"（不只说话，还做事）。
    // 不依赖任何活动类型枚举，新场景只需发对应 LifeSignal 即可被决策与投递。
    const PROACTIVE_SYSTEM_PROMPT = `你察觉到了一件事，需要主动联系用户。

你有两个任务，按顺序执行：
1. **主动做事**：如果信号涉及需要查询或操作的内容（如天气、新闻、行情、日程等），先调用相关工具获取信息。
2. **生成话术**：基于工具结果（如有），生成一句话主动话术。

话术指导（不给示例，自行把握）：
- 像朋友顺嘴提起一件事，不是助理汇报。
- 带出你为什么主动开口，但别啰嗦。
- 融入查到的关键信息，但别像在报数据。
- 语气随场景调整，别一直一个调子。
- 中文简短，别超过 30 字。

直接给出话术正文，不要解释你的决定。`;

    /** C1: 将消息按标点切成 2-3 段，用于分段发送模拟真人打字节奏 */
    function splitIntoSegments(text: string): string[] {
      // 按中文标点（。！？，、；）或英文标点（.!? ,;）切分，保留标点
      const parts = text.split(/(?<=[。！？，,；;])/u).map((s) => s.trim()).filter(Boolean);
      if (parts.length <= 1) return [text];
      // 限制最多 3 段：过多则合并尾部
      if (parts.length > 3) {
        return [parts[0], parts.slice(1, -1).join(""), parts[parts.length - 1]].filter(Boolean);
      }
      return parts;
    }

    function sleep(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function buildFallbackMessage(signal: BrainSignalInput): string {
      // 通用兜底：基于 importance 和信号标题，不依赖活动类型枚举
      const importance = signal.importance ?? "medium";
      const title = signal.title;
      switch (importance) {
        case "critical": return `${title}，需要你现在处理一下。`;
        case "high": return `${title}，提醒你看一下。`;
        case "medium": return `刚刚察觉到：${title}。`;
        default: return `有个小情况：${title}。`;
      }
    }

    /**
     * C2: 构建主动话术 prompt，注入最近主动话术记忆。
     * 让 LLM 能引用上下文，产生"刚才那个我又看了一下"的连续感。
     */
    async function buildProactivePrompt(
      signal: BrainSignalInput,
      decision: BrainDecision,
    ): Promise<string> {
      const summary = signal.summary ? `\n信号摘要: ${signal.summary}` : "";
      const importance = signal.importance ?? "medium";
      const occurredAt = String(signal.metadata?.occurredAt ?? new Date().toISOString());

      // C2: 召回最近主动话术记忆，注入 prompt 供 LLM 引用上下文。
      // Task 5: 优先复用 decide 阶段（recallRecentMemories）已召回的 decision.recallItems，
      // 避免对同一 LifeSignal 重复执行 MemoryCortex.recall；仅在 decide 未携带
      // recallItems（如 fallback:no_e2e_maker 路径 / 召回失败）时降级到独立 episodic 召回。
      const decisionRecall = decision.recallItems;
      let recallItems: MemoryRecallItem[];
      if (decisionRecall !== undefined) {
        recallItems = decisionRecall;
      } else if (brainCenter) {
        try {
          const recallResult = await brainCenter.recall(signal.actorId, signal.title, {
            domain: "episodic",
            limit: 3,
          });
          recallItems = recallResult.items;
        } catch (err) {
          console.log(`[BrainCenter] 主动话术记忆召回失败（忽略）: ${err}`);
          recallItems = [];
        }
      } else {
        recallItems = [];
      }

      let memoryContext = "";
      if (recallItems.length > 0) {
        const recentMsgs = recallItems
          .map((item) => `- ${item.content}`)
          .join("\n");
        memoryContext = `\n你最近主动说过的话:\n${recentMsgs}\n如果与当前信号相关，可以自然引用（如"刚才那个我又看了一下"），但别生硬。`;
      }

      return `信号类型：${signal.kind}
信号标题：${signal.title}
重要程度：${importance}
检测时间：${occurredAt}
决策评分：value=${decision.valueScore}, disturb=${decision.disturbScore}${summary}${memoryContext}

请基于信号内容，主动帮用户做事（调用工具）并生成主动话术。`;
    }

    async function executeProactiveDecision(
      decision: BrainDecision,
      signal: BrainSignalInput,
    ): Promise<void> {
      const traceId = `proactive-${signal.actorId}-${Date.now()}`;
      // Task 5: 加载 Agent 自身风格指纹，注入 system prompt 供话术生成遵循
      const styleProfile = loadAgentStyleProfile(agentMemorySyncService);
      const proactiveSystemPrompt = `${PROACTIVE_SYSTEM_PROMPT}\n\n${formatAgentStylePrompt(styleProfile)}`;
      let mainReplyStarted = false;

      // A3: 主动路径接入 LivingInterimController（proactive_text channel）
      // 让主动做事期间也能发自然垫词（开口词/进度/完成），而不是冷不丁冒出完整结论
      const interimController = new LivingInterimController({
        sessionId: signal.actorId,
        traceId,
        mode: "direct_llm",
        enabled: true,
        channel: "proactive_text",
        provider: createExternalChatProviderFromEnv(),
        send: (text, seq) => {
          if (mainReplyStarted) return;
          wsConnectionRegistry.trySend(
            signal.actorId,
            JSON.stringify({
              type: ServerEventType.ChatAssistantInterim,
              payload: {
                sessionId: signal.actorId,
                messageId: interimAckMessageId(traceId, seq),
                traceId,
                mode: "direct_llm",
                text,
              },
            }),
          );
        },
        isStale: () => false,
        isMainReplyStarted: () => mainReplyStarted,
      });

      // 先发一条开口垫词（异步，不阻塞主流程）
      void interimController.maybeEmitInitial(signal.title);

      // 1. 调 LLM 生成话术（启用 function calling，LLM 可自主调工具做事）
      let message = "";
      if (externalChat) {
        try {
          // 构建工具执行上下文：LLM 调工具 → toolRegistry.execute → 真实执行
          const toolContext: ToolContext = {
            sessionId: signal.actorId,
            userId: signal.actorId,
            agentAccessMode: "full",
          };
          const toolExecCtx: ChatToolExecutionContext = {
            executeTool: (name, args) => toolRegistry.execute(name, args, toolContext),
            onToolExecuteStart: (info) => {
              void interimController.onToolStart(info.toolName, info.input);
            },
            onToolExecuted: (info) => {
              void interimController.onToolEnd(info.toolName, info.input, info.ok);
            },
          };
          await externalChat.streamCompletion(
            `proactive:${signal.actorId}:${Date.now()}`,
            { text: await buildProactivePrompt(signal, decision) },
            (delta) => {
              message += delta;
              mainReplyStarted = true;
            },
            toolExecCtx,
            {
              // C2: 关闭 ephemeralTurn，让主动话术写入 provider thread
              // 下次 buildProactivePrompt 的 recall 能召回"我之前主动说过什么"
              ephemeralTurn: false,
              disableThinking: true,
              maxThreadMessages: 4,
              systemPromptOverride: proactiveSystemPrompt,
              toolExposureProfile: "contextual",
              toolLoop: { maxRounds: 2 },
            },
          );
          // Task 5: LLM 话术生成后做风格一致性校验（非阻塞，仅记录警告日志，不修改输出内容）
          if (message.trim()) {
            const consistency = validateStyleConsistency(message, styleProfile);
            if (!consistency.passed) {
              console.log(
                `[BrainCenter] 话术风格偏离警告: ${consistency.reason}（偏离度=${consistency.deviation}）话术="${message.slice(0, 50)}..."`,
              );
            }
          }
        } catch (err) {
          console.log(`[BrainCenter] LLM 话术生成失败，使用模板兜底: ${err}`);
          message = buildFallbackMessage(signal);
        }
      } else {
        message = buildFallbackMessage(signal);
      }

      // 2. LLM 输出异常（SILENT/空）时用模板兜底发送——
      //    ProactionCortex 已决策 speak，LLM 只负责话术，不应有否决权，
      //    否则 LLM 的保守倾向会把规则判定该发的信号压成静默。
      if (message.trim().toUpperCase() === "SILENT" || !message.trim()) {
        console.log(`[BrainCenter] LLM 输出异常，使用模板兜底`);
        message = buildFallbackMessage(signal);
      }

      // 2.5 Stage 4 Task 2：输出安全过滤——检测话术中的敏感信息并替换为 [REDACTED]。
      //     brainCenter 未注册时原文本透传（checkOutputSafety 内部已降级）。
      //     命中时用 sanitized 覆盖 message，避免把 API key/私钥/内部路径推给用户。
      if (brainCenter && message.trim()) {
        const outputSafety = brainCenter.checkOutputSafety(message, {
          actorId: signal.actorId,
          stage: "executeProactiveDecision",
        });
        if (!outputSafety.safe) {
          console.log(
            `[BrainCenter] 主动话术输出已脱敏 actorId=${signal.actorId} reason=${outputSafety.reason}`,
          );
          message = outputSafety.sanitized;
        }
      }

      // 3. 通过 SynapseBus.sendToUser 投递（WS + MessageHub 离线降级）
      //    注意：synapseBus 可能在 brainNeuroEnabled=0 时未创建
      //    C1: 分段发送——按标点切成 2-3 段，间隔 400-900ms 分批 WS 推送，
      //    模拟真人"打一段发一段"的节奏，而不是一次性冒出完整结论
      const targetBus = synapseBus;
      if (targetBus) {
        const segments = splitIntoSegments(message.trim());
        if (segments.length <= 1) {
          await targetBus.sendToUser(signal.actorId, {
            type: "agent.proactive_message",
            payload: {
              title: "Agent 主动联系",
              text: message.trim(),
              channel: decision.channel ?? "websocket",
              reason: decision.rationale,
            },
          });
        } else {
          // 分段发送：逐段推送，间隔 400-900ms
          for (let i = 0; i < segments.length; i++) {
            const isLast = i === segments.length - 1;
            await targetBus.sendToUser(signal.actorId, {
              type: "agent.proactive_message",
              payload: {
                title: "Agent 主动联系",
                text: segments[i],
                channel: decision.channel ?? "websocket",
                reason: isLast ? decision.rationale : undefined,
                isPartial: !isLast,
              },
            });
            if (!isLast) {
              await sleep(400 + Math.floor(Math.random() * 500));
            }
          }
        }
        console.log(`[BrainCenter] 主动消息已发送给 ${signal.actorId}（${segments.length} 段）: ${message.slice(0, 50)}...`);
      } else {
        // synapseBus 不存在时降级到 proactiveOutbound
        await proactiveOutbound.send({
          actorId: signal.actorId,
          title: "Agent 主动联系",
          text: message.trim(),
          reason: `brain:${decision.rationale}`,
          channel: (decision.channel ?? "websocket") as ProactiveOutboundChannel,
        });
        console.log(`[BrainCenter] 主动消息已通过 outbound 发送给 ${signal.actorId}`);
      }

      // 4. 出行建议已合并到 function calling 阶段：
      //    LLM 可自主调 weather.get_local 等工具查信息并融入话术，
      //    不再需要单独的"出行建议"消息块，避免双消息打断用户。

      // 5. C2: 主动话术写入记忆——下次 buildProactivePrompt 的 recall 能召回
      //    让 LLM 能说"刚才那个我又看了一下"，产生连续感而非每次孤立开口
      if (brainCenter && message.trim()) {
        try {
          await brainCenter.remember(signal.actorId, {
            actorId: signal.actorId,
            kind: "event",
            domain: "episodic",
            content: `[主动话术] ${message.trim()}`,
            importance: signal.importance as "critical" | "high" | "medium" | "low" | undefined,
            source: "system",
            timestamp: new Date().toISOString(),
            metadata: {
              signalKind: signal.kind,
              signalTitle: signal.title,
              decisionRationale: decision.rationale,
            },
          });
        } catch (err) {
          console.log(`[BrainCenter] 主动话术记忆写入失败（忽略）: ${err}`);
        }
      }
    }
  }

  // ========== Webhook 事件驱动 ==========
  // 1) 先建 hookBus（全局唯一事件总线）
  // 2) WebhookService 启动时自动订阅 hookBus，业务代码只需 emit hook
  // 3) 其它服务也通过 hookBus 发事件，无需再 bind WebhookService
  const hookBus = new HookBus();
  setHookBus(hookBus); // 替换单例，便于无 DI 上下文的代码也能 emit

  const webhookService = new WebhookService(hookBus);
  webhookService.start();

  // 把 hookBus 注入到业务服务。
  // 业务服务 emit 的事件会被 hookBus 路由到所有订阅者，
  // 其中 WebhookService 已经自动订阅，会推送到外部端点。
  marketSignalService.bindHookBus(hookBus);
  lifeSignalHubService.bindHookBus(hookBus);

  app.log.info(`[AgentRuntime] ${formatAgentRuntimeConfigSummary(getAgentRuntimeConfig())}`);

  const visionPeriodicScheduler = new VisionPeriodicScheduler({
    agentCore,
    wsRegistry: wsConnectionRegistry,
  });

  const desktopVisual = createDesktopVisualFromEnv();
  const desktopBridgeCoordinator = new DesktopBridgeCoordinator({
    onSync: (actorId, payload) => {
      wsConnectionRegistry.trySend(
        actorId,
        JSON.stringify({ type: ServerEventType.DesktopBridgeSync, payload }),
      );
      desktopPresenceSignalService.handleSync(actorId, payload);
    },
    onTaskResult: (actorId, payload) => {
      desktopPresenceSignalService.handleTaskResult(actorId, payload);
    },
  });
  // vision 工具族需要 desktopBridgeCoordinator 才能走 desktop:bridge 截图路径，
  // 必须在 desktopBridgeCoordinator 实例化后注册。
  registerVisionTools(toolRegistry, visionPeriodicScheduler, deviceRegistry, desktopBridgeCoordinator);
  registerDesktopVisualTools(toolRegistry, {
    localVisual: desktopVisual,
    bridge: desktopBridgeCoordinator,
    audit: auditService,
  });
  agentCore.setDesktopBridgeCoordinator(desktopBridgeCoordinator);

  // ─── Task 4: desktop.event → LifeSignal 转换 ───
  // 将 Python 端推送的桌面事件转为 LifeSignal 并 publish 到 LifeSignalHub，
  // 供 BrainStem（sweepOnce → recentSignals）与 ProactionCortex 消费。
  // 未知事件类型忽略；focus_change 频繁故 importance=low，window_open/close=medium。
  desktopBridgeCoordinator.subscribeEvents((actorId, event) => {
    const kindByEventType: Record<string, string> = {
      focus_change: "desktop_focus_change",
      window_open: "desktop_window_open",
      window_close: "desktop_window_close",
    };
    const kind = kindByEventType[event.eventType];
    if (!kind) return;

    const title = String(event.payload.title ?? "");
    const process = String(event.payload.process ?? "");
    const duration = event.payload.duration;
    const ts = event.timestamp;
    const occurredAt =
      typeof ts === "number"
        ? new Date(ts).toISOString()
        : Number.isNaN(Date.parse(ts))
          ? new Date().toISOString()
          : new Date(ts).toISOString();

    const importance: "low" | "medium" | "high" | "critical" =
      event.eventType === "focus_change" ? "low" : "medium";

    lifeSignalHubService.publish({
      id: `${actorId}:desktop-event:${kind}:${occurredAt}`,
      actorId,
      source: "desktop",
      kind,
      title: title || `desktop ${event.eventType.replace(/_/g, " ")}`,
      summary: [title, process].filter(Boolean).join(" - ") || `desktop ${event.eventType}`,
      tags: ["desktop", "desktop_event", event.eventType],
      importance,
      evidence: [
        `desktop event: ${event.eventType}`,
        title ? `title=${title}` : "",
        process ? `process=${process}` : "",
      ].filter(Boolean),
      metrics: typeof duration === "number" ? { duration } : undefined,
      occurredAt,
      metadata: {
        title,
        process,
        event_type: event.eventType,
        timestamp: event.timestamp,
      },
    });
  });

  // ─── Brain Center 神经解剖分区装配 ───
  // BRAIN_NEURO_ENABLED 未设置或非 "0"/"false"/"off" → 默认启用 5 个新分区
  // 关闭时：5 个新分区不实例化，BrainCenter 回退到 4 皮层模式
  if (brainEnabled && brainNeuroEnabled && brainCenter) {
    // SynapseBus（突触总线 / 胼胝体）—— 先创建，供各皮层注册并建立订阅关系
    synapseBus = new SynapseBus();
    synapseBus.registerHookBus(hookBus);
    synapseBus.registerMessageHub(messageHubService);
    synapseBus.registerAipService(aipService);
    synapseBus.registerWsRegistry(wsConnectionRegistry);

    // SensoryCortex（感官皮层：耳/眼/嘴）
    const sensoryCortex = new SensoryCortex();
    sensoryCortex.registerVoiceDialogue(voiceDialogueService);
    sensoryCortex.registerVoiceCapability(voiceCapabilityService);
    sensoryCortex.registerDesktopVisual(desktopVisual);
    sensoryCortex.registerSynapseBus(synapseBus);
    brainCenter.registerSensory(sensoryCortex);

    // MemoryCortex（记忆皮层 / 海马体）
    memoryCortex = new MemoryCortex();
    memoryCortex.registerShortTerm(shortTermMemoryGateway);
    if (agenticMemoryRuntime) {
      memoryCortex.registerAgentic(agenticMemoryRuntime);
    }
    memoryCortex.registerHumanLike(humanLikeMemory);
    if (narrativeMemory) {
      memoryCortex.registerNarrative(narrativeMemory);
    }
    memoryCortex.registerKvSummary(agentMemorySyncService);
    const memoryManagerService = getMemoryManagerService();
    if (memoryManagerService) {
      memoryCortex.registerMemoryManager(memoryManagerService);
    }
    if (nightlyMemoryService) {
      memoryCortex.registerNightlyScheduler(nightlyMemoryService);
    }
    memoryCortex.registerSynapseBus(synapseBus);
    brainCenter.registerMemory(memoryCortex);

    // 突触总线注册到 BrainCenter（各皮层已通过 registerSynapseBus 建立订阅）
    brainCenter.registerSynapse(synapseBus);

    // LimbicCortex（边缘皮层 / 杏仁核 + 情感）
    const limbicCortex = new LimbicCortex();
    limbicCortex.registerTaskSafety(getAgentTaskSafety());
    limbicCortex.registerMoodInference(moodInferenceService);

    // 包装 assistant-tone-policy 函数为 TonePolicyLike 对象
    // services/assistant-tone-policy.ts 导出的是函数而非类，此处适配 decide 入口。
    const tonePolicyAdapter = {
      decide: (text: string, _emotion: unknown) =>
        detectAssistantToneMode(text),
    };
    limbicCortex.registerTonePolicy(tonePolicyAdapter);

    // 包装 emotion-tone 函数为 EmotionToneLike 对象
    // services/user-personalization/emotion-tone.ts 同样是函数模块，此处适配。
    const emotionToneAdapter = {
      detectEmotionFromText,
      detectPreferredToneFromText,
      buildToneGuidance: (state: unknown) =>
        buildToneGuidance(state as EmotionState),
    };
    limbicCortex.registerEmotionTone(emotionToneAdapter);

    limbicCortex.registerSynapseBus(synapseBus);
    brainCenter.registerLimbic(limbicCortex);

    // PlannerCortex（额叶规划皮层）
    const plannerCortex = new PlannerCortex();
    plannerCortex.registerTaskRouter({ routeLlmExecution });

    // PlanExecuteLoop 适配器：将 runPlanExecuteLoop 函数包装为 { plan, execute, react } 对象。
    // - plan(goal): 调用 runPlanExecuteLoop 生成计划（函数内部已含执行），缓存结果。
    // - execute(plan): 返回缓存的执行结果（plan=null 触发 applyExecutionResult 将所有
    //   pending step 标记为 completed，避免 mergeStepStatuses 把 step 回退为 pending）。
    // - react(observation): 原样返回（PlannerCortex 为同步调用）。
    // 限制：规划皮层无 per-request 的 toolCtx/baseStreamOpts，工具执行由 AgentCore 主路径
    //       处理；此适配器让 PlannerCortex.plan() 能产出 LLM 生成的结构化计划，替代关键词兜底。
    let lastPeResult: PlanExecuteLoopResult | null = null;
    const planExecuteAdapter = {
      plan: async (goal: string, opts?: unknown) => {
        if (!externalChat) {
          return { finalText: "", plan: null };
        }
        const actorId = (opts as { actorId?: string } | undefined)?.actorId ?? "planner-cortex";
        lastPeResult = await runPlanExecuteLoop({
          provider: externalChat,
          planSessionId: `planner-cortex:${actorId}:${Date.now()}`,
          userText: goal,
          toolCtx: undefined,
          baseStreamOpts: undefined,
        });
        return lastPeResult;
      },
      execute: async (_plan: unknown, _opts?: unknown) => {
        return { finalText: lastPeResult?.finalText ?? "", plan: null };
      },
      react: (observation: unknown) => observation,
    };
    plannerCortex.registerPlanExecuteLoop(planExecuteAdapter);

    // 注册 ToolExecutor：让 PlannerCortex.execute 在 PlanExecuteLoop 返回空时
    // fallback 到真实执行 expectedTools，实现 plan→execute→react 闭环。
    plannerCortex.registerToolExecutor({
      execute: async (name, args, opts) => {
        const actorId = opts?.actorId ?? "planner-cortex";
        return toolRegistry.execute(name, args, {
          sessionId: actorId,
          userId: actorId,
          agentAccessMode: "full",
        });
      },
    });

    // 注册 MasterAgentCoordinator：让 PlannerCortex.delegate 真实委派子 Agent。
    // MasterAgentCoordinator 在 AgentCore 内部创建，这里通过 getter 取出引用，
    // 包装为 { invokeSubAgent } 注入。未启用委派时 masterCoordinator 仍为 null，
    // delegate 恒返回失败（保持原降级行为）。
    const masterCoord = agentCore.getMasterAgentCoordinator();
    if (masterCoord) {
      plannerCortex.registerMasterCoordinator({
        invokeSubAgent: async (subAgentType, task, opts) => {
          const actorId = (opts as { actorId?: string } | undefined)?.actorId ?? "brain-delegate";
          const goal = (task as { goal?: string } | undefined)?.goal ?? "";
          return masterCoord.handleInvokeSubAgentTool(
            {
              agentType: subAgentType,
              taskDescription: goal,
              priorContext: String((task as { input?: unknown } | undefined)?.input ?? ""),
            },
            {
              sessionId: actorId,
              userId: actorId,
              agentAccessMode: "full",
            },
          );
        },
      });
      console.log("[PlannerCortex] 已注册 MasterAgentCoordinator（子 Agent 委派能力）");
    } else {
      console.log("[PlannerCortex] MasterAgentCoordinator 未启用，delegate 将降级");
    }

    brainCenter.registerPlanner(plannerCortex);

    // ─── subcortical 分区（脑干/小脑）───
    // 脑干：自主节律——45s 心跳扫描，察觉 sustained_busy / late_night / 趋势翻转，
    //       产出合成 LifeSignal 回流 hub，让 Agent 具备"自己察觉"的持续感知。
    // 小脑：时序协调——皮层决定说，小脑决定何时说。busy/sleeping defer、
    //       用户开口打断时清空 defer 队列 + 设 60s 抑制窗口，避免抢话。
    // 两者均注入 awarenessCortex.observe() 用于读用户活动状态。
    // 生命周期由 BrainCenter.start()/stop() 统一托管（startCortex/stopCortex）。
    if (awarenessCortex) {
      const brainStem = new BrainStem();
      brainStem.registerLifeSignalHub(lifeSignalHubService);
      brainStem.registerAwareness(awarenessCortex);
      // Stage 3 Task 1：注入 SensoryCortex，使脑干心跳扫描时能调 look()
      // 周期性获取屏幕描述（busy 时每 5 分钟一次），发布 desktop_app_focus 信号。
      brainStem.registerSensory(sensoryCortex);
      brainStem.registerUserPersonalization(userPersonalizationService);
      brainCenter.registerBrainStem(brainStem);

      const cerebellum = new Cerebellum();
      cerebellum.registerAwareness(awarenessCortex);
      brainCenter.registerCerebellum(cerebellum);
    }
  }

  // ─── 端到端认知装配（整体端到端调度的核心）───
  // proactionCortex 在 brainEnabled 块创建，memoryCortex 在 brainNeuroEnabled 块创建。
  // 两者就绪后注入端到端决策器：一次 LLM 完成"理解+决策+响应"，不再切片式串联各脑区。
  if (proactionCortex && memoryCortex && brainCenter) {
    // ProactionCortex 主动认知端到端：注入记忆 + 端到端决策器
    proactionCortex.registerMemory(memoryCortex as unknown as MemoryCortexLike);
    const endToEndMaker: EndToEndDecisionMaker = {
      async decide(signal, ctx) {
        const memBrief = ctx.recentMemories.map((m) => `- ${m.content}`).join("\n").slice(0, 800) || "（无）";
        const activity = ctx.userActivity ? `用户当前：${ctx.userActivity.activity}` : "用户状态未知";
        const prompt =
          `你是主动开口决策器。像真人一样一气呵成判断"要不要说+说什么"。\n\n` +
          `信号：${signal.kind} - ${signal.title}${signal.summary ? `\n摘要：${signal.summary}` : ""}\n` +
          `重要性：${signal.importance ?? "medium"}\n` +
          `价值评分：${ctx.valueScore.toFixed(1)} / 打扰评分：${ctx.disturbScore.toFixed(1)}\n` +
          `用户活动状态：${activity}\n` +
          `最近对话记忆：\n${memBrief}\n` +
          `最近已开口次数：${ctx.recentDecisions.length}\n\n` +
          `判断是否要主动开口告诉用户这个信号，如果要，给出自然的话术。\n` +
          `只输出 JSON：{"speak": true/false, "message": "话术或空", "reason": "简短理由"}`;
        let raw = "";
        try {
          const provider = createExternalChatProviderFromEnv();
          if (!provider) throw new Error("no_chat_provider");
          await provider.streamCompletion(
            `e2e-proaction:${signal.actorId}:${Date.now()}`,
            { text: prompt },
            (delta) => { raw += delta; },
            undefined,
            { ephemeralTurn: true, disableThinking: true, maxThreadMessages: 0 },
          );
        } catch (e) {
          return { speak: false, message: "", reason: `llm_failed:${String(e).slice(0, 60)}` };
        }
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) return { speak: false, message: "", reason: "no_json" };
        try {
          const parsed = JSON.parse(match[0]);
          return {
            speak: parsed.speak === true,
            message: typeof parsed.message === "string" ? parsed.message : "",
            reason: typeof parsed.reason === "string" ? parsed.reason : "",
          };
        } catch {
          return { speak: false, message: "", reason: "parse_failed" };
        }
      },
    };
    proactionCortex.registerEndToEndMaker(endToEndMaker);

    // 注册 ActionExecutor：让 ProactionCortex 决策后能直接执行环境控制类动作
    // （如关窗/调空调/创建日程），而非只发消息。注入 ToolRegistry 的包装。
    proactionCortex.registerActionExecutor({
      execute: async (name, args, opts) => {
        const actorId = opts?.actorId ?? "proaction-cortex";
        return toolRegistry.execute(name, args, {
          sessionId: actorId,
          userId: actorId,
          agentAccessMode: "full",
        });
      },
    });

    // BrainCenter 被动认知端到端：注入认知引擎（一次 LLM 完成路由+响应+记忆判断）
    const cognitiveEngine: CognitiveEngine = {
      async cognize(input, ctx) {
        const memBrief = ctx.memories.map((m) => `- ${m.content}`).join("\n").slice(0, 800) || "（无）";
        const emotion = ctx.emotion ? `用户情绪：${ctx.emotion.label}(valence=${ctx.emotion.valence})` : "情绪未知";
        const activity = ctx.userActivity ? `用户活动：${ctx.userActivity.activity}` : "活动未知";
        const caps = ctx.capabilities.map((c) => c.domain).join(", ").slice(0, 200) || "（无）";
        const userText = input.text ?? ctx.audioText ?? "";
        const prompt =
          `你是认知决策器。像真人一样一气呵成完成"理解+路由+响应+置信度评判"。\n\n` +
          `用户消息：${userText}${ctx.visualDescription ? `\n视觉：${ctx.visualDescription}` : ""}\n` +
          `${emotion}\n${activity}\n` +
          `最近记忆：\n${memBrief}\n` +
          `可用能力：${caps}\n` +
          `最近主动开口：${ctx.recentDecisions.length} 次\n\n` +
          `判断路由模式（严格按以下规则）：\n` +
          `  fast_chat=寒暄/简单问答（你好/谢谢/再见/你是谁）\n` +
          `  direct_llm=直接 LLM 回答（纯知识问答/闲聊/不依赖外部信息）\n` +
          `  master_only=主 Agent 自处理（需要调用工具但不需委派，如查天气/查日历/简单工具调用）\n` +
          `  master_delegate=委派子 Agent（需要深度调研/比价/多步搜索/写文案/技术操作/桌面自动化）\n` +
          `  plan_execute=先规划后执行（复杂多步推理任务，需拆解为子步骤）\n` +
          `  state_machine=桌面自动化多步骤（操作电脑/打开网站/批量处理/RPA）\n\n` +
          `路由判断关键词（出现以下意图时优先委派）：\n` +
          `  - 搜索/查/调研/比价/对比/评测/推荐 → master_delegate（info 子 Agent 深度调研）\n` +
          `  - 写代码/调试/部署/自动化脚本/运维 → master_delegate（tech 子 Agent）\n` +
          `  - 截屏/操作电脑/自动化/批量处理 → master_delegate（tech 子 Agent）\n` +
          `  - 转账/消费/充值/订票下单 → master_delegate（life 子 Agent）\n` +
          `  - 简单查天气/查日历/查时间 → master_only（主 Agent 直接调工具）\n\n` +
          `初步响应：若 mode=fast_chat/direct_llm，给出简短回复；否则留空（由执行层产出）。\n` +
          `needsToolLoop：mode=fast_chat 时 false；direct_llm 时 false；其余 true。\n\n` +
          `置信度评判（基于对话内容语义，而非关键词匹配）：\n` +
          `  结合「用户消息意图是否清晰」「现有信息是否足以回答」「是否需要外部数据/工具且能力是否具备」综合判断：\n` +
          `  - 0.9-1.0：寒暄/简单问答/明确的知识问答（信息充足，LLM 直接答）\n` +
          `  - 0.7-0.9：需要一点推理但 LLM 知识足够的知识问答\n` +
          `  - 0.5-0.7：需要工具但请求信息完整、能力匹配（如查天气且用户给了城市）\n` +
          `  - 0.3-0.5：需要工具但信息略有缺失（如查天气但没给城市，需反问澄清）\n` +
          `  - 0.0-0.3：信息严重不足/需要外部数据但无对应能力/复杂任务超出主 Agent 能力（该委派子 Agent）\n` +
          `  注意：recall=0（无记忆）对寒暄/知识问答不是低置信信号；只有需要记忆支撑的任务（如"上次说的那个"）recall=0 才降置信。\n\n` +
          `只输出 JSON：{"mode": "direct_llm", "response": "...", "needsToolLoop": false, "rationale": "...", "confidence": 0.85, "confidenceReason": "..."}`;
        let raw = "";
        const now = new Date().toISOString();
        try {
          const provider = createExternalChatProviderFromEnv();
          if (!provider) throw new Error("no_chat_provider");
          await provider.streamCompletion(
            `cognize:${input.actorId}:${Date.now()}`,
            { text: prompt },
            (delta) => { raw += delta; },
            undefined,
            { ephemeralTurn: true, disableThinking: true, maxThreadMessages: 0 },
          );
        } catch (e) {
          const route = { userMessage: userText, system: "system1" as const, mode: "fast_chat" as const, rationale: `cognize_llm_failed:${String(e).slice(0, 60)}`, decidedAt: now };
          return { route, response: "", memoryWrites: [], needsToolLoop: false, rationale: route.rationale };
        }
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) {
          const route = { userMessage: userText, system: "system1" as const, mode: "fast_chat" as const, rationale: "no_json", decidedAt: now };
          return { route, response: "", memoryWrites: [], needsToolLoop: false, rationale: "no_json" };
        }
        try {
          const parsed = JSON.parse(match[0]);
          const validModes = ["fast_chat", "direct_llm", "master_only", "master_delegate", "plan_execute", "state_machine"];
          const mode = validModes.includes(parsed.mode) ? parsed.mode : "direct_llm";
          const system = (mode === "fast_chat" || mode === "direct_llm") ? "system1" : "system2";
          const route = {
            userMessage: userText,
            system: system as "system1" | "system2",
            mode: mode as "fast_chat" | "direct_llm" | "master_only" | "master_delegate" | "plan_execute" | "state_machine",
            rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
            decidedAt: now,
          };
          // 置信度：由 LLM 基于对话内容语义评判，clamp 到 0-1；缺省 undefined（由规则兜底）
          let confidence: number | undefined;
          let confidenceReason: string | undefined;
          if (typeof parsed.confidence === "number" && !Number.isNaN(parsed.confidence)) {
            confidence = Math.max(0, Math.min(1, parsed.confidence));
            confidenceReason = typeof parsed.confidenceReason === "string" ? parsed.confidenceReason : "";
          }
          return {
            route,
            response: typeof parsed.response === "string" ? parsed.response : "",
            memoryWrites: [],
            needsToolLoop: parsed.needsToolLoop === true,
            rationale: route.rationale,
            confidence,
            confidenceReason,
          };
        } catch {
          const route = { userMessage: userText, system: "system1" as const, mode: "fast_chat" as const, rationale: "parse_failed", decidedAt: now };
          return { route, response: "", memoryWrites: [], needsToolLoop: false, rationale: "parse_failed" };
        }
      },
    };
    brainCenter.registerCognitiveEngine(cognitiveEngine);
  }

  // ─── Brain Center 启动 + 工具注册（移至此处确保 9 分区均注册后再启动）───
  if (brainEnabled && brainCenter) {
    await brainCenter.start();
    // 注册 brain.* 工具到 ToolRegistry，并把 schema 暴露给 LLM。
    // brainCenter 为 null 时（brain 未启用），registerBrainTools 不会注册任何 handler，
    // setBrainChatTools 也不会被调用，BRAIN_TOOLS schema 不进入 LLM 可见列表。
    registerBrainTools(toolRegistry, brainCenter);
    setBrainChatTools(BRAIN_TOOLS);
  }

  // 把 brainCenter 注入 agentCore：可用时 handleUserMessage 走 cognize() 端到端认知入口，
  // BRAIN_CENTER_ENABLED=0 时 brainCenter 为 null，agentCore 降级到原切片路径。
  agentCore.setBrainCenter(brainCenter);

  // 注入人格内核拉取器：PromptContextBuilder.assembleMemory 每轮拉取 PersonalityCore
  // （BrainCenter.getPersonalityCore → MemoryCortex.getPersonalityCore，KV 持久化 + 默认人格兜底），
  // 格式化后填入 memory.personalityCore，由 buildLayeredSystemPrompt 注入 system prompt 稳定前缀
  // 的【人格内核】块，防止单次对话导致人格漂移。brainCenter 为 null（brain 未启用）时返回 null，
  // personalityCore 字段不注入，降级到无人格内核模式。
  promptContextBuilder.setPersonalityProvider((actorId) => brainCenter?.getPersonalityCore(actorId) ?? null);

  const wechatClawBindingService = new WechatClawBindingService();
  void wechatClawBindingService.load();
  const wechatClawBridgeService = new WechatClawBridgeService(agentCore, {
    weatherPrefsService,
    ttsService,
    messageHubService,
  });
  messageBridgeService = new MessageBridgeService(agentCore, messageHubService);

  registerMessageHubTools(toolRegistry, { hub: messageHubService, gateway: messagePlatformGateway, agentCore });

  registerEmbodimentTools(toolRegistry, {
    wsRegistry: wsConnectionRegistry,
    localVisual: desktopVisual,
    bridge: desktopBridgeCoordinator,
  });

  // ========== 注册自我编程和智能生成工具 ==========
  registerSelfProgrammingTools(toolRegistry, skillManager);
  registerAISkillGenerationTools(toolRegistry, externalChat, skillManager, skillGenerator);
  registerSelfLearningTools(toolRegistry, externalChat, skillManager, agentSelfLearningService);
  registerNotesTools(
    toolRegistry,
    notesService,
    scheduleTaskService,
    externalChat,
    narrativeMemory,
  );

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
    voiceMessageService,
    imageGenerationService,
    fileProcessingService,
    desktopBridgeCoordinator,
    phoneBridgeCoordinator,
    wechatClawBindingService,
    wechatClawBridgeService,
    messageHubService,
    messagePlatformGateway,
    messageBridgeService,
    browserSessionService,
    friendService,
    companionService,
    agentCore,
    wsConnectionRegistry,
    lifeSignalHubService,
    marketSignalService,
    proactiveLifeRuntimeService,
    userPersonalizationService,
    webhookService,
    notesService,
    externalChat,
    moodInferenceService,
    devicePairingService,
    deviceRegistry,
    // /agent/voice/transcribe 端点依赖（ASR 专用走 voiceCapabilityService）
    voiceCapabilityService,
    brainCenter,
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
    socialFeedService,
    computeQuotaService,
    agentMemorySyncService,
    unifiedIdempotencyService,
    desktopBridgeCoordinator,
    phoneBridgeCoordinator,
    virtualPhoneService,
    devicePairingService,
    virtualPhoneIncomingCoordinator,
    userPersonalizationService,
    deviceRegistry,
    voiceCapabilityService,
    voiceMessageService,
    morningBriefingScheduler,
  });

  app.addHook("onClose", async () => {
    try {
      await moodInferenceService.flush();
      app.log.info("[MoodInference] 持久化已 flush");
    } catch (e) {
      app.log.warn(`[MoodInference] shutdown flush failed: ${e}`);
    }
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
    voiceCapabilityService,
    voiceMessageService,
    imageGenerationService,
    fileProcessingService,
    emailSmsService,
    mediaMusicService,
    healthFitnessService,
    financeDeepService,
    socialOutreachService,
    codeSandboxService,
    virtualPhoneService,
    friendService,
    messageHubService,
    messagePlatformGateway,
    messageBridgeService,
    voiceDialogueService,
    intelligentReminderService: intelligentReminder.reminderService,
    reminderResponsePersistence: intelligentReminder.userResponsePersistence,
    mcpClientService,
    lifeSignalHubService,
    marketSignalService,
    proactiveLifeRuntimeService,
    hookBus,
    webhookService,
    notesService,
    externalChat,
    moodInferenceService,
    morningBriefingScheduler,
    deviceRegistry,
    devicePairingService,
    brainCenter,
  };
}
