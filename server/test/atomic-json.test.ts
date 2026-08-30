/**
 * 原子 JSON 落盘单元测试。
 *
 * 原子写是记忆图谱/聊天线程等核心存储的损坏防线：
 * 直接 writeFile 覆盖在写入中途崩溃会留下截断 JSON（数据全丢），
 * writeJsonAtomic 通过"临时文件 + rename"保证目标文件始终是完整版本。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeJsonAtomic } from "../src/storage/atomic-json.js";

test("writeJsonAtomic: 写入后文件内容完整且可解析", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atomic-json-"));
  try {
    const file = join(dir, "nested", "store.json");
    await writeJsonAtomic(file, { nodes: { a: 1 }, edges: [] });

    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    assert.deepEqual(parsed, { nodes: { a: 1 }, edges: [] });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("writeJsonAtomic: 覆盖写替换旧内容，且不残留临时文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atomic-json-"));
  try {
    const file = join(dir, "store.json");
    await writeJsonAtomic(file, { version: 1 });
    await writeJsonAtomic(file, { version: 2 });

    const parsed = JSON.parse(await readFile(file, "utf8"));
    assert.equal(parsed.version, 2);

    const leftover = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftover, [], "不应残留 .tmp 临时文件");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("writeJsonAtomic: 目标文件已损坏时仍能整体替换", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atomic-json-"));
  try {
    const file = join(dir, "store.json");
    // 模拟历史损坏文件（截断 JSON）
    await writeJsonAtomic(file, { broken: true });
    const { writeFile: rawWrite } = await import("node:fs/promises");
    await rawWrite(file, '{"nodes": {"a": ', "utf8");

    await writeJsonAtomic(file, { fixed: true });

    const parsed = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(parsed, { fixed: true });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
