/**
 * 画像行新鲜度 sidecar + 隐身会话判定测试（2026-09-29 P1-1/P0-1a 配套）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  parseProfileLines,
  touchProfileLines,
  rebuildProfileMeta,
  listStaleLines,
  readProfileMeta,
} from "../src/brain/profile-lines-meta.js";
import { UserProfileStore } from "../src/services/user-personalization/user-profile-store.js";
import { isIncognitoChatSessionId } from "../src/agent/master-chat-session.js";

const PROFILE_A = `# 用户画像

## 基本信息

- 称呼：顾清梧
- 所在地：苏州

## 兴趣与习惯

- 喜欢黑胶唱机修复
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 在隔离目录建 meta 环境（AGENT_USER_PROFILE_DIR 指向临时目录） */
function withTempDir(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-meta-"));
    const prev = process.env.AGENT_USER_PROFILE_DIR;
    process.env.AGENT_USER_PROFILE_DIR = dir;
    try {
      await new UserProfileStore().write("actor-t", PROFILE_A);
      await fn();
    } finally {
      if (prev === undefined) delete process.env.AGENT_USER_PROFILE_DIR;
      else process.env.AGENT_USER_PROFILE_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("parseProfileLines：只取内容行并归属 section", () => {
  const lines = parseProfileLines(PROFILE_A);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0], { section: "基本信息", line: "称呼：顾清梧" });
  assert.equal(lines[2]!.section, "兴趣与习惯");
});

test(
  "touch：证实行刷新 lastConfirmedAt/seenCount，未证实新行补录 seenCount=0",
  withTempDir(async () => {
    await touchProfileLines("actor-t", PROFILE_A, ["称呼：顾清梧"]);
    await sleep(20);
    const meta = await readProfileMeta("actor-t");
    const confirmed = meta.find((m) => m.line === "称呼：顾清梧")!;
    const bystander = meta.find((m) => m.line === "所在地：苏州")!;
    const fresh = meta.find((m) => m.line === "喜欢黑胶唱机修复")!;
    assert.ok(confirmed.seenCount >= 1);
    assert.equal(bystander.seenCount, 0, "存在但未证实的行 seenCount=0");
    assert.ok(fresh, "画像中的行全部有 meta");
    assert.equal(new Date(confirmed.lastConfirmedAt).getTime() >= new Date(bystander.lastConfirmedAt).getTime(), true);
  }),
);

test(
  "stale：lastConfirmedAt 早于阈值的行被列出，新鲜的不会",
  withTempDir(async () => {
    const old = new Date(Date.now() - 120 * 86_400_000).toISOString();
    await touchProfileLines("actor-t", PROFILE_A, []);
    // 手工把「所在地：苏州」改老
    const meta = await readProfileMeta("actor-t");
    assert.ok(meta.length >= 3);
    await sleep(10);
    // 直接写文件模拟陈旧（readProfileMeta 走同一 loadMeta）
    const { readFile, writeFile } = await import("node:fs/promises");
    const { dirname, join } = await import("node:path");
    const store = new UserProfileStore();
    const metaPath = join(dirname(store.profilePath("actor-t")), "profile-lines-meta.json");
    const raw = JSON.parse(await readFile(metaPath, "utf8"));
    for (const m of Object.values<typeof raw[string]>(raw)) {
      if (m.line === "所在地：苏州") m.lastConfirmedAt = old;
    }
    await writeFile(metaPath, JSON.stringify(raw), "utf8");
    const stale = await listStaleLines("actor-t", PROFILE_A, 90 * 86_400_000);
    assert.equal(stale.length, 1);
    assert.equal(stale[0]!.line, "所在地：苏州");
  }),
);

test(
  "rebuild：整文重写后消失行的 meta 回收、保留行 meta 保留",
  withTempDir(async () => {
    await touchProfileLines("actor-t", PROFILE_A, ["称呼：顾清梧"]);
    const before = await readProfileMeta("actor-t");
    assert.ok(before.find((m) => m.line === "所在地：苏州"));
    const rewritten = PROFILE_A.replace("- 所在地：苏州\n", "").replace("- 喜欢黑胶唱机修复", "- 爱好：黑胶唱机修复");
    await rebuildProfileMeta("actor-t", rewritten);
    const after = await readProfileMeta("actor-t");
    assert.ok(!after.find((m) => m.line === "所在地：苏州"), "消失行 meta 回收");
    assert.ok(after.find((m) => m.line === "称呼：顾清梧"), "保留行 meta 保留");
    assert.ok(after.find((m) => m.line === "爱好：黑胶唱机修复"), "改写行按新行补录");
  }),
);

test("incognito：incognito: 前缀判定，notes:/普通会话不受影响", () => {
  assert.equal(isIncognitoChatSessionId("incognito:abc-1"), true);
  assert.equal(isIncognitoChatSessionId("incognito:"), true);
  assert.equal(isIncognitoChatSessionId("abc-1"), false);
  assert.equal(isIncognitoChatSessionId("notes:abc"), false);
  assert.equal(isIncognitoChatSessionId(undefined), false);
  assert.equal(isIncognitoChatSessionId(null), false);
});
