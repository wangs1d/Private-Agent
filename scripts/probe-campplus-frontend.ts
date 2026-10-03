/**
 * CAM++ 中文版前端口径标定：官方样本（speaker1_a/1b 同人，speaker2_a 异人）
 * × 三种 fbank 时间维归一变体（cmvn / mean / none），实证选区分度最优口径。
 *
 * 运行：npx tsx scripts/probe-campplus-frontend.ts（需先下载模型与官方样本）
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { InferenceSession, Tensor } from "onnxruntime-node";

import { computeFbank, pcm16ToFloat, type FbankNormalize } from "../server/src/services/voice/speaker-fbank.js";
import { parseAudioToPcm16 } from "../server/src/services/voice/voiceprint-service.js";

const MODEL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "models", "speaker-campplus-zh");
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "campplus-examples");
const MODEL = join(MODEL_DIR, "campplus_zh_cn_common_200k.onnx");
const WAVS: Array<[string, string]> = [
  ["speaker1_a", "ex-speaker1_a.wav"],
  ["speaker1_b", "ex-speaker1_b.wav"],
  ["speaker2_a", "ex-speaker2_a.wav"],
];

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function main(): Promise<void> {
  const session = await InferenceSession.create(MODEL, { executionProviders: ["cpu"] });
  console.log("inputNames:", session.inputNames, "outputNames:", session.outputNames);

  // 解析三段官方 wav
  const waves = WAVS.map(([name, file]) => {
    const { pcm, sampleRate } = parseAudioToPcm16(readFileSync(join(FIXTURE_DIR, file)));
    return { name, wave: pcm16ToFloat(pcm), sampleRate };
  });

  const variants: FbankNormalize[] = ["cmvn", "mean", "none"];
  for (const variant of variants) {
    const embs = new Map<string, Float32Array>();
    const t0 = Date.now();
    for (const { name, wave, sampleRate } of waves) {
      const fbank = computeFbank(wave, variant);
      // 实测该导出输入布局为 [batch, time, 80]（固定维 80 在 index2）
      const output = await session.run({
        feats: new Tensor("float32", fbank.data, [1, fbank.frames, fbank.dims]),
      });
      const outName = session.outputNames[0]!;
      const data = output[outName]!.data as Float32Array;
      const norm = Math.sqrt(Array.from(data).reduce((s, v) => s + v * v, 0)) || 1;
      const emb = new Float32Array(data.length);
      for (let i = 0; i < data.length; i++) emb[i] = data[i]! / norm;
      embs.set(name, emb);
    }
    const elapsed = Date.now() - t0;
    const [a, b, c] = waves.map((w) => embs.get(w.name)!);
    const same = cosine(a!, b!); // 同人不同句
    const diff = cosine(a!, c!); // 异人
    const margin = same - diff;
    console.log(
      `[${variant.padEnd(4)}] dims=${a!.length} 同人(1a↔1b)=${same.toFixed(4)} 异人(1a↔2a)=${diff.toFixed(4)} margin=${margin.toFixed(4)} embed×3=${elapsed}ms`,
    );
  }
}

void main().catch((err) => {
  console.error("标定失败:", err);
  process.exit(1);
});
