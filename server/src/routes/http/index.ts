import type { FastifyInstance } from "fastify";

import { registerAccountRoutes } from "./accounts.js";
import { registerFinanceIngestRoutes } from "./finance-ingest.js";
import { registerAgentCollaborationRoutes } from "./agent.js";
import { registerBodyRoutes } from "./body.js";
import { registerBrainRoutes } from "./brain.js";
import { registerChatRoutes } from "./chat.js";
import { registerFriendRoutes } from "./friends.js";
import { registerInfoRoutes } from "./info.js";
import { registerUnifiedProtocolRoutes } from "./protocol-unified.js";
import { registerSystemRoutes } from "./system.js";
import { registerScheduleRoutes } from "./schedule.js";
import { registerWalletRoutes } from "./wallet.js";
import { registerWeatherRoutes } from "./weather.js";
import { registerGeoRoutes } from "./geo.js";
import { registerPhoneRoutes } from "./phone.js";
import { registerCompanionRoutes } from "./companion.js";
import {
  registerWorldFreeMarketRoutes,
  registerWorldRoutes,
  registerWorldSocialRoutes,
  registerAgentWorldWebUi,
} from "@private-ai-agent/agent-world";
import { registerChatWeb } from "./chat-web.js";
import { isAgentWorldSocialEnabled } from "../../config/env.js";
import { registerMultiAgentMonitorRoutes } from "./multi-agent-monitor.js";
import { registerNightlyMemoryRoutes } from "./nightly-memory.js";
import { registerWechatClawRoutes } from "./wechat-claw.js";
import { registerMessageHubRoutes } from "./messages.js";
import { registerMessageBridgeRoutes } from "./message-bridge.js";
import { registerChatDataRoutes } from "./chat-data.js";
import { registerBrowserSessionRoutes } from "./browser-sessions.js";
import { registerPhoneBridgeRoutes } from "./phone-bridge.js";
import { registerDownloadRoutes } from "./downloads.js";
import { registerLifeSignalRoutes } from "./life-signals.js";
import { registerMoodInferenceRoutes } from "./mood-inferences.js";
import { registerMarketSignalRoutes } from "./market-signals.js";
import { registerMorningBriefingRoutes } from "./morning-briefing.js";
import { registerBriefingDeliveryRoutes } from "./briefing-delivery.js";
import { registerProactivitySuppressionRoutes } from "./proactivity-suppression.js";
import { registerProactivityPipelineRoutes } from "./proactivity.js";
import { registerBriefingTestRoutes } from "./briefing-test.js";
import { registerBriefingTtsRoutes } from "./briefing-tts.js";
import { registerUserPreferencesRoutes } from "./user-preferences.js";
import { registerToolSearchAdminRoutes } from "./tool-search-admin.js";
import { registerGatewayAdminRoutes } from "./gateway-admin.js";
import { registerToolRegistryRoutes } from "./tool-registry-routes.js";
import { registerNotesRoutes } from "./notes.js";
import { registerDeviceRoutes } from "./device.js";
import { registerVoiceMessageRoutes } from "./voice-messages.js";
import { registerImageFileRoutes } from "./image-files.js";
import { registerVideoProxyRoutes } from "./video-files.js";
import { registerUserFileRoutes } from "./user-files.js";
import { registerTravelMediaRoutes } from "./travel-media.js";
import { registerAgentActivityRoutes } from "./agent-activities.js";
import { registerTravelPlanRoutes } from "./travel-plan.js";
import { registerWebhookRoutes } from "../../services/webhook/webhook-routes.js";
import type { HttpRouteDeps } from "./types.js";

export type { HttpRouteDeps } from "./types.js";

/**
 * 按子域注册 HTTP 路由：系统、聊天（主域）、钱包、世界、Agent 协作、账号。
 */
export function registerHttpRoutes(app: FastifyInstance, deps: HttpRouteDeps): void {
  const worldRouteDeps = deps as unknown as Parameters<typeof registerWorldRoutes>[1];

  registerSystemRoutes(app, deps);
  registerUnifiedProtocolRoutes(app, deps);
  registerInfoRoutes(app, deps);
  registerScheduleRoutes(app, deps);
  registerWeatherRoutes(app, deps);
  registerGeoRoutes(app);
  registerTravelMediaRoutes(app, deps);
  // 行程路由域（编辑/搜索/预订/分享；travelPlanningService 未装配时端点返回 503）
  registerTravelPlanRoutes(app, deps);
  registerPhoneRoutes(app, deps);
  registerCompanionRoutes(app, deps);
  registerChatRoutes(app, deps);
  registerWalletRoutes(app, deps);
  registerWorldRoutes(app, worldRouteDeps);
  // Agent World 社交经济域开关（AGENT_WORLD_SOCIAL_ENABLED，实验性子系统默认关闭）：
  // 关闭时跳过社交经济域路由 mount（自由市场/技能商店/A2A 外包/社交动态），
  // 仅保留 world.ts 的 identity/注册/房间路由；开启后行为与现状一致。
  if (isAgentWorldSocialEnabled()) {
    registerWorldFreeMarketRoutes(app, worldRouteDeps);
    registerWorldSocialRoutes(app, worldRouteDeps);
  }
  registerChatWeb(app);
  registerAgentWorldWebUi(app);
  registerAgentCollaborationRoutes(app, deps);
  registerAccountRoutes(app, deps);
  registerFinanceIngestRoutes(app, deps);
  registerFriendRoutes(app, deps);
  registerVoiceMessageRoutes(app, {
    voiceMessageService: deps.voiceMessageService,
    voiceCapabilityService: deps.voiceCapabilityService,
  });
  registerImageFileRoutes(app, { imageGenerationService: deps.imageGenerationService });
  registerVideoProxyRoutes(app);
  registerUserFileRoutes(app, { fileProcessingService: deps.fileProcessingService });
  registerWechatClawRoutes(app, deps);
  registerMessageBridgeRoutes(app, { messageBridgeService: deps.messageBridgeService });
  registerMessageHubRoutes(app, {
    messageHubService: deps.messageHubService,
    messagePlatformGateway: deps.messagePlatformGateway,
    runtime: deps.runtime!,
  });
  registerChatDataRoutes(app, {
    externalChat: deps.externalChat ?? null,
    agentMemorySyncService: deps.agentMemorySyncService,
  });
  registerBrowserSessionRoutes(app, deps);
  registerPhoneBridgeRoutes(app, { phoneBridgeCoordinator: deps.phoneBridgeCoordinator });
  registerMultiAgentMonitorRoutes(app, {
    runtime: deps.runtime,
    scheduleTaskService: deps.scheduleTaskService,
  });
  registerNightlyMemoryRoutes(app);
  registerDownloadRoutes(app);
  registerToolSearchAdminRoutes(app);
  registerGatewayAdminRoutes(app);
  registerToolRegistryRoutes(app);
  registerLifeSignalRoutes(app, deps);
  if (deps.moodInferenceService) {
    registerMoodInferenceRoutes(app, { moodInferenceService: deps.moodInferenceService });
  }
  registerMarketSignalRoutes(app, deps);
  if (deps.notesService) {
    registerNotesRoutes(app, {
      notesService: deps.notesService,
      scheduleTaskService: deps.scheduleTaskService,
      externalChat: deps.externalChat ?? null,
    });
  }
  if (deps.webhookService && deps.hookBus) {
    registerWebhookRoutes(app, deps.webhookService, deps.hookBus);
  }
  registerMorningBriefingRoutes(app, {
    weatherService: deps.weatherService,
    weatherPrefsService: deps.weatherPrefsService,
    scheduleTaskService: deps.scheduleTaskService,
    notesService: deps.notesService,
  });
  registerBriefingDeliveryRoutes(app);
  if (deps.proactivitySuppressionStore) {
    registerProactivitySuppressionRoutes(app, {
      suppressionStore: deps.proactivitySuppressionStore,
    });
  }
  registerProactivityPipelineRoutes(app, { pipeline: deps.proactivePipeline ?? null, pushService: deps.proactivePushService ?? null });
  registerAgentActivityRoutes(app, { activityStore: deps.agentActivityStore });
  registerBriefingTestRoutes(app, { wsConnectionRegistry: deps.wsConnectionRegistry });
  registerBriefingTtsRoutes(app, { ttsService: deps.ttsService });
  registerUserPreferencesRoutes(app);
  if (deps.devicePairingService && deps.deviceRegistry) {
    registerDeviceRoutes(app, {
      devicePairingService: deps.devicePairingService,
      deviceRegistry: deps.deviceRegistry,
    });
  }
  // Brain Center 路由（brainCenter 为 null 时端点返回 503 not enabled）
  registerBrainRoutes(app, deps);
  // Body Center 路由（bodyCenter 为 null 时端点返回 503 not enabled）
  registerBodyRoutes(app, deps);
}
