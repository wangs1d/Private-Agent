import type { FastifyInstance } from "fastify";
import type { AgentCore } from "../services/agent-core.js";
import type { AgentAccountService } from "../services/agent-account-service.js";
import type { AipService } from "../aip/aip-service.js";
import type { AgentPairingService } from "../services/agent-pairing-service.js";
import type { AgentRelayService } from "../services/agent-relay-service.js";
import type { AuditService } from "../services/audit-service.js";
import type { EmailRegistrationService } from "../services/email-registration-service.js";
import type { FriendService } from "../services/friend-service.js";
import type { InfoHubService } from "../services/info-hub-service.js";
import type { RealFundsWalletService } from "../services/real-funds-wallet-service.js";
import type { SessionService } from "../services/session-service.js";
import type { ScheduleTaskService } from "../services/schedule-task-service.js";
import type { ScheduleIntentService } from "../services/schedule-intent-service.js";
import type { WsConnectionRegistry } from "../services/ws-connection-registry.js";
import type { SkillManager } from "../skills/index.js";
import type { SkillMetadata } from "../skills/types.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type {
  A2aOutsourcingService,
  SkillMetadataValidatorLike,
  SocialFeedService,
  WorldService,
} from "@private-ai-agent/agent-world";
import type { AgentMemorySyncService } from "../services/agent-memory-sync-service.js";
import type { ComputeQuotaService } from "../services/compute-quota-service.js";
import type { UnifiedIdempotencyService } from "../services/unified-idempotency-service.js";
import type { WeatherPrefsService } from "../services/weather-prefs-service.js";
import type { WeatherService } from "../services/weather-service.js";
import type { TtsService } from "../services/tts-service.js";
import type { VirtualPhoneService } from "../services/virtual-phone-service.js";
import type { VoiceCapabilityService } from "../services/voice-capability-service.js";
import type { VoiceMessageService } from "../services/voice-message-service.js";
import type { ImageGenerationService } from "../services/image-generation-service.js";
import type { FileProcessingService } from "../services/file-processing-service.js";
import type { EmailSmsService } from "../services/email-sms-service.js";
import type { MediaMusicService } from "../services/media-music-service.js";
import type { HealthFitnessService } from "../services/health-fitness-service.js";
import type { FinanceDeepService } from "../services/finance-deep-service.js";
import type { SocialOutreachService } from "../services/social-outreach-service.js";
import type { CodeSandboxService } from "../services/code-sandbox-service.js";
import type { VoiceDialogueService } from "../services/voice-dialogue/voice-dialogue-service.js";
import type { IntelligentReminderService } from "../services/intelligent-reminder/intelligent-reminder-service.js";
import type { UserResponsePersistenceService } from "../services/intelligent-reminder/user-response-persistence.js";
import type { McpClientService } from "../services/mcp-client-service.js";
import type { LifeSignalHubService } from "../services/life-signal-hub-service.js";
import type { MarketSignalService } from "../services/market-signal-service.js";
import type { ProactiveLifeRuntimeService } from "../services/proactive-life-runtime-service.js";
import type { HookBus } from "../services/hooks/index.js";
import type { WebhookService } from "../services/webhook/index.js";
import type { NotesService } from "../services/notes-service.js";
import type { MorningBriefingScheduler } from "../services/morning-briefing-scheduler.js";
import type { ExternalChatProvider } from "../external-model/types.js";
import type { MoodInferenceService } from "../services/mood-inference-service.js";
import type { MessageHubService } from "../services/message-hub-service.js";
import type { MessagePlatformGateway } from "../services/message-platform-gateway.js";
import type { MessageBridgeService } from "../services/message-bridge-service.js";
import type { DeviceRegistry } from "../device-bus/device-registry.js";
import type { DevicePairingService } from "../services/device-pairing-service.js";
import type { BrainCenter } from "../brain/index.js";
import type { BodyCenter } from "../body/index.js";
import type { ReflexArc } from "../body/reflex-arc.js";

export type AppServices = {
  app: FastifyInstance;
  sessionService: SessionService;
  scheduleTaskService: ScheduleTaskService;
  scheduleIntentService: ScheduleIntentService;
  infoHubService: InfoHubService;
  realFundsWallet: RealFundsWalletService;
  auditService: AuditService;
  toolRegistry: ToolRegistry;
  skillManager: SkillManager;
  skillMetadataValidator: SkillMetadataValidatorLike;
  agentRelayService: AgentRelayService;
  wsConnectionRegistry: WsConnectionRegistry;
  agentPairingService: AgentPairingService;
  aipService: AipService;
  agentAccountService: AgentAccountService;
  emailRegistrationService: EmailRegistrationService;
  agentCore: AgentCore;
  worldService: WorldService;
  a2aOutsourcingService: A2aOutsourcingService;
  socialFeedService: SocialFeedService;
  computeQuotaService: ComputeQuotaService;
  agentMemorySyncService: AgentMemorySyncService;
  unifiedIdempotencyService: UnifiedIdempotencyService;
  weatherService: WeatherService;
  weatherPrefsService: WeatherPrefsService;
  ttsService: TtsService;
  /** Agent 底层语音能力中枢（TTS + ASR + WS 推送，Agent 自调度入口） */
  voiceCapabilityService: VoiceCapabilityService;
  /** 语音消息落盘服务（voice.send_message 工具 + 用户上传录音共用） */
  voiceMessageService: VoiceMessageService;
  /** 图像生成服务（image.generate 工具 + 静态拉流共用） */
  imageGenerationService: ImageGenerationService;
  /** 文件/文档处理服务（file.read_text / file.write_text / file.parse_pdf / file.parse_office / file.export_format） */
  fileProcessingService: FileProcessingService;
  /** 邮件/短信主动发送服务（email.send / sms.send，凭证从环境变量读取） */
  emailSmsService: EmailSmsService;
  /** 媒体音乐服务（media.search / media.play / pause / resume / stop / now_playing） */
  mediaMusicService: MediaMusicService;
  /** 健康/运动数据服务（health.log_metric / get_metrics / get_summary / set_goal / get_goals / import_data） */
  healthFitnessService: HealthFitnessService;
  /** 财务深度服务（finance.import_transactions / analyze_spending / set_budget / get_budget_status / reconcile / categorize / export_report） */
  financeDeepService: FinanceDeepService;
  /** 社交主动出击服务（social.post / comment / repost / like / get_feed / search_posts，外部真实平台） */
  socialOutreachService: SocialOutreachService;
  /** 代码执行沙盒服务（code.run / list_files / read_file / write_file，python/node 子进程） */
  codeSandboxService: CodeSandboxService;
  virtualPhoneService: VirtualPhoneService;
  friendService: FriendService;
  messageHubService: MessageHubService;
  messagePlatformGateway: MessagePlatformGateway;
  messageBridgeService: MessageBridgeService;
  voiceDialogueService: VoiceDialogueService;
  intelligentReminderService: IntelligentReminderService;
  reminderResponsePersistence: UserResponsePersistenceService;
  mcpClientService: McpClientService;
  lifeSignalHubService: LifeSignalHubService;
  marketSignalService: MarketSignalService;
  proactiveLifeRuntimeService: ProactiveLifeRuntimeService;
  /** 全局 hook 总线 — 业务代码 emit hook 的唯一入口，WebhookService 内部订阅它 */
  hookBus: HookBus;
  webhookService: WebhookService;
  notesService: NotesService;
  morningBriefingScheduler: MorningBriefingScheduler;
  externalChat: ExternalChatProvider | null;
  moodInferenceService: MoodInferenceService;
  /** 终端互连平台 —— 设备注册表（多设备并存，按 deviceId 路由） */
  deviceRegistry: DeviceRegistry;
  /** 终端互连平台 —— 设备配对服务（生成配对码 + 持久化 owner↔device 绑定） */
  devicePairingService: DevicePairingService;
  /** Agent Brain Center —— 大脑中心外观（BRAIN_CENTER_ENABLED=0 时为 null） */
  brainCenter: BrainCenter | null;
  /** Agent Body Center —— 身体中心外观（BODY_CENTER_ENABLED=0 时为 null） */
  bodyCenter: BodyCenter | null;
  /** Agent ReflexArc —— 反射弧硬安全门（BODY_CENTER_ENABLED=0 时为 null） */
  reflexArc: ReflexArc | null;
};

export type SkillMetadataValidator = {
  validateMetadata(metadata: unknown): SkillMetadata;
};
