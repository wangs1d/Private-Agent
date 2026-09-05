/**
 * 修图师式人像美颜管线。
 *
 * 核心思路对齐专业后期工作流,而非全局滤镜:
 * 1. 频率分离磨皮:图像拆为低频(肤色底色)+高频(毛孔/细纹),在肤色区域内
 *    衰减高频保留低频,皮肤细腻但五官/发丝/背景边缘不糊;
 * 2. 肤色掩码:YCbCr 肤色规则生成掩码并羽化,所有皮肤类操作只落在皮肤上;
 * 3. 皮肤修饰:透亮提亮 / 冷白皮(提亮+偏冷降饱和) / 红润气血(+红粉);
 * 4. 质感与氛围:clarity 大半径局部对比、vibrance 智能鲜艳(低饱和区优先)、
 *    fade 褪色灰蒙感;全局曝光/对比/色温由 sharp 完成。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { OutputInfo, Sharp } from 'sharp';

export interface BeautyAdjustments {
  /** 全局曝光 -100~100(系数 1+v/100) */
  exposure?: number;
  /** 全局对比度 -100~100 */
  contrast?: number;
  /** 色温 -100~100,正暖负冷 */
  warmth?: number;
  /** 全局饱和度 -100~100 */
  saturation?: number;
  /** 智能鲜艳 0~100:饱和度越低的区域提升越多 */
  vibrance?: number;
  /** 质感/局部对比 0~100(大半径 unsharp) */
  clarity?: number;
  /** 磨皮强度 0~100(频率分离,只作用于皮肤) */
  skinSmooth?: number;
  /** 皮肤透亮提亮 0~100 */
  skinBrighten?: number;
  /** 白皙 0~100(皮肤提亮+偏冷降饱和) */
  whiten?: number;
  /** 红润气血 0~100(皮肤+红粉调) */
  rosy?: number;
  /** 褪色胶片感 0~100(黑位抬升+灰蒙) */
  fade?: number;
}

export interface BeautyStyle {
  label: string;
  description: string;
  adjustments: BeautyAdjustments;
}

/** 面向女性用户高频场景的成品风格(参数即"熟练修图师"的手感基准) */
export const BEAUTY_STYLES: Record<string, BeautyStyle> = {
  natural: {
    label: '自然美颜',
    description: '轻度磨皮+气血红润,像自拍app开6成美颜,朋友看不出修过',
    adjustments: { skinSmooth: 45, skinBrighten: 18, rosy: 16, vibrance: 10, clarity: 8 },
  },
  creamy: {
    label: '奶油肌',
    description: '重度磨皮+奶白透亮+轻微灰蒙,小红书奶油质感',
    adjustments: { skinSmooth: 78, skinBrighten: 30, whiten: 18, rosy: 12, warmth: 4, fade: 8 },
  },
  cool_white: {
    label: '冷白皮',
    description: '强白皙偏冷调,皮肤白到发光,适合证件照/正装照',
    adjustments: { skinSmooth: 62, whiten: 46, skinBrighten: 24, warmth: -12, vibrance: 8, fade: 4 },
  },
  japanese: {
    label: '日系清透',
    description: '整体过曝一点点+褪色+低饱和,清新透亮的日系写真感',
    adjustments: { skinSmooth: 50, skinBrighten: 24, exposure: 6, fade: 18, saturation: -8, warmth: 3 },
  },
  hongkong: {
    label: '港风复古',
    description: '胶片褪色+浓一点对比+暖调,90年代港风写真',
    adjustments: { skinSmooth: 35, contrast: 12, saturation: -5, warmth: 8, fade: 14, clarity: 15 },
  },
};

/** 引擎可消费的美颜参数键名 */
export const BEAUTY_KEYS = [
  'exposure', 'contrast', 'warmth', 'saturation', 'vibrance', 'clarity',
  'skinSmooth', 'skinBrighten', 'whiten', 'rosy', 'fade',
] as const;

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** 处理超大图前先降采样,约束耗时与内存;全局基调(曝光/色温/对比/饱和)在此一并应用 */
async function normalizeInput(
  input: string | Buffer,
  maxDimension: number,
  adjustments: BeautyAdjustments,
): Promise<{ data: Buffer; info: OutputInfo }> {
  let pipeline = sharp(input).removeAlpha().toColourspace('srgb');
  const metadata = await sharp(input).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (Math.max(width, height) > maxDimension) {
    pipeline = pipeline.resize({
      width: width >= height ? maxDimension : undefined,
      height: height > width ? maxDimension : undefined,
      fit: 'inside',
    });
  }
  pipeline = applyGlobalTone(pipeline, adjustments);
  return pipeline.raw().toBuffer({ resolveWithObject: true });
}

/** 用 sharp 对 raw 缓冲做高斯模糊(通道数保持一致) */
async function blurRaw(
  buffer: Buffer,
  width: number,
  height: number,
  channels: 1 | 2 | 3 | 4,
  sigma: number,
): Promise<Buffer> {
  return sharp(buffer, { raw: { width, height, channels } })
    .blur(sigma)
    .raw()
    .toBuffer();
}

/** 全局基调:曝光/色温/对比度/饱和度(复用批图语义,系数 1+v/100) */
function applyGlobalTone(pipeline: Sharp, adjustments: BeautyAdjustments): Sharp {
  const { exposure, warmth, contrast, saturation } = adjustments;
  const modulateOptions: { brightness?: number; saturation?: number } = {};
  if (exposure !== undefined) {
    modulateOptions.brightness = 1 + exposure / 100;
  }
  if (saturation !== undefined) {
    modulateOptions.saturation = 1 + saturation / 100;
  }
  if (Object.keys(modulateOptions).length > 0) {
    pipeline = pipeline.modulate(modulateOptions);
  }
  if (warmth !== undefined && warmth !== 0) {
    const delta = Math.abs(warmth) / 100;
    const rGain = warmth > 0 ? 1 + delta * 0.6 : 1 - delta * 0.6;
    const bGain = warmth > 0 ? 1 - delta * 0.6 : 1 + delta * 0.6;
    pipeline = pipeline.linear([rGain, 1, bGain], [0, 0, 0]);
  }
  if (contrast !== undefined && contrast !== 0) {
    const factor = 1 + contrast / 100;
    pipeline = pipeline.linear(factor, 128 * (1 - factor));
  }
  return pipeline;
}

/**
 * YCbCr 肤色规则生成 0/255 掩码(经典 Cb 77-127 / Cr 133-173,加亮度下限),
 * 再由调用方羽化。
 */
export function buildSkinMask(
  rgb: Buffer,
  width: number,
  height: number,
): Buffer {
  const mask = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const r = rgb[i * 3]!;
    const g = rgb[i * 3 + 1]!;
    const b = rgb[i * 3 + 2]!;
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    const isSkin = y > 60 && cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173 && r > b;
    mask[i] = isSkin ? 255 : 0;
  }
  return mask;
}

/** 应用美颜管线并落盘(按扩展名/显式 format 选择输出格式) */
export async function applyBeauty(
  input: string | Buffer,
  adjustments: BeautyAdjustments,
  output?: string,
  options: { maxDimension?: number } = {},
): Promise<void> {
  const maxDimension = options.maxDimension ?? 4096;
  const { data: raw, info } = await normalizeInput(input, maxDimension, adjustments);
  const width = info.width;
  const height = info.height;
  const pixelCount = width * height;

  // ---- 低频底色:磨皮与 clarity 共用的模糊基准 ----
  const smoothSigma = Math.min(8, Math.max(2.2, Math.min(width, height) / 300));
  const claritySigma = Math.min(30, Math.max(6, Math.min(width, height) / 40));

  const needsSmooth = (adjustments.skinSmooth ?? 0) > 0;
  const needsClarity = (adjustments.clarity ?? 0) > 0;
  const needsSkinOps = needsSmooth
    || (adjustments.skinBrighten ?? 0) > 0
    || (adjustments.whiten ?? 0) > 0
    || (adjustments.rosy ?? 0) > 0;

  // 注意:sharp 对单通道 raw 做 blur 会扩张为 3 通道输出,
  // 因此掩码先复制成 3 通道再羽化,读取时按 3 字节步长取通道 0。
  let maskLow: Buffer | null = null;
  if (needsSkinOps) {
    const mask = buildSkinMask(raw, width, height);
    const mask3 = Buffer.alloc(pixelCount * 3);
    for (let i = 0; i < pixelCount; i += 1) {
      mask3[i * 3] = mask[i]!;
      mask3[i * 3 + 1] = mask[i]!;
      mask3[i * 3 + 2] = mask[i]!;
    }
    maskLow = await blurRaw(mask3, width, height, 3, Math.max(1.5, smoothSigma / 2));
  }
  const lowFreq = needsSmooth ? await blurRaw(raw, width, height, 3, smoothSigma) : null;
  const clarityLow = needsClarity ? await blurRaw(raw, width, height, 3, claritySigma) : null;

  const out = Buffer.from(raw); // 不改动输入缓冲
  const smoothAmt = (adjustments.skinSmooth ?? 0) / 100;
  const brightenK = (adjustments.skinBrighten ?? 0) / 100 * 0.3;
  const whitenAmt = (adjustments.whiten ?? 0) / 100;
  const rosyK = (adjustments.rosy ?? 0) / 100;
  const clarityAmt = (adjustments.clarity ?? 0) / 100 * 0.8;
  const vibranceAmt = (adjustments.vibrance ?? 0) / 100 * 0.9;
  const fadeT = (adjustments.fade ?? 0) / 100 * 0.16;

  for (let i = 0; i < pixelCount; i += 1) {
    const o = i * 3;
    let r = out[o]!;
    let g = out[o + 1]!;
    let b = out[o + 2]!;
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;

    // clarity:大半径局部对比(只在亮度上叠加,不动色相)
    if (clarityLow) {
      const lowLuma =
        0.299 * clarityLow[o]! + 0.587 * clarityLow[o + 1]! + 0.114 * clarityLow[o + 2]!;
      const detail = (luma - lowLuma) * clarityAmt;
      r += detail;
      g += detail;
      b += detail;
    }

    // vibrance:饱和度越低提升越多(沿 luma 轴外扩)
    if (vibranceAmt > 0) {
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const sat = (mx - mn) / (mx + 1);
      const boost = 1 + vibranceAmt * (1 - sat);
      r = luma + (r - luma) * boost;
      g = luma + (g - luma) * boost;
      b = luma + (b - luma) * boost;
    }

    // 皮肤区操作
    if (maskLow) {
      // 羽化后的掩码 0-255 → 0-1(3 通道缓冲,取通道 0)
      const m = Math.min(1, maskLow[i * 3]! / 255);
      if (m > 0.01) {
        // 频率分离磨皮:皮肤区衰减高频
        if (lowFreq && smoothAmt > 0) {
          const keep = 1 - smoothAmt;
          const targetR = lowFreq[o]! + keep * (r - lowFreq[o]!);
          const targetG = lowFreq[o + 1]! + keep * (g - lowFreq[o + 1]!);
          const targetB = lowFreq[o + 2]! + keep * (b - lowFreq[o + 2]!);
          r = r + (targetR - r) * m;
          g = g + (targetG - g) * m;
          b = b + (targetB - b) * m;
        }
        // 透亮提亮:皮肤区乘性提升
        if (brightenK > 0) {
          const k = 1 + m * brightenK;
          r *= k;
          g *= k;
          b *= k;
        }
        // 白皙:提亮且偏冷(蓝通道提升更多),轻微降饱和
        if (whitenAmt > 0) {
          const w = m * whitenAmt;
          const afterLuma = 0.299 * r + 0.587 * g + 0.114 * b;
          const liftR = afterLuma * 1.1 + 10;
          const liftG = afterLuma * 1.12 + 11;
          const liftB = afterLuma * 1.16 + 13;
          const desat = w * 0.5;
          const brighten = w * 0.55;
          r = (r * (1 - desat) + liftR * desat) * (1 + brighten * 0.9);
          g = (g * (1 - desat) + liftG * desat) * (1 + brighten);
          b = (b * (1 - desat) + liftB * desat) * (1 + brighten * 1.15);
        }
        // 红润气血:红粉调(红升蓝微降)
        if (rosyK > 0) {
          r *= 1 + m * rosyK * 0.09;
          b *= 1 - m * rosyK * 0.035;
        }
      }
    }

    // 褪色胶片感:黑位抬升 + 灰蒙压缩
    if (fadeT > 0) {
      r = r * (1 - fadeT) + 64 * fadeT;
      g = g * (1 - fadeT) + 64 * fadeT;
      b = b * (1 - fadeT) + 64 * fadeT;
    }

    out[o] = clamp255(Math.round(r));
    out[o + 1] = clamp255(Math.round(g));
    out[o + 2] = clamp255(Math.round(b));
  }

  // ---- 输出 ----
  let result = sharp(out, { raw: { width, height, channels: 3 } });
  if (output) {
    const ext = path.extname(output).toLowerCase();
    if (ext === '.png') {
      result = result.png();
    } else if (ext === '.jpg' || ext === '.jpeg') {
      result = result.jpeg({ quality: 92 });
    } else {
      result = result.webp({ quality: 90 });
    }
  } else {
    result = result.webp({ quality: 90 });
  }
  const outputBuffer = await result.toBuffer();
  const target = output ?? path.join(process.cwd(), 'beauty.webp');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, outputBuffer);
}
