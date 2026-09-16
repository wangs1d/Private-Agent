import "dart:async";
import "dart:convert" show jsonEncode;

import "package:flutter/foundation.dart";
import "package:webview_windows/webview_windows.dart";

import "windows_webview_bootstrap_io.dart" show bootstrapWindowsWebView;

/// 动作执行结果（与 ws browser.bridge.result 通道约定一致）。
typedef SharedBrowserResult = Map<String, dynamic>;

/// 发送 ws 事件的回调（启动时由 main 注入 WsChatService.sendEvent）。
typedef WsEventSender = void Function(String type, Map<String, dynamic> payload);

/// 用户与 Agent 共用的浏览器宿主（进程级单例）。
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

  WebviewController? _controller;
  Future<void>? _starting;
  String? _error;
  StreamSubscription<dynamic>? _urlSub;
  StreamSubscription<LoadingState>? _loadingSub;
  StreamSubscription<String>? _titleSub;

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

  WebviewController? get controller => _controller;

  bool get isReady => _controller != null;

  String? get error => _error;

  bool get atHome => currentUrl.value.isEmpty || currentUrl.value == "about:blank";

  /// 绑定 ws 发送函数（幂等）。
  void bindSend(WsEventSender send) {
    _sendEvent = send;
  }

  /// main.dart 的 ws 事件入口：命中 shared.browser.invoke 时执行并回执
  /// browser.bridge.result（jobId 配对）。
  Future<void> handleServerEvent(String type, Map<String, dynamic> payload) async {
    if (type != "shared.browser.invoke") return;
    final String jobId = payload["jobId"]?.toString() ?? "";
    final String action = payload["action"]?.toString() ?? "";
    final Map<String, dynamic> params =
        (payload["params"] as Map?)?.cast<String, dynamic>() ??
            <String, dynamic>{};

    pendingAgentActions.value += 1;
    lastAgentAction.value = action;
    SharedBrowserResult result;
    try {
      result = await performAction(action, params);
    } catch (e) {
      result = <String, dynamic>{"ok": false, "error": "浏览器动作异常：$e"};
    } finally {
      pendingAgentActions.value = (pendingAgentActions.value - 1).clamp(0, 1 << 30);
    }
    _sendEvent?.call("browser.bridge.result", <String, dynamic>{
      if (jobId.isNotEmpty) "jobId": jobId,
      ...result,
    });
  }

  // ═══════════════════════════════════════════════════════════
  // 初始化
  // ═══════════════════════════════════════════════════════════

  /// 幂等启动：初始化 WebView2 控制器并挂事件流。
  Future<void> ensureStarted() async {
    if (_controller != null) return;
    if (_starting != null) return _starting!;
    _starting = _start();
    return _starting!;
  }

  Future<void> _start() async {
    try {
      await bootstrapWindowsWebView();
      final WebviewController c = WebviewController();
      await c.initialize();
      await c.setPopupWindowPolicy(WebviewPopupWindowPolicy.deny);
      await c.loadUrl("about:blank");

      _urlSub?.cancel();
      _urlSub = c.url.listen((String url) => currentUrl.value = url);
      _titleSub?.cancel();
      _titleSub = c.title.listen((String title) => currentTitle.value = title);
      _loadingSub?.cancel();
      _loadingSub = c.loadingState.listen((LoadingState s) {
        isLoading.value = s == LoadingState.loading;
      });

      _controller = c;
      _error = null;
    } catch (e) {
      _error = "WebView2 初始化失败：$e";
      debugPrint("[SharedBrowserHost] init failed: $e");
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 用户侧导航 API（浏览器页工具栏调用）
  // ═══════════════════════════════════════════════════════════

  /// 回到主页（WebView 停 about:blank，页面显示居中搜索框）。
  Future<void> goHome() async {
    final WebviewController? c = _controller;
    if (c == null) return;
    await c.loadUrl("about:blank");
    currentUrl.value = "about:blank";
    currentTitle.value = "";
  }

  Future<void> goBack() => _controller?.goBack() ?? Future<void>.value();

  Future<void> goForward() => _controller?.goForward() ?? Future<void>.value();

  Future<void> reload() => _controller?.reload() ?? Future<void>.value();

  Future<void> stop() => _controller?.stop() ?? Future<void>.value();

  /// 智能导航（omnibox）：输入像 URL 直接打开，否则走搜索引擎。
  Future<void> submitQuery(String raw) async {
    final String input = raw.trim();
    if (input.isEmpty) return;
    final String? url = resolveInputToUrl(input);
    await navigateTo(url ?? searchUrlFor(input));
  }

  /// 导航到指定 URL（等加载稳定后返回；UI 与 Agent 桥共用）。
  Future<void> navigateTo(String url) async {
    if (_controller == null) await ensureStarted();
    final WebviewController? c = _controller;
    if (c == null) return;
    await c.loadUrl(url);
    // currentUrl 由 url 流更新；这里再等一拍让标题/加载态跟上
    await _waitLoadSettled(c, maxWaitMs: 2000);
  }

  // ═══════════════════════════════════════════════════════════
  // URL 解析（用户 omnibox 与 Agent navigate 共用）
  // ═══════════════════════════════════════════════════════════

  /// 输入是 URL 时返回补全后的 URL；否则返回 null（视为搜索词）。
  static String? resolveInputToUrl(String input) {
    final String s = input.trim();
    if (s.isEmpty) return null;
    if (RegExp(r'^https?://', caseSensitive: false).hasMatch(s)) return s;
    if (s.toLowerCase() == "localhost" || s.startsWith("localhost:")) {
      return "http://$s";
    }
    // 无 scheme 的域名样输入（含点、无空格）→ 补 https
    if (!s.contains(" ") && s.contains(".")) {
      final String host = s.split("/").first;
      if (RegExp(r'^[a-zA-Z0-9][a-zA-Z0-9.\-:_]+$').hasMatch(host)) {
        return "https://$s";
      }
    }
    return null;
  }

  /// 搜索词 → 搜索引擎 URL（Bing 中文，与 desktop.web_search 引擎选择一致）。
  static String searchUrlFor(String query) {
    return "https://cn.bing.com/search?q=${Uri.encodeQueryComponent(query)}";
  }

  // ═══════════════════════════════════════════════════════════
  // Agent 桥动作执行
  // ═══════════════════════════════════════════════════════════

  /// 执行一个浏览器动作（Agent 桥经 handleServerEvent 调用）。
  Future<SharedBrowserResult> performAction(
    String action,
    Map<String, dynamic> params,
  ) async {
    if (_controller == null) {
      // 首次 invoke 可能早于浏览器页打开：惰性拉起控制器
      await ensureStarted();
    }
    final WebviewController? c = _controller;
    if (c == null) {
      return <String, dynamic>{"ok": false, "error": _error ?? "浏览器未初始化"};
    }
    switch (action) {
      case "navigate":
        return _navigate(c, params);
      case "control":
        return _control(c, params);
      case "click":
        return _click(c, params);
      case "type":
        return _type(c, params);
      case "scroll":
        return _scroll(c, params);
      case "read_page":
        return _readPage(c, params);
      case "get_state":
        return _getState(c);
      default:
        return <String, dynamic>{"ok": false, "error": "未知动作：$action"};
    }
  }

  Future<SharedBrowserResult> _navigate(
    WebviewController c,
    Map<String, dynamic> params,
  ) async {
    final String raw = params["url"]?.toString().trim() ?? "";
    if (raw.isEmpty) return <String, dynamic>{"ok": false, "error": "缺少 url"};
    final String? resolved = resolveInputToUrl(raw);
    if (resolved == null) {
      return <String, dynamic>{
        "ok": false,
        "error": "url 格式无效：$raw（须为 http/https 链接）",
      };
    }
    try {
      await c.loadUrl(resolved);
      final Map<String, dynamic> state = await _waitLoadSettled(c);
      return <String, dynamic>{"ok": true, ...state};
    } catch (e) {
      return <String, dynamic>{"ok": false, "error": "导航失败：$e"};
    }
  }

  Future<SharedBrowserResult> _control(
    WebviewController c,
    Map<String, dynamic> params,
  ) async {
    final String nav = params["action"]?.toString() ?? "";
    switch (nav) {
      case "back":
        if (!atHome) await c.goBack();
      case "forward":
        if (!atHome) await c.goForward();
      case "reload":
        if (!atHome) await c.reload();
      case "stop":
        await c.stop();
      case "home":
        await goHome();
      default:
        return <String, dynamic>{"ok": false, "error": "未知导航动作：$nav"};
    }
    if (nav == "home") {
      return <String, dynamic>{"ok": true, "url": "about:blank", "title": ""};
    }
    final Map<String, dynamic> state = await _waitLoadSettled(c, maxWaitMs: 5000);
    return <String, dynamic>{"ok": true, ...state};
  }

  Future<SharedBrowserResult> _click(
    WebviewController c,
    Map<String, dynamic> params,
  ) async {
    final String? selector = (params["selector"] as String?)?.trim();
    final String? text = (params["text"] as String?)?.trim();
    final int? index = params["index"] is int ? params["index"] as int : null;
    if ((selector == null || selector.isEmpty) &&
        (text == null || text.isEmpty) &&
        index == null) {
      return <String, dynamic>{"ok": false, "error": "selector/text/index 至少传一个"};
    }
    final Map<String, dynamic> r = await _sbCall(
      c,
      "click",
      <String, dynamic>{
        "selector": selector,
        "text": text,
        "index": index,
      },
    );
    if (r["clicked"] == true) {
      await Future<void>.delayed(const Duration(milliseconds: 300));
      final Map<String, dynamic> state = await _waitLoadSettled(c, maxWaitMs: 5000);
      return <String, dynamic>{"ok": true, ...state};
    }
    return <String, dynamic>{
      "ok": false,
      "retryable": true,
      "error": r["error"]?.toString() ?? "未找到可点击元素",
    };
  }

  Future<SharedBrowserResult> _type(
    WebviewController c,
    Map<String, dynamic> params,
  ) async {
    final String text = params["text"]?.toString() ?? "";
    if (text.isEmpty) return <String, dynamic>{"ok": false, "error": "缺少 text"};
    final bool submit = params["submit"] == true;
    final Map<String, dynamic> r = await _sbCall(
      c,
      "type",
      <String, dynamic>{
        "selector": (params["selector"] as String?)?.trim(),
        "text": text,
        "submit": submit,
        "clear": params["clear"] != false,
      },
    );
    if (r["typed"] == true) {
      // 提交后给页面一点导航/渲染时间
      final Map<String, dynamic> state =
          await _waitLoadSettled(c, maxWaitMs: submit ? 5000 : 1500);
      return <String, dynamic>{"ok": true, ...state};
    }
    return <String, dynamic>{
      "ok": false,
      "retryable": true,
      "error": r["error"]?.toString() ?? "未找到输入框",
    };
  }

  Future<SharedBrowserResult> _scroll(
    WebviewController c,
    Map<String, dynamic> params,
  ) async {
    final int deltaY = params["deltaY"] is int ? params["deltaY"] as int : 600;
    final String to = params["to"]?.toString() ?? "";
    final String script = to == "top"
        ? "window.scrollTo({top:0}); true"
        : to == "bottom"
            ? "window.scrollTo({top:document.body.scrollHeight}); true"
            : "window.scrollBy({top:$deltaY}); true";
    await c.executeScript(script);
    final dynamic pos = await c.executeScript(
      "(function(){return {y: Math.round(window.scrollY), total: Math.round(document.body ? document.body.scrollHeight : 0)};})()",
    );
    return <String, dynamic>{"ok": true, ..._asMap(pos)};
  }

  Future<SharedBrowserResult> _readPage(
    WebviewController c,
    Map<String, dynamic> params,
  ) async {
    try {
      final Map<String, dynamic> r = await _sbCall(
        c,
        "read",
        <String, dynamic>{
          "selector": ((params["selector"] as String?) ?? "").trim(),
          "includeInteractive": params["includeInteractive"] != false,
          "maxChars": params["maxChars"] is int ? params["maxChars"] as int : 4000,
        },
      );
      if (r.containsKey("error")) {
        return <String, dynamic>{"ok": false, "error": r["error"]};
      }
      return <String, dynamic>{
        "ok": true,
        "url": r["url"],
        "title": r["title"],
        "text": r["text"],
        "elements": r["elements"] ?? const <dynamic>[],
      };
    } catch (e) {
      return <String, dynamic>{"ok": false, "error": "页面读取失败：$e"};
    }
  }

  Future<SharedBrowserResult> _getState(WebviewController c) async {
    try {
      final dynamic r = await c.executeScript(
        "(function(){return {url: location.href, title: document.title, readyState: document.readyState};})()",
      );
      return <String, dynamic>{"ok": true, ..._asMap(r)};
    } catch (e) {
      return <String, dynamic>{"ok": false, "error": "状态读取失败：$e"};
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 页面脚本：每次调用自包含注入（不依赖 addScriptToExecuteOnDocumentCreated
  // 的注册时序，任何页面状态下都可用）
  // ═══════════════════════════════════════════════════════════

  /// 在页面里安装 window.__sharedBrowser 工具集后调用指定函数。
  Future<Map<String, dynamic>> _sbCall(
    WebviewController c,
    String fn,
    Map<String, dynamic> args,
  ) async {
    final String argJson = jsonEncode(args);
    final dynamic r = await c.executeScript(
      "(function(){${_sharedBrowserInstallSource}__installSharedBrowser();"
      "return window.__sharedBrowser.$fn($argJson);})()",
    );
    return _asMap(r);
  }

  /// window.__sharedBrowser = {read, click, type} 安装源码。
  /// read 与 click 的可交互元素用同一遍历顺序，保证 index 稳定一致。
  static const String _sharedBrowserInstallSource = r'''
function __installSharedBrowser() {
  window.__sharedBrowser = {
    INTERACTIVE: [
      "a[href]", "button", "input", "select", "textarea",
      "[role=button]", "[role=link]", "[role=tab]", "[role=checkbox]",
      "[onclick]", "summary", "label"
    ].join(",")
  };
  const SB = window.__sharedBrowser;
  SB.visible = function (el) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none";
  };
  SB.textOf = function (el) {
    return (el.innerText || el.value || el.getAttribute("aria-label") || el.title || "")
      .trim().replace(/\s+/g, " ").slice(0, 80);
  };
  // 返回真实元素（按 DOM 顺序），read/click 共用，index 才能对上
  SB.els = function (limit) {
    const out = [];
    document.querySelectorAll(SB.INTERACTIVE).forEach((el) => {
      if (out.length >= limit) return;
      if (!SB.visible(el) || el.disabled) return;
      out.push(el);
    });
    return out;
  };
  SB.read = function (opts) {
    const maxChars = opts.maxChars || 4000;
    let text = "";
    if (opts.selector) {
      const el = document.querySelector(opts.selector);
      if (!el) return { error: "选择器未命中: " + opts.selector };
      text = el.innerText || "";
    } else {
      text = document.body ? document.body.innerText : "";
    }
    const result = {
      url: location.href,
      title: document.title,
      text: (text || "").trim().slice(0, maxChars)
    };
    if (opts.includeInteractive !== false) {
      result.elements = SB.els(30).map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: SB.textOf(el)
      }));
    }
    return result;
  };
  SB.click = function (opts) {
    let el = null;
    if (opts.index != null) {
      el = SB.els(200)[opts.index] || null;
    } else if (opts.selector) {
      el = document.querySelector(opts.selector);
    } else if (opts.text) {
      const want = opts.text.trim().toLowerCase();
      let exact = null, partial = null;
      SB.els(500).forEach((e) => {
        const t = SB.textOf(e).toLowerCase();
        if (!exact && t === want) exact = e;
        else if (!partial && t && t.includes(want)) partial = e;
      });
      el = exact || partial;
    }
    if (!el) return { clicked: false, error: "未找到目标元素" };
    el.scrollIntoView({ block: "center" });
    el.click();
    return { clicked: true };
  };
  SB.type = function (opts) {
    let el = null;
    if (opts.selector) {
      el = document.querySelector(opts.selector);
    } else {
      document.querySelectorAll("input, textarea").forEach((e) => {
        if (el || !SB.visible(e) || e.disabled || e.readOnly) return;
        const t = (e.type || "text").toLowerCase();
        if (e.tagName === "TEXTAREA" ||
            ["text", "search", "email", "password", "tel", "url", "number", ""].includes(t)) el = e;
      });
    }
    if (!el) return { typed: false, error: "未找到输入框" };
    el.focus();
    el.scrollIntoView({ block: "center" });
    // 走原型 setter 赋值，兼容 React/Vue 受控组件
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    const next = (opts.clear === false ? (el.value || "") : "") + opts.text;
    setter.call(el, next);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (opts.submit) {
      const form = el.form || el.closest("form");
      if (form && typeof form.requestSubmit === "function") {
        form.requestSubmit();
      } else {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      }
    }
    return { typed: true };
  };
}
''';

  /// 等待页面加载稳定（readyState 到 interactive/complete），带超时兜底。
  Future<Map<String, dynamic>> _waitLoadSettled(
    WebviewController c, {
    int maxWaitMs = 15000,
  }) async {
    final DateTime deadline = DateTime.now().add(Duration(milliseconds: maxWaitMs));
    Map<String, dynamic> last = <String, dynamic>{};
    while (DateTime.now().isBefore(deadline)) {
      try {
        final dynamic r = await c.executeScript(
          "(function(){return {url: location.href, title: document.title, readyState: document.readyState};})()",
        );
        final Map<String, dynamic> m = _asMap(r);
        if (m.isNotEmpty) last = m;
        final String ready = m["readyState"]?.toString() ?? "";
        if (ready == "complete" || ready == "interactive") {
          await Future<void>.delayed(const Duration(milliseconds: 200));
          return last.isEmpty ? m : last;
        }
      } catch (_) {
        // 页面跳转中 executeScript 可能瞬时失败，继续等
      }
      await Future<void>.delayed(const Duration(milliseconds: 250));
    }
    if (last.isNotEmpty) return last;
    final Map<String, dynamic> state = await _getState(c);
    return state["ok"] == true
        ? <String, dynamic>{"url": state["url"], "title": state["title"]}
        : last;
  }

  static Map<String, dynamic> _asMap(dynamic v) {
    if (v is Map<String, dynamic>) return v;
    if (v is Map) return v.cast<String, dynamic>();
    return <String, dynamic>{};
  }

  void dispose() {
    _urlSub?.cancel();
    _titleSub?.cancel();
    _loadingSub?.cancel();
    try {
      _controller?.dispose();
    } catch (_) {}
    _controller = null;
    _starting = null;
  }
}
