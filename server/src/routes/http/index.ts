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
  registerGameCenterRoutes,
  registerWorldFreeMarketRoutes,
  registerWorldRoutes,
  registerWorldSocialRoutes,
  registerAgentWorldWebUi,
} from "@private-ai-agent/agent-world";
import { registerGomokuPlayWeb } from "./gomoku-play-web.js";
import { registerChatWeb } from "./chat-web.js";
import { registerMultiAgentMonitorRoutes } from "./multi-agent-monitor.js";
import { registerNightlyMemoryRoutes } from "./nightly-memory.js";
import { registerWechatClawRoutes } from "./wechat-claw.js";
import { registerBrowserSessionRoutes } from "./browser-sessions.js";
import { registerPhoneBridgeRoutes } from "./phone-bridge.js";
import { registerDownloadRoutes } from "./downloads.js";
import { registerLifeSignalRoutes } from "./life-signals.js";
import { registerMarketSignalRoutes } from "./market-signals.js";
import { registerMorningBriefingRoutes } from "./morning-briefing.js";
import { registerUserPreferencesRoutes } from "./user-preferences.js";
import { registerToolSearchAdminRoutes } from "./tool-search-admin.js";
import { registerTranslateRoutes } from "./translate.js";
import { registerNotesRoutes } from "./notes.js";
import { registerWebhookRoutes } from "../../services/webhook/webhook-routes.js";
import type { HttpRouteDeps } from "./types.js";

export type { HttpRouteDeps } from "./types.js";

/**
 * 按子域注册 HTTP 路由：系统、聊天（主域）、钱包、世界、Agent 协作、账号。
 */
export function registerHttpRoutes(app: FastifyInstance, deps: HttpRouteDeps): void {
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
  registerWorldRoutes(app, deps);
  registerWorldFreeMarketRoutes(app, deps);
  registerGameCenterRoutes(app, { gameCenter: deps.gameCenterCoordinator });
  registerWorldSocialRoutes(app, deps);
  registerGomokuPlayWeb(app);
  registerChatWeb(app);
  registerAgentWorldWebUi(app);
  registerAgentCollaborationRoutes(app, deps);
  registerAccountRoutes(app, deps);
  registerFriendRoutes(app, deps);
  registerWechatClawRoutes(app, deps);
  registerBrowserSessionRoutes(app, deps);
  registerPhoneBridgeRoutes(app, { phoneBridgeCoordinator: deps.phoneBridgeCoordinator });
  registerMultiAgentMonitorRoutes(app, { agentCore: deps.agentCore });
  registerNightlyMemoryRoutes(app);
  registerDownloadRoutes(app);
  registerToolSearchAdminRoutes(app);
  registerLifeSignalRoutes(app, deps);
  registerMarketSignalRoutes(app, deps);
  registerTranslateRoutes(app, deps);
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
  registerUserPreferencesRoutes(app);
}
