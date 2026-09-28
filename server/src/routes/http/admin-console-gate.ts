import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * 管理后台网络层门禁：默认仅允许本机回环访问 /admin 页面与全部 /api/admin/*。
 *
 * 密码/会话是应用层的第二道锁，真正的边界在这里——公网请求一律 404（不暴露
 * 后台存在），SSH 隧道（ssh -L 3000:127.0.0.1:3000 <ecs>）出口即回环，正常使用。
 * ADMIN_CONSOLE_ALLOW_REMOTE=1 可显式放行公网（有反代/白名单等替代防护时才用）。
 * 必须在所有 admin 路由注册之前 install（onRequest hook 只对之后注册的路由生效）。
 */

export function isLoopbackRequestIp(ip: string | undefined): boolean {
  if (!ip) return false;
  const normalized = ip.replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export function adminConsoleRemoteAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ADMIN_CONSOLE_ALLOW_REMOTE?.trim() === "1";
}

function isAdminConsoleUrl(rawUrl: string): boolean {
  return rawUrl === "/admin" || rawUrl.startsWith("/admin/") || rawUrl.startsWith("/api/admin/");
}

export function installAdminConsoleLoopbackGate(app: FastifyInstance): void {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const rawUrl = req.raw.url ?? "";
    if (!isAdminConsoleUrl(rawUrl)) return;
    if (adminConsoleRemoteAllowed() || isLoopbackRequestIp(req.ip)) return;
    await reply.code(404).send({ ok: false, message: "Not Found" });
  });
}
