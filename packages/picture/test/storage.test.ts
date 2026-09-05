/** 存储管理模块测试:入库/去重/查询/标签/清理/持久化 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ImageStore } from '../src/index.js';
import { createTestImage, cleanupDir } from './helpers.js';

async function makeStore(t: import('node:test').TestContext): Promise<{ store: ImageStore; dir: string }> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'picture-store-'));
  t.after(() => cleanupDir(dir));
  const store = new ImageStore({ rootDir: dir });
  await store.init();
  return { store, dir };
}

test('入库生成资产、缩略图与索引,重复内容命中去重', async (t) => {
  const { store, dir } = await makeStore(t);
  const imgA = join(dir, 'a.png');
  const imgB = join(dir, 'b.png');
  await createTestImage(imgA, { r: 200, g: 10, b: 10 });
  await createTestImage(imgB, { r: 10, g: 200, b: 10 });

  const first = await store.ingest(imgA, { tags: ['red'] });
  assert.equal(first.deduplicated, false);
  assert.equal(first.asset.tags.includes('red'), true);
  assert.ok(first.asset.thumbnails && Object.keys(first.asset.thumbnails).length === 3);
  assert.equal(await fs.access(first.asset.filePath).then(() => true, () => false), true);

  const duplicate = await store.ingest(imgA, { dedupe: true });
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.asset.id, first.asset.id);

  const second = await store.ingest(imgB, { autoTag: true });
  assert.equal(second.deduplicated, false);

  const stats = store.stats();
  assert.equal(stats.count, 2);
  assert.equal(stats.byFormat['png'], 2);
  assert.equal(stats.thumbCount, 6);
});

test('查询:标签/评分/排序/分页', async (t) => {
  const { store, dir } = await makeStore(t);
  const mk = async (r: number, g: number, b: number) => {
    const path = join(dir, `img-${r}-${g}-${b}.png`);
    await createTestImage(path, { r, g, b });
    return path;
  };
  const a = await store.ingest(await mk(255, 0, 0), { tags: ['warm', 'red'] });
  const b = await store.ingest(await mk(0, 255, 0), { tags: ['green'] });
  await store.setRating(a.asset.id, 90);
  await store.setRating(b.asset.id, 60);

  const byTag = await store.query({ filters: { tags: ['warm'] } });
  assert.equal(byTag.total, 1);
  assert.equal(byTag.items[0]!.id, a.asset.id);

  const byRating = await store.query({ filters: { ratingMin: 80 } });
  assert.equal(byRating.total, 1);
  assert.equal(byRating.items[0]!.id, a.asset.id);

  const sorted = await store.query({ sortBy: 'rating', sortOrder: 'asc' });
  assert.equal(sorted.items[0]!.id, b.asset.id);

  const paged = await store.query({ page: 2, pageSize: 1 });
  assert.equal(paged.total, 2);
  assert.equal(paged.items.length, 1);
  assert.equal(paged.page, 2);
});

test('标签与评分修改并持久化,非法评分报错', async (t) => {
  const { store, dir } = await makeStore(t);
  const img = join(dir, 'x.png');
  await createTestImage(img);
  const { asset } = await store.ingest(img);

  await store.addTag(asset.id, 'favo');
  await store.removeTag(asset.id, 'favo');
  await store.setSceneType(asset.id, 'street');
  await store.setRating(asset.id, 88.4);

  const updated = store.require(asset.id);
  // 入库时自动打上了 landscape 标签,add+remove 后应只剩自动标签
  assert.deepEqual(updated.tags, ['landscape']);
  assert.equal(updated.sceneType, 'street');
  assert.equal(updated.rating, 88);

  await assert.rejects(() => store.setRating(asset.id, 120));

  // 重新加载索引后数据仍在
  const reloaded = new ImageStore({ rootDir: dir });
  await reloaded.init();
  assert.equal(reloaded.require(asset.id).rating, 88);
  assert.equal(reloaded.require(asset.id).sceneType, 'street');
});

test('删除资产与孤儿清理', async (t) => {
  const { store, dir } = await makeStore(t);
  const img = join(dir, 'y.png');
  await createTestImage(img);
  const { asset } = await store.ingest(img);
  const assetPath = asset.filePath;

  // 写入一个未被索引引用的孤儿资产文件
  const orphan = join(dir, 'assets', 'orphan.bin');
  await fs.writeFile(orphan, 'junk');

  const cleanup = await store.cleanupOrphans();
  assert.deepEqual(cleanup.removedAssets, ['orphan.bin']);

  assert.equal(await store.remove(asset.id), true);
  assert.equal(await fs.access(assetPath).then(() => true, () => false), false);
  assert.equal(store.get(asset.id), null);
  assert.equal(await store.remove(asset.id), false);
});
