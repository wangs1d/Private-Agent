import type { FastifyInstance } from "fastify";
import { z } from "zod";
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

  app.get("/geo", async () => ({
    domain: "geo",
    endpoints: ["/geo/reverse?latitude=&longitude="],
    note: "GPS 逆地理（不使用 IP 定位）",
  }));
}
