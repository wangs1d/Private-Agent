import type { FastifyInstance } from "fastify";

import { registerAccountRoutes } from "./accounts.js";
import { registerAgentCollaborationRoutes } from "./agent.js";
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
import { registerMultiAgentMonitorRoutes } from "./multi-agent-monitor.js";
import { registerNightlyMemoryRoutes } from "./nightly-memory.js";
import { registerWechatClawRoutes } from "./wechat-claw.js";
import { registerMessageHubRoutes } from "./messages.js";
import { registerMessageBridgeRoutes } from "./message-bridge.js";
import { registerBrowserSessionRoutes } from "./browser-sessions.js";
import { registerPhoneBridgeRoutes } from "./phone-bridge.js";
import { registerDownloadRoutes } from "./downloads.js";
import { registerLifeSignalRoutes } from "./life-signals.js";
import { registerMoodInferenceRoutes } from "./mood-inferences.js";
import { registerMarketSignalRoutes } from "./market-signals.js";
import { registerMorningBriefingRoutes } from "./morning-briefing.js";
import { registerBriefingDeliveryRoutes } from "./briefing-delivery.js";
import { registerBriefingTestRoutes } from "./briefing-test.js";
import { registerJarvisRoutes } from "./jarvis.js";
import { registerUserPreferencesRoutes } from "./user-preferences.js";
import { registerToolSearchAdminRoutes } from "./tool-search-admin.js";
import { registerNotesRoutes } from "./notes.js";
import { registerDeviceRoutes } from "./device.js";
import { registerVoiceMessageRoutes } from "./voice-messages.js";
import { registerImageFileRoutes } from "./image-files.js";
import { registerUserFileRoutes } from "./user-files.js";
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
  registerPhoneRoutes(app, deps);
  registerCompanionRoutes(app, deps);
  registerChatRoutes(app, deps);
  registerWalletRoutes(app, deps);
  registerWorldRoutes(app, worldRouteDeps);
  registerWorldFreeMarketRoutes(app, worldRouteDeps);
  registerWorldSocialRoutes(app, worldRouteDeps);
  registerChatWeb(app);
  registerAgentWorldWebUi(app);
  registerAgentCollaborationRoutes(app, deps);
  registerAccountRoutes(app, deps);
  registerFriendRoutes(app, deps);
  registerVoiceMessageRoutes(app, { voiceMessageService: deps.voiceMessageService });
  registerImageFileRoutes(app, { imageGenerationService: deps.imageGenerationService });
  registerUserFileRoutes(app, { fileProcessingService: deps.fileProcessingService });
  registerWechatClawRoutes(app, deps);
  registerMessageBridgeRoutes(app, { messageBridgeService: deps.messageBridgeService });
  registerMessageHubRoutes(app, {
    messageHubService: deps.messageHubService,
    messagePlatformGateway: deps.messagePlatformGateway,
    agentCore: deps.agentCore!,
  });
  registerBrowserSessionRoutes(app, deps);
  registerPhoneBridgeRoutes(app, { phoneBridgeCoordinator: deps.phoneBridgeCoordinator });
  registerMultiAgentMonitorRoutes(app, {
    agentCore: deps.agentCore,
    scheduleTaskService: deps.scheduleTaskService,
  });
  registerNightlyMemoryRoutes(app);
  registerDownloadRoutes(app);
  registerToolSearchAdminRoutes(app);
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
  registerBriefingTestRoutes(app, { wsConnectionRegistry: deps.wsConnectionRegistry });
  registerUserPreferencesRoutes(app);
  if (deps.jarvisHarness) {
    registerJarvisRoutes(app, { jarvisHarness: deps.jarvisHarness });
  }
  if (deps.devicePairingService && deps.deviceRegistry) {
    registerDeviceRoutes(app, {
      devicePairingService: deps.devicePairingService,
      deviceRegistry: deps.deviceRegistry,
    });
  }
}
