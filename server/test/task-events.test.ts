/**
 * 任务面 → 对话面 WS 广播（2026-09-08 前后台分工对话改造）行为测试。
 *
 * 契约：
 *   - TaskHub 变更监听器：submit/state/progress 三类变更各触发一次，
 *     携带最新记录快照；监听器异常不反噬任务记账；
 *   - buildTaskUpdateEnvelope：幂等全量快照（type=chat.task_update）；
 *   - broadcastTaskUpdate：开关关闭 / registry 缺失时无操作；trySend 抛错被吞；
 *   - 回退开关：AGENT_TASK_PLANE_WS_EVENTS_ENABLED=0 整体关闭广播。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { TaskHub } = await import("../src/task-plane/task-hub.js");
const {
  buildTaskUpdateEnvelope,
  broadcastTaskUpdate,
  isTaskPlaneWsEventsEnabled,
} = await import("../src/task-plane/task-events.js");

type SentFrame = { sessionId: string; data: string };

function makeRegistry() {
  const sent: SentFrame[] = [];
  return {
    sent,
    trySend(sessionId: string, data: string): boolean {
      sent.push({ sessionId, data });
      return true;
    },
  };
}

test("TaskHub 监听器：submit/state/progress 三类变更各触发一次", () => {
  const hub = new TaskHub();
  const events: Array<{ taskId: string; kind: string; state?: string; progressLine?: string }> = [];
  hub.setChangeListener((record, kind) => {
    events.push({
      taskId: record.taskId,
      kind,
      state: record.state,
      progressLine: record.progressLine,
    });
  });

  hub.submit({ taskId: "e1", sessionId: "s1", goal: "订餐厅" });
  hub.setProgress("e1", "正在查询餐厅");
  hub.setState("e1", "done");

  assert.deepEqual(
    events.map((e) => e.kind),
    ["submit", "progress", "state"],
  );
  assert.equal(events[0]?.state, "running");
  assert.equal(events[1]?.progressLine, "正在查询餐厅");
  assert.equal(events[2]?.state, "done");
});

test("TaskHub 监听器：setState 未命中任务不触发；监听器异常不反噬记账", () => {
  const hub = new TaskHub();
  let calls = 0;
  hub.setChangeListener(() => {
    calls += 1;
    throw new Error("listener boom");
  });
  hub.setState("missing", "done");
  assert.equal(calls, 0, "未命中任务不得触发监听器");

  hub.submit({ taskId: "boom", sessionId: "s2", goal: "x" });
  assert.equal(calls, 1, "submit 触发一次（即使监听器抛错）");
  assert.equal(hub.get("boom")?.state, "running", "监听器异常不影响记录");
  hub.setProgress("boom", "p");
  assert.equal(hub.get("boom")?.progressLine, "p", "监听器异常不影响进度记账");

  const callsBeforeClear = calls;
  hub.setChangeListener(null);
  hub.setState("boom", "done");
  assert.equal(calls, callsBeforeClear, "清除监听器后不再触发");
});

test("buildTaskUpdateEnvelope：chat.task_update 幂等全量快照", () => {
  const hub = new TaskHub();
  hub.submit({
    taskId: "t-env",
    sessionId: "s-env",
    replyAnchorId: "msg-1",
    goal: "帮我找照片",
  });
  hub.setProgress("t-env", "正在使用 search_images");
  const record = hub.get("t-env")!;
  const frame = JSON.parse(buildTaskUpdateEnvelope(record));
  assert.equal(frame.type, "chat.task_update");
  assert.equal(frame.payload.taskId, "t-env");
  assert.equal(frame.payload.sessionId, "s-env");
  assert.equal(frame.payload.state, "running");
  assert.equal(frame.payload.goal, "帮我找照片");
  assert.equal(frame.payload.progressLine, "正在使用 search_images");
  assert.equal(frame.payload.replyAnchorId, "msg-1");
  assert.equal(frame.payload.startedAt, record.startedAt);
  assert.ok(frame.payload.elapsedMs >= 0);
});

test("broadcastTaskUpdate：经 registry 投递到任务会话", () => {
  const hub = new TaskHub();
  hub.submit({ taskId: "t-send", sessionId: "s-send", goal: "查天气" });
  const registry = makeRegistry();
  broadcastTaskUpdate(registry, hub.get("t-send")!);
  assert.equal(registry.sent.length, 1);
  assert.equal(registry.sent[0]?.sessionId, "s-send");
  assert.equal(JSON.parse(registry.sent[0]!.data).type, "chat.task_update");
});

test("broadcastTaskUpdate：registry 缺失 / trySend 抛错均为无操作", () => {
  const hub = new TaskHub();
  hub.submit({ taskId: "t-null", sessionId: "s-null", goal: "x" });
  assert.doesNotThrow(() => broadcastTaskUpdate(null, hub.get("t-null")!));

  const throwing = {
    trySend(): boolean {
      throw new Error("socket gone");
    },
  };
  assert.doesNotThrow(() => broadcastTaskUpdate(throwing, hub.get("t-null")!));
});

test("回退开关：AGENT_TASK_PLANE_WS_EVENTS_ENABLED=0 关闭广播", async () => {
  const prev = process.env.AGENT_TASK_PLANE_WS_EVENTS_ENABLED;
  process.env.AGENT_TASK_PLANE_WS_EVENTS_ENABLED = "0";
  try {
    assert.equal(isTaskPlaneWsEventsEnabled(), false);
    const hub = new TaskHub();
    hub.submit({ taskId: "t-off", sessionId: "s-off", goal: "x" });
    const registry = makeRegistry();
    broadcastTaskUpdate(registry, hub.get("t-off")!);
    assert.equal(registry.sent.length, 0, "开关关闭时不得投递任何事件");
  } finally {
    if (prev === undefined) {
      delete process.env.AGENT_TASK_PLANE_WS_EVENTS_ENABLED;
    } else {
      process.env.AGENT_TASK_PLANE_WS_EVENTS_ENABLED = prev;
    }
  }
});
