// HTTP 路由：能力就绪状态（渐进式解锁的客户端数据源）
//
// GET /api/capabilities —— 全部能力域的就绪状态 + 实验徽标 + 配置提示。
//   内测期 configSource=byok（用户自备 key，hints 指向 env 变量名）；
//   切 CAPABILITY_CONFIG_MODE=platform 后统一由平台供 key（统一服务付费），
//   客户端卡片自动切换为"已包含"文案，无需发版。
import type { FastifyInstance } from "fastify";

import { listCapabilityStatuses } from "../../services/capability-readiness-service.js";

export function registerCapabilityReadinessRoutes(app: FastifyInstance): void {
  app.get("/api/capabilities", async () => {
    const { configSource, capabilities } = listCapabilityStatuses();
    return {
      ok: true,
      configSource,
      readyCount: capabilities.filter((c) => c.state === "ready").length,
      total: capabilities.length,
      capabilities,
    };
  });
}
