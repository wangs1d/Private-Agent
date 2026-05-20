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
import { registerPhoneRoutes } from "./phone.js";
import {
  registerWorldDoudizhuRoutes,
  registerWorldGomokuRoutes,
  registerWorldFreeMarketRoutes,
  registerWorldRoutes,
  registerWorldZhajinhuaRoutes,
  registerWorldSocialRoutes,
  registerAgentWorldWebUi,
} from "@private-ai-agent/agent-world";
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
  registerPhoneRoutes(app, deps);
  registerChatRoutes(app, deps);
  registerWalletRoutes(app, deps);
  registerWorldRoutes(app, deps);
  registerWorldFreeMarketRoutes(app, deps);
  registerWorldDoudizhuRoutes(app, deps);
  registerWorldZhajinhuaRoutes(app, deps);
  registerWorldGomokuRoutes(app, deps);
  registerWorldSocialRoutes(app, deps);
  registerAgentWorldWebUi(app);
  registerAgentCollaborationRoutes(app, deps);
  registerAccountRoutes(app, deps);
  registerFriendRoutes(app, deps);
}
