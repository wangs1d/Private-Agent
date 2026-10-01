/**
 * 当下状态 prompt 块单测（2026-10-01 P0「顺嘴要贴此刻」）。
 *
 * 覆盖：新鲜信号注入、陈旧信号不冒充现在、时长格式化、空板零注入。
 * 事故背景：聊天回复对「用户此刻在干嘛」零输入，模型拿旧记忆套模板
 * （熬夜→劝睡），而状态板上明明写着 screenFocus=game。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { WorldBoard } from "../src/proactivity/world-board.js";
import { formatCurrentStatePrompt } from "../src/agent/current-state-prompt.js";

const T0 = 1_790_000_000_000; // 任意基准时刻

function boardWith(
  focus?: { kind: string; since: number; lastSeenAt: number },
  presence?: { state: string; since: number },
): WorldBoard {
  const board = new WorldBoard();
  if (focus) board.ingest("u1", "current", "screenFocus", focus);
  if (presence) board.ingest("u1", "current", "presence", presence);
  return board;
}

test("新鲜焦点+presence：注入中文标签与持续时长", () => {
  const now = T0;
  const board = boardWith(
    { kind: "game", since: T0 - 70 * 60_000, lastSeenAt: T0 - 60_000 },
    { state: "idle", since: T0 - 5 * 60_000 },
  );
  const text = formatCurrentStatePrompt(board, "u1", now);
  assert.ok(text, "应产出块正文");
  assert.match(text, /屏幕焦点=打游戏（已约1小时）/);
  assert.match(text, /在线状态=挂机（已5分钟）/);
  assert.match(text, /顺嘴要贴此刻状态/);
});

test("焦点 lastSeenAt 超 10 分钟：陈旧不注入焦点，presence 仍可用", () => {
  const board = boardWith(
    { kind: "game", since: T0 - 3 * 60 * 60_000, lastSeenAt: T0 - 11 * 60_000 },
    { state: "offline", since: T0 - 30 * 60_000 },
  );
  const text = formatCurrentStatePrompt(board, "u1", T0);
  assert.ok(text);
  assert.ok(!text.includes("打游戏"), "陈旧焦点不该冒充现在");
  assert.match(text, /在线状态=离线/);
});

test("空板/空 actor：零注入（null）", () => {
  assert.equal(formatCurrentStatePrompt(new WorldBoard(), "nobody", T0), null);
  assert.equal(formatCurrentStatePrompt(new WorldBoard(), "", T0), null);
});

test("未知 kind/state：透传原值不抛错", () => {
  const board = boardWith(
    { kind: "vr_chat", since: T0, lastSeenAt: T0 },
    { state: "do_not_disturb", since: T0 },
  );
  const text = formatCurrentStatePrompt(board, "u1", T0);
  assert.ok(text);
  assert.match(text, /vr_chat/);
  assert.match(text, /do_not_disturb/);
});

test("presence 长于 24h：只报状态不带时长", () => {
  const board = boardWith(undefined, { state: "offline", since: T0 - 30 * 60 * 60_000 });
  const text = formatCurrentStatePrompt(board, "u1", T0);
  assert.ok(text);
  assert.match(text, /在线状态=离线。/);
});
