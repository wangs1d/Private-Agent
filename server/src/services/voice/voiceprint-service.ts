/**
 * 声纹服务：注册（多样本均值声纹）+ 验证（cosine 比对 + 说话人令牌签发）。
 *
 * 用途：语音对话/语音控制的独占闸——只有录入声纹的用户，agent 才响应。
 * 音频输入统一 PCM16 单声道（16k 最佳；22.05k/44.1k 会重采样），或带 RIFF
 * 头的 16bit PCM WAV（自动解析）。
 */

import { randomBytes } from "node:crypto";

import { rmsOf } from "./speaker-fbank.js";
import { initSpeakerEmbeddingEngine, SPEAKER_EMBEDDING_DIMS, type SpeakerEmbeddingEngine } from "./speaker-embedding-engine.js";
import { VoiceprintStore, type VoiceprintRecord } from "./voiceprint-store.js";

/** 单样本字节上限（≈15s PCM16 16k），防超大 payload 拖垮推理 */
const MAX_SAMPLE_BYTES = 480_000;
/** 单次注册样本数上限 */
const MAX_SAMPLES = 8;
/** 静音判定 RMS（[-1,1] 口径）：低于此值的样本不入库 */
const SILENCE_RMS = 0.008;

export type RegisterResult =
  | { ok: true; sampleCount: number; usedSamples: number; dims: number }
  | { ok: false; error: string };

export type VerifyResult =
  | { ok: true; match: boolean; score: number; threshold: number; speakerToken?: string }
  | { ok: false; error: string };

type IssuedToken = { actorId: string; expiresAt: number };

/** WAV（RIFF/PCM 16bit）或裸 PCM16 解析；返回单声道 Int16 与采样率 */
export function parseAudioToPcm16(buf: Buffer): { pcm: Int16Array; sampleRate: number } {
  if (buf.length >= 44 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE") {
    let offset = 12;
    let sampleRate = 16000;
    let channels = 1;
    let bits = 16;
    let format = 1;
    while (offset + 8 <= buf.length) {
      const id = buf.toString("ascii", offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      if (id === "fmt " && offset + 8 + 16 <= buf.length) {
        format = buf.readUInt16LE(offset + 8);
        channels = buf.readUInt16LE(offset + 10);
        sampleRate = buf.readUInt32LE(offset + 12);
        bits = buf.readUInt16LE(offset + 22);
      } else if (id === "data") {
        if (format !== 1 || bits !== 16) {
          throw new Error(`仅支持 16bit PCM WAV（当前 format=${format} bits=${bits}）`);
        }
        const usable = Math.min(size, buf.length - offset - 8) & ~1; // 偶数字节
        const raw = buf.subarray(offset + 8, offset + 8 + usable);
        const pcm = new Int16Array(raw.length / 2);
        for (let i = 0; i < pcm.length; i++) pcm[i] = raw.readInt16LE(i * 2);
        return { pcm: channels > 1 ? downmixMono(pcm, channels) : pcm, sampleRate };
      }
      offset += 8 + size + (size % 2);
    }
    throw new Error("WAV 缺少 data 块");
  }
  // 裸 PCM16：约定 16k 单声道
  const usable = buf.length & ~1;
  const pcm = new Int16Array(usable / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(i * 2);
  return { pcm, sampleRate: 16000 };
}

function downmixMono(pcm: Int16Array, channels: number): Int16Array {
  const frames = Math.floor(pcm.length / channels);
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += pcm[i * channels + c]!;
    out[i] = Math.round(sum / channels);
  }
  return out;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

export class VoiceprintService {
  private readonly store: VoiceprintStore;
  private readonly tokens = new Map<string, IssuedToken>();

  constructor(store?: VoiceprintStore) {
    this.store = store ?? new VoiceprintStore();
  }

  /** 比对阈值（同管线内标定；env 可调） */
  get threshold(): number {
    const v = Number.parseFloat(process.env.VOICEPRINT_THRESHOLD ?? "");
    return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.65;
  }

  get speakerTokenTtlMs(): number {
    const v = Number.parseInt(process.env.VOICEPRINT_SPEAKER_TOKEN_TTL_MS ?? "", 10);
    return Number.isFinite(v) && v > 0 ? v : 15 * 60 * 1000;
  }

  async isEngineReady(): Promise<boolean> {
    return (await this.initEngine()) !== null;
  }

  private async initEngine(): Promise<SpeakerEmbeddingEngine | null> {
    return initSpeakerEmbeddingEngine();
  }

  /** 注册：有效样本（非静音、够长）各出向量 → 均值 → L2 归一 → 存库 */
  async register(actorId: string, samples: Buffer[]): Promise<RegisterResult> {
    if (!actorId.trim()) return { ok: false, error: "actorId required" };
    if (samples.length === 0 || samples.length > MAX_SAMPLES) {
      return { ok: false, error: `样本数须在 1-${MAX_SAMPLES} 之间` };
    }
    const engine = await this.initEngine();
    if (!engine) return { ok: false, error: "说话人引擎不可用（模型缺失或被禁用）" };

    const embeddings: Float32Array[] = [];
    for (const buf of samples) {
      if (buf.length > MAX_SAMPLE_BYTES) return { ok: false, error: "单样本超过 15s 上限" };
      let pcm: Int16Array;
      let sampleRate: number;
      try {
        ({ pcm, sampleRate } = parseAudioToPcm16(buf));
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      const wave = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) wave[i] = pcm[i]! / 32768;
      if (rmsOf(wave) < SILENCE_RMS) continue; // 静音样本跳过（不报错，攒有效样本）
      try {
        embeddings.push(await engine.embedPcm16(pcm, sampleRate));
      } catch {
        // 过短等：跳过该样本
      }
    }
    if (embeddings.length < 2) {
      return { ok: false, error: "有效样本不足（至少 2 段非静音语音，请靠近麦克风再说两句）" };
    }

    // 均值声纹：多样本均值提升稳定性，再归一保证与验证向量同空间
    const avg = new Float32Array(SPEAKER_EMBEDDING_DIMS);
    for (const emb of embeddings) {
      for (let i = 0; i < avg.length; i++) avg[i]! += emb[i]!;
    }
    const norm = Math.sqrt(Array.from(avg).reduce((s, v) => s + v * v, 0)) || 1;
    for (let i = 0; i < avg.length; i++) avg[i] = avg[i]! / norm;

    this.store.upsert(actorId, avg, embeddings.length);
    return { ok: true, sampleCount: samples.length, usedSamples: embeddings.length, dims: avg.length };
  }

  /** 验证：单段音频 → 向量 → 与库内声纹 cosine；命中签发短期说话人令牌 */
  async verify(actorId: string, audio: Buffer): Promise<VerifyResult> {
    const engine = await this.initEngine();
    if (!engine) return { ok: false, error: "说话人引擎不可用" };
    const record = this.store.get(actorId);
    if (!record) return { ok: false, error: "该用户尚未注册声纹" };
    if (audio.length > MAX_SAMPLE_BYTES) return { ok: false, error: "音频超过 15s 上限" };

    let pcm: Int16Array;
    let sampleRate: number;
    try {
      ({ pcm, sampleRate } = parseAudioToPcm16(audio));
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const wave = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) wave[i] = pcm[i]! / 32768;
    if (rmsOf(wave) < SILENCE_RMS) return { ok: false, error: "音频过短或无声" };

    let vector: Float32Array;
    try {
      vector = await engine.embedPcm16(pcm, sampleRate);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const score = cosineSimilarity(vector, record.embedding);
    const match = score >= this.threshold;
    return {
      ok: true,
      match,
      score: Number(score.toFixed(4)),
      threshold: this.threshold,
      ...(match ? { speakerToken: this.issueToken(actorId) } : {}),
    };
  }

  status(actorId: string): { registered: boolean; record?: Omit<VoiceprintRecord, "embedding"> } {
    const record = this.store.get(actorId);
    if (!record) return { registered: false };
    return {
      registered: true,
      record: { actorId: record.actorId, dims: record.dims, sampleCount: record.sampleCount, updatedAt: record.updatedAt },
    };
  }

  unregister(actorId: string): boolean {
    this.revokeTokens(actorId);
    return this.store.delete(actorId);
  }

  // ── 说话人令牌：验证通过后签发，语音会话建立时出示（防绕过客户端闸） ──

  private issueToken(actorId: string): string {
    const token = `spk-${randomBytes(18).toString("hex")}`;
    this.tokens.set(token, { actorId, expiresAt: Date.now() + this.speakerTokenTtlMs });
    if (this.tokens.size > 256) {
      const now = Date.now();
      for (const [k, v] of this.tokens) {
        if (v.expiresAt < now) this.tokens.delete(k);
      }
    }
    return token;
  }

  consumeToken(token: string, actorId: string): boolean {
    const issued = this.tokens.get(token);
    if (!issued || issued.actorId !== actorId || issued.expiresAt < Date.now()) {
      if (issued) this.tokens.delete(token);
      return false;
    }
    this.tokens.delete(token); // 一次性消费
    return true;
  }

  revokeTokens(actorId: string): void {
    for (const [k, v] of this.tokens) {
      if (v.actorId === actorId) this.tokens.delete(k);
    }
  }
}

let singleton: VoiceprintService | null = null;

export function getVoiceprintService(): VoiceprintService {
  if (!singleton) singleton = new VoiceprintService();
  return singleton;
}
