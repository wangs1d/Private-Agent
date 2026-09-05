/**
 * 缩略图服务:按预设尺寸生成 webp 缩略图,文件名 <assetId>_<size>.webp。
 */
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

export const THUMBNAIL_SIZES = {
  small: 256,
  medium: 640,
  large: 1280,
} as const;

export type ThumbnailSize = keyof typeof THUMBNAIL_SIZES;

export class ThumbnailService {
  readonly rootDir: string;

  constructor(rootDir = '.thumbnails') {
    this.rootDir = rootDir;
  }

  private filePath(assetId: string, size: ThumbnailSize): string {
    return path.join(this.rootDir, `${assetId}_${size}.webp`);
  }

  /** 为一张图生成指定尺寸(默认全部)的缩略图,返回 尺寸名 -> 路径 */
  async generate(
    input: string | Buffer,
    assetId: string,
    sizes: readonly ThumbnailSize[] = Object.keys(THUMBNAIL_SIZES) as ThumbnailSize[],
  ): Promise<Record<string, string>> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const result: Record<string, string> = {};
    for (const size of sizes) {
      const target = this.filePath(assetId, size);
      await sharp(input)
        .resize({
          width: THUMBNAIL_SIZES[size],
          height: THUMBNAIL_SIZES[size],
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 82 })
        .toFile(target);
      result[size] = target;
    }
    return result;
  }

  /** 获取已存在的缩略图路径,不存在返回 null */
  get(assetId: string, size: ThumbnailSize): string | null {
    const target = this.filePath(assetId, size);
    return existsSync(target) ? target : null;
  }

  /** 删除某个资产的全部缩略图 */
  async remove(assetId: string): Promise<void> {
    await Promise.all(
      (Object.keys(THUMBNAIL_SIZES) as ThumbnailSize[]).map(async (size) => {
        const target = this.filePath(assetId, size);
        if (existsSync(target)) {
          await fs.rm(target, { force: true });
        }
      }),
    );
  }
}
