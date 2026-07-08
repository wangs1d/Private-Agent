import type { AipService } from "../../aip/aip-service.js";
import type { AgentPairingService } from "../../services/agent-pairing-service.js";
import type { AgentAccountService } from "../../services/agent-account-service.js";
import type { EmailRegistrationService } from "../../services/email-registration-service.js";
import type { AgentRelayService } from "../../services/agent-relay-service.js";
import type { FriendService } from "../../services/friend-service.js";
import type { ScheduleTaskService } from "../../services/schedule-task-service.js";
import type { ScheduleIntentService } from "../../services/schedule-intent-service.js";
import type { InfoHubService } from "../../services/info-hub-service.js";
import type { UpstreamSearchService } from "../../services/upstream-search-service.js";
import type { SkillManager } from "../../skills/index.js";
import type { ToolRegistry } from "../../tools/tool-registry.js";
import type { RealFundsWalletService } from "../../services/real-funds-wallet-service.js";
import type { NotesService } from "../../services/notes-service.js";
import type { ExternalChatProvider } from "../../external-model/types.js";
import type {
  A2aOutsourcingService,
  SkillMetadataValidatorLike,
  SocialFeedService,
  WorldService,
} from "@private-ai-agent/agent-world";
import type { AgentMemorySyncService } from "../../services/agent-memory-sync-service.js";
import type { ComputeQuotaService } from "../../services/compute-quota-service.js";
import type { WeatherPrefsService } from "../../services/weather-prefs-service.js";
import type { WeatherService } from "../../services/weather-service.js";
import type { TtsService } from "../../services/tts-service.js";
import type { VoiceCapabilityService } from "../../services/voice-capability-service.js";
import type { VoiceMessageService } from "../../services/voice-message-service.js";
import type { ImageGenerationService } from "../../services/image-generation-service.js";
import type { FileProcessingService } from "../../services/file-processing-service.js";
import type { VirtualPhoneService } from "../../services/virtual-phone-service.js";
import type { DesktopBridgeCoordinator } from "../../services/desktop-bridge-coordinator.js";
import type { PhoneBridgeCoordinator } from "../../services/phone-bridge-coordinator.js";
import type { WechatClawBindingService } from "../../services/wechat-claw-binding-service.js";
import type { WechatClawBridgeService } from "../../services/wechat-claw-bridge-service.js";
import type { MessageHubService } from "../../services/message-hub-service.js";
import type { MessagePlatformGateway } from "../../services/message-platform-gateway.js";
import type { MessageBridgeService } from "../../services/message-bridge-service.js";
import type { BrowserSessionService } from "../../services/browser-session-service.js";
import type { AgentCore } from "../../services/agent-core.js";
import type { CompanionService } from "../../services/companion-service.js";
import type { WsConnectionRegistry } from "../../services/ws-connection-registry.js";
import type { LifeSignalHubService } from "../../services/life-signal-hub-service.js";
import type { MarketSignalService } from "../../services/market-signal-service.js";
import type { ProactiveLifeRuntimeService } from "../../services/proactive-life-runtime-service.js";
import type { UserPersonalizationService } from "../../services/user-personalization/user-personalization-service.js";
import type { HookBus } from "../../services/hooks/index.js";
import type { WebhookService } from "../../services/webhook/index.js";
import type { MoodInferenceService } from "../../services/mood-inference-service.js";
import type { JarvisHarness } from "../../services/jarvis/index.js";
import type { DevicePairingService } from "../../services/device-pairing-service.js";
import type { DeviceRegistry } from "../../device-bus/device-registry.js";

/** 各 HTTP 子域注册函数共用的依赖 */
export type HttpRouteDeps = {
  toolRegistry: ToolRegistry;
  skillManager: SkillManager;
  skillMetadataValidator: SkillMetadataValidatorLike;
  realFundsWallet: RealFundsWalletService;
  worldService: WorldService;
  a2aOutsourcingService: A2aOutsourcingService;
  socialFeedService: SocialFeedService;
  agentRelayService: AgentRelayService;
  scheduleTaskService: ScheduleTaskService;
  scheduleIntentService: ScheduleIntentService;
  infoHubService: InfoHubService;
  upstreamSearchService: UpstreamSearchService;
  agentPairingService: AgentPairingService;
  aipService: AipService;
  agentAccountService: AgentAccountService;
  emailRegistrationService: EmailRegistrationService;
  computeQuotaService: ComputeQuotaService;
  agentMemorySyncService: AgentMemorySyncService;
  weatherService: WeatherService;
  weatherPrefsService: WeatherPrefsService;
  virtualPhoneService: VirtualPhoneService;
  ttsService: TtsService;
  /** 语音消息落盘服务（voice.send_message 工具 + 用户上传录音共用） */
  voiceMessageService: VoiceMessageService;
  /** 语音能力中枢（ASR 端点 /agent/voice/transcribe 使用）；可选，未注入时该端点返回 503 */
  voiceCapabilityService?: VoiceCapabilityService;
  /** 图像生成服务（image.generate 工具 + 静态拉流共用） */
  imageGenerationService: ImageGenerationService;
  /** 文件/文档处理服务（file.read_text 等工具 + 静态拉流共用） */
  fileProcessingService: FileProcessingService;
  desktopBridgeCoordinator: DesktopBridgeCoordinator;
  phoneBridgeCoordinator: PhoneBridgeCoordinator;
  wechatClawBindingService: WechatClawBindingService;
  wechatClawBridgeService: WechatClawBridgeService;
  messageHubService: MessageHubService;
  messagePlatformGateway: MessagePlatformGateway;
  messageBridgeService: MessageBridgeService;
  browserSessionService: BrowserSessionService;
  friendService: FriendService;
  companionService: CompanionService;
  agentCore?: AgentCore;
  wsConnectionRegistry?: WsConnectionRegistry;
  lifeSignalHubService?: LifeSignalHubService;
  marketSignalService?: MarketSignalService;
  proactiveLifeRuntimeService?: ProactiveLifeRuntimeService;
  userPersonalizationService?: UserPersonalizationService;
  hookBus?: HookBus;
  webhookService?: WebhookService;
  notesService?: NotesService;
  externalChat?: ExternalChatProvider | null;
  moodInferenceService?: MoodInferenceService;
  /** J.A.R.V.I.S. 统一主动消息中枢（可选，老路由可能不传） */
  jarvisHarness?: JarvisHarness;
  /** 终端互连平台：设备配对服务 */
  devicePairingService?: DevicePairingService;
  /** 终端互连平台：设备注册表 */
  deviceRegistry?: DeviceRegistry;
};
