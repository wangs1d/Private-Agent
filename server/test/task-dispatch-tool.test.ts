/**
 * task.dispatch 派任务原语（2026-09-05 前后台架构）测试。
 *
 * 契约：工具本体零副作用——只调 launch 回调登记任务并立即返回 taskId，
 * 不等待执行；launch 未注入时返回拒绝结果。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { registerTaskDispatchTool, TASK_DISPATCH_TOOL_DEFINITION } = await import(
  "../src/tools/task-dispatch-tool.js"
);

function makeRegistry() {
  const handlers = new Map<string, (input: Record<string, unknown>, ctx: unknown) => Promise<Record<string, unknown>>>();
  return {
    handlers,
    register(name: string, handler: (input: Record<string, unknown>, ctx: unknown) => Promise<Record<string, unknown>>) {
      handlers.set(name, handler);
    },
  } as never;
}

const CTX = {
  sessionId: "sess-1",
  userId: "user-1",
  chatUserMessageId: "msg-1",
};

test("dispatch：正常派发 → launch 收到参数并立即返回 taskId", async () => {
  const launched: Array<Record<string, unknown>> = [];
  const registry = makeRegistry();
  registerTaskDispatchTool(registry, {
    launch: (input) => {
      launched.push(input as Record<string, unknown>);
      return "task-123";
    },
  });
  const handler = (registry as unknown as { handlers: Map<string, (i: Record<string, unknown>, c: unknown) => Promise<Record<string, unknown>>> }).handlers.get("task.dispatch")!;
  const result = await handler({ goal: "明天早上八点提醒我开会" }, CTX);
  assert.equal(result.ok, true);
  assert.equal(result.taskId, "task-123");
  assert.equal(launched.length, 1);
  assert.equal(launched[0].goal, "明天早上八点提醒我开会");
  assert.equal(launched[0].actorId, "user-1");
  assert.equal(launched[0].sessionId, "sess-1");
  assert.equal(launched[0].chatUserMessageId, "msg-1");
});

test("dispatch：缺 goal / launch 未注入 → 拒绝且不抛异常", async () => {
  const registry = makeRegistry();
  registerTaskDispatchTool(registry, { launch: () => null });
  const handler = (registry as unknown as { handlers: Map<string, (i: Record<string, unknown>, c: unknown) => Promise<Record<string, unknown>>> }).handlers.get("task.dispatch")!;

  const missing = await handler({}, CTX);
  assert.equal(missing.ok, false);

  const notReady = await handler({ goal: "订机票" }, CTX);
  assert.equal(notReady.ok, false);
  assert.match(String(notReady.error), /launch/);
});

test("dispatch：工具 schema 必须是白名单可见形态（name + goal 必填）", () => {
  assert.equal(TASK_DISPATCH_TOOL_DEFINITION.type, "function");
  assert.equal(TASK_DISPATCH_TOOL_DEFINITION.function.name, "task.dispatch");
  assert.deepEqual(TASK_DISPATCH_TOOL_DEFINITION.function.parameters.required, ["goal"]);
});
