/**
 * 设备自绑定鉴权 HTTP 路由（ACCESS_AUTH_REQUIRED 开启后的凭证发放入口）。
 *
 *   GET  /api/auth/status       鉴权状态（authRequired + 是否已有绑定设备；免鉴权）
 *   POST /api/auth/pairing-code 签发 6 位绑定码（10 分钟有效，一次性）
 *   POST /api/auth/bind         设备提交绑定码 → 签发设备 token（明文只返回这一次；免鉴权）
 *   POST /api/auth/revoke       吊销自己的设备 token（须 Bearer token）
 *
 * 鉴权规则（pairing-code）：
 *  - ACCESS_AUTH_REQUIRED 关闭 → 允许，用 body.userId（与现状一致）
 *  - 开启且已存在绑定设备 → 须有效 Bearer token，userId 以 token 为准（忽略 body）
 *  - 开启但尚无任何绑定设备（bootstrap 首台）→ 允许，用 body.userId
 *
 * 注意：/api/auth/status 与 /api/auth/bind 永远免鉴权（前者是探测，后者是获取凭证
 * 的唯一入口）；/api/auth/pairing-code 与 /api/auth/revoke 在周界 hook 开启时由
 * hook 统一拦截（无效 token 到不了这里），路由内只做 userId 归属与 bootstrap 放行。
 */
import type { FastifyInstance } from "fastify";

import { isAccessAuthRequired } from "../../config/env.js";
import { AccessAuthService } from "../../services/access-auth-service.js";

export interface AuthRouteDeps {
  accessAuthService: AccessAuthService;
}

/**
 * 周界内始终豁免的 /api/* 路径（精确匹配）：
 *  - /api/auth/status  探测端点（客户端开屏第一步，拿不到 token 前就要调）
 *  - /api/auth/bind    获取凭证的唯一入口（先有 bind 才有 token）
 *  - 健康探针：/api/resource/health-check、/api/memory/health
 *    （/health、/brain/health、/system/upstream-health 不在 /api/ 下，天然不受影响）
 */
const AUTH_EXEMPT_PATHS = new Set([
  "/api/auth/status",
  "/api/auth/bind",
  "/api/resource/health-check",
  "/api/memory/health",
]);

/**
 * /api/* 周界鉴权 hook（仅 ACCESS_AUTH_REQUIRED=1 时挂载；未开启零行为变更）。
 *
 *  - 只拦 `/api/` 前缀路径（/health、/device/*、/ws 等维持现状）；
 *  - token 取自 `Authorization: Bearer <t>` 或 `?token=`；无效/缺失 → 401；
 *  - 身份钉死：验证通过后把 `query.userId` 强制改写为 token 归属用户、删除
 *    `query.sessionId`，并对对象型 body（JSON / urlencoded）同步改写——
 *    下游 resolveActorId 无论读哪个通道都拿不到伪造身份。
 */
export function registerAccessAuthHook(app: FastifyInstance, accessAuthService: AccessAuthService): void {
  if (!isAccessAuthRequired()) return;
  app.addHook("onRequest", async (request, reply) => {
    const path = (request.url || "").split("?")[0];
    if (!path.startsWith("/api/")) return;
    if (AUTH_EXEMPT_PATHS.has(path)) return;
    // bootstrap：尚无任何绑定设备时放行绑定码签发（首台设备引导，见 create-app-services 启动日志）
    if (path === "/api/auth/pairing-code" && !accessAuthService.hasAnyTokens()) return;
    const query = (request.query ?? {}) as { token?: string };
    const token = AccessAuthService.extractToken({
      authorization: request.headers.authorization,
      queryToken: query.token,
    });
    const verified = token ? accessAuthService.verifyToken(token) : null;
    if (!verified) {
      return reply.code(401).send({
        ok: false,
        error: "缺少或无效的访问 token（Authorization: Bearer <token> 或 ?token=，经 /api/auth/bind 获取）",
      });
    }
    // 身份钉死（query 与 body 双通道；resolveActorId 的输入只剩 token 归属）
    const pinnedQuery = request.query as Record<string, unknown>;
    pinnedQuery.userId = verified.userId;
    delete pinnedQuery.sessionId;
    if (
      request.body !== null &&
      typeof request.body === "object" &&
      !Array.isArray(request.body) &&
      !Buffer.isBuffer(request.body)
    ) {
      const pinnedBody = request.body as Record<string, unknown>;
      pinnedBody.userId = verified.userId;
      delete pinnedBody.sessionId;
    }
  });
}

/** 从请求中提取明文 token（Bearer 头优先，其次 ?token= query）。 */
function tokenFromRequest(request: { headers: Record<string, unknown>; query: unknown }): string | null {
  const headers = request.headers ?? {};
  const authRaw = headers["authorization"] ?? headers["Authorization"];
  const authorization = Array.isArray(authRaw) ? String(authRaw[0] ?? "") : authRaw == null ? undefined : String(authRaw);
  const query = (request.query ?? {}) as { token?: string };
  return AccessAuthService.extractToken({ authorization, queryToken: query.token });
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { accessAuthService } = deps;

  /** GET /api/auth/status：探测鉴权是否开启 / 是否已有绑定设备（免鉴权） */
  app.get("/api/auth/status", async () => {
    return {
      ok: true,
      authRequired: isAccessAuthRequired(),
      bound: accessAuthService.hasAnyTokens(),
      userId: null,
    };
  });

  /** POST /api/auth/pairing-code：签发 6 位绑定码 */
  app.post("/api/auth/pairing-code", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const authRequired = isAccessAuthRequired();
    const bootstrap = !accessAuthService.hasAnyTokens();

    let userId = asString(body.userId);
    if (authRequired && !bootstrap) {
      // 已有绑定设备：必须凭有效 token 签发新码，userId 以 token 归属为准
      const token = tokenFromRequest(request);
      const verified = token ? accessAuthService.verifyToken(token) : null;
      if (!verified) {
        return reply.code(401).send({ ok: false, error: "需要有效的设备 token（Authorization: Bearer）" });
      }
      userId = verified.userId;
    }
    if (!userId) {
      return reply.code(400).send({ ok: false, error: "缺少 userId" });
    }
    try {
      const code = accessAuthService.issueBindingCode(userId);
      return {
        ok: true,
        code,
        userId,
        expiresInMs: 10 * 60 * 1000,
        message: "请在 10 分钟内于新设备提交此绑定码（一次性）",
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, error: message });
    }
  });

  /** POST /api/auth/bind：设备提交绑定码换取 token（免鉴权——这是获取凭证的唯一入口） */
  app.post("/api/auth/bind", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const code = asString(body.code);
    const deviceId = asString(body.deviceId);
    const deviceLabel = asString(body.deviceLabel);
    if (!code) return reply.code(400).send({ ok: false, error: "缺少 code" });
    if (!deviceId) return reply.code(400).send({ ok: false, error: "缺少 deviceId" });
    try {
      const { token, userId, record } = await accessAuthService.consumeBindingCode(code, deviceId, deviceLabel);
      return {
        ok: true,
        token,
        userId,
        tokenId: record.tokenId,
        message: "绑定成功：token 请妥善保存，仅本次返回（服务端只存哈希）",
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, error: message });
    }
  });

  /** POST /api/auth/revoke：吊销自己的设备 token（须有效 token，且只能吊自己的） */
  app.post("/api/auth/revoke", async (request, reply) => {
    const token = tokenFromRequest(request);
    const verified = token ? accessAuthService.verifyToken(token) : null;
    if (!verified) {
      return reply.code(401).send({ ok: false, error: "需要有效的设备 token（Authorization: Bearer）" });
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const tokenId = asString(body.tokenId);
    if (!tokenId) return reply.code(400).send({ ok: false, error: "缺少 tokenId" });
    const revoked = await accessAuthService.revokeToken(tokenId, verified.userId);
    if (!revoked) {
      return reply.code(404).send({ ok: false, error: "token 不存在或不属于当前用户" });
    }
    return { ok: true, tokenId, message: "已吊销" };
  });
}
