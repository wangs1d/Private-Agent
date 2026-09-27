/**
 * MiniMax 真机探针：TTS 合成链 + 端到端 Realtime 语音对话（真实外网 API）。
 *
 * 用法（server 目录下）：
 *   node --import tsx test/tmp-probe/probe-minimax.ts
 *
 * 需要 MINIMAX_API_KEY（server/.env 会自动加载）。产物落在 test/tmp-probe/out/。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import "../../src/config/load-server-env.js";
import { TtsService } from "../../src/services/tts-service.js";
import { MiniMaxRealtimeService, MINIMAX_REALTIME_OUTPUT_SAMPLE_RATE } from "../../src/services/voice-dialogue/minimax-realtime-service.js";
import { pcmToWav } from "../../src/services/voice-duplex/endpoint-detector.js";

async function main(): Promise<void> {
  const outDir = join(fileURLToPath(new URL(".", import.meta.url)), "out");
  mkdirSync(outDir, { recursive: true });

  // 1. TTS 链路：走 TtsService（应命中 MiniMax 优先）
  const tts = new TtsService();
  console.log("[TTS] provider:", tts.getProvider());
  const t0 = Date.now();
  const ttsResult = await tts.synthesizeMp3Buffer("你好，我是通过 MiniMax 语音合成的新声音，很高兴为你播报今天的日程。");
  if (!ttsResult.ok) {
    console.error("[TTS] 失败:", ttsResult.reason);
    process.exit(1);
  }
  console.log(`[TTS] provider=${ttsResult.provider} bytes=${ttsResult.buffer.length} 耗时=${Date.now() - t0}ms`);
  const ttsPath = join(outDir, "tts-minimax.mp3");
  writeFileSync(ttsPath, ttsResult.buffer);

  // 2. 端到端 Realtime：用 MiniMax TTS 合成"用户提问"，喂给 realtime，收语音回复
  const realtime = new MiniMaxRealtimeService();
  if (!realtime.isEnabled()) {
    console.error("[RT] MINIMAX_API_KEY 未配置");
    process.exit(1);
  }
  const question = "我下午三点有个牙医预约，帮我记一下，然后提醒我别喝太多咖啡。";
  const { MiniMaxTTSAdapter } = await import("../../src/services/voice-dialogue/adapters/minimax-tts-adapter.js");
  const wav = await new MiniMaxTTSAdapter().synthesize(question, { sampleRate: 16000, format: "wav" });
  const pcm = wav.data.subarray(44);
  console.log(`[RT] 提问: "${question}"（${(pcm.length / 32000).toFixed(1)}s @16kHz）`);

  const turn = await realtime.dialogueTurn(pcm, {
    voiceId: process.env.MINIMAX_REALTIME_VOICE?.trim() || "female-shaonv",
  });
  console.log(
    `[RT] 回复: "${turn.transcript}"\n[RT] ASR heard: ${turn.asrText ?? "(未下发)"}\n[RT] 首包语音=${turn.firstAudioMs}ms 全回合=${turn.totalMs}ms 音频=${turn.audio.length}bytes (≈${(turn.audio.length / (MINIMAX_REALTIME_OUTPUT_SAMPLE_RATE * 2)).toFixed(1)}s @24kHz)`,
  );
  const replyPath = join(outDir, "realtime-reply-24k.wav");
  writeFileSync(replyPath, pcmToWav(turn.audio, MINIMAX_REALTIME_OUTPUT_SAMPLE_RATE));

  console.log("\n===== 探针产物 =====");
  console.log("TTS mp3 :", ttsPath);
  console.log("RT wav  :", replyPath);
  if (!turn.transcript || turn.audio.length < 1000) {
    console.error("探针判定：FAIL（转录或音频异常）");
    process.exit(1);
  }
  console.log("探针判定：PASS");
}

main().catch((e) => {
  console.error("探针异常:", e);
  process.exit(1);
});
