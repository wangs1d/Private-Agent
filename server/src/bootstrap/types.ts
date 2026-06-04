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
import type { VoiceDialogueService } from "../services/voice-dialogue/voice-dialogue-service.js";
import type { IntelligentReminderService } from "../services/intelligent-reminder/intelligent-reminder-service.js";
import type { UserResponsePersistenceService } from "../services/intelligent-reminder/user-response-persistence.js";

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
  virtualPhoneService: VirtualPhoneService;
  friendService: FriendService;
  voiceDialogueService: VoiceDialogueService;
  intelligentReminderService: IntelligentReminderService;
  reminderResponsePersistence: UserResponsePersistenceService;
};

export type SkillMetadataValidator = {
  validateMetadata(metadata: unknown): SkillMetadata;
};
