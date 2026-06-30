import type { FastifyInstance } from "fastify";

import { translateScreenRegionBodySchema } from "../../schemas/api.js";
import { getTranslateService } from "../../services/translate-service.js";
import {
  trayAddResult,
  trayClear,
  trayClosePanel,
  trayCollapse,
  trayEnterLive,
  trayEnterSelect,
  trayProbe,
  traySetFontSize,
  traySetLanguage,
  traySetShowSource,
  trayShowWindow,
  trayToggleSubtitle,
  resolveTrayControlBaseUrl,
} from "../../services/tray-control-client.js";
import type { HttpRouteDeps } from "./types.js";

/**
 * 翻译相关 HTTP 路由：
 *   POST /api/translate/screen-region   接收一张屏幕区域截图（base64），返回 OCR + 翻译结果
 *   POST /api/translate/text            纯文本翻译（选中文字翻译，跳过 OCR）
 *   GET  /api/translate/health           检查 PaddleOCR 与翻译服务是否就绪
 *   GET  /api/translate/tray-status      探活本地 Python 托盘（127.0.0.1:<port>/health）
 *   POST /api/translate/show-window      唤起翻译主面板
 *   POST /api/translate/enter-live       兼容旧名，等价于 enter-select
 *   POST /api/translate/enter-select     触发框选翻译（隐藏面板 → Live 蒙版）
 *   POST /api/translate/add-result       直接添加一张翻译结果卡片
 *   POST /api/translate/clear            清空所有卡片
 *   POST /api/translate/set-language     切换目标语言
 *   POST /api/translate/set-show-source  切换原文显示
 *   POST /api/translate/set-font-size    切换字号
 *   POST /api/translate/toggle-subtitle  切换字幕窗口
 *   POST /api/translate/collapse         折叠主面板
 *   POST /api/translate/close            关闭主面板
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

  app.post("/api/translate/text", async (request, reply) => {
    const body = (request.body ?? {}) as { text?: string; targetLang?: string; sourceLang?: string };
    const text = (body.text ?? "").toString();
    if (!text.trim()) {
      return reply.code(400).send({ ok: false, error: "missing 'text' in body" });
    }
    const svc = getTranslateService();
    const result = await svc.translateText({
      text,
      targetLang: body.targetLang,
      sourceLang: body.sourceLang,
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

  // ---------- 托盘 IPC（Flutter 点翻译 → 唤起托盘主面板） ----------

  app.get("/api/translate/tray-status", async (_request, reply) => {
    const probe = await trayProbe();
    return reply.send({
      ok: probe.alive,
      tray: probe.alive ? probe.health : undefined,
      controlUrl: resolveTrayControlBaseUrl(),
      error: probe.alive ? undefined : probe.error,
    });
  });

  app.post("/api/translate/show-window", async (request, reply) => {
    const body = (request.body ?? {}) as { hint?: string };
    const r = await trayShowWindow({ hint: body.hint });
    if (r.ok) {
      return reply.send({ ok: true });
    }
    return reply.code(502).send({ ok: false, error: r.error ?? "未知错误" });
  });

  app.post("/api/translate/enter-live", async (_request, reply) => {
    const r = await trayEnterLive();
    if (r.ok) {
      return reply.send({ ok: true });
    }
    return reply.code(502).send({ ok: false, error: r.error ?? "未知错误" });
  });

  app.post("/api/translate/enter-select", async (_request, reply) => {
    const r = await trayEnterSelect();
    if (r.ok) {
      return reply.send({ ok: true });
    }
    return reply.code(502).send({ ok: false, error: r.error ?? "未知错误" });
  });

  app.post("/api/translate/add-result", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const r = await trayAddResult({
      card_id: typeof body.card_id === "string" ? body.card_id : undefined,
      source_text: typeof body.source_text === "string" ? body.source_text : undefined,
      target_text: typeof body.target_text === "string" ? body.target_text : undefined,
      lang_label: typeof body.lang_label === "string" ? body.lang_label : undefined,
      lang: typeof body.lang === "string" ? body.lang : undefined,
      mode: typeof body.mode === "string" ? body.mode : undefined,
    });
    if (r.ok) {
      return reply.send({ ok: true });
    }
    return reply.code(502).send({ ok: false, error: r.error ?? "未知错误" });
  });

  app.post("/api/translate/clear", async (_request, reply) => {
    const r = await trayClear();
    if (r.ok) {
      return reply.send({ ok: true });
    }
    return reply.code(502).send({ ok: false, error: r.error ?? "未知错误" });
  });

  app.post("/api/translate/set-language", async (request, reply) => {
    const body = (request.body ?? {}) as { lang?: string; code?: string };
    const lang = (body.lang ?? body.code ?? "").toString().trim();
    if (!lang) {
      return reply.code(400).send({ ok: false, error: "missing 'lang' in body" });
    }
    const r = await traySetLanguage(lang);
    if (r.ok) {
      return reply.send({ ok: true });
    }
    return reply.code(502).send({ ok: false, error: r.error ?? "未知错误" });
  });

  app.post("/api/translate/set-show-source", async (request, reply) => {
    const body = (request.body ?? {}) as { show?: boolean };
    const r = await traySetShowSource(Boolean(body.show));
    if (r.ok) {
      return reply.send({ ok: true });
    }
    return reply.code(502).send({ ok: false, error: r.error ?? "未知错误" });
  });

  app.post("/api/translate/set-font-size", async (request, reply) => {
    const body = (request.body ?? {}) as { size?: number };
    const size = Number(body.size);
    if (!Number.isInteger(size) || size < 6 || size > 72) {
      return reply.code(400).send({ ok: false, error: "invalid 'size' (expect int 6..72)" });
    }
    const r = await traySetFontSize(size);
    if (r.ok) {
      return reply.send({ ok: true });
    }
    return reply.code(502).send({ ok: false, error: r.error ?? "未知错误" });
  });

  app.post("/api/translate/toggle-subtitle", async (_request, reply) => {
    const r = await trayToggleSubtitle();
    if (r.ok) {
      return reply.send({ ok: true });
    }
    return reply.code(502).send({ ok: false, error: r.error ?? "未知错误" });
  });

  app.post("/api/translate/collapse", async (_request, reply) => {
    const r = await trayCollapse();
    if (r.ok) {
      return reply.send({ ok: true });
    }
    return reply.code(502).send({ ok: false, error: r.error ?? "未知错误" });
  });

  app.post("/api/translate/close", async (_request, reply) => {
    const r = await trayClosePanel();
    if (r.ok) {
      return reply.send({ ok: true });
    }
    return reply.code(502).send({ ok: false, error: r.error ?? "未知错误" });
  });
}
