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
import { getChatThreadStore } from "../external-model/chat-thread-store.js";
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
import { getRuntimeKernel } from "../agent/runtime-kernel.js";
import {
  formatAgentRuntimeConfigSummary,
  getAgentRuntimeConfig,
} from "../agent/agent-runtime-config.js";
import { resolvePrimaryChatSessionId } from "../agent/master-chat-session.js";
import { HermesEvolutionLoopService } from "../services/hermes-evolution-loop-service.js";
import { UserPersonalizationService } from "../services/user-personalization/user-personalization-service.js";
import { createNarrativeMemoryPort, wrapNarrativeWithHybrid } from "../services/narrative-memory-port.js";
import { createNarrativeHybridRetrievalDefault } from "../services/narrative-hybrid-retrieval-service.js";
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
import { KnowledgeGapExecutor } from "../services/knowledge-gap-executor.js";
import { KnowledgeVerificationService } from "../services/knowledge-verification-service.js";
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
  buildCapabilityModules,
  getAllCapabilityModuleIntentRules,
  registerAllCapabilityModules,
  type CapabilityModuleDeps,
} from "../tools/capability-modules/index.js";
import { setExtraIntentRules } from "../tools/tool-search/intent-metadata.js";
import { setCapabilityModuleDeps, getBuiltinAgentChatTools, setDynamicFastLaneSkillTools, invalidateBuiltinToolsCache } from "../external-model/openai-compatible-tool-loop.js";
import { registerDynamicFastLaneName } from "../tools/tool-search/core-tool-library.js";
import { skillManifestToChatTool } from "../skills/skill-openai-bridge.js";
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
import { setMcpChatTools, setBrainChatTools, setBodyChatTools } from "../external-model/openai-compatible-tool-loop.js";
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
  CodeRepairCortex,
  DefaultTestRunner,
  type CodeRepairLlmLike,
  SensoryCortex,
  MemoryCortex,
  SynapseBus,
  LimbicCortex,
  PlannerCortex,
  BrainStem,
  Cerebellum,
  RuleRouter,
  ActionExecutor,
  DecisionHub,
  WorkingMemoryCortex,
  TaskSwitchingCortex,
  MetaCognitionCortex,
  ContextCortex,
  ToolPlanningCortex,
  OnlineLearningCortex,
  EmotionModulator,
  DefaultModeNetwork,
  type BrainSignalInput,
  type BrainDecision,
  type BrainDecisionAction,
  type MemoryRecallItem,
  type CognitiveEngine,
  type CognitiveInput,
  type CognitiveContext,
  type EndToEndDecisionMaker,
  type MemoryCortexLike,
  type RecentConversationProvider,
  type GapAnalyzer,
  type DelegateJudge,
  createCognitiveEngineFromEnv,
  createDefaultEndToEndDecisionMaker,
  createDefaultDelegateJudge,
  createDefaultTopicExtractor,
  createWorldModelFromEnv,
  getTransitionStore,
  // 记忆认知架构升级（Phase 4）：7 个子模块
  MemoryAssociativeGraph,
  MemoryReconstructionValidator,
  MemoryMetacognitionBridge,
  MemoryForgettingController,
  MemoryProceduralAutomation,
  MemorySchemaFormation,
  MemorySalienceFilter,
  MemoryExperienceLearningLoop,
  // 推理引擎（多线索交叉推理）
  MemoryInferenceEngine,
  // 4 项仿人推理能力扩展：规则自学习 + 类比迁移 + 情感调制 + 无意识触发
  RuleLearner,
  AnalogyMigrator,
  InferenceEmotionModulator,
  BrainStemAutoInferer,
  // LLM 规则归纳器：让 LLM 从历史记忆中归纳因果规则（仅参与"学规则"）
  LLMRuleInducer,
} from "../brain/index.js";
import {
  BodyCenter,
  BodyBus,
  BodyGateway,
  ReflexArc,
  type BodyAction,
  type BodyActionResult,
  type BodySenseQuery,
  type BodySenseResult,
  type BodyModuleSnapshot,
} from "../body/index.js";
import { Hand } from "../body/hand.js";
import { Mouth } from "../body/mouth.js";
import { Eye } from "../body/eye.js";
import { Ear } from "../body/ear.js";
import { Skin } from "../body/skin.js";
import { VestibularApparatus } from "../body/vestibular-apparatus.js";
import { HomeostasisCore } from "../body/homeostasis-core.js";
import { registerBodyTools, BODY_CHAT_TOOLS } from "../tools/body-tools.js";
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
import type { SubAgentType } from "../services/master-agent-types.js";

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
  const narrativeMemory = wrapNarrativeWithHybrid(
    createNarrativeMemoryPort({
      agenticIngest: agenticMemoryRuntime?.ingest ?? null,
      agenticRetrieval: agenticMemoryRuntime?.retrieval ?? null,
      compressor: agenticMemoryRuntime?.compressor ?? null,
      humanLikeMemory,
    }),
    createNarrativeHybridRetrievalDefault(),
  );

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
    : new TrajectoryPromotionPipeline(
        pipelineMode,
        skillPromoValidateDeps,
        skillPromotionQueue,
        // onSkillPromoted 回调：自我进化装载 Skill 成功后触发，
        // 把新能力同步到 CapabilityCortex + 动态 fastLane 名单 + 清缓存。
        // 闭包引用 capabilityCortex（在下方 brainEnabled 块创建），
        // 回调运行时（EvolutionCortex.execute 装载阶段）capabilityCortex 已初始化。
        ({ metadata, skillName }) => {
          // 1. 通知 CapabilityCortex 注册新能力描述符（让 agent.query_capabilities 可见）
          if (capabilityCortex) {
            capabilityCortex.register({
              domain: `evolved_${skillName.replace(/\./g, "_")}`,
              label: metadata.displayName || skillName,
              description: metadata.description,
              tools: [skillName],
              status: "active",
              source: "dynamic",
              registeredAt: new Date().toISOString(),
            });
          }
          // 2. 若 Skill 标记为 fast_lane，注入动态 fastLane（让 Fast 模式可收编）
          const tags = metadata.tags ?? [];
          if (tags.includes("fast_lane") || tags.includes("fast")) {
            registerDynamicFastLaneName(skillName);
            // 收集所有 fastLane 标记的 Skill，转成 ChatCompletionTool 注入 Fast 模式
            const fastLaneSkillTools = skillManager
              .list(true)
              .filter((m) => m.tags?.some((t) => t === "fast_lane" || t === "fast"))
              .map((m) => skillManifestToChatTool({ ...m, enabled: true, trusted: true }));
            setDynamicFastLaneSkillTools(fastLaneSkillTools);
          }
          // 3. 清除 builtin + fastLane 缓存，确保下次请求看到新能力
          invalidateBuiltinToolsCache();
        },
      );

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
  // capabilityCortex / limbicCortex 外层声明：Step 7 DecisionHub 装配块需访问两者
  // （capabilityCortex 在 brainEnabled 块创建，limbicCortex 在 brainNeuroEnabled 块创建，
  //  DecisionHub 装配块在两者之外，故需提升至外层作用域）
  let capabilityCortex: CapabilityCortex | null = null;
  let limbicCortex: LimbicCortex | null = null;
  // evolutionCortex 外层声明：brainEnabled 块创建，brainNeuroEnabled 块内 DMN 装配需访问
  // （DefaultModeNetwork.registerEvolutionCortex 期望 DMNEvolutionCortexLike 接口）
  let evolutionCortex: EvolutionCortex | null = null;
  // 记忆认知架构升级（Phase 4）：knowledge 服务外层声明
  // brainEnabled 块内实例化，brainNeuroEnabled 块内 7 子模块装配需访问。
  // 两者均为 null 时子模块走降级路径（不阻塞主流程）。
  let knowledgeVerificationService: KnowledgeVerificationService | null = null;
  let knowledgeGapExecutor: KnowledgeGapExecutor | null = null;
  if (brainEnabled) {
    brainCenter = new BrainCenter();
    brainCenter.registerRuntimeKernel(getRuntimeKernel());

    // RuntimeKernel minimal 模式下，会话首条 system 由 thread-store 注入一次：
    // - thread-store 在创建/恢复会话时调用 sessionSystemProvider() 取 system 文本写入 msgs[0]
    // - provider 检测到 suppressRuntimeSuffixes + overrideSys 时跳过覆盖 msgs[0]（首轮注入一次）
    // - 靠前缀缓存命中降低每轮字节重发开销（content 不变时命中 cache-read）
    // 注：此处使用 singleton kernel；若需 per-actor 个性化 sessionSys，需在 provider 层透传 actorId（独立大改）
    getChatThreadStore().setSessionSystemProvider(() => getRuntimeKernel().buildSessionSystem() ?? null);
    capabilityCortex = new CapabilityCortex();
    awarenessCortex = new AwarenessCortex();
    proactionCortex = new ProactionCortex();
    evolutionCortex = new EvolutionCortex();

    // CapabilityCortex：注入回 prompt builder（让能力域出现在 prompt 中）
    setCapabilityCortex(capabilityCortex);

    // ─── GapAnalyzer 装配（identifyGap 的 LLM 语义分析）───
    // identifyGap 不是热路径（由 EvolutionCortex 周期触发），可承受 LLM 调用成本。
    // BRAIN_LLM_IDENTIFYGAP_ENABLED=0 时降级到 SCENARIO_KEYWORD_MAP 规则匹配。
    const gapAnalyzer: GapAnalyzer = {
      async analyze(params) {
        const { scenario, existingDomains } = params;
        const failures = params.recentFailures?.slice(0, 5) ?? [];
        const failureBrief = failures.length > 0
          ? `\n最近工具失败记录：\n${failures.map((f) => `- ${f.tool}: ${f.errorMessage ?? "未知错误"}（请求：${f.userRequest ?? ""}）`).join("\n")}`
          : "";
        const prompt =
          `你是能力缺口分析器。分析用户场景，识别 Agent 当前能力是否足以应对，找出缺失的能力域。\n\n` +
          `用户场景：${scenario}${failureBrief}\n` +
          `当前已注册能力域：${existingDomains.join("、") || "（无）"}\n\n` +
          `已知能力域参考（可缺失的）：travel_planning, finance_deep, code_sandbox, self_programming, weather, shopping_order, calendar, health_fitness, email_sms, image_gen, smart_home, notes\n\n` +
          `分析规则：\n` +
          `  - 场景所需能力域已在 existingDomains 中 → 不是缺口\n` +
          `  - 场景所需能力域不在 existingDomains 中 → 是缺口\n` +
          `  - 缺口域属可 self-programming 扩展的（travel_planning/notes/code_sandbox/self_programming）→ suggestedAction 填"走 self-programming 生成"\n` +
          `  - 其他缺口 → suggestedAction 填"接入第三方工具"\n\n` +
          `只输出 JSON：{"gaps": [{"scenario": "场景描述", "missingCapability": "能力域标识", "suggestedAction": "建议动作"}], "rationale": "整体分析理由"}`;
        let raw = "";
        try {
          const provider = createExternalChatProviderFromEnv();
          if (!provider) throw new Error("no_chat_provider");
          await provider.streamCompletion(
            `gap-analyzer:${Date.now()}`,
            { text: prompt },
            (delta) => { raw += delta; },
            undefined,
            { ephemeralTurn: true, disableThinking: true, maxThreadMessages: 0 },
          );
        } catch (e) {
          throw new Error(`gap_analyzer_llm_failed:${String(e).slice(0, 60)}`);
        }
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) throw new Error("gap_analyzer_no_json");
        try {
          const parsed = JSON.parse(match[0]);
          const gaps: Array<{
            scenario: string;
            missingCapability: string;
            suggestedAction: string;
          }> = [];
          if (Array.isArray(parsed.gaps)) {
            for (const g of parsed.gaps) {
              if (g && typeof g === "object" && typeof g.missingCapability === "string") {
                gaps.push({
                  scenario: typeof g.scenario === "string" ? g.scenario : scenario,
                  missingCapability: g.missingCapability,
                  suggestedAction: typeof g.suggestedAction === "string" ? g.suggestedAction : "",
                });
              }
            }
          }
          return {
            gaps,
            rationale: typeof parsed.rationale === "string" ? parsed.rationale : undefined,
          };
        } catch {
          throw new Error("gap_analyzer_parse_failed");
        }
      },
    };
    capabilityCortex.registerGapAnalyzer(gapAnalyzer);

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

    // 知识缺口执行器（学知识层）：RAG 召回 + 联网兜底 + LLM 摘要 + 记忆沉淀 + 验证状态机
    // - 复用 toolRegistry 调 desktop.http_get（享受 URL 白名单+超时+审计）
    // - 复用 narrativeMemory（NarrativeMemoryPort：HumanLikeMemory + Mem0 + 向量库）
    // - 复用 agentMemorySyncService 写入 memory_facts KV（带验证状态标签）
    // - 复用 externalChat 做 LLM 摘要（去噪 + 提炼核心事实）
    // - 复用 knowledgeVerificationService 跟踪置信度 + 反馈累积
    // 记忆认知架构升级（Phase 4）：提升至外层作用域，brainNeuroEnabled 块内 7 子模块装配需访问。
    knowledgeVerificationService = new KnowledgeVerificationService();
    await knowledgeVerificationService.start();
    knowledgeGapExecutor = new KnowledgeGapExecutor({
      toolRegistry,
      narrativeMemory,
      memorySync: agentMemorySyncService,
      verification: knowledgeVerificationService,
      chatProvider: externalChat,
    });
    evolutionCortex.registerKnowledgeExecutor(knowledgeGapExecutor);
    // 反馈回路：每次工具交互都通知 verification service，触发状态机演进
    evolutionCortex.registerKnowledgeVerification(knowledgeVerificationService);

    // ─── Phase 5：自我驱动进化（规则触发 + LLM 深度评估 + 沙箱测试先行）───
    // 流程：ExternalTechScanner / BenchmarkSelfAssessment 规则触发 →
    //       SelfDrivenEvolutionProposer LLM 深度评估 →
    //       ingestProposals 注入 EvolutionCortex →
    //       autoLoop 推进到 approved → executeSelfUpgrade →
    //       UpgradeSandboxRunner 沙箱测试（备份 → 安装 → tsc + test → 通过才应用）
    try {
      const { ExternalTechScanner } = await import("../services/external-tech-scanner.js");
      const { SelfDrivenEvolutionProposer } = await import("../brain/self-driven-evolution-cortex.js");
      const { BenchmarkSelfAssessment } = await import("../services/benchmark-self-assessment.js");
      const { UpgradeSandboxRunner } = await import("../services/upgrade-sandbox-runner.js");
      const { getModelOverrideForTask, TaskTier } = await import("../config/model-routing.js");

      const techScanner = new ExternalTechScanner(externalChat);
      const selfDrivenProposer = new SelfDrivenEvolutionProposer();
      const benchmarkAssessment = new BenchmarkSelfAssessment();
      await benchmarkAssessment.load();

      // 注册 LLM 评估器到 SelfDrivenEvolutionProposer
      // 复用主聊天通道，用 mini 模型 + ephemeralTurn 避免污染会话历史
      if (externalChat?.isEnabled()) {
        selfDrivenProposer.registerLlm({
          async complete(systemPrompt, userPrompt, opts) {
            let fullContent = "";
            await externalChat.streamCompletion(
              `evolution-eval-${Date.now()}`,
              { text: userPrompt },
              (delta) => { fullContent += delta; },
              undefined,
              {
                systemPromptOverride: systemPrompt,
                ephemeralTurn: true,
                disableThinking: true,
                maxThreadMessages: 0,
                modelOverride: getModelOverrideForTask(TaskTier.MINI),
              },
            );
            if (opts?.maxTokens && fullContent.length > opts.maxTokens * 4) {
              return fullContent.slice(0, opts.maxTokens * 4);
            }
            return fullContent;
          },
        });
      }

      // 沙箱测试运行器：self_upgrade 执行的核心
      const sandboxRunner = new UpgradeSandboxRunner(process.cwd());

      // 定时器：每日技术扫描 → LLM 评估 → 提案 → 注入 EvolutionCortex
      const TECH_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
      const runTechScan = async () => {
        try {
          const results = await techScanner.scan();
          // proposeFromTechScan 现在是 async（内部调 LLM 评估）
          const proposals = await selfDrivenProposer.proposeFromTechScan(results);
          if (proposals.length > 0) {
            // 收集 LLM 评估结果传给 EvolutionCortex
            const assessments = new Map();
            for (const p of proposals) {
              const a = selfDrivenProposer.getAssessment(p.id);
              if (a) assessments.set(p.id, a);
            }
            evolutionCortex?.ingestProposals(proposals, assessments);
          }
        } catch (err) {
          console.log("[Phase5] tech scan 异常:", err);
        }
      };
      const techScanTimer = setInterval(() => { void runTechScan(); }, TECH_SCAN_INTERVAL_MS);
      techScanTimer.unref?.();
      // 启动后 5 分钟执行首次扫描
      setTimeout(() => { void runTechScan(); }, 5 * 60 * 1000)?.unref?.();

      // 定时器：每周运行 benchmark 自评 → LLM 评估 → 提案 → 注入 EvolutionCortex
      const runBenchmark = async () => {
        try {
          const benchScripts: string[] = [];
          const raw = process.env.BENCH_SCRIPTS?.trim();
          if (raw) benchScripts.push(...raw.split(",").map((s) => s.trim()).filter(Boolean));
          const { regressions } = await benchmarkAssessment.runAssessment(benchScripts);
          // proposeFromBenchmark 现在是 async（内部调 LLM 评估）
          const proposals = await selfDrivenProposer.proposeFromBenchmark(regressions);
          if (proposals.length > 0) {
            const assessments = new Map();
            for (const p of proposals) {
              const a = selfDrivenProposer.getAssessment(p.id);
              if (a) assessments.set(p.id, a);
            }
            evolutionCortex?.ingestProposals(proposals, assessments);
          }
        } catch (err) {
          console.log("[Phase5] benchmark 异常:", err);
        }
      };
      const BENCH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
      const benchTimer = setInterval(() => { void runBenchmark(); }, BENCH_INTERVAL_MS);
      benchTimer.unref?.();

      // 注册真实的 self_upgrade 执行器（沙箱测试先行）
      // 替换原来的 stub：从 "self_upgrade_requires_manual_approval" 改为真实沙箱测试
      evolutionCortex.registerCodeRepairExecutor({
        executeUpgrade: async (params) => {
          console.log(
            `[EvolutionCortex] self_upgrade 启动沙箱测试：${params.target}`,
          );

          // 从 proposal title 中解析包名和版本
          const target = params.target;

          // 有 breaking changes 时不自动升级，需人工确认
          if (params.llmAssessment?.breakingChanges?.length) {
            return {
              ok: false,
              error: `LLM 识别到 ${params.llmAssessment.breakingChanges.length} 个潜在 breaking changes，需人工确认：${params.llmAssessment.breakingChanges.join("; ")}`,
            };
          }

          // 尝试从 title/suggestedAction 中查找白名单包名
          const allowedPkgs = UpgradeSandboxRunner.getAllowedPackages();
          let resolvedPkg: string | undefined;
          let resolvedVer: string | undefined;

          for (const pkg of allowedPkgs) {
            if (params.suggestedAction.includes(pkg) || target.includes(pkg)) {
              resolvedPkg = pkg;
              break;
            }
          }

          // 从 title 提取版本号（格式："到 X.Y.Z"）
          const versionMatch = target.match(/到\s*(\d+\.\d+\.\d+)/);
          if (versionMatch) {
            resolvedVer = versionMatch[1];
          }

          if (!resolvedPkg || !resolvedVer) {
            return {
              ok: false,
              error: `无法从提案中解析包名和版本（target="${target}"）。建议操作：${params.suggestedAction}`,
            };
          }

          // 执行沙箱测试
          const report = await sandboxRunner.testUpgrade({
            type: "npm_dependency",
            description: target,
            packageName: resolvedPkg,
            targetVersion: resolvedVer,
            llmAssessment: params.llmAssessment,
          });

          if (!report.ok) {
            console.log(
              `[EvolutionCortex] 沙箱测试失败：${report.error}，已回滚=${report.rolledBack}`,
            );
          } else {
            console.log(
              `[EvolutionCortex] 沙箱测试通过：tsc=${report.tscPassed}, tests=${report.testsPassed}, ` +
              `testFiles=[${report.testFilesRun.join(", ")}], 耗时=${(report.totalMs / 1000).toFixed(1)}s`,
            );
          }

          return {
            ok: report.ok,
            patchApplied: report.ok,
            error: report.ok ? undefined : report.error,
            sandboxReport: report,
          };
        },
      });
      console.log(
        "[EvolutionCortex] 已注册 Phase 5 自我进化：" +
        "TechScanner(24h) + Benchmark(7d) + LLM评估 + 沙箱测试执行器",
      );
    } catch (err) {
      console.log("[EvolutionCortex] Phase 5 模块注册失败（忽略）:", err);
    }

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

    // ─── 自我修复皮层（CodeRepairCortex）装配 ───
    // 默认开启（BRAIN_CODE_REPAIR_ENABLED=0 关闭）。
    // 理由：用户明确要求"出问题的地方把它隔离，然后让 agent 自己去修复，
    // 去测试，然后自己改正"——这是核心能力，必须默认工作。
    // 安全边界已在 cortex 内部通过白名单 + 黑名单 + 危险模式黑名单三道闸门保证。
    // 装配 4 个依赖：
    //   1. LLM 适配器：把 ExternalChatProvider 包装成 CodeRepairLlmLike（一次性非流式调用）
    //   2. TestRunner：默认 DefaultTestRunner（跑 tsc --noEmit + 相关 test）
    //   3. BrainCenter.registerCodeRepair：外观层注入
    //   4. BrainCenter.start()：随主生命周期启动 autoLoop
    if (process.env.BRAIN_CODE_REPAIR_ENABLED?.trim() !== "0") {
      const codeRepairCortex = new CodeRepairCortex({
        serverRoot: process.cwd(),
      });

      // LLM 适配器：复用主聊天通道，但用 ephemeralTurn 避免污染会话历史
      // externalChat 可能为 null（未配置 OPENAI_API_KEY 时），适配器内部处理
      const codeRepairLlm: CodeRepairLlmLike = {
        async complete(systemPrompt, userPrompt, opts) {
          if (!externalChat) {
            throw new Error("externalChat 未配置（未设置 OPENAI_API_KEY 等环境变量）");
          }
          let fullContent = "";
          await externalChat.streamCompletion(
            `code-repair-${Date.now()}`,
            { text: userPrompt },
            (delta) => {
              fullContent += delta;
            },
            undefined,
            {
              systemPromptOverride: systemPrompt,
              ephemeralTurn: true,
              maxThreadMessages: 2,
            },
          );
          // 简单截断到 maxTokens（如果指定），避免 LLM 输出过长
          if (opts?.maxTokens && fullContent.length > opts.maxTokens * 4) {
            return fullContent.slice(0, opts.maxTokens * 4);
          }
          return fullContent;
        },
      };
      codeRepairCortex.registerLlm(codeRepairLlm);

      // 默认测试运行器：tsc --noEmit（60s）+ 相关 test（30s）
      const testRunner = new DefaultTestRunner(process.cwd(), {
        tscTimeoutMs: 60_000,
        testTimeoutMs: 30_000,
      });
      codeRepairCortex.registerTestRunner(testRunner);

      brainCenter.registerCodeRepair(codeRepairCortex);
      if (process.env.BRAIN_CODE_REPAIR_ENABLED?.trim() === "0") {
        console.log("[Bootstrap] CodeRepairCortex 未启用（BRAIN_CODE_REPAIR_ENABLED=0）");
      } else {
        console.log("[Bootstrap] CodeRepairCortex 已启用（默认开启）");
      }
    }

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

      // 拉取用户最近实时对话，让话术生成能感知当前话题走向
      let recentConversation = "";
      try {
        const chatSessionId = resolvePrimaryChatSessionId(
          signal.actorId,
          getAgentRuntimeConfig().masterDelegation.enabled,
        );
        const messages = getChatThreadStore().thread(chatSessionId, "");
        const recent = messages.slice(-6);
        const lines: string[] = [];
        for (const msg of recent) {
          const role = msg.role === "user" ? "用户" : msg.role === "assistant" ? "Agent" : null;
          if (!role) continue;
          const content = typeof msg.content === "string" ? msg.content : "[多模态消息]";
          const cleaned = content.replace(/^\[ts:[^\]]+\]\n?/, "").trim();
          if (cleaned) lines.push(`${role}：${cleaned}`);
        }
        recentConversation = lines.join("\n");
      } catch {
        // thread store 拉取失败不阻塞话术生成
      }
      const convContext = recentConversation.trim()
        ? `\n用户最近实时对话：\n${recentConversation.trim().slice(0, 600)}\n（关键参考：用户当前在聊什么。话术要自然融入当前对话节奏，不要强行扯回无关的旧话题）`
        : "";

      return `信号类型：${signal.kind}
信号标题：${signal.title}
重要程度：${importance}
检测时间：${occurredAt}
决策评分：value=${decision.valueScore}, disturb=${decision.disturbScore}${summary}${memoryContext}${convContext}

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
        mode: "fast",
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
                mode: "fast",
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

  // ─── Body Center 开关 ───
  // BODY_CENTER_ENABLED 未设置或非 "0"/"false"/"off" → 默认启用身体中心
  // 关闭时：整个 body/ 模块不实例化、BrainCenter.registerBodyGateway 会内部跳过
  const bodyCenterEnabled = !["0", "false", "off"].includes(
    (process.env.BODY_CENTER_ENABLED ?? "").trim().toLowerCase(),
  );

  // ─── Body Center 装配 ───
  // 启用 body 时：实例化 8 个 BodyModule + BodyBus + ReflexArc + BodyGateway + BodyCenter
  // 关闭 body 时（BODY_CENTER_ENABLED=0）：整个 body/ 模块不实例化、不启动，
  //   BrainCenter.registerBodyGateway 内部会因 isBodyCenterEnabled() 返回 false 而忽略注入
  let bodyCenter: BodyCenter | null = null;
  let reflexArc: ReflexArc | null = null;
  if (bodyCenterEnabled) {
    // 1. BodyBus + ReflexArc（硬安全门，纯规则匹配）
    const bodyBus = new BodyBus();
    reflexArc = new ReflexArc();
    // 局部 const 引用：reflexArc 是外层 let（可空），闭包内 TS 无法自动窄化，
    // 用 reflexArcInst 在 if 块内保留 non-null 窄化。
    const reflexArcInst = reflexArc;

    // 2. BodyGateway：注入 ReflexArc + 兜底 ToolRegistry
    const bodyGateway = new BodyGateway({
      reflexArc,
      fallbackToolRegistry: {
        execute: async (name, args, opts) => {
          const actorId = opts?.actorId ?? "body-gateway";
          return toolRegistry.execute(name, args, {
            sessionId: actorId,
            userId: actorId,
            agentAccessMode: "full",
          });
        },
      },
    });

    // 3. 子系统适配器：真实服务接口 → BodyModule 期望的最小化结构接口
    //    （避免修改 body/ 目录，所有适配在装配层完成）

    // 3.1 DeviceRegistry → DeviceRegistryLike（Eye & Skin & HomeostasisCore 共用）
    //     真实 DeviceRegistry.invoke 返回 DeviceInvokeResult {ok, data?, error?}，
    //     期望 {ok, result?}；真实 openStream(deviceId, params) 返回 {ok, streamId, stream, error?}，
    //     期望 openStream(deviceId, streamId, params) 返回 AsyncIterable<{type, payload}>
    const deviceRegistryAdapter = {
      listByCapability: (_cap: string) => [] as Array<{ deviceId: string; kind: string }>,
      async invoke(
        deviceId: string,
        action: string,
        params: Record<string, unknown>,
      ): Promise<{ ok: boolean; result?: unknown }> {
        const r = await deviceRegistry.invoke(deviceId, action, params);
        return { ok: r.ok, result: r.data };
      },
      openStream(
        deviceId: string,
        _streamId: string,
        params: Record<string, unknown>,
      ): AsyncIterable<{ type: string; payload: Record<string, unknown> }> {
        const r = deviceRegistry.openStream(deviceId, params);
        if (!r.ok || !r.stream) {
          return (async function* () {
            /* empty stream */
          })();
        }
        const upstream = r.stream;
        return (async function* () {
          for await (const chunk of upstream) {
            yield {
              type: chunk.kind,
              payload:
                typeof chunk.data === "object" && chunk.data !== null
                  ? (chunk.data as Record<string, unknown>)
                  : { data: chunk.data },
            };
          }
        })();
      },
    };

    // 3.2 DesktopBridgeCoordinator → DesktopBridgeLike（Eye 用，可选）
    //     真实 desktopBridgeCoordinator.invoke(actorId, payload, timeoutMs) → DesktopVisualRunResult | null
    //     期望 runTask?({task, region}) → Promise<unknown>
    const desktopBridgeAdapter = {
      async runTask(opts: {
        task: string;
        region?: [number, number, number, number] | null;
        [key: string]: unknown;
      }): Promise<unknown> {
        return desktopBridgeCoordinator.invoke(
          "default",
          { task: opts.task, region: opts.region ?? null },
          600_000,
        );
      },
    };

    // 3.3 SmartHomeService → SmartHomeLike（Skin 用）
    //     真实 SmartHomeService.getState 返回 HADeviceState {entity_id, state: string, attributes, ...}
    //     期望 getState 返回 {state: Record<string, unknown>} | null
    //     真实控制走 callService(domain, service, data)
    const smartHomeAdapter = {
      async controlDevice(opts: {
        deviceId?: string;
        entityType?: string;
        entityId?: string;
        action?: string;
        params?: Record<string, unknown>;
      }): Promise<{ ok: boolean; state?: Record<string, unknown> }> {
        // action 形如 "light.turn_off" → domain=light, service=turn_off
        const action = String(opts.action ?? "");
        const [domain, service] = action.split(".");
        if (!domain || !service) return { ok: false };
        try {
          await smartHomeService.callService(
            domain,
            service,
            opts.params ?? {},
          );
          return { ok: true };
        } catch {
          return { ok: false };
        }
      },
      async getState(entityId: string): Promise<{ state: Record<string, unknown> } | null> {
        try {
          const r = await smartHomeService.getState(entityId);
          return { state: { ...(r.attributes ?? {}), value: r.state } };
        } catch {
          return null;
        }
      },
      async getAllStates(): Promise<Record<string, Record<string, unknown>>> {
        try {
          const list = await smartHomeService.getAllStates();
          const out: Record<string, Record<string, unknown>> = {};
          for (const s of list) {
            out[s.entity_id] = { ...(s.attributes ?? {}), value: s.state };
          }
          return out;
        } catch {
          return {};
        }
      },
    };

    // 3.4 ComputeQuotaService → ComputeQuotaLike（HomeostasisCore 用）
    //     真实 ComputeQuotaService.getState(sessionId) 返回 {limit, reserved, consumed, available}
    //     期望 getQuota() → number 0-1（配额剩余比例）
    const computeQuotaAdapter = {
      getQuota(): number {
        const s = computeQuotaService.getState("default");
        return s.limit > 0 ? s.available / s.limit : 1;
      },
    };

    // 4. 8 个 BodyModule（注入现有服务 + 适配器为子系统）
    const hand = new Hand({
      bodyBus,
      desktopBridge: desktopBridgeCoordinator,
      desktopVisualPort: desktopVisual,
      agentBrowserService,
      fileProcessingService,
      codeSandboxService,
    });

    // Mouth 子系统适配器：真实服务接口包装为 BodyModule 期望的最小化接口
    const mouth = new Mouth({
      bodyBus,
      voiceDialogue: voiceDialogueService,
      ttsService: {
        // 真实 TtsService.synthesizeMp3Base64 → 适配为 synthesize(text, opts?)
        async synthesize(text: string, _opts?: { voiceId?: string }) {
          const r = await ttsService.synthesizeMp3Base64(text);
          if (!r.ok) return {};
          return {
            base64: r.base64,
            format: "mp3",
            provider: r.provider,
          };
        },
      },
      voiceCapability: voiceCapabilityService,
      voiceMessageService: {
        // 真实 VoiceMessageService.composeAndStore → 适配为 send({to, audioUrl, text})
        async send(opts: { to?: string; audioUrl?: string; text?: string }) {
          const text = String(opts.text ?? "");
          if (!text) return { ok: false, error: "missing text" };
          // to 字段在 VoiceMessageLike 接口中是 to?: string，与 actorId 含义一致；
          // 默认用 "default"，真实 send 路径会从 args.actorId 传入
          const actorId = String(opts.to ?? "default");
          const r = await voiceMessageService.composeAndStore(text, actorId);
          if (!r.ok) return { ok: false, error: r.reason };
          return { ok: true, messageId: r.msgId };
        },
      },
      phoneBridge: {
        // 真实 PhoneBridgeCoordinator.invoke(actorId, "outbound_speak", params)
        // → 适配为 outboundSpeak({text, voiceId?})
        async outboundSpeak(opts: { text: string; voiceId?: string }) {
          // actorId 无法从此接口拿到，Body 模块调用时通过 args.actorId 传入
          // 此处默认 "default"，真实路径会从 args.actorId 传入
          const r = await phoneBridgeCoordinator.invoke(
            "default",
            "outbound_speak",
            { text: opts.text, voiceId: opts.voiceId },
          );
          // PhoneBridgeResult 的 error 字段为 unknown，需强制转为 string
          if (!r.ok) {
            const err = r.error;
            return {
              ok: false,
              error: typeof err === "string" ? err : "phone_bridge_outbound_speak_failed",
            };
          }
          return { ok: true };
        },
      },
    });

    const eye = new Eye({
      bodyBus,
      desktopVisualPort: desktopVisual,
      desktopBridge: desktopBridgeAdapter,
      deviceRegistry: deviceRegistryAdapter,
    });

    const ear = new Ear({
      bodyBus,
      voiceDialogue: voiceDialogueService,
      funasrAdapter,
      openaiAsrAdapter,
    });

    const skin = new Skin({
      bodyBus,
      smartHomeService: smartHomeAdapter,
      deviceRegistry: deviceRegistryAdapter,
    });

    const vestibularApparatus = new VestibularApparatus({
      bodyBus,
      wsRegistry: wsConnectionRegistry,
      embodimentAutonomy,
    });

    const homeostasisCore = new HomeostasisCore({
      bodyBus,
      computeQuotaService: computeQuotaAdapter,
      deviceRegistry: deviceRegistryAdapter,
    });

    // 5. ReflexArc → BodyModuleLike 适配器
    //    ReflexArc 本身实现 ReflexArcLike（check/registerPattern/listPatterns），
    //    但 BodyCenter.setReflex 期望 BodyModuleLike（name/label/tools/act/sense/snapshot）。
    //    BodyGateway 已通过构造参数注入 reflexArc 作为硬安全门（execute 入口先过反射弧检查），
    //    此处适配器仅用于把 ReflexArc 纳入 BodyCenter.snapshot()/start()/stop() 统一管理。
    const reflexModuleAdapter = {
      name: "reflex" as const,
      label: "反射弧（脊髓反射）",
      tools: [] as string[],
      async act(_action: BodyAction): Promise<BodyActionResult> {
        // ReflexArc 已在 BodyGateway.execute 入口处生效，此处不会触达；
        // 返回 ok=true 空结果，避免万一被路由到时阻塞调用方。
        return { ok: true, result: {} };
      },
      async sense(_query: BodySenseQuery): Promise<BodySenseResult> {
        return {
          ok: true,
          data: { patterns: reflexArcInst.listPatterns().length },
        };
      },
      snapshot(): BodyModuleSnapshot {
        return {
          name: "reflex",
          label: "反射弧（脊髓反射）",
          tools: [],
          online: true,
          subsystems: ["reflex-arc"],
          lastActivityAt: null,
        };
      },
    };

    // 6. BodyCenter 外观类
    bodyCenter = new BodyCenter(bodyGateway, bodyBus);
    bodyCenter.setHand(hand);
    bodyCenter.setMouth(mouth);
    bodyCenter.setEye(eye);
    bodyCenter.setEar(ear);
    bodyCenter.setSkin(skin);
    bodyCenter.setVestibularApparatus(vestibularApparatus);
    bodyCenter.setHomeostasis(homeostasisCore);
    bodyCenter.setReflex(reflexModuleAdapter);

    // 6.1 Task 12 工具下沉：填充 BodyGateway.routeTable（前缀最长匹配）
    //      策略 A：保留独立文件 register 调用，BodyGateway 在 execute 时按前缀拦截，
    //      BodyModule.act() 未覆盖的具体工具会降级到 fallbackToolRegistry（独立 handler 兜底）。
    //      前缀按 BodyModule 归属组织：
    //        - hand：desktop.* / agent_browser.* / file_doc.* / file.* / code_sandbox.* / code.*
    //        - vestibular：embodiment.*
    //        - skin：smart_home.* / device.*
    //        - mouth：tts.* / voice.* / voice_message.* / phone_bridge.*
    //      注：eye.* / ear.* 走 BodyGateway.sense 上行通路，不走 execute 下行，
    //          故不在此注册；reflex 是反射弧硬安全门，在 execute 入口已先于路由生效。
    bodyGateway.registerToolRoute("desktop.visual.", "hand");
    bodyGateway.registerToolRoute("desktop.", "hand");
    bodyGateway.registerToolRoute("agent_browser.", "hand");
    bodyGateway.registerToolRoute("file_doc.", "hand");
    bodyGateway.registerToolRoute("file.", "hand");
    bodyGateway.registerToolRoute("code_sandbox.", "hand");
    bodyGateway.registerToolRoute("code.", "hand");
    bodyGateway.registerToolRoute("embodiment.", "vestibular");
    bodyGateway.registerToolRoute("smart_home.", "skin");
    bodyGateway.registerToolRoute("device.sensor.", "skin");
    bodyGateway.registerToolRoute("device.", "skin");
    bodyGateway.registerToolRoute("tts.", "mouth");
    bodyGateway.registerToolRoute("voice_message.", "mouth");
    bodyGateway.registerToolRoute("voice.", "mouth");
    bodyGateway.registerToolRoute("phone_bridge.", "mouth");

    // 5. 工具下沉：各 BodyModule 通过 registerTools 把工具挂到 ToolRegistry，
    //    handler 内部委托 this.act()；handler 调用栈：ToolRegistry → BodyModule.act → 子系统执行
    hand.registerTools(toolRegistry);
    mouth.registerTools(toolRegistry);
    eye.registerTools(toolRegistry);
    ear.registerTools(toolRegistry);
    skin.registerTools(toolRegistry);
    vestibularApparatus.registerTools(toolRegistry);
    // homeostasisCore.tools=[] 跳过
    // reflexArc 无 registerTools 方法（不在 BodyModuleLike 工具下沉范围内）

    // 6. 注册 body.* LLM 工具（body.where_am_i / body.state / body.list_modules / body.calibrate）
    registerBodyTools(toolRegistry, bodyCenter);
    // 把 body.* 工具 schema 暴露给 LLM（与 setBrainChatTools 对称）。
    // bodyCenterEnabled=false 时本分支不进入，BODY_CHAT_TOOLS 不注入，保持原 getBuiltinAgentChatTools 行为。
    setBodyChatTools(BODY_CHAT_TOOLS);

    app.log.info(`[BodyCenter] 已装配 8 个 BodyModule（Hand/Mouth/Eye/Ear/Skin/Vestibular/Homeostasis/Reflex）`);
    app.log.info(`[BodyCenter] 已下沉工具到 ToolRegistry（body.* 工具已注册）`);
    app.log.info(`[BodyCenter] ReflexArc 已加载 ${reflexArc.listPatterns().length} 条内置危险模式`);
  }

  // ─── Brain Center 神经解剖分区装配 ───
  // BRAIN_NEURO_ENABLED 未设置或非 "0"/"false"/"off" → 默认启用 5 个新分区
  // 关闭时：5 个新分区不实例化，BrainCenter 回退到 4 皮层模式
  //
  // 世界模型（World Model）在外层创建：两个装配块（神经分区块 + 端到端认知块）
  // 都需要访问。BRAIN_WORLD_MODEL_ENABLED=0 时不实例化，所有皮层走原路径（零影响）。
  const worldModel = createWorldModelFromEnv();
  if (worldModel) {
    console.log("[BrainCenter] WorldModel 已创建（RuleBasedWorldModel），将在各皮层装配时注入");
  }
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

    // ─── SubTask 14.2 续：BodyBus 上行通路接入 brain ───
    // BodyBus 桥接到 SynapseBus（body.* 信号上达 brain 域）
    // BodyBus → SynapseBus.fire，让 brain 侧皮层通过 SynapseBus.subscribe 收到身体信号
    if (bodyCenter) {
      const bodyBus = bodyCenter.getBus();
      bodyBus.bridgeToSynapse(synapseBus);
      // SensoryCortex 订阅 BodyBus 的 body.eye.frame / body.ear.transcript / body.mouth.spoken
      sensoryCortex.attachBodyBus(bodyBus);
      // AwarenessCortex 订阅 body.homeostasis.battery_low / body.skin.device_change / body.vestibular.device_switch
      awarenessCortex?.attachBodyBus(bodyBus);
    }

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

    // ─── Phase 1：长期关系图谱 ───
    // 复用 HumanLikeMemoryService 的 relationship domain 作为存储后端，
    // 让 MemoryCortex.recall(domain="relationship") 能拉到关系轨迹摘要（≤200 char）。
    // 不新增 LLM 调用，纯规则读取 + 压缩输出。
    try {
      const { RelationshipGraphService } = await import("../services/relationship-graph-service.js");
      const relationshipGraph = new RelationshipGraphService(humanLikeMemory);
      memoryCortex.registerRelationshipGraph(relationshipGraph);
      console.log("[BrainCenter] 已注册 RelationshipGraphService（Phase 1 关系图谱）");
    } catch (err) {
      console.log("[BrainCenter] RelationshipGraphService 注册失败（忽略）:", err);
    }

    // 缺口 3 修复：注入 AwarenessCortex 到 nightly 服务，启用"夜间 + sleeping"双条件触发 dreaming
    // 注意：awarenessCortex 在 brainNeuroEnabled 块内创建（行 1093），
    // 此处注入若 awarenessCortex 未创建则传 null（降级为仅时间窗触发）
    if (nightlyMemoryService && awarenessCortex) {
      nightlyMemoryService.setAwarenessCortex(awarenessCortex);
    }

    // 突触总线注册到 BrainCenter（各皮层已通过 registerSynapseBus 建立订阅）
    brainCenter.registerSynapse(synapseBus);

    // LimbicCortex（边缘皮层 / 杏仁核 + 情感）
    limbicCortex = new LimbicCortex();
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

    // ─── DelegateJudge 装配（shouldDelegate 的 LLM 语义判断）───
    // 仅在边界情况（步骤数 > 阈值但规则未命中委派关键词）时调用 LLM 做语义判断。
    // 热路径成本控制：白名单预筛 + 规则快速路径 + 步骤数阈值 → 绝大多数请求不触发 LLM。
    // BRAIN_LLM_SHOULDDELEGATE_ENABLED=0 时降级到纯规则 shouldDelegate。
    // 决策器实现已抽到 brain/decision-maker-factory.ts，支持未来"换大脑"时同步替换。
    const delegateJudge = createDefaultDelegateJudge();
    plannerCortex.registerDelegateJudge(delegateJudge);

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
      // 人格/情绪簇集成：注入 MemoryCortex 引用，使 PersonalityAdjuster
      // 能在 observeTurnAsync 中读写 MemoryCortex.personalityCache
      if (memoryCortex) {
        userPersonalizationService.registerMemoryCortex(memoryCortex);
      }
      brainCenter.registerBrainStem(brainStem);

      const cerebellum = new Cerebellum();
      cerebellum.registerAwareness(awarenessCortex);
      brainCenter.registerCerebellum(cerebellum);
    }

    // ─── Phase 4：多模态融合皮层 ───
    // 纯规则冲突检测 + 优先级仲裁，无 LLM 调用、不增加 token。
    // BRAIN_MULTIMODAL_FUSION_ENABLED=0 时 BrainCenter 内部自动降级回 buildSensoryFrame。
    if (sensoryCortex) {
      const { MultimodalFusionCortex } = await import("../brain/multimodal-fusion-cortex.js");
      brainCenter.registerMultimodalFusion(new MultimodalFusionCortex());
    }

    // ─── 世界模型（World Model）装配：第一部分 ───
    // plannerCortex 在此块内创建，注入 WorldModel 开启 model-based planning 能力。
    // PredictiveCoding/MetaCognition/DMN 在第二块创建，由第二部分注入。
    if (worldModel) {
      plannerCortex.registerWorldModel(worldModel);
      console.log("[BrainCenter] WorldModel 已注入 PlannerCortex（model-based planning）");
    }
  }

  // ─── 端到端认知装配（整体端到端调度的核心）───
  // proactionCortex 在 brainEnabled 块创建，memoryCortex 在 brainNeuroEnabled 块创建。
  // 两者就绪后注入端到端决策器：一次 LLM 完成"理解+决策+响应"，不再切片式串联各脑区。
  if (proactionCortex && memoryCortex && brainCenter) {
    // ProactionCortex 主动认知端到端：注入记忆 + 端到端决策器
    proactionCortex.registerMemory(memoryCortex as unknown as MemoryCortexLike);
    // 注入最近对话提供者：让主动决策能感知用户当前话题走向，
    // 避免用户已转换话题后还回去讲旧话题（根源修复"重复且不正面回复"问题）。
    const recentConvProvider: RecentConversationProvider = {
      fetchRecentConversation(actorId: string, limit = 6): string {
        try {
          const chatSessionId = resolvePrimaryChatSessionId(
            actorId,
            getAgentRuntimeConfig().masterDelegation.enabled,
          );
          const messages = getChatThreadStore().thread(chatSessionId, "");
          const recent = messages.slice(-limit);
          const lines: string[] = [];
          for (const msg of recent) {
            const role = msg.role === "user" ? "用户" : msg.role === "assistant" ? "Agent" : null;
            if (!role) continue;
            const content = typeof msg.content === "string" ? msg.content : "[多模态消息]";
            const cleaned = content.replace(/^\[ts:[^\]]+\]\n?/, "").trim();
            if (cleaned) lines.push(`${role}：${cleaned}`);
          }
          return lines.join("\n");
        } catch {
          return "";
        }
      },
    };
    proactionCortex.registerRecentConversationProvider(recentConvProvider);
    // 决策器实现已抽到 brain/decision-maker-factory.ts，支持未来"换大脑"时同步替换。
    const endToEndMaker = createDefaultEndToEndDecisionMaker();
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
    // 认知引擎实现已抽到 brain/cognitive-engine-factory.ts，通过 COGNITIVE_ENGINE_IMPL 环境变量
    // 配置驱动选择不同实现，支持未来"换大脑"（升级到更强 LLM / 切换到 AGI 世界模型）。
    const cognitiveEngine = createCognitiveEngineFromEnv();
    brainCenter.registerCognitiveEngine(cognitiveEngine);

    // ─── Step 7 扩展：DecisionHub 装配（规则驱动端到端认知）───
    // 替代 cognitiveEngine 的 LLM 路由判断：规则驱动，避免幻觉。
    // BrainCenter.cognize 阶段 2 优先调用 DecisionHub.decidePassive，
    // 未注册时回退到 cognitiveEngine（向后兼容）。
    const ruleRouter = new RuleRouter();
    const actionExecutor = new ActionExecutor({
      execute: async (name, args, opts) => {
        const actorId = opts?.actorId ?? "decision-hub";
        return toolRegistry.execute(name, args, {
          sessionId: actorId,
          userId: actorId,
          agentAccessMode: "full",
        });
      },
    });
    // 注入 LimbicCortex 用于统一安全检查
    if (limbicCortex) {
      actionExecutor.registerLimbic(limbicCortex as unknown as import("../brain/action-executor.js").LimbicCortexLike);
    }
    // Task 12 工具下沉：把 BodyGateway 注入 ActionExecutor，
    // 使 BrainCenter 决策的 BrainDecisionAction 走 BodyGateway（先过反射弧，再路由到 BodyModule.act），
    // 未下沉工具降级到 ActionExecutor 自带的 toolRegistry fallback。
    // bodyCenter 为 null（BODY_CENTER_ENABLED=0）时不注入，ActionExecutor 自动走原 toolRegistry 直连路径。
    if (bodyCenter) {
      actionExecutor.registerBodyGateway(bodyCenter.getGateway());
      // P0-2 工具执行反馈闭环：注入 BodyBus，让 execute 成功/失败后回流信号
      // 到 BodyBus（body.action.executed / body.action.failed），
      // 下一轮 cognize 可通过 BodyBus 感知上一轮 hand 做了什么。
      actionExecutor.registerBodyBus(bodyCenter.getBus());
    }
    const decisionHub = new DecisionHub(ruleRouter, actionExecutor);
    // 注入共享认知能力（记忆/状态/能力）
    if (memoryCortex) {
      decisionHub.registerMemory(memoryCortex as unknown as import("../brain/decision-hub.js").MemoryCortexLike);
    }
    if (awarenessCortex) {
      decisionHub.registerAwareness(awarenessCortex as unknown as import("../brain/decision-hub.js").AwarenessCortexLike);
    }
    if (capabilityCortex) {
      decisionHub.registerCapability(capabilityCortex as unknown as import("../brain/decision-hub.js").CapabilityCortexLike);
    }
    brainCenter.setDecisionHub(decisionHub);
    console.log("[BrainCenter] DecisionHub 装配完成（规则驱动端到端认知 + 统一 ActionExecutor）");

    // ─── Step 7 扩展：7 个新皮层模块装配 ───
    // 类人化 4 模块 + Agent 特化 3 模块，全部注册到 BrainCenter + DecisionHub
    const workingMemoryCortex = new WorkingMemoryCortex();
    const taskSwitchingCortex = new TaskSwitchingCortex();
    taskSwitchingCortex.registerWorkingMemory(workingMemoryCortex); // 任务切换联动工作记忆
    const metaCognitionCortex = new MetaCognitionCortex();
    const contextCortexLocal = new ContextCortex();
    if (awarenessCortex) {
      contextCortexLocal.registerAwareness(awarenessCortex as unknown as import("../brain/context-cortex.js").ContextAwarenessLike);
    }
    const toolPlanningCortex = new ToolPlanningCortex();
    const onlineLearningCortex = new OnlineLearningCortex();

    // 注册到 BrainCenter
    brainCenter.registerWorkingMemoryCortex(workingMemoryCortex);
    brainCenter.registerTaskSwitchingCortex(taskSwitchingCortex);
    brainCenter.registerContextCortex(contextCortexLocal);
    brainCenter.registerToolPlanningCortex(toolPlanningCortex);
    brainCenter.registerOnlineLearningCortex(onlineLearningCortex);
    brainCenter.registerMetaCognitionCortex(metaCognitionCortex);

    const emotionModulator = new EmotionModulator();
    brainCenter.registerEmotionModulator(emotionModulator);
    decisionHub.registerEmotionModulator(emotionModulator);

    const defaultModeNetwork = new DefaultModeNetwork();
    brainCenter.registerDefaultModeNetwork(defaultModeNetwork);

    // 深度优化：DMN 接入三个依赖皮层（让 onIdle 时记忆固化 + 反思 + 进化建议真正生效）
    defaultModeNetwork.registerMemoryCortex(memoryCortex);
    // EvolutionCortex 已提升至外层作用域，DMN 可访问其 proposeEvolution
    // （EvolutionCortex 类现已实现 proposeEvolution(actorId) 方法）
    if (evolutionCortex) {
      defaultModeNetwork.registerEvolutionCortex(evolutionCortex);
    }

    // ─── 世界模型（World Model）装配：第二部分 ───
    // DefaultModeNetwork 在此块创建，注入 WorldModel 开启空闲反事实模拟。
    // worldModel 在外层声明（第一部分已注入 PlannerCortex）。
    if (worldModel) {
      defaultModeNetwork.registerWorldModel(worldModel);
      console.log("[BrainCenter] WorldModel 已注入 DefaultModeNetwork");
    }

    // 深度优化：让脑干定期调度 WorkingMemoryCortex.decay() 和 DefaultModeNetwork.onIdle()
    // 通过 BrainCenter.getBrainStem() 拿回 brainStem 引用（brainStem 在上方 if 块内创建）
    const brainStemRef = brainCenter.getBrainStem() as unknown as
      | (import("../brain/brain-stem.js").BrainStem & {
          registerWorkingMemory(wm: import("../brain/brain-stem.js").BrainStemWorkingMemoryLike): void;
          registerDefaultModeNetwork(dmn: import("../brain/brain-stem.js").BrainStemDefaultModeNetworkLike): void;
          registerMemoryConsolidator(mc: import("../brain/brain-stem.js").BrainStemMemoryConsolidatorLike): void;
          registerSequencePatternMiner(miner: import("../services/sequence-pattern-miner.js").SequencePatternMiner): void;
        })
      | null;
    if (brainStemRef) {
      brainStemRef.registerWorkingMemory(workingMemoryCortex);
      brainStemRef.registerDefaultModeNetwork(defaultModeNetwork);
      // 仿人记忆连续性：白天 idle 时触发轻量记忆整理，不必等到夜晚 dreaming
      const memMgrForBrainStem = getMemoryManagerService();
      if (memMgrForBrainStem) {
        brainStemRef.registerMemoryConsolidator(memMgrForBrainStem);
      }

      // ─── Phase 3：序列模式预测 ───
      // 让脑干心跳扫描时调 SequencePatternMiner 从 LifeSignalHub 历史挖掘序列模式，
      // 当前事件流匹配模式前缀时合成 predicted_action 信号。
      // 纯规则无 LLM 调用，PredictiveActionSynthesizer 已在 BrainStem 内部实例化。
      try {
        const { SequencePatternMiner } = await import("../services/sequence-pattern-miner.js");
        const miner = new SequencePatternMiner(lifeSignalHubService);
        brainStemRef.registerSequencePatternMiner(miner);
        console.log("[BrainStem] 已注册 SequencePatternMiner（Phase 3 序列预测）");
      } catch (err) {
        console.log("[BrainStem] SequencePatternMiner 注册失败（忽略）:", err);
      }
    }

    // ─── 记忆认知架构升级（Phase 4）：7 个子模块装配 ───
    // 主开关 BRAIN_MEMORY_COGNITIVE_ENABLED 缺省开启；关闭时 7 个子模块均不实例化，
    // MemoryCortex 行为与升级前完全一致（零影响降级）。
    // 各子模块内部还有独立开关（如 BRAIN_MEMORY_ASSOCIATIVE_ENABLED 等），
    // 控制运行时方法行为；此处仅负责实例化与注入。
    const memoryCognitiveEnabled = !["0", "false", "off"].includes(
      (process.env.BRAIN_MEMORY_COGNITIVE_ENABLED ?? "").trim().toLowerCase(),
    );
    if (memoryCognitiveEnabled) {
      try {
        // 实例化 7 个子模块（依赖注入：humanLikeMemory / metaCognitionCortex / knowledge 服务 / synapseBus）
        const associativeGraph = new MemoryAssociativeGraph({
          humanLike: humanLikeMemory as unknown as import("../brain/memory-cognitive/memory-associative-graph.js").HumanLikeMemoryAssociativeLike,
          metaCognition: metaCognitionCortex as unknown as import("../brain/memory-cognitive/memory-associative-graph.js").MetaCognitionLike,
          knowledgeGapExecutor: knowledgeGapExecutor as unknown as import("../brain/memory-cognitive/memory-associative-graph.js").KnowledgeGapExecutorLike,
        });
        const reconstructionValidator = new MemoryReconstructionValidator(
          humanLikeMemory as unknown as import("../brain/memory-cognitive/memory-reconstruction-validator.js").HumanLikeMemoryReconstructionLike,
        );
        const metacognitionBridge = new MemoryMetacognitionBridge({
          memoryCortex: memoryCortex as unknown as import("../brain/memory-cognitive/memory-metacognition-bridge.js").MemoryCortexLike,
          metaCognition: metaCognitionCortex as unknown as import("../brain/memory-cognitive/memory-metacognition-bridge.js").MetaCognitionLike,
          knowledgeVerification: knowledgeVerificationService as unknown as import("../brain/memory-cognitive/memory-metacognition-bridge.js").KnowledgeVerificationLike,
          knowledgeGapExecutor: knowledgeGapExecutor as unknown as import("../brain/memory-cognitive/memory-metacognition-bridge.js").KnowledgeGapExecutorLike,
        });
        const forgettingController = new MemoryForgettingController();
        forgettingController.registerHumanLikeMemory(
          humanLikeMemory as unknown as import("../brain/memory-cognitive/memory-forgetting-controller.js").HumanLikeMemoryForgettingLike,
        );
        if (synapseBus) {
          forgettingController.registerSynapseBus(
            synapseBus as unknown as import("../brain/memory-cognitive/memory-forgetting-controller.js").SynapseBusLike,
          );
        }
        const proceduralAutomation = new MemoryProceduralAutomation();
        const schemaFormation = new MemorySchemaFormation({
          humanLike: humanLikeMemory as unknown as import("../brain/memory-cognitive/memory-schema-formation.js").HumanLikeMemorySchemaLike,
        });
        const salienceFilter = new MemorySalienceFilter();
        const experienceLearningLoop = new MemoryExperienceLearningLoop();

        // 推理引擎（多线索交叉推理）：BRAIN_MEMORY_INFERENCE_ENABLED 缺省开启
        // 注入依赖：humanLikeMemory（读节点 + 回写）+ associativeGraph（扩散）+ schemaFormation（图式匹配）
        // 关闭时不实例化，MemoryCortex.inferFromClues 始终返回空结果（优雅降级）
        let inferenceEngine: MemoryInferenceEngine | null = null;
        const inferenceEnabled = !["0", "false", "off"].includes(
          (process.env.BRAIN_MEMORY_INFERENCE_ENABLED ?? "").trim().toLowerCase(),
        );
        // 4 项仿人推理能力的环境开关（各自独立，缺省开启）
        const ruleLearningEnabled = !["0", "false", "off"].includes(
          (process.env.BRAIN_MEMORY_RULE_LEARNING_ENABLED ?? "").trim().toLowerCase(),
        );
        const analogyMigrationEnabled = !["0", "false", "off"].includes(
          (process.env.BRAIN_MEMORY_ANALOGY_MIGRATION_ENABLED ?? "").trim().toLowerCase(),
        );
        const emotionModulationEnabled = !["0", "false", "off"].includes(
          (process.env.BRAIN_MEMORY_EMOTION_MODULATION_ENABLED ?? "").trim().toLowerCase(),
        );
        const autoInferenceEnabled = !["0", "false", "off"].includes(
          (process.env.BRAIN_MEMORY_AUTO_INFERENCE_ENABLED ?? "").trim().toLowerCase(),
        );

        if (inferenceEnabled) {
          // 4 项仿人推理能力扩展（各自独立开关，未启用时不实例化）
          const inferenceHumanLike = humanLikeMemory as unknown as import("../brain/memory-cognitive/memory-inference-engine.js").HumanLikeMemoryInferenceLike;
          // LLM 规则归纳器：BRAIN_MEMORY_LLM_INDUCER_ENABLED 缺省开启
          // 仅当 externalChat 可用且 ruleLearning 开启时才实例化（否则降级到纯算法）
          const llmInducerEnabled = !["0", "false", "off"].includes(
            (process.env.BRAIN_MEMORY_LLM_INDUCER_ENABLED ?? "").trim().toLowerCase(),
          );
          const llmInducer =
            llmInducerEnabled && externalChat?.isEnabled()
              ? new LLMRuleInducer({ chatProvider: externalChat })
              : null;
          if (llmInducer) {
            console.log("[BrainCenter] LLM 规则归纳器已启用（学规则用 LLM，推理仍走算法）");
          } else if (llmInducerEnabled) {
            console.log("[BrainCenter] LLM 规则归纳器未启用（chatProvider 不可用，降级到纯算法）");
          }
          const ruleLearner = ruleLearningEnabled
            ? new RuleLearner({ humanLike: inferenceHumanLike, llmInducer })
            : null;
          const analogyMigrator = analogyMigrationEnabled
            ? new AnalogyMigrator()
            : null;
          const emotionModulator = emotionModulationEnabled
            ? new InferenceEmotionModulator()
            : null;

          inferenceEngine = new MemoryInferenceEngine({
            humanLike: inferenceHumanLike,
            associativeGraph,
            schemaFormation: schemaFormation as unknown as import("../brain/memory-cognitive/memory-inference-engine.js").MemorySchemaFormationLike,
            emotionModulator,
            ruleLearner,
            analogyMigrator,
            // 注入 llmInducer：若 ruleLearner 未注入但 llmInducer 已注入，自动创建
            llmInducer,
          });

          // 无意识触发（BrainStemAutoInferer）：注册到 BrainStem 心跳
          // 每 N 次心跳自动跑推理，结果存入缓存（不主动通知用户）
          if (autoInferenceEnabled && brainStemRef) {
            const autoInferer = new BrainStemAutoInferer({
              inferenceEngine,
              humanLike: inferenceHumanLike,
            });
            brainStemRef.onHeartbeat(() => {
              const actors = brainStemRef.getKnownActors();
              for (const actorId of actors) {
                void autoInferer.onHeartbeat(actorId);
              }
            });
            console.log("[BrainStem] 已桥接 BrainStemAutoInferer 到 45s 心跳（无意识推理）");
          }

          // LLM 规则归纳器：启动时自动触发一次 autoLearn（避免冷启动）
          // 仅在 llmInducer 已注入且 chatProvider 可用时触发
          // 失败静默降级（不阻塞服务启动）
          if (llmInducer) {
            const bootstrapActorIds = process.env.BRAIN_MEMORY_LLM_INDUCER_BOOTSTRAP_ACTORS;
            const actorIdsToLearn = bootstrapActorIds
              ? bootstrapActorIds.split(",").map((s) => s.trim()).filter(Boolean)
              : ["default"];
            void (async () => {
              try {
                for (const aid of actorIdsToLearn) {
                  const learned = await inferenceEngine!.autoLearn(aid);
                  if (learned.length > 0) {
                    console.log(
                      `[BrainCenter] 启动时 LLM 规则归纳完成 actor=${aid} 学到 ${learned.length} 条规则`,
                    );
                  }
                }
              } catch (err) {
                console.log(`[BrainCenter] 启动时 LLM 规则归纳失败（忽略，不影响启动）: ${err}`);
              }
            })();
          }
        }

        // 通过 BrainCenter.registerMemoryCognitiveSubmodules 统一注入到 MemoryCortex
        brainCenter.registerMemoryCognitiveSubmodules({
          associativeGraph,
          reconstructionValidator,
          metacognitionBridge,
          forgettingController,
          proceduralAutomation,
          schemaFormation,
          salienceFilter,
          experienceLearningLoop,
          inferenceEngine,
        });

        // 心跳桥接：BrainStem 45s 心跳 → ForgettingController.continuousScore
        // 让遗忘曲线打分跟随脑干节律，无需额外定时器。
        // 回调内遍历 brainStemRef.getKnownActors()，对每个 actor 执行连续打分。
        if (brainStemRef) {
          brainStemRef.onHeartbeat(() => {
            const actors = brainStemRef.getKnownActors();
            for (const actorId of actors) {
              void forgettingController.continuousScore(actorId);
            }
          });
          console.log("[BrainStem] 已桥接 ForgettingController.continuousScore 到 45s 心跳");
        }

        console.log("[BrainCenter] 记忆认知架构升级（Phase 4）：7 个子模块装配完成");
      } catch (err) {
        console.log("[BrainCenter] 记忆认知架构升级装配失败（降级到原行为）:", err);
      }
    }

    // 深度优化：注入 TopicExtractor（LLM 驱动）—— 替代 working-memory-cortex.ts 硬编码主题词列表
    // 让 BrainCenter.cognize 每轮异步调一次轻量 LLM 提取 1-3 个业务领域关键词，
    // 写入工作记忆槽位，使 toSummary 真正反映"在聊什么"。
    // 决策器实现已抽到 brain/decision-maker-factory.ts，支持未来"换大脑"时同步替换。
    if (externalChat?.isEnabled()) {
      const topicExtractor = createDefaultTopicExtractor(externalChat);
      brainCenter.setTopicExtractor(topicExtractor.extract.bind(topicExtractor));
    }

    // 注入到 DecisionHub（让 decidePassive 调用新模块）
    decisionHub.registerWorkingMemory(workingMemoryCortex);
    decisionHub.registerTaskSwitching(taskSwitchingCortex);
    decisionHub.registerContextCortex(contextCortexLocal);
    decisionHub.registerToolPlanning(toolPlanningCortex);
    decisionHub.registerOnlineLearning(onlineLearningCortex);

    console.log("[BrainCenter] Step 7 扩展装配完成（7 个新皮层模块全部接入 BrainCenter + DecisionHub）");
  }

  // ─── Brain Center 启动 + 工具注册（移至此处确保 9 分区均注册后再启动）───
  if (brainEnabled && brainCenter) {
    await brainCenter.start();
    // 预热：启动后立即触发一次 BrainStem 扫描（加速 DMN 首次触发）
    void brainCenter.sweepBrainStem().catch(() => {});
    console.log("[BrainCenter] 预热完成（BrainStem 首次扫描已触发）");

    // 注册 brain.* 工具到 ToolRegistry，并把 schema 暴露给 LLM。
    // brainCenter 为 null 时（brain 未启用），registerBrainTools 不会注册任何 handler，
    // setBrainChatTools 也不会被调用，BRAIN_TOOLS schema 不进入 LLM 可见列表。
    registerBrainTools(toolRegistry, brainCenter, (name) => {
      // 先从 builtin chat tools 找 schema
      const builtin = getBuiltinAgentChatTools().find(
        (t) => t.type === "function" && t.function?.name === name,
      );
      if (builtin) return builtin;
      // 找不到再从 SkillManager 找（self-programming / 社区 skill）
      const sm = toolRegistry.getSkillManager?.();
      if (sm) {
        const manifest = sm.list(true).find((m) => m.name === name);
        if (manifest) {
          const properties: Record<string, unknown> = {};
          const required: string[] = [];
          for (const p of manifest.parameters) {
            properties[p.name] = {
              type: p.type,
              description: p.description ?? "",
              ...(p.enum ? { enum: p.enum } : {}),
              ...(p.default !== undefined ? { default: p.default } : {}),
            };
            if (p.required) required.push(p.name);
          }
          return {
            type: "function" as const,
            function: {
              name: manifest.name,
              description: manifest.description,
              parameters: { type: "object", properties, required },
            },
          };
        }
      }
      return null;
    });
    setBrainChatTools(BRAIN_TOOLS);

    // ─── 把 ToolRegistry 已注册工具名注入 CapabilityCortex ───
    // 让 brain.list_capabilities / introspect 返回的 descriptor.tools 是真实工具名，
    // 而非 loadSeed 时的空数组。必须在所有 registerXxxTools 完成后调用。
    if (capabilityCortex) {
      // 先从 capability-modules 自动派生 domain → toolNames 映射，
      // 新增 capability-module 时不需要改 DOMAIN_TOOL_PATTERNS
      const modules = buildCapabilityModules(capabilityModuleDeps);
      for (const mod of modules) {
        const toolNames = mod.chatTools
          .map((t) => (t.type === "function" && t.function?.name ? t.function.name : ""))
          .filter(Boolean);
        if (toolNames.length > 0) {
          capabilityCortex.registerDomainToolNames(mod.domain, toolNames);
        }
      }
      capabilityCortex.attachToolNames(toolRegistry.list());
    }

    // ─── SubTask 14.2: BodyCenter 注入 BrainCenter（下行通路）───
    // brainCenter.registerBodyGateway 内部会检查 BODY_CENTER_ENABLED，
    // 关闭时（isBodyCenterEnabled=false）会忽略注入，回退纯脑模式。
    if (bodyCenter) {
      brainCenter.registerBodyGateway(bodyCenter.getGateway());
      // DecisionHub 内部 ActionExecutor 也注入 bodyGateway（让 decidePassive 走 BodyGateway）
      // ActionExecutor 在 brainNeuroEnabled 块内创建，此处通过 BrainCenter 间接拿不到，
      // 已通过 brainCenter.registerBodyGateway 在 cognize 阶段 1 调 bodyGateway.sense 覆盖；
      // decidePassive 路径走 BrainCenter.cognize → CognitiveEngine → 主 Agent toolLoop，
      // 主 Agent 的 toolLoop 经 ChatToolExecutionContext.executeTool 直接调 toolRegistry.execute，
      // 而下沉到 BodyModule 的工具已被 registerTools 注册到 toolRegistry，故能间接命中 BodyModule.act。
      // 这里只注入 brainCenter.bodyGateway，让 cognize 能感知 where_am_i + bodyState。
    }
  }

  // ─── Body Center 启动（在 BrainCenter 启动之前或之后均可，无强依赖）───
  if (bodyCenterEnabled && bodyCenter) {
    await bodyCenter.start();
    app.log.info("[BodyCenter] 已启动");
    const snap = bodyCenter.snapshot();
    app.log.info(
      `[BodyCenter] 模块清单: ${snap.modules
        .map((m) => `${m.name}(${m.tools.length}个工具,${m.online ? "在线" : "离线"})`)
        .join(", ")}`,
    );
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

  // ========== 注册自我驱动进化工具（fast/complex 模式都能用）==========
  // 接入自我驱动进化管线：用户说"自我进化"/"扫描新版本"/"升级依赖"时，
  // Agent 调 self_evolution.* 工具触发真实的技术扫描 + LLM 评估 + 沙箱测试
  try {
    const { registerSelfEvolutionTools } = await import("../tools/self-evolution-tools.js");
    const { SelfDrivenEvolutionProposer } = await import("../brain/self-driven-evolution-cortex.js");
    const { UpgradeSandboxRunner } = await import("../services/upgrade-sandbox-runner.js");
    const { ExternalTechScanner } = await import("../services/external-tech-scanner.js");

    // 复用上文 Phase 5 已创建的实例（如果存在），否则新建
    type SelfEvoProposerType = typeof SelfDrivenEvolutionProposer;
    type SelfEvoTechScannerType = typeof ExternalTechScanner;
    type SelfEvoSandboxRunnerType = typeof UpgradeSandboxRunner;
    const globalAny = globalThis as {
      __selfEvoProposer?: InstanceType<SelfEvoProposerType>;
      __selfEvoTechScanner?: InstanceType<SelfEvoTechScannerType>;
      __selfEvoSandboxRunner?: InstanceType<SelfEvoSandboxRunnerType>;
    };

    const selfEvoProposer =
      globalAny.__selfEvoProposer ?? new SelfDrivenEvolutionProposer();
    globalAny.__selfEvoProposer = selfEvoProposer;

    const selfEvoTechScanner =
      globalAny.__selfEvoTechScanner ?? new ExternalTechScanner(externalChat);
    globalAny.__selfEvoTechScanner = selfEvoTechScanner;

    const selfEvoSandboxRunner =
      globalAny.__selfEvoSandboxRunner ?? new UpgradeSandboxRunner(process.cwd());
    globalAny.__selfEvoSandboxRunner = selfEvoSandboxRunner;

    // 同步 LLM 评估器（如果未注册）
    if (externalChat?.isEnabled()) {
      // 尝试访问 llm 字段（已注册则跳过）
      const isLlmRegistered = (selfEvoProposer as unknown as { llm?: unknown }).llm;
      if (!isLlmRegistered) {
        selfEvoProposer.registerLlm({
          async complete(systemPrompt: string, userPrompt: string, opts?: { maxTokens?: number }) {
            let fullContent = "";
            await externalChat.streamCompletion(
              `self-evo-tool-${Date.now()}`,
              { text: userPrompt },
              (delta: string) => { fullContent += delta; },
              undefined,
              {
                systemPromptOverride: systemPrompt,
                ephemeralTurn: true,
                disableThinking: true,
                maxThreadMessages: 0,
              },
            );
            if (opts?.maxTokens && fullContent.length > opts.maxTokens * 4) {
              return fullContent.slice(0, opts.maxTokens * 4);
            }
            return fullContent;
          },
        });
      }
    }

    registerSelfEvolutionTools(toolRegistry, {
      evolutionCortex: evolutionCortex!,
      externalChat,
      techScanner: selfEvoTechScanner,
      proposer: selfEvoProposer,
      sandboxRunner: selfEvoSandboxRunner,
    });
    console.log("[Bootstrap] self-evolution 工具已注册（5 个工具）");
  } catch (err) {
    console.warn("[Bootstrap] 注册 self-evolution 工具失败（不影响主流程）:", err);
  }
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
    bodyCenter,
    reflexArc,
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
    bodyCenter,
    reflexArc,
  };
}
