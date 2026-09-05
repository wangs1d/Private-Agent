/**
 * 图像解析服务:一次解析得到格式/尺寸/EXIF/拍摄时间/色彩统计/自动标签。
 * 自动打标签逻辑与 Python 版 GalleryService._auto_tag 保持一致,
 * 并在此基础上扩展了暗光/高亮标签。
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import sharp from 'sharp';
import { computeImageStats } from './color.js';
import { exifTimeToIso, parseExif, parseRational } from './exif.js';
import type { ImageParseResult, ImageStats } from '../models.js';

export class ImageAnalysisService {
  /** 解析图片输入(文件路径或 Buffer)为完整元信息 */
  async parse(input: string | Buffer): Promise<ImageParseResult> {
    const buffer = typeof input === 'string' ? await fs.readFile(input) : input;
    const metadata = await sharp(buffer).metadata();
    let stats: ImageStats;
    try {
      stats = await computeImageStats(buffer);
    } catch {
      stats = { avgBrightness: 0, avgColor: [0, 0, 0], dominant: [0, 0, 0] };
    }
    const exif = parseExif(buffer);
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    const orientationRaw = exif['Image Orientation'];
    const orientation = orientationRaw ? Number(orientationRaw.split(',')[0]) || null : null;
    return {
      fileName: typeof input === 'string' ? input.split(/[\\/]/).pop() ?? null : null,
      filePath: typeof input === 'string' ? input : null,
      format: metadata.format ?? null,
      space: metadata.space ?? null,
      hasAlpha: metadata.hasAlpha ?? false,
      width,
      height,
      fileSize: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      exif,
      takenAt: exifTimeToIso(exif['EXIF DateTimeOriginal']),
      orientation,
      stats,
      autoTags: this.autoTag(width, height, stats.avgBrightness),
    };
  }

  /** 基于宽高比与尺寸的自动打标签(对齐 Python 版语义) */
  autoTag(width: number, height: number, avgBrightness?: number): string[] {
    const tags: string[] = [];
    if (width > height) {
      tags.push('landscape');
    } else if (height > width) {
      tags.push('portrait');
    } else {
      tags.push('square');
    }
    if (Math.max(width, height) >= 2000) {
      tags.push('high_res');
    }
    if (avgBrightness !== undefined && avgBrightness > 0) {
      if (avgBrightness < 60) {
        tags.push('low_light');
      } else if (avgBrightness > 200) {
        tags.push('high_key');
      }
    }
    return tags;
  }

  /** 从 EXIF 中解析拍摄时间,失败返回 null */
  parseTakenAt(exif: Record<string, string>): string | null {
    return exifTimeToIso(exif['EXIF DateTimeOriginal']);
  }

  /** 从 EXIF 中解析焦段(支持 "300/1" 形式),失败返回 null */
  parseFocalLength(exif: Record<string, string>): number | null {
    return parseRational(exif['EXIF FocalLength']);
  }
}
