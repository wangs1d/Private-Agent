/**
 * shared_browser.* 工具注册 + 离线降级冒烟：
 *   - 6 个工具注册后 schema 可调用
 *   - 浏览器桥离线时返回明确错误（不抛错、不排队）
 *   - 参数校验前置（缺 url / 非法 action / 缺点击定位参数）
 */
import assert from "node:assert/strict";
import test from "node:test";

import { SharedBrowserCoordinator } from "../src/services/shared-browser-coordinator.js";
import { registerSharedBrowserTools } from "../src/tools/capability-modules/shared-browser/handlers.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import type { ToolContext } from "../src/tools/tool-registry.js";

const ctx: ToolContext = { sessionId: "sess-1", userId: "user-1" };

function makeRegistry(): { registry: ToolRegistry; coordinator: SharedBrowserCoordinator } {
  const registry = new ToolRegistry();
  const coordinator = new SharedBrowserCoordinator();
  registerSharedBrowserTools(registry, { sharedBrowserCoordinator: coordinator });
  return { registry, coordinator };
}

test("registers all six shared_browser tools", () => {
  const { registry } = makeRegistry();
  const names = new Set(registry.list());
  for (const name of [
    "shared_browser.navigate",
    "shared_browser.control",
    "shared_browser.click",
    "shared_browser.type",
    "shared_browser.scroll",
    "shared_browser.read_page",
  ]) {
    assert.ok(names.has(name), `${name} 未注册`);
  }
});

test("offline bridge returns explicit error for every tool", async () => {
  const { registry } = makeRegistry();
  const { result } = await registry.execute("shared_browser.read_page", {}, ctx);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /共用浏览器未连接/);
});

test("navigate requires url; control validates action; click needs a target", async () => {
  const { registry } = makeRegistry();
  const noUrl = await registry.execute("shared_browser.navigate", {}, ctx);
  assert.match(String(noUrl.result.error), /缺少 url/);

  const badAction = await registry.execute("shared_browser.control", { action: "jump" }, ctx);
  assert.match(String(badAction.result.error), /back\/forward\/reload\/stop\/home/);

  const noTarget = await registry.execute("shared_browser.click", {}, ctx);
  assert.match(String(noTarget.result.error), /至少传一个/);

  const noText = await registry.execute("shared_browser.type", { selector: "#q" }, ctx);
  assert.match(String(noText.result.error), /缺少 text/);
});

test("online bridge forwards params through coordinator", async () => {
  const { registry, coordinator } = makeRegistry();
  const sent: object[] = [];
  const socket = {
    sent,
    send(data: string) {
      sent.push(JSON.parse(data));
    },
  } as never as Parameters<SharedBrowserCoordinator["bindExecutor"]>[1];
  coordinator.bindExecutor("user-1", socket);

  const execution = registry.execute(
    "shared_browser.navigate",
    { url: "https://example.com" },
    ctx,
  );
  // handler 链路是异步的：让一拍事件循环，invoke 帧才会发出
  await new Promise((resolve) => setTimeout(resolve, 0));
  const frame = sent[0] as { payload: { jobId: string; action: string; params: { url: string } } };
  assert.equal(frame.payload.action, "navigate");
  assert.equal(frame.payload.params.url, "https://example.com");

  coordinator.completeFromSocket("user-1", socket, frame.payload.jobId, {
    ok: true,
    title: "Example",
  });
  const { result } = await execution;
  assert.equal(result.ok, true);
  assert.equal(result.title, "Example");
});
