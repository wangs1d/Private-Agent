/**
 * 纯 TypeScript 的 EXIF 解析器(对齐 exifread 的输出约定)。
 *
 * 支持 JPEG(APP1/Exif)与 TIFF 头,解析 IFD0(Image)与 Exif 子 IFD。
 * 产出的 key 形如 "EXIF DateTimeOriginal"、"Image Make",与 Python 版
 * exifread.process_file 的 key 格式保持一致;RATIONAL 序列化为 "num/den"
 * 字符串(如 "300/1"),与图库焦段过滤逻辑兼容。
 */

const TYPE_SIZES: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  7: 1, // UNDEFINED
  9: 4, // SLONG
  10: 8, // SRATIONAL
};

const IMAGE_TAGS: Record<number, string> = {
  0x010f: 'Make',
  0x0110: 'Model',
  0x0112: 'Orientation',
  0x011a: 'XResolution',
  0x011b: 'YResolution',
  0x0128: 'ResolutionUnit',
  0x0131: 'Software',
  0x0132: 'DateTime',
  0x013b: 'Artist',
  0x8298: 'Copyright',
};

const EXIF_TAGS: Record<number, string> = {
  0x829a: 'ExposureTime',
  0x829d: 'FNumber',
  0x8827: 'ISOSpeedRatings',
  0x9003: 'DateTimeOriginal',
  0x9004: 'DateTimeDigitized',
  0x9201: 'ShutterSpeedValue',
  0x9202: 'ApertureValue',
  0x9204: 'ExposureBiasValue',
  0x9207: 'MeteringMode',
  0x9209: 'Flash',
  0x920a: 'FocalLength',
  0xa002: 'PixelXDimension',
  0xa003: 'PixelYDimension',
  0xa402: 'ExposureMode',
  0xa403: 'WhiteBalance',
  0xa405: 'FocalLengthIn35mmFilm',
  0xa434: 'LensModel',
};

class Reader {
  constructor(
    private readonly view: DataView,
    private readonly littleEndian: boolean,
  ) {}

  u16(offset: number): number {
    return this.view.getUint16(offset, this.littleEndian);
  }

  u32(offset: number): number {
    return this.view.getUint32(offset, this.littleEndian);
  }

  i32(offset: number): number {
    return this.view.getInt32(offset, this.littleEndian);
  }
}

/** 从 TIFF 头起始的 EXIF 块解析出 tag 映射 */
export function parseExifBlock(block: Uint8Array): Record<string, string> {
  const result: Record<string, string> = {};
  if (block.length < 8) {
    return result;
  }
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const byteOrder = String.fromCharCode(block[0], block[1]);
  const littleEndian = byteOrder === 'II';
  if (!littleEndian && byteOrder !== 'MM') {
    return result;
  }
  const reader = new Reader(view, littleEndian);
  if (reader.u16(2) !== 42) {
    return result;
  }
  const ifd0Offset = reader.u32(4);
  const exifPointer = readIfd(reader, block, ifd0Offset, 'Image', IMAGE_TAGS, result);
  if (exifPointer !== null) {
    readIfd(reader, block, exifPointer, 'EXIF', EXIF_TAGS, result);
  }
  return result;
}

function readIfd(
  reader: Reader,
  block: Uint8Array,
  offset: number,
  prefix: string,
  tagNames: Record<number, string>,
  out: Record<string, string>,
): number | null {
  if (offset <= 0 || offset + 2 > block.length) {
    return null;
  }
  const count = reader.u16(offset);
  let exifPointer: number | null = null;
  for (let i = 0; i < count; i += 1) {
    const entry = offset + 2 + i * 12;
    if (entry + 12 > block.length) {
      break;
    }
    const tag = reader.u16(entry);
    const type = reader.u16(entry + 2);
    const valueCount = reader.u32(entry + 4);
    if (tag === 0x8769) {
      exifPointer = reader.u32(entry + 8);
      continue;
    }
    const name = tagNames[tag];
    if (!name) {
      continue;
    }
    const unitSize = TYPE_SIZES[type];
    if (!unitSize) {
      continue;
    }
    const total = unitSize * valueCount;
    // TIFF 值偏移相对 TIFF 头起始;≤4 字节的值内联在 entry 中
    const valueOffset = total <= 4 ? entry + 8 : reader.u32(entry + 8);
    if (valueOffset < 0 || valueOffset + total > block.length) {
      continue;
    }
    out[`${prefix} ${name}`] = formatValue(reader, block, type, valueCount, valueOffset);
  }
  return exifPointer;
}

function formatValue(
  reader: Reader,
  block: Uint8Array,
  type: number,
  count: number,
  offset: number,
): string {
  if (type === 2) {
    // ASCII:截断到第一个 NUL
    let end = offset;
    const limit = Math.min(offset + count, block.length);
    while (end < limit && block[end] !== 0) {
      end += 1;
    }
    return Buffer.from(block.subarray(offset, end)).toString('utf8').trim();
  }
  if (type === 5 || type === 10) {
    // RATIONAL / SRATIONAL:输出 "num/den"
    const parts: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const base = offset + i * 8;
      const num = type === 5 ? reader.u32(base) : reader.i32(base);
      const den = type === 5 ? reader.u32(base + 4) : reader.i32(base + 4);
      parts.push(`${num}/${den}`);
    }
    return parts.join(', ');
  }
  const values: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = offset + i * TYPE_SIZES[type];
    switch (type) {
      case 1:
        values.push(String(block[base]));
        break;
      case 3:
        values.push(String(reader.u16(base)));
        break;
      case 4:
        values.push(String(reader.u32(base)));
        break;
      case 9:
        values.push(String(reader.i32(base)));
        break;
      default:
        values.push(String(block[base]));
    }
  }
  return values.join(', ');
}

/** 从原始文件字节中定位 EXIF 块:JPEG 扫 APP1 段,TIFF 直接取头 */
export function extractExifBlock(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length >= 4 && ((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d))) {
    return bytes;
  }
  // JPEG:SOI(FFD8)后逐段扫描 APP1
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let pos = 2;
    while (pos + 4 <= bytes.length) {
      if (bytes[pos] !== 0xff) {
        break;
      }
      const marker = bytes[pos + 1];
      if (marker === 0xd9 || marker === 0xda) {
        break; // EOI / SOS:数据已结束
      }
      const size = (bytes[pos + 2] << 8) | bytes[pos + 3];
      if (marker === 0xe1) {
        const payloadStart = pos + 4;
        const payload = bytes.subarray(payloadStart, Math.min(payloadStart + size - 2, bytes.length));
        if (
          payload.length > 6 &&
          payload[0] === 0x45 &&
          payload[1] === 0x78 &&
          payload[2] === 0x69 &&
          payload[3] === 0x66 &&
          payload[4] === 0 &&
          payload[5] === 0
        ) {
          return payload.subarray(6);
        }
      }
      pos += 2 + size;
    }
  }
  return null;
}

/** 解析文件的 EXIF;非 JPEG/TIFF 或无 EXIF 时返回空对象 */
export function parseExif(bytes: Uint8Array): Record<string, string> {
  const block = extractExifBlock(bytes);
  return block ? parseExifBlock(block) : {};
}

/** EXIF 时间 "YYYY:MM:DD HH:MM:SS" → ISO 字符串,失败返回 null */
export function exifTimeToIso(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim());
  if (!match) {
    return null;
  }
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** 解析 exifread 风格的有理数("300/1"),失败返回 null */
export function parseRational(raw: string | undefined): number | null {
  if (!raw) {
    return null;
  }
  const value = raw.split(',')[0]!.trim();
  if (value.includes('/')) {
    const [num, den] = value.split('/', 2);
    const n = Number(num);
    const d = Number(den);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) {
      return null;
    }
    return n / d;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
