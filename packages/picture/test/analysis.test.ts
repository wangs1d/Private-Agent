/** 图像解析模块测试:EXIF 解析 / 拍摄时间 / 有理数 / 分析服务 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseExif,
  exifTimeToIso,
  parseRational,
  ImageAnalysisService,
} from '../src/index.js';
import { buildJpegWithExif, createTestImage, cleanupDir } from './helpers.js';

test('parseExif 解析手工构造的 JPEG EXIF', () => {
  const jpeg = buildJpegWithExif();
  const exif = parseExif(jpeg);
  assert.equal(exif['EXIF DateTimeOriginal'], '2024:01:15 10:30:00');
  assert.equal(exif['EXIF FocalLength'], '35/1');
});

test('exifTimeToIso 转换 EXIF 时间', () => {
  assert.ok(exifTimeToIso('2024:01:15 10:30:00'));
  assert.equal(exifTimeToIso('not a time'), null);
  assert.equal(exifTimeToIso(undefined), null);
});

test('parseRational 解析 exifread 风格有理数', () => {
  assert.equal(parseRational('300/1'), 300);
  assert.equal(parseRational('35/10'), 3.5);
  assert.equal(parseRational('50'), 50);
  assert.equal(parseRational(undefined), null);
  assert.equal(parseRational('1/0'), null);
});

test('ImageAnalysisService.parse 输出尺寸/哈希/统计/自动标签', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'picture-analysis-'));
  t.after(() => cleanupDir(dir));

  const filePath = join(dir, 'photo.png');
  await createTestImage(filePath, { width: 2400, height: 1200, r: 30, g: 30, b: 30 });

  const service = new ImageAnalysisService();
  const parsed = await service.parse(filePath);

  assert.equal(parsed.width, 2400);
  assert.equal(parsed.height, 1200);
  assert.equal(parsed.format, 'png');
  assert.equal(parsed.fileSize! > 0, true);
  assert.match(parsed.sha256!, /^[0-9a-f]{64}$/);
  assert.equal(parsed.autoTags.includes('landscape'), true);
  assert.equal(parsed.autoTags.includes('high_res'), true);
  assert.equal(parsed.autoTags.includes('low_light'), true);
  assert.ok(parsed.stats.avgBrightness >= 0 && parsed.stats.avgBrightness <= 255);

  // Buffer 输入同样可解析
  const buffer = await fs.readFile(filePath);
  const parsed2 = await service.parse(buffer);
  assert.equal(parsed2.sha256, parsed.sha256);
});

test('手工 EXIF JPEG 提取拍摄时间与焦段(不经 sharp,构造字节无真实像素)', async (t) => {
  const service = new ImageAnalysisService();
  const jpeg = buildJpegWithExif();
  const exif = parseExif(jpeg);
  assert.equal(service.parseFocalLength(exif), 35);
  const iso = service.parseTakenAt(exif);
  assert.ok(iso);
  assert.equal(iso!.startsWith('2024-01-15'), true);
});
