import type { FastifyInstance } from "fastify";

import { MiniMaxTTSAdapter } from "../../services/voice-dialogue/adapters/minimax-tts-adapter.js";
import {
  MiniMaxRealtimeService,
  MINIMAX_REALTIME_OUTPUT_SAMPLE_RATE,
} from "../../services/voice-dialogue/minimax-realtime-service.js";
import { pcmToWav } from "../../services/voice-duplex/endpoint-detector.js";

/**
 * MiniMax 端到端实时语音对话探针端点。
 *
 * 两种用法（二选一）：
 * - `text`：服务端用 MiniMax TTS 合成一句 16kHz 提问音频，当作"用户开口"喂给 Realtime；
 * - `audioBase64`：客户端录好的 PCM16 单声道 16kHz base64（未来纯语音模式直传麦克风音频）。
 *
 * 服务端跑完一轮端到端对话（ASR + LLM + 语音合成同一条 realtime 连接），
 * 返回 24kHz wav（base64）+ 双向转录 + 延迟指标，客户端用 TtsPlayer 直接播。
 */
export function registerVoiceRealtimeRoutes(app: FastifyInstance): void {
  const realtime = new MiniMaxRealtimeService();

  app.post("/api/voice/realtime/turn", async (request, reply) => {
    const body = (request.body ?? {}) as {
      text?: string;
      audioBase64?: string;
      voiceId?: string;
      instructions?: string;
    };

    if (!realtime.isEnabled()) {
      return reply.code(503).send({ ok: false, error: "MiniMax Realtime 未配置：请设置 MINIMAX_API_KEY" });
    }

    let inputPcm: Buffer;
    if (body.audioBase64) {
      inputPcm = Buffer.from(body.audioBase64, "base64");
      if (inputPcm.length === 0) {
        return reply.code(400).send({ ok: false, error: "audioBase64 为空" });
      }
    } else {
      const text = body.text?.trim();
      if (!text) {
        return reply.code(400).send({ ok: false, error: "text 或 audioBase64 必填其一" });
      }
      // 用 MiniMax TTS 直接合成 wav 16k（同厂同 key），剥 44 字节头得 PCM
      const tts = new MiniMaxTTSAdapter();
      if (!tts.isEnabled()) {
        return reply.code(503).send({ ok: false, error: "MiniMax TTS 未配置：请设置 MINIMAX_API_KEY" });
      }
      try {
        const wav = await tts.synthesize(text, { voiceId: "female-shaonv", sampleRate: 16000, format: "wav" });
        inputPcm = wav.data.subarray(44);
      } catch (e) {
        return reply.code(502).send({
          ok: false,
          error: `提问音频合成失败: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }

    try {
      const turn = await realtime.dialogueTurn(inputPcm, {
        voiceId: body.voiceId,
        instructions: body.instructions,
      });
      return {
        ok: true,
        provider: "minimax-realtime",
        transcript: turn.transcript,
        asrText: turn.asrText,
        format: "wav",
        sampleRate: MINIMAX_REALTIME_OUTPUT_SAMPLE_RATE,
        base64: pcmToWav(turn.audio, MINIMAX_REALTIME_OUTPUT_SAMPLE_RATE).toString("base64"),
        latency: { firstAudioMs: turn.firstAudioMs, totalMs: turn.totalMs },
      };
    } catch (e) {
      return reply.code(502).send({
        ok: false,
        error: `Realtime 对话失败: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  });
}
