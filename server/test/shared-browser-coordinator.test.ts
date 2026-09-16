/**
 * SharedBrowserCoordinator 单测：
 *   - 离线调用立即失败（不排队、不抛错）
 *   - invoke/result 按 jobId + actorId + socket 三重配对
 *   - 超时兜底（retryable=true）
 *   - socket 断开清理挂起任务 + 解绑
 *   - 绑定校验：不匹配的 actorId/socket 无法提交结果
 */
import assert from "node:assert/strict";
import test from "node:test";

import { SharedBrowserCoordinator } from "../src/services/shared-browser-coordinator.js";
import type { WsSendLike } from "../src/services/shared-browser-coordinator.js";

function fakeSocket(sent: object[] = []): WsSendLike & { sent: object[] } {
  const socket = {
    sent,
    send(data: string) {
      sent.push(JSON.parse(data));
    },
  };
  return socket as WsSendLike & { sent: object[] };
}

test("offline invoke fails fast with clear error", async () => {
  const c = new SharedBrowserCoordinator();
  const r = await c.invoke("actor-1", "navigate", { url: "https://example.com" });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /offline/);
  assert.equal(c.hasExecutor("actor-1"), false);
});

test("invoke sends payload and result pairs by jobId", async () => {
  const c = new SharedBrowserCoordinator();
  const sent: object[] = [];
  const socket = fakeSocket(sent);
  c.bindExecutor("actor-1", socket);

  const pending = c.invoke("actor-1", "read_page", { includeInteractive: true }, 5000);
  assert.equal(sent.length, 1);
  const frame = sent[0] as { type: string; payload: { jobId: string; action: string; params: Record<string, unknown> } };
  assert.equal(frame.type, "shared.browser.invoke");
  assert.equal(frame.payload.action, "read_page");
  assert.equal(frame.payload.params.includeInteractive, true);

  const delivered = c.completeFromSocket("actor-1", socket, frame.payload.jobId, {
    ok: true,
    url: "https://example.com/",
    title: "Example",
  });
  assert.equal(delivered, true);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.title, "Example");
});

test("completeFromSocket rejects mismatched actor or socket", async () => {
  const c = new SharedBrowserCoordinator();
  const socket = fakeSocket();
  c.bindExecutor("actor-1", socket);

  const pending = c.invoke("actor-1", "click", {}, 5000);
  const jobId = (socket.sent[0] as { payload: { jobId: string } }).payload.jobId;

  // 错误 socket / 错误 actor / 未知 jobId 都必须拒绝
  assert.equal(c.completeFromSocket("actor-1", fakeSocket(), jobId, { ok: true }), false);
  assert.equal(c.completeFromSocket("actor-2", socket, jobId, { ok: true }), false);
  assert.equal(c.completeFromSocket("actor-1", socket, "no-such-job", { ok: true }), false);

  assert.equal(c.completeFromSocket("actor-1", socket, jobId, { ok: true }), true);
  assert.equal((await pending).ok, true);
});

test("invoke times out with retryable error", async () => {
  const c = new SharedBrowserCoordinator();
  c.bindExecutor("actor-1", fakeSocket());
  const result = await c.invoke("actor-1", "navigate", { url: "https://example.com" }, 30);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /timeout/);
  assert.equal(result.retryable, true);
});

test("socket disconnect unbinds and fails pending jobs", async () => {
  const c = new SharedBrowserCoordinator();
  const socket = fakeSocket();
  c.bindExecutor("actor-1", socket);

  const pending = c.invoke("actor-1", "type", { text: "hi" }, 30_000);
  assert.equal(c.unbindIfSocket("actor-1", socket), true);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(String(result.error), /disconnect/);
  assert.equal(c.hasExecutor("actor-1"), false);
  // 重复解绑返回 false
  assert.equal(c.unbindIfSocket("actor-1", socket), false);
});

test("re-bind overwrites stale executor socket", async () => {
  const c = new SharedBrowserCoordinator();
  const oldSocket = fakeSocket();
  const newSocket = fakeSocket();
  c.bindExecutor("actor-1", oldSocket);
  c.bindExecutor("actor-1", newSocket);

  const pending = c.invoke("actor-1", "scroll", {}, 5000);
  // invoke 只发新 socket；拿新 jobId 用旧 socket 提交必须被拒
  const newJobId = (newSocket.sent[0] as { payload: { jobId: string } }).payload.jobId;
  assert.equal(c.completeFromSocket("actor-1", oldSocket, newJobId, { ok: true }), false);
  assert.equal(c.completeFromSocket("actor-1", newSocket, newJobId, { ok: true }), true);
  assert.equal((await pending).ok, true);
});
