import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { resolveIpGeolocation } from "../../services/ip-geolocation-service.js";
import { reverseGeocodeCoordinates } from "../../services/reverse-geocode-service.js";

const reverseQuerySchema = z.object({
  latitude: z.coerce.number().finite(),
  longitude: z.coerce.number().finite(),
});

/** 前端 GPS 逆地理：返回中文省市区（不使用 IP）。 */
export function registerGeoRoutes(app: FastifyInstance): void {
  app.get("/geo/reverse", async (request, reply) => {
    const parsed = reverseQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { latitude, longitude } = parsed.data;
    const hit = await reverseGeocodeCoordinates(latitude, longitude);
    if (!hit) {
      return reply.code(502).send({
        ok: false,
        message: "逆地理编码失败，请确认已开启定位且网络可用",
      });
    }
    return { ok: true, location: hit };
  });

  /** 根据请求方连接 IP 解析大致地址（供 App 展示，非 Agent 位置兜底）。 */
  app.get("/geo/ip", async (request) => {
    const forwarded = request.headers["x-forwarded-for"];
    const forwardedIp =
      typeof forwarded === "string"
        ? forwarded.split(",")[0]?.trim()
        : Array.isArray(forwarded)
          ? forwarded[0]?.split(",")[0]?.trim()
          : undefined;
    const clientIp = forwardedIp || request.ip;
    const hit = await resolveIpGeolocation(clientIp);
    if (!hit) {
      return { ok: false, message: "无法根据网络 IP 解析位置" };
    }
    return { ok: true, location: hit };
  });

  app.get("/geo", async () => ({
    domain: "geo",
    endpoints: [
      "/geo/reverse?latitude=&longitude=",
      "/geo/ip",
    ],
    note: "GPS 逆地理 + 网络 IP 粗定位（IP 仅用于 App 展示）",
  }));
}
