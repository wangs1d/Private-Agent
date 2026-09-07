/**
 * TaskOutbox（2026-09-08 离线结果投递箱）行为测试。
 *
 * 契约：
 *   - 入箱：投递失败的结果暂存，FIFO 重放（messageId 去重）；
 *   - 重放：事件格式与 dispatchBackgroundTask.pushDone 完全一致
 *     （chat.assistant_done + source: task_plane），drain 后清空不重发；
 *   - 单条发送失败重新入箱（网络抖动不吞结果）；
 *   - 每会话上限 20 条，超限丢最旧（防泄漏）。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { TaskOutbox } = await import("../src/task-plane/task-outbox.js");

type SentFrame = { type: string; payload: Record<string, unknown> };

function fakeSocket(failOn?: string) {
  const sent: string[] = [];
  const socket = {
    send(data: string): void {
      const parsed = JSON.parse(data) as SentFrame;
      if (failOn && parsed.payload.messageId === failOn) {
        throw new Error("socket closed");
      }
      sent.push(data);
    },
  };
  return { socket, sent };
}

function parseSent(sent: string[]): SentFrame[] {
  return sent.map((raw) => JSON.parse(raw) as SentFrame);
}

test("enqueue → drain：FIFO 顺序 + drain 清空（幂等重放）", () => {
  const outbox = new TaskOutbox();
  outbox.enqueue("s1", { messageId: "assistant-task-t1", finalText: "结果一" });
  outbox.enqueue("s1", { messageId: "assistant-task-t2", finalText: "结果二" });
  const batch = outbox.drain("s1");
  assert.deepEqual(
    batch.map((e) => e.messageId),
    ["assistant-task-t1", "assistant-task-t2"],
    "应按入箱顺序重放",
  );
  assert.equal(outbox.drain("s1").length, 0, "drain 后不得重复投递");
});

test("enqueue 去重：同一 messageId 只补投一次", () => {
  const outbox = new TaskOutbox();
  outbox.enqueue("s1", { messageId: "assistant-task-t1", finalText: "结果一" });
  outbox.enqueue("s1", { messageId: "assistant-task-t1", finalText: "结果一" });
  assert.equal(outbox.drain("s1").length, 1);
});

test("会话隔离：不同 session 不串台", () => {
  const outbox = new TaskOutbox();
  outbox.enqueue("s1", { messageId: "m1", finalText: "会话一的结果" });
  outbox.enqueue("s2", { messageId: "m2", finalText: "会话二的结果" });
  assert.equal(outbox.pendingCount("s1"), 1);
  assert.equal(outbox.pendingCount("s2"), 1);
  assert.equal(outbox.drain("s1")[0]?.finalText, "会话一的结果");
  assert.equal(outbox.pendingCount("s2"), 1, "drain s1 不得影响 s2");
});

test("replayFor：事件格式与 pushDone 一致（chat.assistant_done + source task_plane）", () => {
  const outbox = new TaskOutbox();
  outbox.enqueue("s1", { messageId: "assistant-task-t1", finalText: "查到了 3 张照片" });
  const { socket, sent } = fakeSocket();
  const replayed = outbox.replayFor("s1", socket);
  assert.equal(replayed, 1);
  const [frame] = parseSent(sent);
  assert.equal(frame.type, "chat.assistant_done");
  assert.equal(frame.payload.sessionId, "s1");
  assert.equal(frame.payload.messageId, "assistant-task-t1");
  assert.equal(frame.payload.finalText, "查到了 3 张照片");
  assert.equal(frame.payload.source, "task_plane");
  assert.deepEqual(frame.payload.toolCalls, []);
  assert.equal(outbox.pendingCount("s1"), 0, "重放后清空");
});

test("replayFor：单条发送失败重新入箱，其余条目照常投递", () => {
  const outbox = new TaskOutbox();
  outbox.enqueue("s1", { messageId: "assistant-task-t1", finalText: "结果一" });
  outbox.enqueue("s1", { messageId: "assistant-task-t2", finalText: "结果二" });
  const { socket, sent } = fakeSocket("assistant-task-t1");
  const replayed = outbox.replayFor("s1", socket);
  assert.equal(replayed, 2, "两条都尝试过重放");
  const frames = parseSent(sent);
  assert.equal(frames.length, 1, "失败的那条不应出现在发送记录中");
  assert.equal(frames[0]?.payload.messageId, "assistant-task-t2");
  assert.equal(outbox.pendingCount("s1"), 1, "失败条目应重新入箱");
  assert.equal(outbox.drain("s1")[0]?.messageId, "assistant-task-t1");
});

test("上限保护：每会话最多 20 条，超限丢最旧", () => {
  const outbox = new TaskOutbox();
  for (let i = 0; i < 25; i++) {
    outbox.enqueue("s1", { messageId: `assistant-task-t${i}`, finalText: `结果${i}` });
  }
  const batch = outbox.drain("s1");
  assert.equal(batch.length, 20, "条数封顶 20");
  assert.equal(batch[0]?.messageId, "assistant-task-t5", "最旧的应被丢弃");
  assert.equal(batch[19]?.messageId, "assistant-task-t24", "最新的应保留");
});

test("空投递：无待投递条目时 replayFor 零发送", () => {
  const outbox = new TaskOutbox();
  const { socket, sent } = fakeSocket();
  assert.equal(outbox.replayFor("s-empty", socket), 0);
  assert.equal(sent.length, 0);
});

test("非法入箱：空字段直接忽略", () => {
  const outbox = new TaskOutbox();
  outbox.enqueue("s1", { messageId: "", finalText: "x" });
  outbox.enqueue("", { messageId: "m1", finalText: "x" });
  outbox.enqueue("s1", { messageId: "m2", finalText: "" });
  assert.equal(outbox.pendingCount("s1"), 0);
});
