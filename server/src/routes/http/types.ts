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
import type {
  A2aOutsourcingService,
  DoudizhuService,
  GameCenterCoordinator,
  GomokuService,
  SkillMetadataValidatorLike,
  SocialFeedService,
  WorldService,
  ZhaJinHuaService,
} from "@private-ai-agent/agent-world";
import type { AgentMemorySyncService } from "../../services/agent-memory-sync-service.js";
import type { ComputeQuotaService } from "../../services/compute-quota-service.js";
import type { WeatherPrefsService } from "../../services/weather-prefs-service.js";
import type { WeatherService } from "../../services/weather-service.js";
import type { TtsService } from "../../services/tts-service.js";
import type { VirtualPhoneService } from "../../services/virtual-phone-service.js";
import type { DesktopBridgeCoordinator } from "../../services/desktop-bridge-coordinator.js";
import type { WechatClawBindingService } from "../../services/wechat-claw-binding-service.js";
import type { WechatClawBridgeService } from "../../services/wechat-claw-bridge-service.js";
import type { BrowserSessionService } from "../../services/browser-session-service.js";
import type { AgentCore } from "../../services/agent-core.js";
import type { CompanionService } from "../../services/companion-service.js";
import type { WsConnectionRegistry } from "../../services/ws-connection-registry.js";
import type { LifeSignalHubService } from "../../services/life-signal-hub-service.js";
import type { MarketSignalService } from "../../services/market-signal-service.js";
import type { ProactiveLifeRuntimeService } from "../../services/proactive-life-runtime-service.js";

/** 各 HTTP 子域注册函数共用的依赖 */
export type HttpRouteDeps = {
  toolRegistry: ToolRegistry;
  skillManager: SkillManager;
  skillMetadataValidator: SkillMetadataValidatorLike;
  realFundsWallet: RealFundsWalletService;
  worldService: WorldService;
  a2aOutsourcingService: A2aOutsourcingService;
  gomokuService: GomokuService;
  doudizhuService: DoudizhuService;
  zhaJinHuaService: ZhaJinHuaService;
  gameCenterCoordinator: GameCenterCoordinator;
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
  desktopBridgeCoordinator: DesktopBridgeCoordinator;
  wechatClawBindingService: WechatClawBindingService;
  wechatClawBridgeService: WechatClawBridgeService;
  browserSessionService: BrowserSessionService;
  friendService: FriendService;
  companionService: CompanionService;
  agentCore?: AgentCore;
  wsConnectionRegistry?: WsConnectionRegistry;
  lifeSignalHubService?: LifeSignalHubService;
  marketSignalService?: MarketSignalService;
  proactiveLifeRuntimeService?: ProactiveLifeRuntimeService;
};
