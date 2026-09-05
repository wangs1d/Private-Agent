/**
 * 图像处理服务:基于 sharp 的尺寸/裁剪/旋转/翻转/调整/格式转换/水印。
 * 调整参数语义与 Python 版 PillowBatchEngine 对齐:
 * - brightness/contrast/saturation/sharpness/temperature 均为 -100~100,
 *   内部换算为 1 + v/100 的系数。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { Blend, FitEnum, Gravity, Metadata, Sharp } from 'sharp';

export interface ProcessResult {
  outputPath: string;
  width: number;
  height: number;
  format?: string;
  fileSize: number;
}

export interface ImageAdjustments {
  /** -100~100,系数 1+v/100 */
  brightness?: number;
  contrast?: number;
  saturation?: number;
  sharpness?: number;
  /** -100~100,正值暖色(加红减蓝),负值冷色 */
  temperature?: number;
  /** sharp gamma,1.0~3.0 */
  gamma?: number;
  /** 色相旋转 -360~360 */
  hue?: number;
  /** 高斯模糊 sigma,设置后忽略 sharpness */
  blur?: number;
}

export type OutputFormat = 'jpeg' | 'png' | 'webp' | 'tiff' | 'avif' | 'gif';

export interface ResizeOptions {
  width?: number;
  height?: number;
  fit?: keyof FitEnum;
  withoutEnlargement?: boolean;
  quality?: number;
}

export interface WatermarkOptions {
  /** 九宫格方位:north/northeast/east/southeast/south/... 或 centre */
  gravity?: Gravity;
  blend?: Blend;
  /** 水印相对主图的宽度比例,0-1,默认 0.25 */
  scale?: number;
  /** 水印不透明度 0-1 */
  opacity?: number;
}

export class ImageProcessingService {
  /** 输出路径为空时,在原文件同目录生成 "processed_" 前缀文件(对齐 Python 版) */
  private async defaultOutput(input: string, ext?: string): Promise<string> {
    const dir = path.dirname(input);
    const base = path.basename(input);
    const suffix = ext ? path.extname(base) + ext : path.extname(base);
    return path.join(dir, `processed_${path.parse(base).name}${suffix}`);
  }

  private async finalize(pipeline: Sharp, outputPath: string): Promise<ProcessResult> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const info = await pipeline.toFile(outputPath);
    return {
      outputPath,
      width: info.width,
      height: info.height,
      format: info.format,
      fileSize: info.size,
    };
  }

  async resize(input: string, options: ResizeOptions, output?: string): Promise<ProcessResult> {
    const target = output ?? (await this.defaultOutput(input));
    const pipeline = sharp(input)
      .resize({
        width: options.width,
        height: options.height,
        fit: options.fit ?? 'cover',
        withoutEnlargement: options.withoutEnlargement ?? true,
      });
    if (options.quality !== undefined) {
      pipeline.webp({ quality: options.quality });
    }
    return this.finalize(pipeline, target);
  }

  async crop(
    input: string,
    region: { left: number; top: number; width: number; height: number },
    output?: string,
  ): Promise<ProcessResult> {
    const target = output ?? (await this.defaultOutput(input));
    return this.finalize(sharp(input).extract(region), target);
  }

  async rotate(input: string, angle: number, output?: string): Promise<ProcessResult> {
    const target = output ?? (await this.defaultOutput(input));
    return this.finalize(sharp(input).rotate(angle), target);
  }

  async flip(
    input: string,
    options: { vertical?: boolean; horizontal?: boolean } = {},
    output?: string,
  ): Promise<ProcessResult> {
    const target = output ?? (await this.defaultOutput(input));
    let pipeline = sharp(input);
    if (options.vertical) {
      pipeline = pipeline.flip();
    }
    if (options.horizontal) {
      pipeline = pipeline.flop();
    }
    if (!options.vertical && !options.horizontal) {
      pipeline = pipeline.flip();
    }
    return this.finalize(pipeline, target);
  }

  /** 应用亮度/对比度/饱和度/锐度/色温等调整,默认输出 webp */
  async adjust(
    input: string,
    adjustments: ImageAdjustments,
    output?: string,
  ): Promise<ProcessResult> {
    const target = output ?? (await this.defaultOutput(input, '.webp'));
    const pipeline = this.applyAdjustments(sharp(input), adjustments);
    return this.finalize(pipeline, target);
  }

  /** 将调整参数挂到 sharp 管道上,供 adjust 与批图引擎复用 */
  applyAdjustments(pipeline: Sharp, adjustments: ImageAdjustments): Sharp {
    let result = pipeline;
    const { brightness, contrast, saturation, sharpness, temperature, gamma, hue, blur } = adjustments;
    if (brightness !== undefined || saturation !== undefined || hue !== undefined) {
      // sharp 会校验传入的每个选项,只能携带实际提供的键
      const modulateOptions: { brightness?: number; saturation?: number; hue?: number } = {};
      if (brightness !== undefined) {
        modulateOptions.brightness = 1 + brightness / 100;
      }
      if (saturation !== undefined) {
        modulateOptions.saturation = 1 + saturation / 100;
      }
      if (hue !== undefined) {
        modulateOptions.hue = hue;
      }
      result = result.modulate(modulateOptions);
    }
    if (contrast !== undefined && contrast !== 0) {
      // 对比度:围绕中点 128 做线性拉伸,等价 Pillow ImageEnhance.Contrast
      const factor = 1 + contrast / 100;
      result = result.linear(factor, 128 * (1 - factor));
    }
    if (temperature !== undefined && temperature !== 0) {
      // 色温:RGB 通道线性缩放,等价 Pillow 的 point 通道调整
      const delta = Math.abs(temperature) / 100;
      const rGain = temperature > 0 ? 1 + delta : 1 - delta;
      const bGain = temperature > 0 ? 1 - delta : 1 + delta;
      result = result.linear([rGain, 1, bGain], [0, 0, 0]);
    }
    if (gamma !== undefined) {
      result = result.gamma(gamma);
    }
    if (blur !== undefined) {
      result = result.blur(blur);
    } else if (sharpness !== undefined && sharpness !== 0) {
      const factor = 1 + sharpness / 100;
      if (factor < 1) {
        // Pillow 锐度 <1 表示柔化
        result = result.blur((1 - factor) * 2);
      } else if (factor > 1) {
        result = result.sharpen({ sigma: Math.min(2, 0.5 + (factor - 1) * 1.5) });
      }
    }
    return result;
  }

  async convert(
    input: string,
    options: { format: OutputFormat; quality?: number },
    output?: string,
  ): Promise<ProcessResult> {
    const target = output ?? (await this.defaultOutput(input, `.${options.format === 'jpeg' ? 'jpg' : options.format}`));
    const pipeline = sharp(input);
    switch (options.format) {
      case 'jpeg':
        pipeline.jpeg({ quality: options.quality });
        break;
      case 'png':
        pipeline.png();
        break;
      case 'webp':
        pipeline.webp({ quality: options.quality });
        break;
      case 'tiff':
        pipeline.tiff({ quality: options.quality });
        break;
      case 'avif':
        pipeline.avif({ quality: options.quality });
        break;
      case 'gif':
        pipeline.gif();
        break;
    }
    return this.finalize(pipeline, target);
  }

  /** 叠加水印图片;可按主图宽度比例缩放并调整不透明度 */
  async watermark(
    input: string,
    watermarkPath: string,
    options: WatermarkOptions = {},
    output?: string,
  ): Promise<ProcessResult> {
    const target = output ?? (await this.defaultOutput(input, '.webp'));
    const metadata = await sharp(input).metadata();
    const mainWidth = metadata.width ?? 0;
    let overlay = sharp(watermarkPath);
    if (options.scale !== undefined && mainWidth > 0) {
      const targetWidth = Math.max(1, Math.round(mainWidth * options.scale));
      overlay = overlay.resize({ width: targetWidth });
    }
    if (options.opacity !== undefined) {
      // 通过 dilate alpha 通道实现整体不透明度
      const alpha = Math.max(0, Math.min(1, options.opacity));
      const [buf, meta] = await Promise.all([
        overlay.ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
        overlay.metadata(),
      ]);
      const channels = meta.channels ?? 4;
      for (let i = channels - 1; i < buf.data.length; i += channels) {
        buf.data[i] = Math.round(buf.data[i]! * alpha);
      }
      overlay = sharp(buf.data, {
        raw: { width: buf.info.width, height: buf.info.height, channels },
      });
    }
    const composite = await overlay.toBuffer();
    return this.finalize(
      sharp(input).composite([
        {
          input: composite,
          gravity: options.gravity ?? 'southeast',
          blend: options.blend ?? 'over',
        },
      ]),
      target,
    );
  }

  /** 读取图片元信息 */
  async info(input: string | Buffer): Promise<Metadata> {
    return sharp(input).metadata();
  }
}
