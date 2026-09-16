import "dart:async";

import "package:flutter/foundation.dart";
import "package:flutter/services.dart" show rootBundle;
import "package:webview_windows/webview_windows.dart"
    show WebviewController;

import "../browser/browser_action_executor.dart";
import "../browser/browser_driver.dart";
import "../browser/shared_browser_protocol.dart" as proto;
import "../browser/webview_windows_driver.dart";

export "../browser/shared_browser_protocol.dart"
    show SbActionTrace, SbConfirmRequest, resolveInputToUrl, searchUrlFor;

/// 动作执行结果（与 ws browser.bridge.result 通道约定一致）。
typedef SharedBrowserResult = Map<String, dynamic>;

/// 发送 ws 事件的回调（启动时由 main 注入 WsChatService.sendEvent）。
typedef WsEventSender = void Function(String type, Map<String, dynamic> payload);

/// 用户与 Agent 共用的浏览器宿主（进程级单例）。
///
/// 本类是**薄壳**：只负责 ws 桥（shared.browser.invoke / browser.bridge.result）、
/// 生命周期（惰性启动/常驻）、UI 状态通知与高风险动作确认门；动作编排委托给
/// framework-free 的 [BrowserActionExecutor]，引擎访问委托给 [BrowserDriver]
/// 端口（当前实现 WebviewWindowsDriver）。换 WebView 引擎时本类原则上只改
/// 驱动构造一行。
///
/// 浏览器本体是客户端 WebView2：用户在「常用工具 → 浏览器」里正常浏览，
/// Agent 的 shared_browser.* 动作经 ws（shared.browser.invoke）转发到这里，
/// 在**同一个** WebView 实例上执行——用户的登录态/页面状态天然共享，
/// 用户全程可见，可随时手动接管。
///
/// 生命周期：进程级常驻（与 TravelWebPanelHost 同思路），控制器惰性初始化；
/// 浏览器页关闭只摘除渲染挂载点，页面状态保留，Agent 仍可在后台继续操作。
class SharedBrowserHost {
  SharedBrowserHost._();

  static final SharedBrowserHost instance = SharedBrowserHost._();

  /// 注入运行时资产（framework-free JS，见 assets/shared_browser/）。
  static const String _runtimeAsset =
      "assets/shared_browser/shared_browser_runtime.js";

  WebviewWindowsDriver? _driver;
  BrowserActionExecutor? _executor;
  Future<void>? _starting;
  String? _error;
  String? _runtimeSource;
  StreamSubscription<String>? _urlSub;
  StreamSubscription<String>? _titleSub;
  StreamSubscription<DriverLoadingState>? _loadingSub;

  /// 远程调试端口（CDP 桥用）。null = 关闭（默认）。必须在 ensureStarted 前
  /// 设置；开启后客户端会把 `http://127.0.0.1:<port>` 经 browser.bridge.info
  /// 上报服务端，供 trusted 工具（Playwright CDP 直连，isTrusted=true 输入）使用。
  int? remoteDebugPort;

  /// ws 发送函数（main.dart 注入 _ws.sendEvent）。
  WsEventSender? _sendEvent;

  /// 当前地址（空或 about:blank = 主页态，页面显示居中搜索框）。
  final ValueNotifier<String> currentUrl = ValueNotifier<String>("");

  /// 当前页面标题。
  final ValueNotifier<String> currentTitle = ValueNotifier<String>("");

  /// 页面是否加载中。
  final ValueNotifier<bool> isLoading = ValueNotifier<bool>(false);

  /// Agent 桥状态：挂起的 invoke 数量 + 最近一次动作（页面状态条展示「Agent 正在操作」）。
  final ValueNotifier<int> pendingAgentActions = ValueNotifier<int>(0);
  final ValueNotifier<String> lastAgentAction = ValueNotifier<String>("");

  /// 高风险动作确认请求（浏览器页弹确认条；null = 无待确认）。
  final ValueNotifier<proto.SbConfirmRequest?> confirmRequest =
      ValueNotifier<proto.SbConfirmRequest?>(null);

  /// 动作轨迹（足迹回放，最新在前，环形上限 50 条）。
  final ValueNotifier<List<proto.SbActionTrace>> actionTrace =
      ValueNotifier<List<proto.SbActionTrace>>(<proto.SbActionTrace>[]);

  Completer<bool>? _confirmCompleter;

  /// 引擎控制器（仅供渲染层 Webview 组件挂载；动作逻辑禁止直接使用）。
  WebviewController? get controller =>
      _driver?.isReady == true ? _driver!.controller : null;

  bool get isReady => _driver?.isReady == true;

  String? get error => _error;

  bool get atHome => currentUrl.value.isEmpty || currentUrl.value == "about:blank";

  /// 绑定 ws 发送函数（幂等）。
  void bindSend(WsEventSender send) {
    _sendEvent = send;
  }

  /// main.dart 的 ws 事件入口：命中 shared.browser.invoke 时执行并回执
  /// browser.bridge.result（jobId 配对）。服务端下发的 gate.required=true
  /// 表示高风险动作：先弹确认条，用户允许才执行（120 秒未决视为拒绝）。
  Future<void> handleServerEvent(String type, Map<String, dynamic> payload) async {
    if (type != "shared.browser.invoke") return;
    final String jobId = payload["jobId"]?.toString() ?? "";
    final String action = payload["action"]?.toString() ?? "";
    final Map<String, dynamic> params =
        (payload["params"] as Map?)?.cast<String, dynamic>() ??
            <String, dynamic>{};

    final Map<String, dynamic> gate =
        (payload["gate"] as Map?)?.cast<String, dynamic>() ??
            <String, dynamic>{};
    if (gate["required"] == true) {
      final bool allowed = await _requestConfirmation(proto.SbConfirmRequest(
        jobId: jobId,
        action: action,
        reason: gate["reason"]?.toString() ?? "高风险动作",
        targetSummary: gate["targetSummary"]?.toString() ??
            (params["text"] ?? params["selector"] ?? params["url"] ?? "").toString(),
      ));
      if (!allowed) {
        _sendEvent?.call("browser.bridge.result", <String, dynamic>{
          if (jobId.isNotEmpty) "jobId": jobId,
          "ok": false,
          "error": "用户在浏览器里拒绝（或未确认）该操作",
          "code": proto.SbErrors.userDenied,
          "denied": true,
        });
        return;
      }
    }

    pendingAgentActions.value += 1;
    lastAgentAction.value = action;
    SharedBrowserResult result;
    try {
      result = await performAction(action, params);
    } catch (e) {
      result = <String, dynamic>{
        "ok": false,
        "error": "浏览器动作异常：$e",
        "code": proto.SbErrors.engine,
      };
    } finally {
      pendingAgentActions.value = (pendingAgentActions.value - 1).clamp(0, 1 << 30);
    }
    _sendEvent?.call("browser.bridge.result", <String, dynamic>{
      if (jobId.isNotEmpty) "jobId": jobId,
      ...result,
    });
  }

  /// 用户在确认条上点「允许 / 拒绝」。
  void resolveConfirmation(bool allow) {
    final Completer<bool>? c = _confirmCompleter;
    if (c != null && !c.isCompleted) c.complete(allow);
  }

  Future<bool> _requestConfirmation(proto.SbConfirmRequest request) async {
    final Completer<bool> completer = Completer<bool>();
    _confirmCompleter = completer;
    confirmRequest.value = request;
    final Timer timer = Timer(const Duration(seconds: 120), () {
      if (!completer.isCompleted) completer.complete(false);
    });
    final bool allowed = await completer.future;
    timer.cancel();
    if (identical(_confirmCompleter, completer)) {
      _confirmCompleter = null;
      confirmRequest.value = null;
    }
    return allowed;
  }

  // ═══════════════════════════════════════════════════════════
  // 用户侧导航（omnibox / 工具栏）
  // ═══════════════════════════════════════════════════════════

  /// omnibox/主页搜索框提交：URL 直接打开，否则走搜索引擎。
  Future<void> submitQuery(String raw) async {
    final String url =
        proto.resolveInputToUrl(raw) ?? proto.searchUrlFor(raw);
    await ensureStarted();
    await performAction(proto.SbActions.navigate,
        <String, dynamic>{"url": url});
  }

  Future<void> goBack() async => _driver?.goBack();
  Future<void> goForward() async => _driver?.goForward();
  Future<void> reload() async => _driver?.reload();
  Future<void> stop() async => _driver?.stopLoading();

  Future<void> goHome() async {
    await _driver?.loadUrl("about:blank");
    currentUrl.value = "";
  }

  // ── 协议纯函数转发（UI/测试沿用旧入口）────────────────────────────
  static String? resolveInputToUrl(String input) => proto.resolveInputToUrl(input);
  static String searchUrlFor(String query) => proto.searchUrlFor(query);

  // ═══════════════════════════════════════════════════════════
  // Agent 桥动作执行
  // ═══════════════════════════════════════════════════════════

  /// 执行一个协议动作（Agent 桥经 handleServerEvent 调用）。
  Future<SharedBrowserResult> performAction(
    String action,
    Map<String, dynamic> params,
  ) async {
    await ensureStarted();
    final BrowserActionExecutor? executor = _executor;
    if (executor == null) {
      return <String, dynamic>{
        "ok": false,
        "error": _error ?? "浏览器未初始化",
        "code": proto.SbErrors.engine,
      };
    }
    return executor.perform(action, params);
  }

  // ═══════════════════════════════════════════════════════════
  // 初始化（薄壳：装配驱动 + 执行器 + 事件流）
  // ═══════════════════════════════════════════════════════════

  /// 幂等启动：加载注入运行时 → 启动驱动 → 挂事件流 → 构造执行器。
  Future<void> ensureStarted() async {
    if (_driver?.isReady == true) return;
    if (_starting != null) return _starting!;
    _starting = _start();
    return _starting!;
  }

  Future<void> _start() async {
    try {
      _runtimeSource ??= await rootBundle.loadString(_runtimeAsset);
      final WebviewWindowsDriver driver = WebviewWindowsDriver();
      await driver.start(BrowserStartOptions(
        documentBootstrapScript: _runtimeSource,
        additionalArguments: remoteDebugPort == null
            ? null
            : "--remote-debugging-port=$remoteDebugPort",
      ));

      _urlSub?.cancel();
      _urlSub = driver.urlStream.listen((String url) => currentUrl.value = url);
      _titleSub?.cancel();
      _titleSub = driver.titleStream.listen((String title) => currentTitle.value = title);
      _loadingSub?.cancel();
      _loadingSub = driver.loadingStateStream
          .listen((DriverLoadingState s) => isLoading.value = s == DriverLoadingState.loading);

      _driver = driver;
      _executor = BrowserActionExecutor(
        driver: driver,
        runtimeSource: _runtimeSource!,
        onTrace: _recordTrace,
      );

      // CDP 桥：仅在用户显式开启调试端口时上报端点（默认关闭）
      if (remoteDebugPort != null) {
        _sendEvent?.call("browser.bridge.info", <String, dynamic>{
          "endpoint": "http://127.0.0.1:$remoteDebugPort",
        });
      }
    } catch (e) {
      _error = "浏览器初始化失败：$e";
      _starting = null;
    }
  }

  void _recordTrace(proto.SbActionTrace trace) {
    final List<proto.SbActionTrace> next =
        List<proto.SbActionTrace>.of(actionTrace.value)..insert(0, trace);
    if (next.length > 50) next.removeRange(50, next.length);
    actionTrace.value = next;
  }

  @mustCallSuper
  void dispose() {
    _urlSub?.cancel();
    _titleSub?.cancel();
    _loadingSub?.cancel();
    try {
      _driver?.dispose();
    } catch (_) {}
    _driver = null;
    _executor = null;
    _starting = null;
  }
}
