/**
 * Kaldi 风格 80 维 log-mel fbank 特征（说话人 embedding 前端）。
 *
 * 口径对齐 torchaudio.compliance.kaldi.fbank 在 pyannote/wespeaker 管线中的
 * 用法：25ms 窗 / 10ms 移 / 80 mel / povey 窗 / 预加重 0.97 / 去 DC / 自然对数，
 * 之后做逐句 CMVN（时间维均值方差归一）——CMVN 后常数尺度因子被完全抵消，
 * 因此 FFT/滤波器组的绝对能量标量约定不影响最终 embedding。
 *
 * 精度取舍：与 torchaudio 存在窗函数与滤波器组实现的微小差异，但注册与
 * 验证共用本实现，系统内一致；不追求与 pyannote 侧 embedding 互认。
 */

const WINDOW_MS = 25;
const SHIFT_MS = 10;
const NUM_MEL_BINS = 80;
const PREEMPHASIS = 0.97;
const FFT_SIZE = 512; // ≥400（25ms@16k）的最小 2 的幂
const LOW_FREQ = 20;
const LOG_FLOOR = 1e-10;

export type FbankResult = {
  /** [frames][NUM_MEL_BINS] 行主序 */
  data: Float32Array;
  frames: number;
  dims: number;
  sampleRate: number;
};

/** 任意采样率 → 16k 单声道（线性插值；说话人 embedding 对此足够） */
export function resampleTo16k(input: Float32Array, sampleRate: number): Float32Array {
  if (sampleRate === 16000) return input;
  const ratio = sampleRate / 16000;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = input[i0]! * (1 - frac) + input[i1]! * frac;
  }
  return out;
}

/** PCM16 Int16（单声道）→ [-1, 1] float */
export function pcm16ToFloat(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i]! / 32768;
  return out;
}

/** 迭代 radix-2 FFT（原地，实部虚部交错数组） */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k]!;
        const uIm = im[i + k]!;
        const vRe = re[i + k + len / 2]! * curRe - im[i + k + len / 2]! * curIm;
        const vIm = re[i + k + len / 2]! * curIm + im[i + k + len / 2]! * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

const htkMel = (freq: number) => 2595 * Math.log10(1 + freq / 700);
const inverseHtkMel = (mel: number) => 700 * (10 ** (mel / 2595) - 1);

/** 三角 mel 滤波器组权重（kaldi/HTK 口径；返回 [bins][fftBins/2+1]） */
function buildMelFilterbank(numBins: number, fftSize: number, sampleRate: number): Float32Array[] {
  const numFftBins = fftSize / 2 + 1;
  const nyquist = sampleRate / 2;
  const melLow = htkMel(LOW_FREQ);
  const melHigh = htkMel(nyquist);
  const melPoints: number[] = [];
  for (let i = 0; i < numBins + 2; i++) {
    melPoints.push(melLow + ((melHigh - melLow) * i) / (numBins + 1));
  }
  const binFreq = (b: number) => (b * sampleRate) / fftSize;
  const filters: Float32Array[] = [];
  for (let b = 0; b < numBins; b++) {
    const left = inverseHtkMel(melPoints[b]!);
    const center = inverseHtkMel(melPoints[b + 1]!);
    const right = inverseHtkMel(melPoints[b + 2]!);
    const w = new Float32Array(numFftBins);
    for (let k = 0; k < numFftBins; k++) {
      const f = binFreq(k);
      if (f <= left || f >= right) continue;
      w[k] = f <= center ? (f - left) / (center - left) : (right - f) / (right - center);
    }
    filters.push(w);
  }
  return filters;
}

/** 预计算（16k 固定）：povey 窗 + mel 滤波器组 */
const FRAME_LEN = Math.round((WINDOW_MS * 16000) / 1000); // 400
const FRAME_SHIFT = Math.round((SHIFT_MS * 16000) / 1000); // 160
const POVEY_WINDOW = (() => {
  const w = new Float32Array(FRAME_LEN);
  for (let n = 0; n < FRAME_LEN; n++) {
    w[n] = (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (FRAME_LEN - 1))) ** 0.85;
  }
  return w;
})();
const MEL_FILTERS = buildMelFilterbank(NUM_MEL_BINS, FFT_SIZE, 16000);

/** 最小可分析毫秒数对应的帧数下限（防超短输入跑出垃圾 embedding） */
export const MIN_FRAMES = 25; // ≈0.25s
export const MAX_FRAMES = 600; // 6s 截断（与训练 num_frms=200 同量级，余量覆盖 3-5s 注册句）

/**
 * 16k float 波形 → log-mel fbank + 时间维归一化。
 * 输入约定：已重采样到 16k 的单声道 [-1,1]。
 *
 * normalize 变体（前端口径按官方样本实证标定，见 scripts/probe-campplus-frontend.ts）：
 *   - "cmvn"：逐句均值方差归一（wespeaker ResNet34 训练口径）
 *   - "mean"：仅逐句减均值（3D-Speaker/sherpa-onnx 对 CAM++ 的推理口径）
 *   - "none"：原始 log-mel
 */
export type FbankNormalize = "cmvn" | "mean" | "none";

export function computeFbank(
  samples16k: Float32Array,
  normalize: FbankNormalize = "cmvn",
): FbankResult {
  const numFrames = samples16k.length >= FRAME_LEN
    ? 1 + Math.floor((samples16k.length - FRAME_LEN) / FRAME_SHIFT)
    : 0;
  if (numFrames < MIN_FRAMES) {
    throw new Error(`音频过短：${numFrames} 帧 < ${MIN_FRAMES} 帧（约 ${Math.round((MIN_FRAMES - 1) * SHIFT_MS)}ms）`);
  }
  const useFrames = Math.min(numFrames, MAX_FRAMES);

  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const power = new Float32Array(FFT_SIZE / 2 + 1);
  const feats = new Float32Array(useFrames * NUM_MEL_BINS);

  let prevSample = samples16k[0] ?? 0; // 预加重跨帧连续
  for (let f = 0; f < useFrames; f++) {
    const start = f * FRAME_SHIFT;
    // 帧内：去 DC → 预加重 → povey 窗
    let mean = 0;
    for (let n = 0; n < FRAME_LEN; n++) mean += samples16k[start + n]!;
    mean /= FRAME_LEN;
    for (let n = 0; n < FFT_SIZE; n++) {
      const x = n < FRAME_LEN ? samples16k[start + n]! - mean : 0;
      const emph = x - PREEMPHASIS * prevSample;
      prevSample = n < FRAME_LEN - 1 ? samples16k[start + n]! - mean : prevSample;
      re[n] = n < FRAME_LEN ? emph * POVEY_WINDOW[n]! : 0;
      im[n] = 0;
    }
    fft(re, im);
    for (let k = 0; k < power.length; k++) {
      power[k] = re[k]! * re[k]! + im[k]! * im[k]!;
    }
    const base = f * NUM_MEL_BINS;
    for (let b = 0; b < NUM_MEL_BINS; b++) {
      const w = MEL_FILTERS[b]!;
      let energy = 0;
      for (let k = 0; k < power.length; k++) energy += w[k]! * power[k]!;
      feats[base + b] = Math.log(Math.max(energy, LOG_FLOOR));
    }
  }

  // 时间维归一化（口径见上）
  if (normalize !== "none") {
    for (let d = 0; d < NUM_MEL_BINS; d++) {
      let mean = 0;
      for (let f = 0; f < useFrames; f++) mean += feats[f * NUM_MEL_BINS + d]!;
      mean /= useFrames;
      if (normalize === "none") continue;
      if (normalize === "mean") {
        for (let f = 0; f < useFrames; f++) {
          feats[f * NUM_MEL_BINS + d] = feats[f * NUM_MEL_BINS + d]! - mean;
        }
        continue;
      }
      let variance = 0;
      for (let f = 0; f < useFrames; f++) {
        const diff = feats[f * NUM_MEL_BINS + d]! - mean;
        variance += diff * diff;
      }
      const std = Math.sqrt(variance / useFrames) + 1e-8;
      for (let f = 0; f < useFrames; f++) {
        feats[f * NUM_MEL_BINS + d] = (feats[f * NUM_MEL_BINS + d]! - mean) / std;
      }
    }
  }

  return { data: feats, frames: useFrames, dims: NUM_MEL_BINS, sampleRate: 16000 };
}

/** 兼容旧名：逐句 CMVN（wespeaker 口径）。 */
export function computeFbankWithCmvn(samples16k: Float32Array): FbankResult {
  return computeFbank(samples16k, "cmvn");
}

/** 波形 RMS（[-1,1] 口径），用于静音检测 */
export function rmsOf(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / samples.length);
}
