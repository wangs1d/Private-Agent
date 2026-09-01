import assert from "node:assert/strict";
import { test } from "node:test";

import { WsRuntimeClient } from "../src/runtime/link/ws-runtime-client.js";
import { startRuntimeLinkServer } from "../src/runtime/link/link-server.js";
import type { RuntimeFacade, AgentReply } from "../src/runtime/runtime-facade.js";

/** 假 runtime：可观测的流式回调 + abort 感知。 */
function createFakeFacade() {
  let turnAbortSignal: AbortSignal | null = null;
  const facade: RuntimeFacade & {
    lastSignalAborted: () => boolean;
  } = {
    async handleUserMessage(actorId, text, opts) {
      turnAbortSignal = opts?.signal ?? null;
      opts?.onAssistantDelta?.("你");
      opts?.onAssistantDelta?.("好");
      await new Promise((r) => setTimeout(r, 50));
      const reply: AgentReply = { text: `echo:${actorId}:${text}`, streamedChunks: true };
      return reply;
    },
    async runToolIfNeeded() {
      return { ok: true, result: { done: true } };
    },
    async routeTurnForWs() {
      return { mode: "fast", reasons: ["test"], segmentable: false };
    },
    async resumeAutonomousTasks() {
      return 3;
    },
    lastSignalAborted: () => !!turnAbortSignal?.aborted,
  };
  return facade;
}

test("runtime 链路：req/res、流式 ev 帧、abort 与鉴权", async (t) => {
  const facade = createFakeFacade();
  const port = 3399 + Math.floor(Math.random() * 200);
  const server = await startRuntimeLinkServer({ port, token: "secret-token", facade });
  t.after(() => server.close());

  // token 错误 → 连不上
  const badClient = new WsRuntimeClient({ url: `ws://127.0.0.1:${port}`, token: "wrong", connectTimeoutMs: 1500 });
  t.after(() => badClient.dispose());
  await assert.rejects(() => badClient.health());

  const client = new WsRuntimeClient({ url: `ws://127.0.0.1:${port}`, token: "secret-token" });
  t.after(() => client.dispose());

  // health
  const health = await client.health();
  assert.equal(health.ok, true);

  // 流式 turn：回调经 ev 帧回推，最终结果 res 帧返回
  const deltas: string[] = [];
  const controller = new AbortController();
  const reply = await client.handleUserMessage("actor-1", "嗨", {
    sessionId: "actor-1",
    onAssistantDelta: (d) => deltas.push(d),
    signal: controller.signal,
  });
  assert.equal(reply.text, "echo:actor-1:嗨");
  assert.deepEqual(deltas, ["你", "好"]);

  // abort：signal 触发 AbortTurn 帧 → runtime 侧 controller.abort
  const slow = new WsRuntimeClient({ url: `ws://127.0.0.1:${port}`, token: "secret-token" });
  const abortController = new AbortController();
  const p = slow.handleUserMessage("actor-1", "long", {
    signal: abortController.signal,
  });
  abortController.abort();
  await p.catch(() => {});
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(facade.lastSignalAborted(), true, "runtime 侧 AbortController 应被 abort");
  slow.dispose();

  // 简单 RPC
  const decision = await client.routeTurnForWs("actor-1", "hi");
  assert.equal(decision.mode, "fast");
  const restored = await client.resumeAutonomousTasks();
  assert.equal(restored, 3);
  const tool = await client.runToolIfNeeded("actor-1", { text: "x", toolName: "t", toolInput: {} });
  assert.equal(tool.ok, true);
});
