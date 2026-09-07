import assert from "node:assert/strict";
import test from "node:test";

import { EndpointDetector, pcmToWav } from "../src/services/voice-duplex/endpoint-detector.js";

const SAMPLE_RATE = 16000;

/** 生成一块指定 RMS 能量的 100ms 16-bit PCM。 */
function makeChunk(rms: number, ms = 100): Buffer {
  const samples = Math.floor((SAMPLE_RATE * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(rms * Math.sin((i / SAMPLE_RATE) * 2 * Math.PI * 440)), i * 2);
  }
  return buf;
}

test("端点检测：说话后静音达到阈值判端点", () => {
  const detector = new EndpointDetector({ speechThreshold: 350, silenceMs: 700 });
  // 500ms 说话
  for (let i = 0; i < 5; i++) {
    assert.equal(detector.feed(makeChunk(2000), SAMPLE_RATE), "speaking");
  }
  // 400ms 静音：还未到 700ms
  for (let i = 0; i < 4; i++) {
    assert.equal(detector.feed(makeChunk(5), SAMPLE_RATE), "speaking");
  }
  // 再 300ms 静音（第 3 块时累计 700ms ≥ 700ms）→ endpoint
  assert.equal(detector.feed(makeChunk(5), SAMPLE_RATE), "speaking");
  assert.equal(detector.feed(makeChunk(5), SAMPLE_RATE), "speaking");
  assert.equal(detector.feed(makeChunk(5), SAMPLE_RATE), "endpoint");
});

test("端点检测：持续无人说话保持 idle，reset 可复用", () => {
  const detector = new EndpointDetector({ speechThreshold: 350 });
  assert.equal(detector.feed(makeChunk(5), SAMPLE_RATE), "idle");
  assert.equal(detector.hasSpeech, false);
  detector.reset();
  assert.equal(detector.feed(makeChunk(2000), SAMPLE_RATE), "speaking");
});

test("端点检测：单句超时强制端点", () => {
  const detector = new EndpointDetector({ speechThreshold: 350, maxUtteranceMs: 500 });
  let event: string = "idle";
  for (let i = 0; i < 10; i++) {
    event = detector.feed(makeChunk(2000), SAMPLE_RATE);
    if (event === "endpoint") break;
  }
  assert.equal(event, "endpoint");
});

test("pcmToWav：44 字节头 + 正确采样率与长度", () => {
  const pcm = Buffer.alloc(3200);
  const wav = pcmToWav(pcm, SAMPLE_RATE);
  assert.equal(wav.length, 44 + 3200);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt32LE(24), SAMPLE_RATE);
  assert.equal(wav.readUInt32LE(40), 3200);
});
