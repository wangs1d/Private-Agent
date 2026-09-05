/** PictureKit 门面与工具路由端到端测试 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createPictureKit,
  OpenAIImageProvider,
  ImageGenerationService,
  ToolRegistry,
  makeSchema,
} from '../src/index.js';
import { createTestImage, cleanupDir } from './helpers.js';

test('createPictureKit:注册 11 个工具并可通过 invoke 路由', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'picture-kit-'));
  t.after(() => cleanupDir(dir));

  const kit = await createPictureKit({ rootDir: join(dir, 'data'), batchOutputDir: join(dir, 'batch') });
  const names = kit.listTools().map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'batch', 'evaluation', 'gallery', 'guidance', 'habit', 'image_analyze',
    'image_generate', 'image_process', 'image_store', 'presets', 'thumbnail',
  ]);

  // 未注册生成 Provider 时,生成工具应报错而不是崩溃
  const genFail = await kit.invokeRaw('image_generate', { prompt: '一只猫' });
  assert.equal(genFail.success, false);

  // gallery upload → image_store query → image_analyze → thumbnail
  const img = join(dir, 'photo.png');
  await createTestImage(img, { width: 1000, height: 500, r: 10, g: 100, b: 200 });

  const upload = await kit.invokeRaw('gallery', { action: 'upload', file_path: img });
  assert.equal(upload.success, true);
  const photoId = (upload.result!['photo'] as { id: string }).id;

  const query = await kit.invokeRaw('image_store', { action: 'query', filters: { tags: ['landscape'] } });
  assert.equal(query.success, true);
  assert.ok((query.result!['total'] as number) >= 1);

  const analyzed = await kit.invokeRaw('image_analyze', { input: img });
  assert.equal(analyzed.success, true);
  assert.equal((analyzed.result!['result'] as { width: number }).width, 1000);

  const thumb = await kit.invokeRaw('thumbnail', { action: 'generate', input: img, asset_id: photoId, sizes: ['small'] });
  assert.equal(thumb.success, true);

  const resized = await kit.invokeRaw('image_process', {
    action: 'resize', input: img, width: 200, height: 100,
  });
  assert.equal(resized.success, true);

  // 未知工具与未知 action
  const missing = await kit.invokeRaw('nope', {});
  assert.equal(missing.success, false);
  assert.match(missing.error!, /Tool not found/);
  const badAction = await kit.invokeRaw('gallery', { action: 'nope' });
  assert.equal(badAction.success, false);
});

test('OpenAIImageProvider 兼容接口(mock fetch)与生成落盘', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'picture-gen-'));
  t.after(() => cleanupDir(dir));

  const png = await sharpPng();
  const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init!.body!);
    assert.equal(body.prompt, '一只橘猫');
    assert.equal(body.model, 'gpt-image-1');
    const payload = { data: [{ b64_json: png.toString('base64'), revised_prompt: '一只可爱的橘猫' }] };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  const provider = new OpenAIImageProvider({ apiKey: 'sk-test', baseUrl: 'https://example.com/v1', fetchImpl });
  const generation = new ImageGenerationService();
  generation.registerProvider(provider, true);

  const images = await generation.generate({
    prompt: '一只橘猫',
    outputDir: join(dir, 'gen'),
    fileNamePrefix: 'cat',
  });
  assert.equal(images.length, 1);
  assert.equal(images[0]!.width, 8);
  assert.ok(await fs.access(images[0]!.outputPath).then(() => true, () => false));

  // 错误响应抛出
  const failingProvider = new OpenAIImageProvider({
    apiKey: 'sk-test',
    fetchImpl: (async () => new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 429 })) as unknown as typeof fetch,
  });
  const failingService = new ImageGenerationService();
  failingService.registerProvider(failingService.hasProvider() ? failingService.getProvider() : failingProvider, true);
  await assert.rejects(
    () => failingService.generate({ prompt: 'x', outputDir: join(dir, 'gen2') }),
    /quota exceeded/,
  );
});

test('ToolRegistry:重复注册报错,注销后可重新注册', () => {
  const registry = new ToolRegistry();
  const definition = { name: 'demo', description: 'demo', inputSchema: makeSchema({}), outputSchema: makeSchema({}) };
  registry.register(definition, () => ({ ok: true }));
  assert.throws(() => registry.register(definition, () => ({})));
  registry.unregister('demo');
  registry.register(definition, () => ({ ok: true }));
  assert.equal(registry.listTools().length, 1);
});

async function sharpPng(): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  return sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 255, g: 180, b: 0 } } }).png().toBuffer();
}
