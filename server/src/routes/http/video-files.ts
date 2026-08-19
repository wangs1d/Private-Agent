import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IncomingMessage } from "node:http";

/**
 * 视频/封面代理路由：
 *   - `GET /agent/media/proxy?url=<编码后的资源地址>&referer=<可选防盗链来源>`
 *
 * 用途：抖音/小红书/B站等平台返回的视频流与封面存在跨域限制与防盗链，
 * 前端无法直接播放/加载。本路由由后端代为请求上游并把流透传给前端：
 *   - 透传 Range 请求头，支持 HTML5 video 拖拽/seek（断点续传）
 *   - 透传 Content-Type / Content-Length / Content-Range / Accept-Ranges
 *   - 客户端断开时主动销毁上游连接，避免资源泄漏
 *   - 仅接受 http/https，防止协议注入
 *
 * 说明：这是通用媒体代理，适配层允许 agent 把从网上获得的任意视频/封面
 * 经由此路由真实地返回到前端播放，不绑定任何单一平台。
 */

/** 浏览器 UA（供上游请求使用，绕过基础反爬） */
const WEB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export function registerVideoProxyRoutes(app: FastifyInstance): void {
  app.get("/agent/media/proxy", async (request, reply) => {
    const query = (request.query ?? {}) as { url?: string; referer?: string };
    const rawUrl = String(query.url ?? "").trim();
    if (!rawUrl) {
      return reply.code(400).send({ ok: false, reason: "url 不能为空" });
    }
    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      return reply.code(400).send({ ok: false, reason: "url 无效" });
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return reply.code(400).send({ ok: false, reason: "仅支持 http/https 协议" });
    }

    const referer = String(query.referer ?? "").trim() || undefined;
    return proxyStream(request, reply, target, referer);
  });
}

/** 透传代理：转发 Range 并回流上游媒体流 */
function proxyStream(
  request: FastifyRequest,
  reply: FastifyReply,
  target: URL,
  referer?: string,
): Promise<void> {
  return new Promise((resolve) => {
    const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
    const headers: Record<string, string> = {
      "user-agent": WEB_USER_AGENT,
      accept: "*/*",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    };
    const range = request.headers.range;
    if (typeof range === "string" && range) headers.range = range;
    if (referer) headers.referer = referer;

    const upReq = transport(
      target,
      { method: "GET", headers },
      (upRes: IncomingMessage) => {
        const status = upRes.statusCode ?? 200;
        if (status >= 400) {
          upRes.resume();
          reply.code(502).send({ ok: false, reason: `上游返回 ${status}` });
          resolve();
          return;
        }
        // 透传媒体相关响应头
        const contentType = upRes.headers["content-type"];
        if (contentType) void reply.header("Content-Type", contentType);
        const contentLength = upRes.headers["content-length"];
        if (contentLength) void reply.header("Content-Length", contentLength);
        const contentRange = upRes.headers["content-range"];
        if (contentRange) void reply.header("Content-Range", contentRange);
        void reply.header("Accept-Ranges", upRes.headers["accept-ranges"] ?? "bytes");
        void reply.header("Cache-Control", "public, max-age=3600");
        // 视频流跨域放行
        void reply.header("Access-Control-Allow-Origin", "*");
        void reply.header("Access-Control-Allow-Headers", "Range");
        void reply.header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");

        void reply.code(status);
        void reply.send(upRes);
        upRes.on("end", () => resolve());
        upRes.on("error", () => resolve());
      },
    );

    // 客户端断开时销毁上游连接
    request.raw.on("close", () => {
      if (!reply.sent) return;
      upReq.destroy();
    });

    // 仅覆盖"建连/响应首包"的等待；进入流式后由 upRes 的 end/error 收尾
    upReq.setTimeout(15_000, () => {
      upReq.destroy(new Error("proxy upstream connect timeout"));
    });

    upReq.on("error", (err: Error) => {
      if (reply.sent) return;
      reply.code(502).send({ ok: false, reason: `代理失败: ${err.message}` });
      resolve();
    });

    upReq.end();
  });
}
