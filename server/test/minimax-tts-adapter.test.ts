import assert from "node:assert/strict";
import test from "node:test";

import {
  MiniMaxTTSAdapter,
  type MiniMaxTTSOptions,
} from "../src/services/voice-dialogue/adapters/minimax-tts-adapter.js";

type FetchCall = { url: string; init: RequestInit };

/** 临时替换全局 fetch，结束后恢复。 */
async function withFetch<T>(
  stub: (call: FetchCall) => Response | Promise<Response>,
  fn: () => Promise<T>,
): Promise<{ result: T; calls: FetchCall[] }> {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const call: FetchCall = { url: String(url), init: init ?? {} };
    calls.push(call);
    return await stub(call);
  }) as typeof fetch;
  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

function okTtsResponse(audioBytes: Buffer): Response {
  return new Response(
    JSON.stringify({
      data: { audio: audioBytes.toString("hex") },
      base_resp: { status_code: 0, status_msg: "success" },
      extra_info: { usage_characters: 10, audio_length: 1000 },
    }),
    { status: 200 },
  );
}

const ENV = {
  MINIMAX_API_KEY: "test-key",
  MINIMAX_TTS_MODEL: "speech-2.5-hd-preview",
  MINIMAX_TTS_VOICE: "female-yujie",
  MINIMAX_TTS_SPEED: "1.1",
} as unknown as NodeJS.ProcessEnv;

test("MiniMax TTS：请求形状与 hex 音频解码", async () => {
  const adapter = new MiniMaxTTSAdapter(ENV);
  assert.equal(adapter.isEnabled(), true);

  const payload = Buffer.from("fake-mp3-bytes", "utf8");
  const { result, calls } = await withFetch(() => okTtsResponse(payload), () =>
    adapter.synthesize("你好，世界。"),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.minimaxi.com/v1/t2a_v2");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer test-key");
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.model, "speech-2.5-hd-preview");
  assert.equal(body.stream, false);
  assert.equal(body.text, "你好，世界。");
  assert.equal(body.voice_setting.voice_id, "female-yujie");
  assert.equal(body.voice_setting.speed, 1.1);
  assert.equal(body.audio_setting.sample_rate, 32000);
  assert.equal(body.audio_setting.format, "mp3");
  assert.equal(body.audio_setting.channel, 1);

  assert.ok(Buffer.isBuffer(result.data));
  assert.equal(result.data.toString("utf8"), "fake-mp3-bytes");
  assert.equal(result.format, "mp3");
  assert.equal(result.sampleRate, 32000);
});

test("MiniMax TTS：voice/speed/pitch/volume 选项透传，speed 越界收拢", async () => {
  const adapter = new MiniMaxTTSAdapter(ENV);
  const options: MiniMaxTTSOptions = { voiceId: "presenter_female", speed: 9, pitch: 30, volume: 0.5 };
  const { calls } = await withFetch(() => okTtsResponse(Buffer.from([1])), () =>
    adapter.synthesize("测试", options),
  );
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.voice_setting.voice_id, "presenter_female");
  assert.equal(body.voice_setting.speed, 2); // clamp 到上限
  assert.equal(body.voice_setting.pitch, 12); // clamp 到上限
  assert.equal(body.voice_setting.vol, 0.5);
});

test("MiniMax TTS：wav/采样率直取（realtime 提问链路）", async () => {
  const adapter = new MiniMaxTTSAdapter(ENV);
  const { result, calls } = await withFetch(() => okTtsResponse(Buffer.from([7, 8])), () =>
    adapter.synthesize("提问", { sampleRate: 16000, format: "wav" }),
  );
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.audio_setting.sample_rate, 16000);
  assert.equal(body.audio_setting.format, "wav");
  assert.equal(result.format, "wav");
  assert.equal(result.sampleRate, 16000);
});

test("MiniMax TTS：base_resp 业务失败要抛错（HTTP 仍 200）", async () => {
  const adapter = new MiniMaxTTSAdapter(ENV);
  await assert.rejects(
    withFetch(
      () =>
        new Response(
          JSON.stringify({ base_resp: { status_code: 1004, status_msg: "invalid api key" } }),
          { status: 200 },
        ),
      () => adapter.synthesize("测试"),
    ),
    /invalid api key/,
  );
});

test("MiniMax TTS：HTTP 5xx 抛错", async () => {
  const adapter = new MiniMaxTTSAdapter(ENV);
  await assert.rejects(
    withFetch(() => new Response("server boom", { status: 500 }), () => adapter.synthesize("测试")),
    /\(500\)/,
  );
});

test("MiniMax TTS：空文本与超长文本裁剪", async () => {
  const adapter = new MiniMaxTTSAdapter(ENV);
  await assert.rejects(adapter.synthesize("   "), /不能为空/);

  const long = "啊".repeat(9500);
  const { calls } = await withFetch(() => okTtsResponse(Buffer.from([1])), () => adapter.synthesize(long));
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.text.length, 9000);
  assert.ok(body.text.endsWith("…"));
});

test("MiniMax TTS：未配置 key 时禁用并拒绝合成", async () => {
  const adapter = new MiniMaxTTSAdapter({} as NodeJS.ProcessEnv);
  assert.equal(adapter.isEnabled(), false);
  await assert.rejects(adapter.synthesize("测试"), /MINIMAX_API_KEY/);
});

test("MiniMax TTS：自定义 baseUrl 去尾斜杠", async () => {
  const adapter = new MiniMaxTTSAdapter({
    MINIMAX_API_KEY: "k",
    MINIMAX_BASE_URL: "https://api.minimax.io/",
  } as unknown as NodeJS.ProcessEnv);
  const { calls } = await withFetch(() => okTtsResponse(Buffer.from([1])), () => adapter.synthesize("hi"));
  assert.equal(calls[0].url, "https://api.minimax.io/v1/t2a_v2");
});

test("MiniMax TTS：音色清单", async () => {
  const adapter = new MiniMaxTTSAdapter(ENV);
  const voices = await adapter.getAvailableVoices?.();
  assert.ok(voices && voices.length >= 3);
  assert.ok(voices.some((v) => v.id === "female-shaonv"));
});
