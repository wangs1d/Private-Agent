import type { FastifyInstance } from "fastify";

import { translateScreenRegionBodySchema } from "../../schemas/api.js";
import { getTranslateService } from "../../services/translate-service.js";
import type { HttpRouteDeps } from "./types.js";

/**
 * 翻译相关 HTTP 路由：
 *   POST /api/translate/screen-region   接收一张屏幕区域截图（base64），返回 OCR + 翻译结果
 *   GET  /api/translate/health           检查 PaddleOCR 与翻译服务是否就绪
 */
export function registerTranslateRoutes(app: FastifyInstance, _deps: HttpRouteDeps): void {
  app.post("/api/translate/screen-region", async (request, reply) => {
    const parsed = translateScreenRegionBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const body = parsed.data;
    const svc = getTranslateService();
    const result = await svc.translate({
      imageBase64: body.imageBase64,
      mimeType: body.mimeType,
      sourceLang: body.sourceLang,
      targetLang: body.targetLang,
    });
    const httpCode = result.ok ? 200 : 502;
    return reply.code(httpCode).send(result);
  });

  app.get("/api/translate/health", async (_request, reply) => {
    const svc = getTranslateService();
    let paddleOk = false;
    let paddleError: string | undefined;
    try {
      const base = (svc as unknown as { paddleBaseUrl: string }).paddleBaseUrl;
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 3000);
      try {
        const r = await fetch(`${base.replace(/\/+$/, "")}/health`, {
          method: "GET",
          signal: controller.signal,
        });
        paddleOk = r.ok;
        if (!r.ok) paddleError = `HTTP ${r.status}`;
      } finally {
        clearTimeout(t);
      }
    } catch (e) {
      paddleError = e instanceof Error ? e.message : String(e);
    }
    const s = svc as unknown as {
      translationClient: unknown;
      providerMode: string;
      freeApiBase: string;
    };
    return reply.send({
      ok: paddleOk,
      paddleOcr: { available: paddleOk, error: paddleError },
      translateProvider: {
        mode: s.providerMode,
        llmConfigured: s.translationClient != null,
        freeApi: s.freeApiBase,
      },
    });
  });
}
