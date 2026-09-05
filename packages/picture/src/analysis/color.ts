/** 基于 sharp 的图像统计:平均亮度、平均颜色与主导色。 */
import sharp from 'sharp';
import type { ImageStats } from '../models.js';

/** 灰度均值采用 ITU-R BT.601 加权,与 Pillow convert("L") 的均值口径一致 */
export async function computeImageStats(input: string | Buffer): Promise<ImageStats> {
  const stats = await sharp(input).stats();
  const channels = stats.channels;
  const r = channels[0]?.mean ?? 0;
  const g = channels[1]?.mean ?? r;
  const b = channels[2]?.mean ?? r;
  const round = (v: number) => Math.round(v);
  const dominant = stats.dominant
    ? ([stats.dominant.r, stats.dominant.g, stats.dominant.b] as [number, number, number])
    : ([round(r), round(g), round(b)] as [number, number, number]);
  return {
    avgBrightness: 0.299 * r + 0.587 * g + 0.114 * b,
    avgColor: [round(r), round(g), round(b)],
    dominant,
  };
}
