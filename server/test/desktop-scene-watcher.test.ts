/**
 * 桌面情境感知（SceneWatcher）单元测试：场景分类 + 停留状态机 + 冷却。
 * 全部纯逻辑，注入时钟，不触桌面、不触模型。
 *
 * 运行：cd server && npx tsx --test test/desktop-scene-watcher.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyWindow,
  DesktopSceneWatcherService,
  DEFAULT_SCENE_WATCHER_CONFIG,
} from "../src/services/desktop-scene-watcher-service.js";

// ─── classifyWindow ────────────────────────────────────────────────────────

test("classifyWindow: 专用会议进程任意窗口都是会议", () => {
  assert.equal(classifyWindow("wemeetapp.exe", "腾讯会议").kind, "meeting");
  assert.equal(classifyWindow("Zoom.exe", "Zoom Meeting").kind, "meeting");
});

test("classifyWindow: 标题含会议词即会议（未知进程也算）", () => {
  assert.equal(classifyWindow("unknown.exe", "每周例会 - 腾讯会议").kind, "meeting");
  assert.equal(classifyWindow("teams.exe", "Team Meeting | Microsoft Teams").kind, "meeting");
});

test("classifyWindow: 协作进程的普通聊天窗口不是会议", () => {
  assert.equal(classifyWindow("dingtalk.exe", "钉钉 - 工作台").kind, null);
  assert.equal(classifyWindow("feishu.exe", "飞书").kind, null);
});

test("classifyWindow: 标题里的完整路径文档 → document（含 filePath）", () => {
  const r = classifyWindow("Acrobat.exe", "2026年Q2财报.pdf - Adobe Acrobat Reader");
  assert.equal(r.kind, "document");
  if (r.kind === "document") {
    assert.equal(r.fileName, "2026年Q2财报.pdf");
    assert.equal(r.filePath, null); // 标题只有文件名，无路径
  }
});

test("classifyWindow: 标题含盘符路径 → document（提取 filePath）", () => {
  const r = classifyWindow("notepad.exe", "C:\\Users\\me\\Desktop\\notes.md - 记事本");
  assert.equal(r.kind, "document");
  if (r.kind === "document") {
    assert.equal(r.filePath, "C:\\Users\\me\\Desktop\\notes.md");
    assert.equal(r.fileName, "notes.md");
  }
});

test("classifyWindow: 浏览器 + 电商关键词 → shopping", () => {
  assert.equal(classifyWindow("chrome.exe", "【官方旗舰】无线耳机 - 京东").kind, "shopping");
  assert.equal(classifyWindow("msedge.exe", "商品详情 - 淘宝网").kind, "shopping");
});

test("classifyWindow: 浏览器普通页面 / 非浏览器电商词 → null", () => {
  assert.equal(classifyWindow("chrome.exe", "知乎 - 有问题就会有答案").kind, null);
  // 非浏览器进程里的电商词不触发（避免聊天窗口误报）
  assert.equal(classifyWindow("wechat.exe", "京东快递已发货").kind, null);
});

test("classifyWindow: 会议优先于文档（会议窗口标题带 .pdf 的边界）", () => {
  // wemeetapp 主窗口是会议，即便标题带其他词
  assert.equal(classifyWindow("wemeetapp.exe", "纪要.txt").kind, "meeting");
});

// ─── 状态机：会议 ──────────────────────────────────────────────────────────

type Harness = {
  watcher: DesktopSceneWatcherService;
  now: { value: number };
  events: { meetingStart: number; meetingEnd: number; doc: number; shop: number };
};

function makeHarness(configOverrides = {}): Harness {
  const now = { value: 1_000_000 };
  const events = { meetingStart: 0, meetingEnd: 0, doc: 0, shop: 0 };
  const watcher = new DesktopSceneWatcherService({
    config: { ...DEFAULT_SCENE_WATCHER_CONFIG, ...configOverrides },
    now: () => now.value,
    onMeetingStarted: () => {
      events.meetingStart += 1;
    },
    onMeetingEnded: () => {
      events.meetingEnd += 1;
    },
    onDocumentDetected: () => {
      events.doc += 1;
    },
    onProductPageDetected: () => {
      events.shop += 1;
    },
  });
  return { watcher, now, events };
}

test("会议: window_open 专用会议进程立即开会话，window_close 结束", () => {
  const h = makeHarness();
  assert.equal(
    h.watcher.handleDesktopEvent("u1", "window_open", {
      title: "腾讯会议",
      process: "wemeetapp.exe",
      hwnd: 111,
    }),
    true,
  );
  assert.equal(h.events.meetingStart, 1);

  // 会议窗口后台挂着，前台来回切换不影响
  h.now.value += 5 * 60_000;
  h.watcher.handleDesktopEvent("u1", "scene_tick", { title: "知乎", process: "chrome.exe" });
  assert.equal(h.events.meetingEnd, 0);

  // 关闭会议窗口 → 结束，时长正确
  assert.equal(h.watcher.handleWindowClose("u1", { hwnd: 111 }), true);
  assert.equal(h.events.meetingEnd, 1);
});

test("会议: 前台持续确认后开会话，离开超过宽限期结束", () => {
  const h = makeHarness({ meetingConfirmMs: 35_000, meetingEndGraceMs: 120_000 });
  h.watcher.handleDesktopEvent("u2", "scene_tick", { title: "腾讯会议", process: "wemeetapp.exe" });
  assert.equal(h.events.meetingStart, 0); // 尚未持续确认

  h.now.value += 40_000;
  h.watcher.handleDesktopEvent("u2", "scene_tick", { title: "腾讯会议", process: "wemeetapp.exe" });
  assert.equal(h.events.meetingStart, 1);

  // 切走 → 进入宽限
  h.now.value += 30_000;
  h.watcher.handleDesktopEvent("u2", "scene_tick", { title: "文档", process: "winword.exe" });
  assert.equal(h.events.meetingEnd, 0);
  // 宽限期内回到会议 → 不结束
  h.now.value += 60_000;
  h.watcher.handleDesktopEvent("u2", "scene_tick", { title: "腾讯会议", process: "wemeetapp.exe" });
  h.now.value += 30_000;
  h.watcher.handleDesktopEvent("u2", "scene_tick", { title: "文档", process: "winword.exe" });
  h.now.value += 130_000;
  h.watcher.handleDesktopEvent("u2", "scene_tick", { title: "文档", process: "winword.exe" });
  assert.equal(h.events.meetingEnd, 1);
});

test("文档: 停留超过确认时长才触发，同文档 6h 冷却", () => {
  const h = makeHarness();
  const doc = { title: "设计文档.md - Visual Studio Code", process: "code.exe" };
  h.watcher.handleDesktopEvent("u3", "scene_tick", doc);
  h.now.value += 30_000;
  assert.equal(h.events.doc, 0);
  h.watcher.handleDesktopEvent("u3", "scene_tick", doc);
  h.now.value += 31_000;
  h.watcher.handleDesktopEvent("u3", "scene_tick", doc);
  assert.equal(h.events.doc, 1);

  // 冷却期内不重复
  h.now.value += 60_000;
  h.watcher.handleDesktopEvent("u3", "scene_tick", doc);
  assert.equal(h.events.doc, 1);
});

test("商品页: 前台停留触发一次，不同商品页各自触发", () => {
  const h = makeHarness({ shoppingConfirmMs: 45_000 });
  const shopA = { title: "无线耳机 - 京东", process: "chrome.exe" };
  h.watcher.handleDesktopEvent("u4", "focus_change", shopA);
  h.now.value += 50_000;
  h.watcher.handleDesktopEvent("u4", "scene_tick", shopA);
  assert.equal(h.events.shop, 1);

  // 换一个商品页 → 新 key，再触发
  h.now.value += 50_000;
  h.watcher.handleDesktopEvent("u4", "focus_change", {
    title: "机械键盘 - 淘宝网",
    process: "chrome.exe",
  });
  h.now.value += 50_000;
  h.watcher.handleDesktopEvent("u4", "scene_tick", {
    title: "机械键盘 - 淘宝网",
    process: "chrome.exe",
  });
  assert.equal(h.events.shop, 2);
});

test("多 actor 状态互相隔离", () => {
  const h = makeHarness();
  h.watcher.handleDesktopEvent("a", "window_open", { title: "腾讯会议", process: "wemeetapp.exe", hwnd: 1 });
  h.watcher.handleDesktopEvent("b", "window_open", { title: "腾讯会议", process: "wemeetapp.exe", hwnd: 2 });
  assert.equal(h.events.meetingStart, 2);
});

test("无关事件被忽略", () => {
  const h = makeHarness();
  assert.equal(h.watcher.handleDesktopEvent("u5", "desktop.task.step", { title: "腾讯会议", process: "wemeetapp.exe" }), false);
  assert.equal(h.events.meetingStart, 0);
});
