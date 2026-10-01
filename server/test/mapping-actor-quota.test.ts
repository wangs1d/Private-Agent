/**
 * 主动性「配额窃取」根修单测（2026-10-01 P0）。
 *
 * 审计实证：规则去重/节流状态全局共享，tickAll 按板上插入序遍历，先到的
 * 测试 actor 吃掉当天配额——真实用户 16 天 0 事件。修复=事件去重按 actor
 * 分键 + 规则状态按 (ruleId, actor) 切片 + tickAll 活跃过滤。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { MappingExecutor, type AttentionEvent } from "../src/proactivity/mapping-executor.js";
import { WorldBoard } from "../src/proactivity/world-board.js";
import type { BoardRule } from "../src/proactivity/mapping-executor.js";

function makeDailyRule(id: string, fired: string[]): BoardRule {
  return {
    id,
    layers: ["current"],
    // 每次评估都产出（去重靠执行器 dayKey；状态记自己发过没有——模拟
    // 「一天一次」类规则的典型写法：state 记日期）
    eval: (ctx) => {
      const day = ctx.now.toISOString().slice(0, 10);
      const last = ctx.state.get("lastDay");
      if (last === day) return [];
      ctx.state.set("lastDay", day);
      fired.push(ctx.actorId);
      return [{ kind: id, urgency: "normal", decision: "log" as const, title: `${id}:${ctx.actorId}` }];
    },
  } as unknown as BoardRule;
}

test("事件去重按 actor 分键：先到的测试 actor 不吃掉真实用户当天配额", () => {
  const board = new WorldBoard();
  board.ingest("e2e-old-actor", "current", "presence", { state: "active", since: 1 });
  board.ingest("real-user@qq.com", "current", "presence", { state: "active", since: 2 });

  const fired: string[] = [];
  const exec = new MappingExecutor({
    board,
    rules: [makeDailyRule("sleep_boundary", fired)],
    tickIntervalMs: 0,
  });

  exec.tickActor("e2e-old-actor", Date.now());
  exec.tickActor("real-user@qq.com", Date.now() + 1);

  assert.ok(fired.includes("e2e-old-actor"));
  assert.ok(fired.includes("real-user@qq.com"), "真实用户不因测试 actor 先发过而被去重吞掉");
});

test("规则状态按 actor 切片：互不读写对方的 state", () => {
  const board = new WorldBoard();
  board.ingest("a", "current", "presence", { state: "active", since: 1 });
  board.ingest("b", "current", "presence", { state: "active", since: 2 });
  const fired: string[] = [];
  const exec = new MappingExecutor({
    board,
    rules: [makeDailyRule("r", fired)],
    tickIntervalMs: 0,
  });
  exec.tickActor("a", Date.now());
  exec.tickActor("b", Date.now() + 1);
  assert.deepEqual(fired.sort(), ["a", "b"]);
  // 同 actor 再 tick（下一毫秒仍在同一天）→ 被自己的切片去重
  const fired2: string[] = [];
  exec.tickActor("a", Date.now() + 2);
  assert.deepEqual(fired2, []);
  assert.deepEqual(fired.filter((x) => x === "a").length, 1, "a 只发一次（自身切片去重仍生效）");
});

test("tickAll 活跃过滤：坟场 actor 不进评估", () => {
  const board = new WorldBoard();
  board.ingest("zombie-e2e", "current", "presence", { state: "active", since: 1 });
  board.ingest("live-user@qq.com", "current", "presence", { state: "active", since: 2 });
  const evaluated: string[] = [];
  const rule: BoardRule = {
    id: "any",
    layers: ["current"],
    eval: (ctx) => {
      evaluated.push(ctx.actorId);
      return [];
    },
  } as unknown as BoardRule;
  const exec = new MappingExecutor({
    board,
    rules: [rule],
    tickIntervalMs: 0,
    isActiveActor: (id) => id.endsWith("@qq.com"),
  });
  exec.tickAll(Date.now());
  assert.deepEqual(evaluated, ["live-user@qq.com"], "僵尸 actor 不进 tick");
});
