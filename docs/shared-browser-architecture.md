# 共用浏览器架构（含框架解耦与换引擎指南）

> 2026-09-16 重构落地。核心目标：**把浏览器"技术层"从 UI/引擎框架中解耦**——
> 动作协议、等待编排、注入运行时全部框架无关；后续换 WebView 引擎（或服务端
> 自动化框架）时只换适配器，不重构业务层。

## 一、分层总览

```
┌─ 服务端 ────────────────────────────────────────────────┐
│ shared_browser.* 工具（chat-tools schema + intent 元数据）│
│ handlers：参数校验 → 风险分级（risk.ts）→ gate 附加        │
│ SharedBrowserCoordinator：ws 转发 / jobId 配对 / 审计      │
│ SharedBrowserCdpGateway：可信输入（CDP 桥，默认关）         │
└──────────────┬──────────────────────────────────────────┘
               │ ws: shared.browser.invoke / browser.bridge.result
               │     browser.bridge.info（CDP 端点上报）
┌─ 客户端 ─────┴──────────────────────────────────────────┐
│ SharedBrowserHost（薄壳：ws 桥 + 生命周期 + UI 通知 + 确认门）│
│ ┌─ framework-free 核心层（lib/core/browser/）──────────┐ │
│ │ shared_browser_protocol.dart  协议/错误码/URL 纯函数   │ │
│ │ browser_action_executor.dart  等待/重试/降级编排       │ │
│ │ browser_driver.dart           引擎端口（抽象类）       │ │
│ │ webview_windows_driver.dart   WebView2 适配器（唯一耦合点）│
│ └──────────────────────────────────────────────────────┘ │
│ assets/shared_browser/shared_browser_runtime.js（注入运行时，│
│ 纯同步 JS，framework-free，可独立测试）                     │
└─────────────────────────────────────────────────────────┘
```

依赖方向：`Host → Executor → Driver 端口 → 适配器`；协议与运行时不依赖任何上层。

## 二、framework-free 核心层（换框架时**不动**的部分）

### 1. 协议层 `shared_browser_protocol.dart`
- 动作名（`SbActions`）：navigate / control / click / type / scroll / read_page / get_state / export_state
- 结构化错误码（`SbErrors`）：`NOT_FOUND / DISABLED / COVERED / VERIFY_FAILED / BAD_PARAMS / ENGINE_ERROR / USER_DENIED / WAIT_TIMEOUT`——LLM 据此决策（重试/换定位/先关弹窗/放弃）
- URL 纯函数：`resolveInputToUrl` / `searchUrlFor`（omnibox 与 Agent navigate 共用）
- 结果构造 `SbResult`（与服务端 `SharedBrowserResult` 形状一致）

### 2. 执行器 `browser_action_executor.dart`
只依赖 `BrowserDriver` 端口 + 运行时源码字符串，包含全部编排：
- **click**：probe 轮询（元素出现 → 可用 → 未被遮挡）→ clickAt → 等待稳定。
  遮挡元素持续重探（浮层动画），deadline 到点后按"是否曾遮挡"区分 `COVERED`/`NOT_FOUND`
- **type**：等待输入框 → 原型 setter 赋值（React/Vue 受控组件兼容）→ 回读校验，
  吞输入时重试一次后报 `VERIFY_FAILED`
- **scroll**：滚动后短轮询 scrollHeight/scrollY 变化（懒加载）
- **read_page**：主内容启发式提取 + offset 分页续读 + 带 ref 的可交互元素
- **export_state**：cookie（HttpOnly 不可见，limited=true 标记）/ storage 导出
- 失败自动附截图（能力可用且 ≤180KB 时内联 PNG，否则标记）
- 每次动作回调 `onTrace`（足迹）

### 3. 注入运行时 `assets/shared_browser/shared_browser_runtime.js`
纯同步 JS（等待循环全部在 Dart 侧，规避各引擎对 Promise 求值差异）：
- **ref 稳定引用**：WeakMap 正查 + WeakRef 反查；read_page 返回 ref，click 按 ref
  定位，页面局部刷新不错位（index 仅兜底，整页导航后 ref 自然重置——期望行为）
- **probe**：单次探测元素可操作性，`elementFromPoint` 遮挡检测（含遮挡者文本）
- 幂等安装：文档级常驻（引擎支持时）与动作前内联并用，互不冲突
- `interceptBlank`：window.open / target=_blank → 本窗导航（弹窗策略 deny 下不再吞链接）

## 三、引擎适配层（换框架时**只动**的部分）

`BrowserDriver` 端口（`browser_driver.dart`）：start/loadUrl/导航控制/evaluateScript/
installDocumentBootstrap/captureScreenshot + 三个状态流 + 能力声明
（`BrowserCapabilities.screenshot / documentBootstrap`）。

当前实现 `webview_windows_driver.dart`（WebView2 via webview_windows 0.4.0）：
- 该插件**没有** capturePreview → `screenshot: false`，执行器自动降级
- 支持 addScriptToExecuteOnDocumentCreated → 运行时按文档常驻安装
- CDP 端口经 `initializeEnvironment(additionalArguments:)` 传入

### 换引擎步骤（如 flutter_inappwebview / WebView2 直托管 / CEF）
1. 新建 `xxx_driver.dart implements BrowserDriver`（唯一允许 import 新插件的动作层文件）
2. 如实声明能力（截图/Cookie 管理器支持则翻 `screenshot: true`，失败自纠立刻生效）
3. `SharedBrowserHost._start()` 换一行驱动构造
4. `BrowserPage` 渲染端同步替换 `Webview(controller)` 挂载组件（渲染层允许知道引擎）
5. 跑 `test/browser_action_executor_test.dart`（FakeDriver 驱动，无需真引擎）

## 四、安全：风险分级 + 确认门 + 可信输入

### 风险确认门（默认生效）
- 服务端 `risk.ts` 对 click/type 分级：提交/支付类文案命中，或电商/票务/支付域上的
  点击 → `level: high`
- coordinator 在 `shared.browser.invoke` 附 `gate: {required: true, level, reason, targetSummary}`
- 客户端浏览器页弹确认条，用户「允许」才执行；拒绝或 120 秒未决 → 结果
  `ok:false, code:USER_DENIED, denied:true`
- 全链路审计：invoke / done / failed / timeout 均落 `category "shared_browser"`，
  含耗时（durationMs）与拒绝标记

### 可信输入 CDP 桥（`shared_browser.trusted` 工具，默认关闭）
三层开关，缺一不可：
1. 客户端 `SharedBrowserHost.remoteDebugPort`（用户显式设置，默认 null）
2. 服务端总开关 `SHARED_BROWSER_CDP_ENABLED=1`
3. 客户端上报端点（`browser.bridge.info`，服务端只接受 127.0.0.1/localhost 回环）

开启后服务端 Playwright `connectOverCDP` 直连用户浏览器派发 isTrusted=true 的
真实事件（抗风控）；未开启时工具自动回退注入路径并在结果注明 `trusted:false`。
部署约束：服务端须与客户端同机（或可达客户端回环口）。

## 五、测试

- 客户端：`test/browser_action_executor_test.dart`（FakeDriver，19 例：等待重试/
  错误码/ref 失效/吞输入/分页/截图降级/轨迹）+ `test/shared_browser_host_test.dart`
- 服务端：`test/shared-browser-coordinator.test.ts`（配对/超时/gate 附加/CDP 端点）
  + `test/shared-browser-tools.test.ts`（8 工具注册/离线降级/参数校验/在线转发）
- 服务端总编译：`npx tsc -p tsconfig.json --noEmit`；客户端：`flutter analyze` + `flutter test`

## 六、已知边界与后续

- 截图能力待引擎升级（webview_windows 无 capturePreview）；换引擎后零代码获得
- 多标签页未做（单 WebView 实例）；`tabId` 参数已预留为工具层扩展位
- export_state 拿不到 HttpOnly Cookie（WebView2 CookieManager 未暴露）；完整
  storageState 建议走服务端 agent_browser 池 + shopping-order 既有 Cookie 导入链路
- 下单类任务维持既有分工：shared_browser 只到"把结算页摆好 + 用户确认"，
  真正下单走 shopping-order-service 两阶段确认链路
