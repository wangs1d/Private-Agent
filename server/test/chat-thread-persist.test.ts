/**
 * chat-thread-persist 启动竞态回归测试（2026-09-08）。
 *
 * 实测事故：dev server watch 重启时，load()（异步读文件）尚未完成，
 * 早到的落盘（scheduleSave/deleteSession/flushToDisk）以空骨架 this.data
 * 全量覆写 chat-threads.json——全部会话上下文丢失。
 *
 * 本文件锁定契约：初始 load 完成前，任何写入/删除必须等待；
 * load 期间到达的写入不得丢失；删除必须作用在已加载的数据上。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

const { ChatThreadPersistence } = await import("../src/external-model/chat-thread-persist.js");

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** debounce 250ms < 慢读取 400ms：保证「落盘触发时 load 尚未完成」的窗口确定复现。 */
const SLOW_READ_MS = 400;

function slowReader(): (path: string) => Promise<string> {
  return async (path) => {
    await delay(SLOW_READ_MS);
    return readFile(path, "utf8");
  };
}

test("启动竞态守卫：load 完成前到达的落盘必须等待，不得用空骨架覆盖既有会话", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thread-persist-race-"));
  const file = join(dir, "chat-threads.json");
  const notes = join(dir, "chat-threads-notes.json");
  writeFileSync(
    file,
    JSON.stringify({
      sessions: {
        "session-existing": {
          updatedAt: new Date().toISOString(),
          messages: [{ role: "user", content: "既有上下文" }],
        },
      },
    }),
  );

  const persist = new ChatThreadPersistence(file, notes, slowReader());
  const loading = persist.load();
  // load 未完成时，另一会话的写入到达（真实场景：boot 期间的首次对话/后台会话）
  persist.scheduleSave("session-new", [{ role: "user", content: "新会话消息" }]);
  await loading;
  await delay(400); // debounce 250ms + flush 链

  const data = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(data.sessions["session-existing"], "既有会话必须存活（竞态修复前会被空数据覆盖）");
  assert.ok(data.sessions["session-new"], "load 期间到达的新会话写入不得丢失");
  assert.match(
    JSON.stringify(data.sessions["session-existing"].messages),
    /既有上下文/,
    "既有会话内容必须完整保留",
  );
});

test("启动竞态守卫：load 完成前到达的删除，作用在已加载的数据上", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thread-persist-del-"));
  const file = join(dir, "chat-threads.json");
  writeFileSync(
    file,
    JSON.stringify({
      sessions: {
        "session-to-remove": {
          updatedAt: new Date().toISOString(),
          messages: [{ role: "user", content: "待删除" }],
        },
        "session-keep": {
          updatedAt: new Date().toISOString(),
          messages: [{ role: "user", content: "保留" }],
        },
      },
    }),
  );

  const persist = new ChatThreadPersistence(
    file,
    join(dir, "chat-threads-notes.json"),
    slowReader(),
  );
  const loading = persist.load();
  persist.deleteSession("session-to-remove");
  await loading;
  await delay(400);

  const data = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(!data.sessions["session-to-remove"], "删除意图必须生效");
  assert.ok(data.sessions["session-keep"], "其他会话不受影响");
});
