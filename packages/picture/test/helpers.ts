/** 测试工具:构造测试图片与手工 EXIF/PLY 字节 */
import sharp from 'sharp';
import { promises as fs } from 'node:fs';

/** Windows 下 sharp 工作线程可能短暂持有文件锁,删除目录时重试 */
export async function cleanupDir(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'EBUSY' && code !== 'ENOTEMPTY' && code !== 'EPERM') || attempt >= 5) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

/** 生成纯色测试图片(JPEG/PNG) */
export async function createTestImage(
  filePath: string,
  options: { width?: number; height?: number; r?: number; g?: number; b?: number; format?: 'png' | 'jpeg' } = {},
): Promise<void> {
  const { width = 64, height = 48, r = 128, g = 128, b = 128, format = 'png' } = options;
  const pipeline = sharp({
    create: { width, height, channels: 3, background: { r, g, b } },
  });
  if (format === 'jpeg') {
    await pipeline.jpeg().toFile(filePath);
  } else {
    await pipeline.png().toFile(filePath);
  }
}

/**
 * 手工构造一个带 EXIF 的最小 JPEG:
 * IFD0 仅含 ExifIFD 指针;EXIF IFD 含 DateTimeOriginal(ASCII)与 FocalLength(RATIONAL 35/1)。
 */
export function buildJpegWithExif(): Buffer {
  const encoder = new TextEncoder();
  const dateTimeOriginal = '2024:01:15 10:30:00\0';
  const dtoBytes = encoder.encode(dateTimeOriginal); // 20 bytes

  // 布局:TIFF 头 8B;IFD0 @8(1 项,18B);EXIF IFD @26(2 项,2+24+4=30B);DTO @56(20B);焦段 rational @76(8B)
  const IFD0_OFFSET = 8;
  const EXIF_IFD_OFFSET = 26;
  const DTO_OFFSET = 56;
  const FOCAL_OFFSET = 76;
  const total = 84;

  const tiff = new Uint8Array(total);
  const view = new DataView(tiff.buffer);
  tiff[0] = 0x49; tiff[1] = 0x49; // "II" little endian
  view.setUint16(2, 42, true);
  view.setUint32(4, IFD0_OFFSET, true);

  // IFD0:1 项(ExifIFD 指针)
  view.setUint16(8, 1, true);
  view.setUint16(10, 0x8769, true);
  view.setUint16(12, 4, true); // LONG
  view.setUint32(14, 1, true);
  view.setUint32(18, EXIF_IFD_OFFSET, true);
  view.setUint32(22, 0, true); // next IFD

  // EXIF IFD:2 项
  view.setUint16(EXIF_IFD_OFFSET, 2, true);
  // DateTimeOriginal
  view.setUint16(28, 0x9003, true);
  view.setUint16(30, 2, true); // ASCII
  view.setUint32(32, dtoBytes.length, true);
  view.setUint32(36, DTO_OFFSET, true);
  // FocalLength
  view.setUint16(40, 0x920a, true);
  view.setUint16(42, 5, true); // RATIONAL
  view.setUint32(44, 1, true);
  view.setUint32(48, FOCAL_OFFSET, true);
  view.setUint32(52, 0, true); // next IFD

  tiff.set(dtoBytes, DTO_OFFSET);
  view.setUint32(FOCAL_OFFSET, 35, true);
  view.setUint32(FOCAL_OFFSET + 4, 1, true);

  // 包一层 JPEG:SOI + APP1("Exif\0\0" + TIFF) + EOI
  const app1Payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), Buffer.from(tiff)]);
  const segmentLength = app1Payload.length + 2;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1, (segmentLength >> 8) & 0xff, segmentLength & 0xff]),
    app1Payload,
    Buffer.from([0xff, 0xd9]),
  ]);
}
