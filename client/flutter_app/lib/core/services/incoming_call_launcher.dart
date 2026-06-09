import "dart:async";

import "package:flutter/foundation.dart";
import "package:flutter/services.dart";

/// 独立来电悬浮窗启动器。
///
/// 收到 [agent.phone.ringing_start] 时调用 [show] 唤起一个脱离主窗口的
/// Win32 悬浮窗，位于工作区右下角，自带铃声 + 接听/挂断按钮。
///
/// 事件回调：
///   - [onAccept]  : 用户点了接听（窗口已自动关闭）
///   - [onDecline] : 用户点了挂断（窗口已自动关闭）
///   - [onTimeout] : 振铃超时（默认 30s）
class IncomingCallLauncher {
  IncomingCallLauncher._();

  static const MethodChannel _channel =
      MethodChannel("pai/incoming_call");

  static final ValueNotifier<bool> isVisible = ValueNotifier<bool>(false);

  static VoidCallback? _onAccept;
  static VoidCallback? _onDecline;
  static VoidCallback? _onTimeout;

  /// 绑定事件回调。多次调用会覆盖前一次。
  static void bindHandlers({
    VoidCallback? onAccept,
    VoidCallback? onDecline,
    VoidCallback? onTimeout,
  }) {
    _onAccept = onAccept;
    _onDecline = onDecline;
    _onTimeout = onTimeout;
    _channel.setMethodCallHandler(_onNativeMessage);
  }

  /// 解除事件绑定（一般在 App 退出时调）
  static void unbind() {
    _onAccept = null;
    _onDecline = null;
    _onTimeout = null;
    _channel.setMethodCallHandler(null);
  }

  /// 弹出独立来电悬浮窗。
  static Future<bool> show({
    required String callerName,
    String subtitle = "语音提醒",
    String? callerInitial,
    int ringTimeoutMs = 30000,
    int accentColor = 0xFF22C55E,
  }) async {
    try {
      final bool ok = await _channel.invokeMethod<bool>("show", <String, dynamic>{
        "callerName": callerName,
        "subtitle": subtitle,
        "callerInitial": callerInitial ??
            _firstChar(callerName, fallback: "?"),
        "ringTimeoutMs": ringTimeoutMs,
        "accentColor": accentColor,
      }) ??
          false;
      if (ok) isVisible.value = true;
      return ok;
    } on PlatformException catch (e) {
      debugPrint("[IncomingCall] show failed: ${e.message}");
      return false;
    } on MissingPluginException {
      // 无原生实现时静默失败
      return false;
    }
  }

  /// 提取首字符（处理中英文混合，回退到 fallback）
  static String _firstChar(String s, {required String fallback}) {
    if (s.isEmpty) return fallback;
    // 用 runes 拿首个 Unicode code point 的字符串表示
    return String.fromCharCode(s.runes.first);
  }

  /// 主动关闭悬浮窗（如挂断、通话已开始等场景）
  static Future<void> hide() async {
    try {
      await _channel.invokeMethod<bool>("hide");
      isVisible.value = false;
    } on PlatformException catch (e) {
      debugPrint("[IncomingCall] hide failed: ${e.message}");
    } on MissingPluginException {
      // ignore
    }
  }

  /// 把主窗口拉回前台（接通后调用，让用户看到通话 UI）
  static Future<void> bringMainWindowToFront() async {
    try {
      await _channel.invokeMethod<bool>("bringToFront");
    } on PlatformException {
      // ignore
    } on MissingPluginException {
      // ignore
    }
  }

  // ---- 原生事件派发 ----

  static Future<dynamic> _onNativeMessage(MethodCall call) async {
    if (call.method != "onNativeEvent") return null;
    final args = call.arguments;
    if (args is! Map) return null;
    final event = args["event"]?.toString();
    debugPrint("[IncomingCall] native event: $event $args");
    switch (event) {
      case "accept":
        isVisible.value = false;
        _onAccept?.call();
        break;
      case "decline":
        isVisible.value = false;
        _onDecline?.call();
        break;
      case "timeout":
        isVisible.value = false;
        _onTimeout?.call();
        break;
    }
    return null;
  }
}
