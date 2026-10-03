/**
 * 模型接入目录（/api/model-providers）单测：
 *  1. 仓库 config/model-providers.json 可读且条目自洽（defaultModel 必须在 models 里、
 *     baseUrl/consoleUrl 均为 https、id 唯一）——目录是向导/设置页的唯一数据源，写错即线上事故；
 *  2. 目录缺失/损坏时回退内置兜底（接口必须始终可用，与 client-manifest 同一容错哲学）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { readModelProviderCatalog, registerModelProviderRoutes } = await import(
  "../src/routes/http/model-providers.js"
);

test("catalog: 仓库目录文件可读且条目自洽", async () => {
  const catalog = await readModelProviderCatalog();
  assert.ok(catalog.providers.length >= 6, "至少 6 家服务商");
  for (const p of catalog.providers) {
    assert.match(p.baseUrl, /^https:\/\//, `${p.id} baseUrl 必须 https`);
    if (p.consoleUrl) assert.match(p.consoleUrl, /^https:\/\//, `${p.id} consoleUrl 必须 https`);
    const ids = p.models.map((m) => m.id);
    assert.ok(ids.length > 0, `${p.id} models 不能为空`);
    assert.ok(
      ids.includes(p.defaultModel),
      `${p.id} 的 defaultModel(${p.defaultModel}) 必须在 models 里`,
    );
  }
  const ids = catalog.providers.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "provider id 必须唯一");
  assert.ok(ids.includes("deepseek"), "国内主推 DeepSeek 在列");
});

test("catalog: 目录缺失时回退内置兜底", async () => {
  const missing = join(tmpdir(), `model-providers-missing-${Date.now()}`);
  const catalog = await readModelProviderCatalog(missing);
  assert.ok(catalog.providers.length >= 4);
  assert.match(catalog.providers[0].baseUrl, /^https:\/\//);
});

test("catalog: 损坏条目被过滤，好条目保留", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-providers-"));
  await writeFile(
    join(dir, "model-providers.json"),
    JSON.stringify({
      version: 2,
      providers: [
        { id: "ok", name: "OK", baseUrl: "https://ok.example/v1", defaultModel: "m1", models: [{ id: "m1" }] },
        { id: "broken", name: "Broken" }, // 缺 baseUrl/defaultModel/models → 过滤
        "not-an-object",
      ],
    }),
    "utf8",
  );
  const catalog = await readModelProviderCatalog(dir);
  assert.equal(catalog.version, 2);
  assert.deepEqual(catalog.providers.map((p) => p.id), ["ok"]);
});

test("catalog: 路由注册函数已导出（真链由运行中的 runtime curl 验证）", () => {
  assert.equal(typeof registerModelProviderRoutes, "function");
});
