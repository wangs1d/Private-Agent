/** 美颜管线测试:磨皮/提亮/白皙/红润只作用于皮肤区,风格列表与引擎分发 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import {
  applyBeauty,
  buildSkinMask,
  BEAUTY_STYLES,
  listBeautyStyles,
  BatchService,
  SharpBatchEngine,
  SCENE_PRESETS,
} from '../src/index.js';
import { cleanupDir } from './helpers.js';

/** 构造合成图:左半为带噪点的皮肤色块(模拟毛孔),右半为平坦灰背景 */
async function createSyntheticPortrait(filePath: string): Promise<void> {
  const width = 200;
  const height = 100;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 3;
      if (x < width / 2) {
        // 皮肤色 + 噪点(高频毛孔)
        const noise = Math.round((Math.random() - 0.5) * 36);
        raw[o] = clamp8(214 + noise);
        raw[o + 1] = clamp8(164 + noise);
        raw[o + 2] = clamp8(148 + noise);
      } else {
        raw[o] = 120;
        raw[o + 1] = 120;
        raw[o + 2] = 120;
      }
    }
  }
  await sharp(raw, { raw: { width, height, channels: 3 } }).png().toFile(filePath);
}

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

async function readRaw(filePath: string): Promise<{ data: Buffer; info: sharp.OutputInfo }> {
  // 以 Buffer 读取,避免 Windows 上 sharp 路径读取句柄滞留
  const buffer = await fs.readFile(filePath);
  return sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
}

/** 相邻像素差的绝对值均值(高频能量代理指标) */
function highFrequencyEnergy(data: Buffer, width: number, height: number, region: 'skin' | 'bg'): number {
  const x0 = region === 'skin' ? 20 : 120;
  const x1 = region === 'skin' ? 80 : 180;
  let sum = 0;
  let count = 0;
  for (let y = 10; y < height - 10; y += 1) {
    for (let x = x0; x < x1 - 1; x += 1) {
      const o = (y * width + x) * 3;
      const oNext = o + 3;
      sum += Math.abs(data[o]! - data[oNext]!) + Math.abs(data[o + 1]! - data[oNext + 1]!);
      count += 1;
    }
  }
  return sum / count;
}

function regionMean(data: Buffer, width: number, height: number, region: 'skin' | 'bg'): { r: number; g: number; b: number } {
  const x0 = region === 'skin' ? 20 : 120;
  const x1 = region === 'skin' ? 80 : 180;
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let y = 10; y < height - 10; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const o = (y * width + x) * 3;
      r += data[o]!;
      g += data[o + 1]!;
      b += data[o + 2]!;
      count += 1;
    }
  }
  return { r: r / count, g: g / count, b: b / count };
}

test('buildSkinMask 识别皮肤色、排除灰色背景', () => {
  const rgb = Buffer.from([
    214, 164, 148, // 皮肤
    120, 120, 120, // 灰背景
    30, 30, 30, // 暗黑(低于亮度下限)
  ]);
  const mask = buildSkinMask(rgb, 3, 1);
  assert.equal(mask[0], 255);
  assert.equal(mask[1], 0);
  assert.equal(mask[2], 0);
});

test('磨皮降低皮肤高频,且背景不动', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'picture-beauty-'));
  t.after(() => cleanupDir(dir));
  const input = join(dir, 'portrait.png');
  const output = join(dir, 'smoothed.png');
  await createSyntheticPortrait(input);

  await applyBeauty(input, { skinSmooth: 85 }, output);
  const before = await readRaw(input);
  const after = await readRaw(output);
  const width = after.info.width;

  const skinBefore = highFrequencyEnergy(before.data, before.info.width, before.info.height, 'skin');
  const skinAfter = highFrequencyEnergy(after.data, width, after.info.height, 'skin');
  assert.ok(skinAfter < skinBefore * 0.6, `磨皮后皮肤高频应显著下降: ${skinBefore.toFixed(2)} -> ${skinAfter.toFixed(2)}`);

  // 背景无皮肤操作时基本不变(编码允许小误差)
  const bgBefore = regionMean(before.data, before.info.width, before.info.height, 'bg');
  const bgAfter = regionMean(after.data, width, after.info.height, 'bg');
  assert.ok(Math.abs(bgAfter.r - bgBefore.r) < 6, `背景不应被磨皮影响: ${bgBefore.r.toFixed(1)} -> ${bgAfter.r.toFixed(1)}`);
});

test('提亮/白皙/红润都只落在皮肤区', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'picture-beauty2-'));
  t.after(() => cleanupDir(dir));
  const input = join(dir, 'portrait.png');
  await createSyntheticPortrait(input);
  const before = await readRaw(input);

  const brightened = join(dir, 'bright.png');
  await applyBeauty(input, { skinBrighten: 60 }, brightened);
  const after = await readRaw(brightened);
  const skinBefore = regionMean(before.data, before.info.width, before.info.height, 'skin');
  const skinAfter = regionMean(after.data, after.info.width, after.info.height, 'skin');
  assert.ok(skinAfter.r > skinBefore.r + 8, `皮肤应被提亮: ${skinBefore.r.toFixed(1)} -> ${skinAfter.r.toFixed(1)}`);
  const bgAfter = regionMean(after.data, after.info.width, after.info.height, 'bg');
  assert.ok(Math.abs(bgAfter.r - 120) < 6);

  // 冷白皮:皮肤变亮且蓝通道相对提升
  const whitened = join(dir, 'white.png');
  await applyBeauty(input, { whiten: 60 }, whitened);
  const white = await readRaw(whitened);
  const skinWhite = regionMean(white.data, white.info.width, white.info.height, 'skin');
  assert.ok(skinWhite.r > skinBefore.r);
  assert.ok(skinWhite.b - skinBefore.b > (skinWhite.r - skinBefore.r) * 0.5, '白皙应比红通道更抬升蓝通道(偏冷)');

  // 红润:红/绿比上升
  const rosyPath = join(dir, 'rosy.png');
  await applyBeauty(input, { rosy: 70 }, rosyPath);
  const rosy = await readRaw(rosyPath);
  const skinRosy = regionMean(rosy.data, rosy.info.width, rosy.info.height, 'skin');
  assert.ok(skinRosy.r / skinRosy.g > skinBefore.r / skinBefore.g, '红润应提升 r/g 比');
});

test('风格列表与引擎美颜分发', async (t) => {
  const styles = listBeautyStyles();
  assert.equal(styles.length, 5);
  assert.deepEqual(styles.map((style) => style.id).sort(), ['cool_white', 'creamy', 'hongkong', 'japanese', 'natural']);

  const dir = await fs.mkdtemp(join(tmpdir(), 'picture-beauty3-'));
  t.after(() => cleanupDir(dir));
  const input = join(dir, 'p.png');
  await createSyntheticPortrait(input);

  // BatchService.processPhotos 走 style
  const batch = new BatchService(new SharpBatchEngine(), join(dir, 'out'));
  const result = await batch.processPhotos({ photoPaths: [input], style: 'natural' });
  assert.equal(result.count, 1);
  assert.equal(result.appliedAdjustments['skinSmooth'], BEAUTY_STYLES['natural']!.adjustments.skinSmooth);
  assert.equal(await fs.access(result.outputPaths[0]!).then(() => true, () => false), true);

  // 美颜场景预设
  assert.ok('beauty_portrait' in SCENE_PRESETS);
  assert.ok('selfie' in SCENE_PRESETS);
});
