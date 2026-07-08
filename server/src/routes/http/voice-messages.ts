import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Multipart } from "@fastify/multipart";

import { resolveActorId } from "../../agent/actor-id.js";
import type { VoiceCapabilityService } from "../../services/voice-capability-service.js";
import type { VoiceMessageService } from "../../services/voice-message-service.js";

/** `@fastify/multipart` 注册后 `request.parts()` 可用。 */
type MultipartRequest = FastifyRequest & {
  parts: () => AsyncIterable<Multipart>;
};

/**
 * 语音消息 HTTP 路由：
 *   - `POST /agent/voice/messages/upload`        用户端上传录音（multipart/form-data）
 *   - `GET  /agent/voice/messages/:actorId/:fileName`  静态拉流（agent / 用户均可读）
 *   - `POST /agent/voice/transcribe`             ASR 专用端点：上传音频后立刻转写
 *                                                （不走 chat pipeline，仅返回转写文本）
 *
 * 设计要点：
 *   - 与 socialFeedService 解耦（独立目录 `data/voice-messages/`）。
 *   - 文件名严格校验（UUID.mp3），防穿越。
 *   - 上传走 multipart 优先（节省 33% 体积），JSON Base64 为兜底。
 */
export function registerVoiceMessageRoutes(
  app: FastifyInstance,
  deps: {
    voiceMessageService: VoiceMessageService;
    /** 语音能力中枢（用于 ASR 端点）；未注入时 transcribe 返回 not_configured。 */
    voiceCapabilityService?: VoiceCapabilityService;
  },
): void {
  const { voiceMessageService, voiceCapabilityService } = deps;

  /**
   * 用户端上传录音：multipart/form-data
   * 字段：sessionId / userId（二选一） + durationMs（可选）
   * 文件字段：file（mp3）
   * 返回：{ ok, mediaUrl, msgId, durationMs }
   */
  app.post("/agent/voice/messages/upload", async (request, reply) => {
    const req = request as MultipartRequest;
    if (typeof req.parts !== "function") {
      return reply.code(400).send({ ok: false, reason: "MULTIPART_NOT_REGISTERED" });
    }

    let sessionId = "";
    let userId = "";
    let durationMsStr = "";
    let uploadBuf: Buffer | null = null;
    let uploadMime = "audio/mpeg";

    try {
      for await (const part of req.parts()) {
        if (part.type === "file") {
          if (uploadBuf === null) {
            uploadBuf = await part.toBuffer();
            uploadMime = part.mimetype || "audio/mpeg";
          }
        } else {
          const value = String(part.value ?? "");
          if (part.fieldname === "sessionId") sessionId = value;
          else if (part.fieldname === "userId") userId = value;
          else if (part.fieldname === "durationMs") durationMsStr = value;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, reason: "MULTIPART_PARSE_FAILED", message: msg });
    }

    if (!uploadBuf || uploadBuf.length === 0) {
      return reply.code(400).send({ ok: false, reason: "MISSING_FILE" });
    }
    const actorId = resolveActorId({ userId: userId || undefined, sessionId: sessionId || "" });
    if (!actorId) {
      return reply.code(400).send({ ok: false, reason: "MISSING_ACTOR" });
    }
    if (!uploadMime.toLowerCase().includes("audio") && !uploadMime.toLowerCase().includes("mpeg")) {
      return reply.code(400).send({ ok: false, reason: "NOT_AUDIO" });
    }

    const durationMs = durationMsStr ? Number.parseInt(durationMsStr, 10) : undefined;
    const result = await voiceMessageService.storeUploaded(uploadBuf, actorId, durationMs);
    if (!result.ok) {
      return reply.code(400).send(result);
    }
    return { ok: true, mediaUrl: result.mediaUrl, msgId: result.msgId, durationMs: result.durationMs };
  });

  /**
   * 静态拉流：`GET /agent/voice/messages/:actorId/:fileName`
   * 支持范围请求（HTTP Range）由 fastify-sendfile 或手动处理；当前简单 send(stream)。
   */
  app.get<{ Params: { actorId: string; fileName: string } }>(
    "/agent/voice/messages/:actorId/:fileName",
    async (request, reply) => {
      const { actorId, fileName } = request.params;
      const fullPath = voiceMessageService.resolveFilePath(actorId, fileName);
      if (!fullPath) {
        return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });
      }
      void reply.header("Content-Type", "audio/mpeg");
      void reply.header("Cache-Control", "public, max-age=86400");
      void reply.header("Accept-Ranges", "bytes");
      return reply.send(createReadStream(fullPath));
    },
  );

  /**
   * ASR 专用端点：`POST /agent/voice/transcribe`
   *
   * 用途：客户端「测试 ASR」按钮走这里 —— 上传一段录音，立即拿到转写文本。
   * 与 `chat.user_message` 的 audio 链路区别：
   *   - 本端点**不**进入 chat pipeline、**不**触发 LLM、**不**创建消息气泡
   *   - 仅做一次转写并返回 `{ok, text, error}`，方便调试 ASR 能力
   *
   * 入参（multipart/form-data）：
   *   - sessionId 或 userId（二选一）—— 决定 actorId 与文件归属目录
   *   - file 字段：音频文件（任意容器，m4a / wav / mp3 都行；服务端按 mp3 转发给 ASR）
   *   - language（可选，默认 "zh"）
   *
   * 出参：`{ ok: true, text, language, audioBytes }` 或 `{ ok: false, error }`
   */
  app.post("/agent/voice/transcribe", async (request, reply) => {
    if (!voiceCapabilityService) {
      return reply.code(503).send({
        ok: false,
        error: "VoiceCapabilityService 未注入，ASR 不可用",
      });
    }
    const req = request as MultipartRequest;
    if (typeof req.parts !== "function") {
      return reply.code(400).send({ ok: false, reason: "MULTIPART_NOT_REGISTERED" });
    }

    let sessionId = "";
    let userId = "";
    let language = "zh";
    let uploadBuf: Buffer | null = null;

    try {
      for await (const part of req.parts()) {
        if (part.type === "file") {
          if (uploadBuf === null) {
            uploadBuf = await part.toBuffer();
          }
        } else {
          const value = String(part.value ?? "");
          if (part.fieldname === "sessionId") sessionId = value;
          else if (part.fieldname === "userId") userId = value;
          else if (part.fieldname === "language") language = value.trim() || "zh";
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, reason: "MULTIPART_PARSE_FAILED", message: msg });
    }

    if (!uploadBuf || uploadBuf.length === 0) {
      return reply.code(400).send({ ok: false, reason: "MISSING_FILE" });
    }
    const actorId = resolveActorId({ userId: userId || undefined, sessionId: sessionId || "" });
    if (!actorId) {
      return reply.code(400).send({ ok: false, reason: "MISSING_ACTOR" });
    }

    try {
      const result = await voiceCapabilityService.transcribe({
        audio: { data: Buffer.from(uploadBuf), format: "mp3" },
        language,
      });
      if (!result.ok || !result.text) {
        return reply.code(500).send({
          ok: false,
          error: result.error ?? "识别结果为空",
        });
      }
      return {
        ok: true,
        text: result.text.trim(),
        language: result.language ?? language,
        audioBytes: uploadBuf.length,
        actorId,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(500).send({ ok: false, error: `ASR 失败：${msg}` });
    }
  });
}
