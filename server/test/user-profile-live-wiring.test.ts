/**
 * 用户画像根修接线测试（2026-09-29 P0-1/P0-2/P1/P2 落地配套）。
 *
 * 覆盖四个新机制：
 *  - hasRealProfileContent：模板画像判定（prompt 注入闸——模板不注入）
 *  - mergeUserProfilePromptSources：文件画像 + manager 派生摘要合并（互斥改合并）
 *  - shouldExtractNow：抽取 token 闸（highSignal/个人陈述预筛，寒暄轮跳过）
 *  - UserProfileStore.deleteAll：隐私闭环级联删除
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  UserProfileStore,
  hasRealProfileContent,
  defaultUserProfileMarkdown,
} from "../src/services/user-personalization/user-profile-store.js";
import { mergeUserProfilePromptSources } from "../src/agent/prompt-context-builder.js";
import { UserProfileAggregator } from "../src/brain/user-profile-aggregator.js";

/* ── hasRealProfileContent：模板/样板行不算真实事实 ── */

test("模板判定：默认模板画像 = 无真实内容", () => {
  assert.equal(hasRealProfileContent(defaultUserProfileMarkdown("u1")), false);
});

test("模板判定：只含语气同步样板行 = 无真实内容", () => {
  const p = defaultUserProfileMarkdown("u1").replace(
    "- 语气风格：自然均衡（系统根据对话自动调整）",
    "- 语气风格：温馨亲切（系统根据对话自动调整）",
  );
  assert.equal(hasRealProfileContent(p), false);
});

test("模板判定：任一真实内容行（称呼/爱好）= 有真实内容", () => {
  const p = defaultUserProfileMarkdown("u1").replace(
    "- （待了解：称呼、常用语言、所在地等）",
    "- 称呼：周明远",
  );
  assert.equal(hasRealProfileContent(p), true);
});

test("模板判定：占位括号行不算（LLM 写的「（待补充）」变体）", () => {
  const p = defaultUserProfileMarkdown("u1").replace("- （待了解）", "- （待补充）");
  assert.equal(hasRealProfileContent(p), false);
});

/* ── mergeUserProfilePromptSources：互斥改合并 ── */

test("合并：文件画像为主位，manager 摘要非重复行追加", () => {
  const file = "## 基本信息\n- 称呼：周明远\n- 所在地：成都";
  const manager = "- 称呼：周明远\n- 职业：消防员";
  const merged = mergeUserProfilePromptSources(file, manager);
  assert.ok(merged!.includes("称呼：周明远"));
  assert.equal(merged!.match(/称呼：周明远/g)!.length, 1, "重复行去重");
  assert.ok(merged!.includes("职业：消防员"), "manager 独有行保留");
});

test("合并：只有文件画像 / 只有 manager 摘要 / 双空", () => {
  assert.equal(mergeUserProfilePromptSources("A", undefined), "A");
  assert.equal(mergeUserProfilePromptSources(undefined, "B"), "B");
  assert.equal(mergeUserProfilePromptSources(undefined, undefined), undefined);
});

test("合并：manager 摘要全部重复时不追加空尾巴", () => {
  const file = "- 称呼：周明远";
  const merged = mergeUserProfilePromptSources(file, "- 称呼：周明远");
  assert.equal(merged, file);
});

/* ── 抽取 token 闸（私有方法直测：shouldExtractNow） ── */

const agg = new UserProfileAggregator();
const gate = (text: string, highSignal = false) =>
  (agg as unknown as { shouldExtractNow: (t: string, h: boolean) => boolean }).shouldExtractNow(
    text,
    highSignal,
  );

test("抽取闸：highSignal 轮无条件放行", () => {
  assert.equal(gate("在吗", true), true);
  assert.equal(gate("嗯", true), true);
});

test("抽取闸：个人陈述正则命中放行（我叫/住在/喜欢/最近在学）", () => {
  assert.equal(gate("我叫周明远，在成都当消防员"), true);
  assert.equal(gate("我最近在学日语"), true);
  assert.equal(gate("我喜欢钓鱼"), true);
});

test("抽取闸：寒暄轮拦截（省 MINI 抽取调用）", () => {
  assert.equal(gate("在吗"), false);
  assert.equal(gate("晚上一起吃饭不"), false);
  assert.equal(gate("今天加班好累啊"), false);
  assert.equal(gate("嗯嗯好的"), false);
});

test("抽取闸：改口/迁移类表述放行（2026-09-29 纠错腿盲区回归）", () => {
  assert.equal(gate("我民宿上个月转让出去了，现在在泉州开咖啡店，以后就在泉州长住了"), true);
  assert.equal(gate("我改行了，现在不教书了"), true);
  assert.equal(gate("过阵子搬到杭州去"), true);
});

test("抽取闸：MEMORY_PROFILE_EXTRACT_PRESCREEN=0 关闭预筛全放行", () => {
  const prev = process.env.MEMORY_PROFILE_EXTRACT_PRESCREEN;
  process.env.MEMORY_PROFILE_EXTRACT_PRESCREEN = "0";
  try {
    // config 在构造时定格：预筛开关必须作用于新实例
    const a2 = new UserProfileAggregator();
    const gate2 = (t: string) =>
      (a2 as unknown as { shouldExtractNow: (t: string, h: boolean) => boolean }).shouldExtractNow(t, false);
    assert.equal(gate2("在吗"), true, "关闭预筛后寒暄也放行");
  } finally {
    if (prev === undefined) delete process.env.MEMORY_PROFILE_EXTRACT_PRESCREEN;
    else process.env.MEMORY_PROFILE_EXTRACT_PRESCREEN = prev;
  }
});

/* ── observeTurn 新签名：highSignal 透传不抛错 + 队列落盘 ── */

test("observeTurn：新签名（含 highSignal）正常入队", async () => {
  const dir = mkdtempSync(join(tmpdir(), "profile-store-"));
  const prevExtract = process.env.MEMORY_PROFILE_EXTRACT_ENABLED;
  try {
    process.env.AGENT_USER_PROFILE_DIR = dir;
    // 关掉每轮抽取（有 key 环境防真实 LLM 调用）；本测只验证入队语义
    process.env.MEMORY_PROFILE_EXTRACT_ENABLED = "0";
    const a = new UserProfileAggregator();
    a.observeTurn("actor-x", "我叫周明远", "你好呀", { highSignal: true });
    a.observeTurn("actor-y", "在吗", "在的");
    await new Promise((r) => setTimeout(r, 400));
    const pendingX = JSON.parse(readFileSync(join(dir, "actor-x", "pending-turns.json"), "utf8"));
    assert.equal(pendingX.length, 1);
    assert.ok(pendingX[0].includes("你好呀"), "助手半边进入队列");
    const pendingY = JSON.parse(readFileSync(join(dir, "actor-y", "pending-turns.json"), "utf8"));
    assert.ok(pendingY[0].includes("在的"), "低信号轮同样入队（等深度合成兜底）");
  } finally {
    delete process.env.AGENT_USER_PROFILE_DIR;
    if (prevExtract === undefined) delete process.env.MEMORY_PROFILE_EXTRACT_ENABLED;
    else process.env.MEMORY_PROFILE_EXTRACT_ENABLED = prevExtract;
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── deleteAll：隐私闭环级联删除 ── */

test("deleteAll：画像文件 + 轮次队列目录整删", async () => {
  const dir = mkdtempSync(join(tmpdir(), "profile-del-"));
  try {
    process.env.AGENT_USER_PROFILE_DIR = dir;
    const store = new UserProfileStore();
    await store.write("actor-z", "# 用户画像\n- 称呼：测试");
    writeFileSync(join(dir, "actor-z", "pending-turns.json"), "[]", "utf8");
    assert.ok(existsSync(store.profilePath("actor-z")));
    assert.equal(await store.deleteAll("actor-z"), true);
    assert.ok(!existsSync(join(dir, "actor-z")), "目录整删");
    assert.equal(await store.deleteAll("actor-z"), true, "幂等：不存在也返回成功");
  } finally {
    delete process.env.AGENT_USER_PROFILE_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});
