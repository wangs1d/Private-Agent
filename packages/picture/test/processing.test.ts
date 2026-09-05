/** 图像处理 / 缩略图 / 批图模块测试 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ImageProcessingService,
  ThumbnailService,
  THUMBNAIL_SIZES,
  BatchService,
  SharpBatchEngine,
  SCENE_PRESETS,
} from '../src/index.js';
import { createTestImage, cleanupDir } from './helpers.js';

test('resize / rotate / convert 输出正确的尺寸与格式', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'picture-process-'));
  t.after(() => cleanupDir(dir));
  const input = join(dir, 'src.png');
  await createTestImage(input, { width: 800, height: 600 });

  const processing = new ImageProcessingService();

  const resized = await processing.resize(input, { width: 320, height: 240, fit: 'cover' });
  assert.equal(resized.width, 320);
  assert.equal(resized.height, 240);
  assert.ok(resized.outputPath.includes('processed_'));

  const rotated = await processing.rotate(input, 90);
  assert.equal(rotated.width, 600);
  assert.equal(rotated.height, 800);

  const converted = await processing.convert(input, { format: 'webp', quality: 80 });
  assert.equal(converted.format, 'webp');

  const cropped = await processing.crop(input, { left: 10, top: 10, width: 100, height: 80 });
  assert.equal(cropped.width, 100);
  assert.equal(cropped.height, 80);

  const info = await processing.info(input);
  assert.equal(info.width, 800);
});

test('adjust 亮度调整确实改变平均亮度', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'picture-adjust-'));
  t.after(() => cleanupDir(dir));
  const input = join(dir, 'src.png');
  await createTestImage(input, { width: 64, height: 64, r: 100, g: 100, b: 100 });

  const processing = new ImageProcessingService();
  const brighter = await processing.adjust(input, { brightness: 50 }, join(dir, 'bright.webp'));
  assert.ok(brighter.fileSize > 0);

  const { computeImageStats } = await import('../src/index.js');
  // 以 Buffer 读取,避免 Windows 上 sharp 路径读取句柄滞留
  const before = await computeImageStats(await fs.readFile(input));
  const after = await computeImageStats(await fs.readFile(brighter.outputPath));
  assert.ok(after.avgBrightness > before.avgBrightness);

  // 色温:暖色提升红通道
  const warm = await processing.adjust(input, { temperature: 50 }, join(dir, 'warm.webp'));
  const warmStats = await computeImageStats(await fs.readFile(warm.outputPath));
  assert.ok(warmStats.avgColor[0]! >= warmStats.avgColor[2]!);
});

test('ThumbnailService 生成三个尺寸并可获取/删除', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'picture-thumb-'));
  t.after(() => cleanupDir(dir));
  const input = join(dir, 'src.png');
  await createTestImage(input, { width: 2000, height: 1000 });

  const thumbs = new ThumbnailService(join(dir, 'thumbs'));
  const paths = await thumbs.generate(input, 'asset1');
  assert.deepEqual(Object.keys(paths).sort(), Object.keys(THUMBNAIL_SIZES).sort());
  for (const path of Object.values(paths)) {
    assert.equal(await fs.access(path).then(() => true, () => false), true);
  }
  assert.equal(thumbs.get('asset1', 'small'), paths['small']);
  assert.equal(thumbs.get('missing', 'small'), null);

  await thumbs.remove('asset1');
  assert.equal(thumbs.get('asset1', 'small'), null);
});

test('BatchService 场景预设匹配与习惯融合', () => {
  const batch = new BatchService(new SharpBatchEngine(), join(tmpdir(), 'unused'));
  assert.deepEqual(batch.matchPreset('night'), SCENE_PRESETS['night']);
  assert.deepEqual(batch.matchPreset('unknown_scene'), SCENE_PRESETS['default']);

  // 融合:preset*0.7 + habit*0.3,四舍五入
  const blended = batch.matchPreset('night', { batchStyleAvg: { brightness: 0 } });
  assert.equal(blended['brightness'], Math.round(8 * 0.7 + 0 * 0.3));
  assert.equal(blended['contrast'], 10);

  // 批图预设 CRUD
  const preset = batch.createBatchPreset('测试风格', 'street', { contrast: 10 });
  assert.equal(batch.listBatchPresets('street').length, 1);
  batch.updateBatchPreset(preset.id, { name: '改名' });
  assert.equal(batch.getBatchPreset(preset.id)?.name, '改名');
  assert.equal(batch.deleteBatchPreset(preset.id), true);
  assert.throws(() => batch.deleteBatchPreset(preset.id));
});

test('BatchService 批处理输出与前后对比', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'picture-batch-'));
  t.after(() => cleanupDir(dir));
  const a = join(dir, 'a.png');
  const b = join(dir, 'b.png');
  await createTestImage(a, { r: 90, g: 90, b: 90 });
  await createTestImage(b, { r: 120, g: 120, b: 120 });

  const batch = new BatchService(new SharpBatchEngine(), join(dir, 'out'));
  const result = await batch.processPhotos({ photoPaths: [a, b], sceneType: 'street' });
  assert.equal(result.count, 2);
  assert.deepEqual(result.appliedAdjustments, SCENE_PRESETS['street']);
  for (const output of result.outputPaths) {
    assert.equal(await fs.access(output).then(() => true, () => false), true);
  }

  const comparison = await batch.compareBeforeAfter(a, result.outputPaths[0]!);
  assert.equal(comparison.original.width, 64);
  assert.ok(Number.isFinite(comparison.brightnessDiff));

  const andCompare = await batch.processAndCompare(a, { brightness: 30 });
  assert.equal(andCompare.originalPath, a);
  assert.ok(Number.isFinite(andCompare.comparison.brightnessDiff));
});
