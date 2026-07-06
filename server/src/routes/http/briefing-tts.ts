import type { FastifyInstance } from "fastify";

import type { TtsService } from "../../services/tts-service.js";

/**
 * 早间简报 TTS 合成端点。
 *
 * 用途：客户端 voice 模式或卡片 🔊 按钮点击时，把 narrationText 发到服务端
 * 合成 mp3 base64，再用客户端 TtsPlayer.playFromBase64 播放。
 *
 * 复用现有 TtsService（硅基流动优先，OpenAI 回退），不存档、不落盘。
 */
export function registerBriefingTtsRoutes(
  app: FastifyInstance,
  deps: { ttsService: TtsService },
): void {
  app.post("/api/morning-briefing/tts", async (request, reply) => {
    const body = (request.body ?? {}) as { text?: string };
    const text = body.text?.trim();
    if (!text) {
      return reply.code(400).send({ ok: false, error: "text required" });
    }

    const result = await deps.ttsService.synthesizeMp3Base64(text);
    if (!result.ok) {
      return reply.code(503).send({ ok: false, error: result.reason });
    }

    return {
      ok: true,
      format: result.format,
      base64: result.base64,
      provider: result.provider,
    };
  });
}
