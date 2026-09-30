import type { FastifyInstance } from "fastify";

import { resolveActorId } from "../../agent/actor-id.js";

/** 身份解析：显式 actorId 优先（向导/探针），其次 userId/sessionId（正式客户端）。 */
function resolveRouteActor(parts: { actorId?: string; userId?: string; sessionId?: string }): string {
  return parts.actorId?.trim() || resolveActorId({ userId: parts.userId, sessionId: parts.sessionId ?? "" });
}
import { getVoiceprintService } from "../../services/voice/voiceprint-service.js";

/**
 * 声纹 HTTP API（首启向导声纹注册 + 语音对话/控制的说话人闸）。
 *
 *   POST   /api/voice/voiceprint/register  {actorId?, samples:[base64]}  注册/重录声纹
 *   POST   /api/voice/voiceprint/verify    {actorId?, audioBase64}      验证（命中签发 speakerToken）
 *   GET    /api/voice/voiceprint/status?actorId=                        注册状态
 *   DELETE /api/voice/voiceprint?actorId=                                注销声纹
 *
 * 音频：PCM16 单声道（16k 最佳，22.05k/44.1k 自动重采样）或 16bit PCM WAV，
 * base64 编码。register 需 ≥2 段有效语音（静音样本自动跳过）。
 */
export function registerVoiceprintRoutes(app: FastifyInstance): void {
  const service = getVoiceprintService();

  app.post("/api/voice/voiceprint/register", async (request, reply) => {
    const body = request.body as { userId?: string; sessionId?: string; samples?: unknown };
    const actorId = resolveRouteActor(body ?? {});
    if (!actorId) return reply.code(400).send({ ok: false, error: "actorId/userId/sessionId required" });
    if (!Array.isArray(body?.samples) || body.samples.length === 0) {
      return reply.code(400).send({ ok: false, error: "samples required（PCM16 base64 数组）" });
    }
    const buffers: Buffer[] = [];
    for (const item of body.samples) {
      if (typeof item !== "string" || item.length === 0) {
        return reply.code(400).send({ ok: false, error: "samples 内须为 base64 字符串" });
      }
      const buf = Buffer.from(item, "base64");
      if (buf.length < 16000) {
        return reply.code(400).send({ ok: false, error: "样本过短（单段至少约 0.5s）" });
      }
      buffers.push(buf);
    }
    const result = await service.register(actorId, buffers);
    if (!result.ok) return reply.code(400).send(result);
    return result;
  });

  app.post("/api/voice/voiceprint/verify", async (request, reply) => {
    const body = request.body as { userId?: string; sessionId?: string; audioBase64?: string };
    const actorId = resolveRouteActor(body ?? {});
    if (!actorId) return reply.code(400).send({ ok: false, error: "actorId/userId/sessionId required" });
    if (typeof body?.audioBase64 !== "string" || body.audioBase64.length === 0) {
      return reply.code(400).send({ ok: false, error: "audioBase64 required" });
    }
    const audio = Buffer.from(body.audioBase64, "base64");
    if (audio.length < 16000) {
      return reply.code(400).send({ ok: false, error: "音频过短（至少约 0.5s）" });
    }
    const result = await service.verify(actorId, audio);
    if (!result.ok) return reply.code(400).send(result);
    return result;
  });

  app.get("/api/voice/voiceprint/status", async (request) => {
    const query = request.query as { actorId?: string; userId?: string; sessionId?: string };
    const actorId = resolveRouteActor(query);
    if (!actorId) return { ok: true, registered: false, engineReady: await service.isEngineReady() };
    const status = service.status(actorId);
    return { ok: true, ...status, engineReady: await service.isEngineReady() };
  });

  app.delete("/api/voice/voiceprint", async (request, reply) => {
    const query = request.query as { actorId?: string; userId?: string; sessionId?: string };
    const actorId = resolveRouteActor(query);
    if (!actorId) return reply.code(400).send({ ok: false, error: "actorId/userId/sessionId required" });
    const removed = service.unregister(actorId);
    return { ok: true, removed };
  });
}
