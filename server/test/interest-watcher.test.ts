// InterestWatcher 单元测试：兴趣池管理、匹配、去重、间隔、衰减、持久化。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InterestWatcher,
  normalizeFp,
  interestMatches,
  type InterestHit,
} from "../src/proactivity/interest-watcher.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function makeWatcher(opts?: {
  hits?: InterestHit[];
  onHit?: (actorId: string, name: string, title: string) => void;
  now?: () => number;
  persistPath?: string;
  minPushIntervalMs?: number;
}) {
  const base = new InterestWatcher({
    fetchHot: async () => opts?.hits ?? [],
    now: opts?.now,
    minPushIntervalMs: opts?.minPushIntervalMs,
    persistPath: opts?.persistPath ?? join(tmpdir(), "iw-test.json"),
  });
  if (opts?.onHit) {
    base.setOnHit((actorId, interest, hit) => opts.onHit!(actorId, interest.name, hit.title));
  }
  return base;
}

test("addInterest：同名合并并自增 mentionCount，新对象保留 firstSeenAt", async () => {
  let ts = 1_000_000;
  const watcher = makeWatcher({ now: () => ts });
  await watcher.addInterest("u1", "刘浩存", "person");
  ts += 1000;
  await watcher.addInterest("u1", "刘浩存", "person");
  const list = watcher.listInterests("u1");
  assert.equal(list.length, 1);
  assert.equal(list[0].mentionCount, 2);
  assert.equal(list[0].firstSeenAt, 1_000_000);
  assert.equal(list[0].lastSeenAt, 1_001_000);
  assert.equal(list[0].type, "person");
});

test("addInterest：池容量上限 50 后拒绝新增", async () => {
  const watcher = makeWatcher();
  for (let i = 0; i < 50; i++) await watcher.addInterest("u1", `兴趣${i}`);
  await assert.rejects(() => watcher.addInterest("u1", "第51个"), /满/);
});

test("removeInterest：支持按名字和按 id 移除", async () => {
  const watcher = makeWatcher();
  await watcher.addInterest("u1", "刘浩存", "person");
  await watcher.addInterest("u1", "王者荣耀", "game");
  let list = await watcher.removeInterest("u1", "刘浩存");
  assert.deepEqual(list.map((i) => i.name), ["王者荣耀"]);
  const id = list[0].id;
  list = await watcher.removeInterest("u1", id);
  assert.equal(list.length, 0);
});

test("listForPrompt：只列出 enabled，无兴趣返回 null（零注入）", async () => {
  const watcher = makeWatcher();
  assert.equal(watcher.listForPrompt("u1"), null);
  await watcher.addInterest("u1", "刘浩存", "person");
  await watcher.addInterest("u1", "王者荣耀", "game");
  const text = watcher.listForPrompt("u1");
  assert.ok(text?.includes("刘浩存"));
  assert.ok(text?.includes("人物"));
  assert.ok(text?.includes("王者荣耀"));
});

test("持久化：load 恢复上次新增的兴趣", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iw-persist-"));
  const file = join(dir, "pool.json");
  const watcher = makeWatcher({ persistPath: file });
  await watcher.addInterest("u1", "刘浩存", "person");
  const reloaded = makeWatcher({ persistPath: file });
  await reloaded.load();
  const list = reloaded.listInterests("u1");
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "刘浩存");
  assert.equal(list[0].type, "person");
  await rm(dir, { recursive: true, force: true });
});

test("interestMatches：归一化包含匹配（中文/符号容错）", () => {
  const interest = { name: "刘浩存" } as { name: string };
  assert.equal(interestMatches(interest as never, { title: "刘浩存新片官宣定档" }), true);
  assert.equal(interestMatches(interest as never, { title: "某某明星街拍" }), false);
  // 长度 <2 的泛词不参与匹配（防单字符误伤）
  assert.equal(interestMatches({ name: "V" } as never, { title: "V 时代来了" }), false);
});

test("normalizeFp：去符号小写", () => {
  assert.equal(normalizeFp("刘浩存 新片 官宣！"), "刘浩存新片官宣");
  assert.equal(normalizeFp("abc  Def-123"), "abcdef123");
});

test("checkInterest：热搜命中 → onHit + 指纹去重 + 间隔拦截", async () => {
  const hits: InterestHit[] = [];
  const pushed: Array<{ actorId: string; name: string; title: string }> = [];
  const watcher = makeWatcher({
    minPushIntervalMs: 2 * HOUR,
    hits,
    onHit: (actorId, name, title) => pushed.push({ actorId, name, title }),
  });
  await watcher.addInterest("u1", "刘浩存", "person");

  const now0 = 10_000_000;
  // 第 1 次：热搜命中 → 推
  hits.push({ title: "刘浩存新片官宣", platform: "weibo", hot: "热" });
  assert.equal(watcher.checkInterest(watcher.listInterests("u1")[0], hits, now0), true);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].title, "刘浩存新片官宣");

  // 第 2 次（同一条热搜仍在，1h 后）：指纹相同 → 不推
  assert.equal(watcher.checkInterest(watcher.listInterests("u1")[0], hits, now0 + HOUR), false);
  assert.equal(pushed.length, 1);

  // 第 3 次（换新热搜，但距上次仅 1h < 2h 间隔）：不推
  hits[0] = { title: "刘浩存获奖实至名归", platform: "baidu" };
  assert.equal(watcher.checkInterest(watcher.listInterests("u1")[0], hits, now0 + HOUR), false);
  assert.equal(pushed.length, 1);

  // 第 4 次（新热搜 + 已过 2h 间隔）：推新热点
  assert.equal(watcher.checkInterest(watcher.listInterests("u1")[0], hits, now0 + 2 * HOUR + 1), true);
  assert.equal(pushed.length, 2);
  assert.equal(pushed[1].title, "刘浩存获奖实至名归");
});

test("checkInterest：未命中热搜时不动状态（不占推送位）", async () => {
  const pushed: string[] = [];
  const watcher = makeWatcher({
    hits: [{ title: "无关热点", platform: "weibo" }],
    onHit: (_a, _n, title) => pushed.push(title),
  });
  await watcher.addInterest("u1", "刘浩存", "person");
  const interest = watcher.listInterests("u1")[0];
  assert.equal(watcher.checkInterest(interest, watcher.listInterests("u1"), 1_000_000), false);
  assert.equal(pushed.length, 0);
  assert.equal(interest.lastPushedFp, null);
  // 热搜拉取失败/为空时 checkAll 静默跳过
  const empty = makeWatcher({ hits: [] });
  await empty.addInterest("u1", "刘浩存", "person");
  assert.equal(await empty.checkAll(1_000_000), 0);
});

test("checkAll：单次热搜匹配多用户多兴趣，仅对命中者推送", async () => {
  const pushed: string[] = [];
  const watcher = makeWatcher({
    hits: [
      { title: "刘浩存新片官宣", platform: "weibo" },
      { title: "王者荣耀S35赛季开启", platform: "baidu" },
    ],
    minPushIntervalMs: 0,
    onHit: (_a, name) => pushed.push(name),
  });
  await watcher.addInterest("u1", "刘浩存", "person");
  await watcher.addInterest("u1", "王者荣耀", "game");
  await watcher.addInterest("u1", "某不相关", "other");
  await watcher.addInterest("u2", "刘浩存", "person");

  const pushedCount = await watcher.checkAll(5_000_000);
  assert.equal(pushedCount, 3); // u1 两条 + u2 一条
  assert.deepEqual(pushed.sort(), ["刘浩存", "刘浩存", "王者荣耀"].sort());
});

test("applyDecay：30 天未提及降权（enabled=false），60 天移除", async () => {
  const watcher = makeWatcher();
  const now = Date.now();
  await watcher.addInterest("u1", "旧兴趣A");
  await watcher.addInterest("u1", "旧兴趣B");
  // 按名字拿稳定引用：A → 31 天前（降权线）；B → 61 天前（移除线）
  const a = watcher.listInterests("u1").find((i) => i.name === "旧兴趣A")!;
  const b = watcher.listInterests("u1").find((i) => i.name === "旧兴趣B")!;
  a.lastSeenAt = now - 31 * DAY;
  b.lastSeenAt = now - 61 * DAY;
  watcher.applyDecay(now);

  const after = watcher.listInterests("u1");
  assert.equal(after.length, 1); // B 已过 60 天 → 移除
  assert.equal(after[0].name, "旧兴趣A");
  assert.equal(after[0].enabled, false); // A 降权，不再推送

  // 降权后不参与推送，但 touchInterest 可重新激活
  await watcher.touchInterest("u1", "旧兴趣A");
  assert.equal(watcher.listInterests("u1")[0].enabled, true);
});