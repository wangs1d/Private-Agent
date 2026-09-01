/**
 * 桌面操控链路冒烟验证：不依赖真实桌面 / 桥接在线。
 *
 * 三层校验：
 *   1. ToolRegistry：全部 desktop.* 工具已注册，非法参数被正确拒绝（代码级校验）
 *   2. chat-tool schema：LLM 工具定义齐全（screenshot/run_input/uia_query/run_automation/
 *      window/clipboard 的关键字段），暴露门控生效
 *   3. 真实子进程（可选）：DESKTOP_VISUAL_ENABLED=1 时走 stdio_worker 跑
 *      window list / clipboard set+get / run_input cursor_position / screenshot 实链路
 *
 * 用法：
 *   cd server && npx tsx scripts/verify-desktop-control.ts          # 仅 1+2
 *   DESKTOP_VISUAL_ENABLED=1 npx tsx scripts/verify-desktop-control.ts --live  # 含 3
 */
import { ToolRegistry } from "../src/tools/tool-registry.js";
import {
  registerDesktopVisualTools,
  type DesktopVisualToolsDeps,
} from "../src/tools/desktop-visual-tools.js";
import {
  DESKTOP_VISUAL_CHAT_TOOL_DEFINITIONS,
  isDesktopVisualControlChatToolsEnabled,
} from "../src/tools/desktop-visual-chat-tools.js";
import type { DesktopBridgeCoordinator } from "../src/services/desktop-bridge-coordinator.js";
import type { DesktopVisualPort } from "../src/services/desktop-visual-port.js";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 不触达桌面的假 port：任何调用都返回明确错误（供代码级校验走 localVisual 分支） */
const stubPort: DesktopVisualPort = {
  isEnabled: () => true,
  runTask: async () => ({ ok: false, error: "stub" }),
};

const stubBridge = {
  isBridgeFeatureEnabled: () => false,
  hasExecutor: (_actorId: string) => false,
  invoke: async () => null,
  recordTaskResult: () => undefined,
} as unknown as DesktopBridgeCoordinator;

function buildRegistry(): ToolRegistry {
  const deps: DesktopVisualToolsDeps = { localVisual: stubPort, bridge: stubBridge };
  const registry = new ToolRegistry();
  registerDesktopVisualTools(registry, deps);
  return registry;
}

async function verifyRegistry(): Promise<void> {
  console.log("\n[1] ToolRegistry 注册与参数校验");
  const registry = buildRegistry();
  const ctx = { sessionId: "verify-desktop-control" };

  const expectedTools = [
    "desktop.visual.screenshot",
    "desktop.visual.run_task",
    "desktop.open",
    "desktop.run_preset",
    "desktop.run_shell",
    "desktop.uia_query",
    "desktop.run_input",
    "desktop.run_automation",
    "desktop.http_get",
    "desktop.web_search",
    "desktop.web_fetch",
    "desktop.window",
    "desktop.clipboard",
  ];
  const registered = new Set(registry.list());
  for (const name of expectedTools) {
    check(`已注册 ${name}`, registered.has(name));
  }

  // ---- run_input 参数校验（新动作空间）----
  const ri = (input: Record<string, unknown>) =>
    registry.execute("desktop.run_input", input, ctx);

  let r = await ri({ action: "triple_click", x: 10, y: 20 });
  check("triple_click 接受合法参数", !r.result.error || !String(r.result.error).includes("必须是"), JSON.stringify(r.result));
  r = await ri({ action: "wait", waitMs: 300 });
  check("wait 接受合法参数", !r.result.error || !String(r.result.error).includes("必须是"), JSON.stringify(r.result));
  r = await ri({ action: "cursor_position" });
  check("cursor_position 接受合法参数", !r.result.error || !String(r.result.error).includes("必须是"), JSON.stringify(r.result));
  r = await ri({ action: "scroll", scrollX: 2 });
  check("scroll 支持水平滚动 scrollX", !r.result.error || !String(r.result.error).includes("需要"), JSON.stringify(r.result));
  r = await ri({ action: "click" });
  check("click 缺坐标被拒", String(r.result.error ?? "").includes("x, y"), JSON.stringify(r.result));
  r = await ri({ action: "scroll" });
  check("scroll 缺滚动量被拒", String(r.result.error ?? "").includes("scrollClicks"), JSON.stringify(r.result));
  r = await ri({ action: "hover_gently" });
  check("未知 action 被拒", String(r.result.error ?? "").includes("必须是"), JSON.stringify(r.result));

  // ---- window / clipboard 参数校验 ----
  let w = await registry.execute("desktop.window", { op: "bogus" }, ctx);
  check("desktop.window 非法 op 被拒", String(w.result.error ?? "").includes("必须是"), JSON.stringify(w.result));
  w = await registry.execute("desktop.window", { op: "activate" }, ctx);
  check("desktop.window activate 缺定位被拒", String(w.result.error ?? "").includes("title / hwnd / index"), JSON.stringify(w.result));
  w = await registry.execute("desktop.window", { op: "move", title: "x" }, ctx);
  check("desktop.window move 缺坐标被拒", String(w.result.error ?? "").includes("x, y"), JSON.stringify(w.result));

  let c = await registry.execute("desktop.clipboard", { op: "nuke" }, ctx);
  check("desktop.clipboard 非法 op 被拒", String(c.result.error ?? "").includes("get 或 set"), JSON.stringify(c.result));
  c = await registry.execute("desktop.clipboard", { op: "set" }, ctx);
  check("desktop.clipboard set 缺 text 被拒", String(c.result.error ?? "").includes("text"), JSON.stringify(c.result));

  // ---- uia_query / run_automation 新参数校验 ----
  let u = await registry.execute("desktop.uia_query", { mode: "snapshot", windowTitle: "记事本" }, ctx);
  check("uia_query snapshot 模式通过参数校验", !String(u.result.error ?? "").includes("mode"), JSON.stringify(u.result));
  u = await registry.execute("desktop.uia_query", { mode: "wildguess" }, ctx);
  check("uia_query 非法 mode 被拒", String(u.result.error ?? "").includes("snapshot"), JSON.stringify(u.result));

  let a = await registry.execute(
    "desktop.run_automation",
    { action: "expand", selector: { path: "2.1.3" }, windowTitle: "设置" },
    ctx,
  );
  check("run_automation expand + path 通过参数校验", !String(a.result.error ?? "").includes("action"), JSON.stringify(a.result));
  a = await registry.execute("desktop.run_automation", { action: "detonate", selector: { name: "x" } }, ctx);
  check("run_automation 非法 action 被拒", String(a.result.error ?? "").includes("必须是"), JSON.stringify(a.result));
}

function verifyChatTools(): void {
  console.log("\n[2] LLM chat-tool schema");
  const names = new Set(
    DESKTOP_VISUAL_CHAT_TOOL_DEFINITIONS.map((t) => (t.type === "function" ? t.function.name : "")),
  );
  for (const name of [
    "desktop.visual.screenshot", "desktop.run_input", "desktop.uia_query",
    "desktop.run_automation", "desktop.window", "desktop.clipboard",
  ]) {
    check(`schema 含 ${name}`, names.has(name));
  }

  const inputTool = DESKTOP_VISUAL_CHAT_TOOL_DEFINITIONS.find(
    (t) => t.type === "function" && t.function.name === "desktop.run_input",
  );
  if (inputTool && inputTool.type === "function") {
    const props = inputTool.function.parameters?.properties as Record<string, unknown> | undefined;
    for (const field of ["triple_click", "wait", "cursor_position", "hold_key"]) {
      const actionEnum = (props?.action as { enum?: string[] } | undefined)?.enum ?? [];
      check(`run_input.action 含 ${field}`, actionEnum.includes(field));
    }
    for (const field of ["coordSpace", "imageWidth", "imageHeight", "scrollX", "waitMs", "holdSeconds"]) {
      check(`run_input 参数含 ${field}`, Boolean(props && field in props));
    }
  } else {
    check("run_input schema 可解析", false);
  }

  const shotTool = DESKTOP_VISUAL_CHAT_TOOL_DEFINITIONS.find(
    (t) => t.type === "function" && t.function.name === "desktop.visual.screenshot",
  );
  if (shotTool && shotTool.type === "function") {
    const props = shotTool.function.parameters?.properties as Record<string, unknown> | undefined;
    check("screenshot 参数含 display", Boolean(props && "display" in props));
    check("screenshot 参数含 maxDim", Boolean(props && "maxDim" in props));
  } else {
    check("screenshot schema 可解析", false);
  }

  const offByDefault = !isDesktopVisualControlChatToolsEnabled({} as NodeJS.ProcessEnv);
  check("环境门控：无环境变量时不暴露桌面工具（默认安全）", offByDefault);
}

async function verifyLiveSubprocess(): Promise<void> {
  console.log("\n[3] 真实子进程链路（DESKTOP_VISUAL_ENABLED=1 --live）");
  const { createDesktopVisualFromEnv } = await import("../src/services/desktop-visual-subprocess.js");
  const port = createDesktopVisualFromEnv();
  check("子进程 port isEnabled", port.isEnabled());

  if (port.window) {
    const w = await port.window({ op: "list" });
    check("window list", w.ok, JSON.stringify(w).slice(0, 200));
  }
  if (port.clipboard) {
    const marker = `verify-desktop-control ${Date.now()}`;
    const s = await port.clipboard({ op: "set", text: marker });
    check("clipboard set", s.ok, JSON.stringify(s).slice(0, 200));
    const g = await port.clipboard({ op: "get" });
    check("clipboard get 内容一致", g.ok && g.text === marker, JSON.stringify(g).slice(0, 200));
  }
  if (port.runInput) {
    const c = await port.runInput({ action: "cursor_position" });
    check("run_input cursor_position", c.ok, JSON.stringify(c).slice(0, 200));
  }
  if (port.screenshot) {
    const s = await port.screenshot({ maxDim: 800 });
    check("screenshot 含 scale/screenWidth 标定", s.ok && typeof s.scale === "number" && typeof s.screenWidth === "number", JSON.stringify({ ...s, imageBase64: undefined }).slice(0, 300));
  }
}

async function main(): Promise<void> {
  const live = process.argv.includes("--live");
  console.log("verify-desktop-control");
  await verifyRegistry();
  verifyChatTools();
  if (live) {
    await verifyLiveSubprocess();
  } else {
    console.log("\n[3] 跳过真实子进程链路（加 --live 且 DESKTOP_VISUAL_ENABLED=1 启用）");
  }
  console.log(failures === 0 ? "\nPASS" : `\nFAIL（${failures} 项未通过）`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
