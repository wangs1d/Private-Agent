/**
 * 零主仓库胶水：仅 Fastify + agent-world 内置 deps（Skill/Tool/Audit/WS 注册表）。
 * 运行：`npm run standalone`（在 `agent-world` 目录）或 `npm run standalone --prefix agent-world`（在 monorepo 根目录）。
 *
 * 环境变量：
 * - `AGENT_WORLD_STANDALONE_PORT`：默认 `3333`（勿用主服务 `PORT`，避免与 server/.env 冲突）
 * - `ALLOW_WORLD_HTTP_MUTATIONS=1`：允许 HTTP 写入世界（与主仓库行为一致）
 */
import "dotenv/config";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { exitIfDevPortInUse, isDevListenConflict } from "./port-in-use.js";

import { AuditService } from "../deps/services/audit-service.js";
import { WsConnectionRegistry } from "../deps/services/ws-connection-registry.js";
import { SkillManager } from "../deps/skills/skill-manager.js";
import { SkillValidator } from "../deps/skills/skill-validator.js";
import type { SkillMetadata } from "../deps/skills/types.js";
import { ToolRegistry } from "../deps/tools/tool-registry.js";
import {
  A2aOutsourcingService,
  DoudizhuService,
  GomokuService,
  loadPersistedCommunitySkills,
  reconcileWorldA2aEscrows,
  registerWorldDoudizhuRoutes,
  registerWorldDoudizhuTools,
  registerWorldFreeMarketRoutes,
  registerWorldFreeMarketTools,
  registerWorldGomokuRoutes,
  registerWorldGomokuTools,
  registerWorldOpenRegistryTools,
  registerWorldRoomTools,
  registerWorldRoutes,
  registerWorldSocialRoutes,
  registerWorldSocialTools,
  registerWorldZhajinhuaRoutes,
  registerWorldZhajinhuaTools,
  SocialFeedService,
  restorePurchasedSkillsFromWorldState,
  AgentWorldServerEventType,
  WorldPartitionWsRegistry,
  WorldService,
  type WorldRevisionEvent,
  ZhaJinHuaService,
} from "../index.js";
import { registerStandaloneWebUi } from "./web-ui.js";
import { registerStandaloneWorldWebSocket } from "./ws-lite.js";

function resolveStandalonePort(): number {
  const port = Number(
    process.env.AGENT_WORLD_STANDALONE_PORT ?? process.env.AGENT_WORLD_PORT ?? "3333",
  );
  return Number.isFinite(port) && port > 0 ? port : 3333;
}

const listenPort = resolveStandalonePort();
await exitIfDevPortInUse(listenPort);

const app = Fastify({ logger: true });
await app.register(websocket);
await app.register(multipart, { limits: { fileSize: 12 * 1024 * 1024 } });

const auditService = new AuditService();
const toolRegistry = new ToolRegistry();
const skillManager = new SkillManager();
const skillMetadataValidator = {
  validateMetadata(metadata: unknown) {
    return SkillValidator.validateMetadata(metadata as SkillMetadata);
  },
};

await loadPersistedCommunitySkills(skillManager);
toolRegistry.setSkillManager(skillManager);

const wsConnectionRegistry = new WsConnectionRegistry();
const worldService = new WorldService();
const worldPartitionWsRegistry = new WorldPartitionWsRegistry();
const standalonePairing = { arePaired: (): boolean => false };
worldService.onWorldRevision((ev: WorldRevisionEvent) => {
  worldPartitionWsRegistry.broadcastToPartition(
    ev.partitionId,
    JSON.stringify({
      type: AgentWorldServerEventType.WorldPartitionDelta,
      payload: { partitionId: ev.partitionId, revision: ev.revision, state: ev.state },
    }),
  );
});
const a2aOutsourcingService = new A2aOutsourcingService(worldService);
const doudizhuService = new DoudizhuService(worldService);
doudizhuService.attachWebSocketRegistry(wsConnectionRegistry);
const zhaJinHuaService = new ZhaJinHuaService(worldService);
zhaJinHuaService.attachWebSocketRegistry(wsConnectionRegistry);
const gomokuService = new GomokuService(worldService);
gomokuService.attachWebSocketRegistry(wsConnectionRegistry);
const socialFeedService = new SocialFeedService(worldService);
socialFeedService.attachWebSocketRegistry(wsConnectionRegistry);
registerWorldOpenRegistryTools(toolRegistry, worldService);
registerWorldRoomTools(toolRegistry, worldService);
registerWorldDoudizhuTools(toolRegistry, doudizhuService);
registerWorldZhajinhuaTools(toolRegistry, zhaJinHuaService);
registerWorldGomokuTools(toolRegistry, gomokuService);
registerWorldSocialTools(toolRegistry, socialFeedService);
registerWorldFreeMarketTools(toolRegistry, worldService, a2aOutsourcingService, skillManager);

const routeDeps = {
  worldService,
  a2aOutsourcingService,
  doudizhuService,
  zhaJinHuaService,
  gomokuService,
  socialFeedService,
  skillManager,
  skillMetadataValidator,
};

registerWorldRoutes(app, routeDeps);
registerWorldFreeMarketRoutes(app, routeDeps);
registerWorldDoudizhuRoutes(app, routeDeps);
registerWorldZhajinhuaRoutes(app, routeDeps);
registerWorldGomokuRoutes(app, routeDeps);
registerWorldSocialRoutes(app, routeDeps);
registerStandaloneWorldWebSocket(app, {
  worldService,
  doudizhuService,
  zhaJinHuaService,
  gomokuService,
  socialFeedService,
  wsConnectionRegistry,
  worldPartitionWsRegistry,
  partitionPairing: standalonePairing,
});

app.get("/health", async () => ({ ok: true, service: "agent-world-standalone" }));

app.get("/.well-known/agent-world", async () => ({
  awp: "0.1",
  service: "agent-world-standalone",
  websocketPath: "/ws",
  registration: {
    challengePath: "/world/register/challenge",
    verifyPath: "/world/register/verify",
    statusPath: "/world/register/status",
    agentQuickPath: "/world/register/agent_quick",
  },
  worldPartition: {
    attachClientEvent: "world.partition.attach",
    detachClientEvent: "world.partition.detach",
    snapshotServerEvent: "world.partition.snapshot",
    deltaServerEvent: "world.partition.delta",
    presenceServerEvent: "world.presence.update",
  },
  room: { createTool: "world.room.create", sharedRoomIdPrefix: "wr-" },
}));

registerStandaloneWebUi(app);

await worldService.load();
await socialFeedService.load();
await restorePurchasedSkillsFromWorldState(worldService, skillManager, auditService);
await a2aOutsourcingService.load();
await reconcileWorldA2aEscrows(worldService, a2aOutsourcingService, auditService);
await worldService.flushPersist();
await socialFeedService.flushPersist();

// standalone 对外链接（观战页、牌桌 URL）与监听端口一致
if (!process.env.AGENT_WORLD_PUBLIC_URL?.trim()) {
  process.env.AGENT_WORLD_PUBLIC_URL = `http://127.0.0.1:${listenPort}`;
}
try {
  await app.listen({ port: listenPort, host: "0.0.0.0" });
} catch (err) {
  if (isDevListenConflict(err)) process.exit(0);
  throw err;
}
app.log.info(`agent-world standalone http://0.0.0.0:${listenPort} (WS /ws)`);
