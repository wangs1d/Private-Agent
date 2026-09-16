import "dart:async";
import "dart:convert" show base64Encode, jsonEncode;

import "browser_driver.dart";
import "shared_browser_protocol.dart";

/// 共用浏览器动作执行器（framework-free）。
///
/// 编排逻辑（等待/重试/降级/轨迹）只依赖 [BrowserDriver] 端口与注入运行时
/// 源码字符串，不依赖任何引擎插件。等待循环一律在 Dart 侧轮询运行时的
/// 同步探测原语（probe/pageState），注入 JS 保持纯同步，避免依赖引擎对
/// Promise 的求值差异。
///
/// 降级策略：
///   - 引擎无 documentBootstrap → 每次动作前内联安装运行时
///   - 引擎无截图能力 → 失败结果不带截图字段
///   - ref 失效（元素被移除）→ 运行时自动落到 selector/text/index 线索
class BrowserActionExecutor {
  BrowserActionExecutor({
    required BrowserDriver driver,
    required String runtimeSource,
    void Function(SbActionTrace trace)? onTrace,
    this.defaultWaitTimeoutMs = 8000,
    this.pollIntervalMs = 250,
  })  : _driver = driver,
        _runtime = runtimeSource,
        _onTrace = onTrace;

  final BrowserDriver _driver;
  final String _runtime;
  final void Function(SbActionTrace trace)? _onTrace;

  /// 元素等待默认超时（SPA 异步渲染的兜底窗口）。
  final int defaultWaitTimeoutMs;
  final int pollIntervalMs;

  /// 执行一个协议动作，返回与服务端 SharedBrowserResult 兼容的结果。
  Future<Map<String, dynamic>> perform(
    String action,
    Map<String, dynamic> params,
  ) async {
    final DateTime at = DateTime.now();
    final Stopwatch sw = Stopwatch()..start();
    Map<String, dynamic> result = Map<String, dynamic>.of(params);
    final String target = _targetOf(action, params);
    try {
      result = await _dispatch(action, params);
    } catch (e) {
      result = SbResult.fail("动作执行异常：$e", code: SbErrors.engine);
    }
    sw.stop();
    if (result["ok"] != true) {
      await _attachFailureScreenshot(result, params);
    }
    _onTrace?.call(SbActionTrace(
      action: action,
      ok: result["ok"] == true,
      durationMs: sw.elapsedMilliseconds,
      at: at,
      target: target.isEmpty ? null : target,
      url: result["url"]?.toString(),
      errorCode: result["code"]?.toString(),
      error: result["error"]?.toString(),
    ));
    return result;
  }

  Future<Map<String, dynamic>> _dispatch(
    String action,
    Map<String, dynamic> params,
  ) async {
    switch (action) {
      case SbActions.navigate:
        return _navigate(params);
      case SbActions.control:
        return _control(params);
      case SbActions.click:
        return _click(params);
      case SbActions.type:
        return _type(params);
      case SbActions.scroll:
        return _scroll(params);
      case SbActions.readPage:
        return _readPage(params);
      case SbActions.getState:
        return _getState();
      case SbActions.exportState:
        return _exportState();
      default:
        return SbResult.fail("未知动作：$action", code: SbErrors.badParams);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 动作实现
  // ═══════════════════════════════════════════════════════════

  Future<Map<String, dynamic>> _navigate(Map<String, dynamic> params) async {
    final String invalid = SbValidate.navigate(params) ?? "";
    if (invalid.isNotEmpty) {
      return SbResult.fail(invalid, code: SbErrors.badParams);
    }
    final String raw = (params["url"] ?? "").toString().trim();
    final String? resolved = resolveInputToUrl(raw);
    if (resolved == null) {
      return SbResult.fail(
        "url 格式无效：$raw（须为 http/https 链接）",
        code: SbErrors.badParams,
      );
    }
    try {
      await _driver.loadUrl(resolved);
    } catch (e) {
      return SbResult.fail("导航失败：$e", code: SbErrors.engine, retryable: true);
    }
    final Map<String, dynamic> state = await _waitSettled();
    await _call("interceptBlank", const <String, dynamic>{});
    return SbResult.ok(state);
  }

  Future<Map<String, dynamic>> _control(Map<String, dynamic> params) async {
    final String nav = (params["action"] ?? "").toString();
    try {
      switch (nav) {
        case "back":
          await _driver.goBack();
        case "forward":
          await _driver.goForward();
        case "reload":
          await _driver.reload();
        case "stop":
          await _driver.stopLoading();
        case "home":
          await _driver.loadUrl("about:blank");
          return SbResult.ok(<String, dynamic>{"url": "about:blank", "title": ""});
        default:
          return SbResult.fail(
            "未知导航动作：$nav",
            code: SbErrors.badParams,
          );
      }
    } catch (e) {
      return SbResult.fail("导航控制失败：$e", code: SbErrors.engine, retryable: true);
    }
    final Map<String, dynamic> state = await _waitSettled(maxWaitMs: 5000);
    return SbResult.ok(state);
  }

  Future<Map<String, dynamic>> _click(Map<String, dynamic> params) async {
    final String? invalid = SbValidate.click(params);
    if (invalid != null) return SbResult.fail(invalid, code: SbErrors.badParams);

    final Map<String, dynamic> target = _targetArgs(params);
    final int waitMs = _waitMs(params);

    // 等待循环：元素出现 → 可用 → 未被遮挡；遮挡元素也持续重探
    // （浮层动画/自动消失），由同一 deadline 兜底区分 NOT_FOUND/COVERED。
    final DateTime deadline = DateTime.now().add(Duration(milliseconds: waitMs));
    Map<String, dynamic> last = const <String, dynamic>{};
    bool everCovered = false;
    while (true) {
      last = await _call("probe", <String, dynamic>{...target, "center": true});
      if (last["found"] == true) {
        if (last["disabled"] == true) {
          return SbResult.fail(
            "目标元素处于禁用状态：${last["text"] ?? last["tag"] ?? ""}",
            code: SbErrors.disabled,
          );
        }
        if (last["covered"] != true) break;
        everCovered = true;
      } else if (last["staleRef"] == true) {
        return SbResult.fail(
          "引用的元素已随页面更新消失，请重新 read_page",
          code: SbErrors.notFound,
          retryable: true,
        );
      }
      if (DateTime.now().isAfter(deadline)) {
        return everCovered
            ? SbResult.fail(
                "目标被遮挡：${last["coverer"] ?? "未知浮层"}（可先关闭弹窗或滚动页面）",
                code: SbErrors.covered,
                retryable: true,
              )
            : SbResult.fail(
                "未找到可操作元素（已等待 ${waitMs}ms）",
                code: SbErrors.notFound,
                retryable: true,
              );
      }
      await Future<void>.delayed(Duration(milliseconds: pollIntervalMs));
    }

    final Map<String, dynamic> clicked = await _call("clickAt", target);
    if (clicked["clicked"] != true) {
      return SbResult.fail("点击执行失败", code: SbErrors.engine, retryable: true);
    }
    final Map<String, dynamic> state = await _waitSettled(maxWaitMs: 5000);
    return SbResult.ok(<String, dynamic>{
      "clicked": true,
      "ref": clicked["ref"],
      "targetText": last["text"],
      ...state,
    });
  }

  Future<Map<String, dynamic>> _type(Map<String, dynamic> params) async {
    final String? invalid = SbValidate.type(params);
    if (invalid != null) return SbResult.fail(invalid, code: SbErrors.badParams);

    final String text = (params["text"] ?? "").toString();
    final bool submit = params["submit"] == true;
    final bool clear = params["clear"] != false;
    final Map<String, dynamic> target = _targetArgs(params);
    final int waitMs = _waitMs(params);

    final DateTime deadline = DateTime.now().add(Duration(milliseconds: waitMs));
    Map<String, dynamic> typed = const <String, dynamic>{};
    while (true) {
      typed = await _call("typeInto", <String, dynamic>{
        ...target,
        "text": text,
        "submit": submit,
        "clear": clear,
      });
      if (typed["typed"] == true) break;
      if (DateTime.now().isAfter(deadline)) {
        return SbResult.fail(
          typed["error"]?.toString() ?? "未找到输入框（已等待 ${waitMs}ms）",
          code: SbErrors.notFound,
          retryable: true,
        );
      }
      await Future<void>.delayed(Duration(milliseconds: pollIntervalMs));
    }

    // 回读校验：清空后输入却为空 → 受控组件吞值，重试一次
    final String value = (typed["value"] ?? "").toString();
    if (clear && text.isNotEmpty && value.isEmpty) {
      typed = await _call("typeInto", <String, dynamic>{
        ...target,
        "text": text,
        "submit": false,
        "clear": true,
      });
      final String retryValue = (typed["value"] ?? "").toString();
      if (retryValue.isEmpty) {
        return SbResult.fail(
          "输入未生效（页面吞掉了输入值）",
          code: SbErrors.verifyFailed,
          retryable: true,
        );
      }
    }

    final Map<String, dynamic> state =
        await _waitSettled(maxWaitMs: submit ? 5000 : 1200);
    return SbResult.ok(<String, dynamic>{
      "typed": true,
      "value": typed["value"],
      "ref": typed["ref"],
      ...state,
    });
  }

  Future<Map<String, dynamic>> _scroll(Map<String, dynamic> params) async {
    final Map<String, dynamic> after =
        await _call("scrollPage", <String, dynamic>{
      "deltaY": params["deltaY"] is int ? params["deltaY"] as int : 600,
      if (params["to"] is String) "to": params["to"],
    });
    // 懒加载等待：滚动后短轮询，内容长高/位移变化才返回
    final DateTime deadline = DateTime.now().add(const Duration(milliseconds: 1500));
    Map<String, dynamic> last = after;
    while (DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 300));
      last = await _call("pageState", const <String, dynamic>{});
      final int total = (last["scrollHeight"] ?? 0) as int;
      final int prevTotal = (after["scrollHeight"] ?? 0) as int;
      final int y = (last["scrollY"] ?? 0) as int;
      final int prevY = (after["scrollY"] ?? 0) as int;
      if (total != prevTotal || y != prevY) {
        await Future<void>.delayed(const Duration(milliseconds: 300));
        last = await _call("pageState", const <String, dynamic>{});
        break;
      }
    }
    return SbResult.ok(last);
  }

  Future<Map<String, dynamic>> _readPage(Map<String, dynamic> params) async {
    final Map<String, dynamic> r = await _call("read", <String, dynamic>{
      if ((params["selector"] ?? "").toString().trim().isNotEmpty)
        "selector": (params["selector"] ?? "").toString().trim(),
      "includeInteractive": params["includeInteractive"] != false,
      "maxChars": params["maxChars"] is int ? params["maxChars"] as int : 4000,
      if (params["offset"] is int) "offset": params["offset"] as int,
      if (params["elementLimit"] is int) "elementLimit": params["elementLimit"] as int,
    });
    if (r.containsKey("error")) {
      return SbResult.fail(r["error"].toString(), code: SbErrors.badParams);
    }
    return SbResult.ok(<String, dynamic>{
      "url": r["url"],
      "title": r["title"],
      "text": r["text"],
      "offset": r["offset"],
      "total": r["total"],
      "hasMore": r["hasMore"],
      if (r["elements"] != null) "elements": r["elements"],
      if (r["elementTotal"] != null) "elementTotal": r["elementTotal"],
    });
  }

  Future<Map<String, dynamic>> _getState() async {
    final Map<String, dynamic> state = await _call("pageState", const <String, dynamic>{});
    return SbResult.ok(state);
  }

  Future<Map<String, dynamic>> _exportState() async {
    final Map<String, dynamic> state = await _call("exportState", const <String, dynamic>{});
    if (state.containsKey("__sbError")) {
      return SbResult.fail("登录态导出失败", code: SbErrors.engine, retryable: true);
    }
    return SbResult.ok(<String, dynamic>{
      "origin": state["origin"],
      "url": state["url"],
      "cookie": state["cookie"],
      "localStorage": state["localStorage"],
      "sessionStorage": state["sessionStorage"],
      "limited": state["limited"],
      "note": "HttpOnly Cookie 不可见（limited=true），服务端拼 storageState 时仅覆盖可见部分",
    });
  }

  // ═══════════════════════════════════════════════════════════
  // 注入调用与等待原语
  // ═══════════════════════════════════════════════════════════

  /// 安装（幂等）注入运行时并调用其中一个函数。
  /// 引擎求值瞬时失败（页面跳转中）返回 __sbTransient，由调用方决定重试。
  Future<Map<String, dynamic>> _call(
    String fn,
    Map<String, dynamic> args,
  ) async {
    final String script = "(function(){${_runtime}try{__installSharedBrowser();}"
        "catch(e){}const SB=window.__sharedBrowser;"
        "return SB && SB.$fn ? SB.$fn(${jsonEncode(args)}) : {__sbError:'runtime_missing'};})()";
    try {
      final dynamic r = await _driver.evaluateScript(script);
      return sbAsMap(r);
    } catch (_) {
      return <String, dynamic>{"__sbTransient": true};
    }
  }

  /// 等待页面加载稳定（readyState 到 interactive/complete），带超时兜底。
  Future<Map<String, dynamic>> _waitSettled({int maxWaitMs = 8000}) async {
    final DateTime deadline = DateTime.now().add(Duration(milliseconds: maxWaitMs));
    Map<String, dynamic> last = <String, dynamic>{};
    while (DateTime.now().isBefore(deadline)) {
      final Map<String, dynamic> s = await _call("pageState", const <String, dynamic>{});
      if (s["url"] != null) last = s;
      final String ready = s["readyState"]?.toString() ?? "";
      if (ready == "complete" || ready == "interactive") {
        await Future<void>.delayed(const Duration(milliseconds: 200));
        return last.isEmpty ? s : last;
      }
      await Future<void>.delayed(Duration(milliseconds: pollIntervalMs));
    }
    return last;
  }

  Future<void> _attachFailureScreenshot(
    Map<String, dynamic> result,
    Map<String, dynamic> params,
  ) async {
    if (params["screenshot"] == false) return;
    if (!_driver.capabilities.screenshot) {
      result["screenshotAvailable"] = false;
      return;
    }
    try {
      final bytes = await _driver.captureScreenshot();
      if (bytes == null) {
        result["screenshotAvailable"] = false;
        return;
      }
      // 180KB 上限：超出不内联（撑爆工具结果），仅标记可用
      if (bytes.lengthInBytes <= 180 * 1024) {
        result["screenshotPng"] = base64Encode(bytes);
      } else {
        result["screenshotOmitted"] = true;
      }
    } catch (_) {
      result["screenshotAvailable"] = false;
    }
  }

  Map<String, dynamic> _targetArgs(Map<String, dynamic> params) =>
      <String, dynamic>{
        if (((params["ref"] ?? "") as String).trim().isNotEmpty)
          "ref": (params["ref"] ?? "").toString().trim(),
        if (((params["selector"] ?? "") as String).trim().isNotEmpty)
          "selector": (params["selector"] ?? "").toString().trim(),
        if (((params["text"] ?? "") as String).trim().isNotEmpty)
          "text": (params["text"] ?? "").toString().trim(),
        if (params["index"] is int) "index": params["index"] as int,
      };

  String _targetOf(String action, Map<String, dynamic> params) {
    switch (action) {
      case SbActions.navigate:
        return (params["url"] ?? "").toString();
      case SbActions.click:
      case SbActions.type:
        final String t = ((params["text"] ?? params["selector"] ?? params["ref"] ?? "")).toString();
        return t;
      case SbActions.control:
        return (params["action"] ?? "").toString();
      default:
        return "";
    }
  }

  int _waitMs(Map<String, dynamic> params) =>
      params["waitTimeoutMs"] is int && (params["waitTimeoutMs"] as int) > 0
          ? params["waitTimeoutMs"] as int
          : defaultWaitTimeoutMs;
}
