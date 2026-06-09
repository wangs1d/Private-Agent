import "dart:async";

import "package:flutter/foundation.dart";
import "package:flutter/services.dart";

/// 独立"通话中"窗口启动器。
///
/// 仿电脑微信电话设计：竖向悬浮窗（320 x 540），位于工作区右下角。
/// 展示头像 + 名称 + 通话计时 + 静音/免提/挂断按钮。无 transcript 文本。
///
/// 事件回调：
///   - [onHangUp]       : 用户点挂断
///   - [onMuteToggle]   : 用户点静音，参数 newMuted
///   - [onSpeakerToggle]: 用户点免提，参数 newOn
class ConnectedCallLauncher {
  ConnectedCallLauncher._();

  static const MethodChannel _channel =
      MethodChannel("pai/connected_call");

  static final ValueNotifier<bool> isVisible = ValueNotifier<bool>(false);

  static void Function()? _onHangUp;
  static void Function(bool newMuted)? _onMuteToggle;
  static void Function(bool newOn)? _onSpeakerToggle;

  /// 绑定事件回调
  static void bindHandlers({
    void Function()? onHangUp,
    void Function(bool newMuted)? onMuteToggle,
    void Function(bool newOn)? onSpeakerToggle,
  }) {
    _onHangUp = onHangUp;
    _onMuteToggle = onMuteToggle;
    _onSpeakerToggle = onSpeakerToggle;
    _channel.setMethodCallHandler(_onNativeMessage);
  }

  /// 解绑
  static void unbind() {
    _onHangUp = null;
    _onMuteToggle = null;
    _onSpeakerToggle = null;
    _channel.setMethodCallHandler(null);
  }

  /// 弹出"通话中"窗口
  static Future<bool> show({
    required String callerName,
    String? callerInitial,
    int accentColor = 0xFF22C55E,
  }) async {
    try {
      final bool ok = await _channel.invokeMethod<bool>("show", <String, dynamic>{
        "callerName": callerName,
        "callerInitial": callerInitial ??
            _firstChar(callerName, fallback: "A"),
        "accentColor": accentColor,
      }) ??
          false;
      if (ok) isVisible.value = true;
      return ok;
    } on PlatformException catch (e) {
      debugPrint("[ConnectedCall] show failed: ${e.message}");
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  /// 主动关闭窗口
  static Future<void> hide() async {
    try {
      await _channel.invokeMethod<bool>("hide");
      isVisible.value = false;
    } on PlatformException catch (e) {
      debugPrint("[ConnectedCall] hide failed: ${e.message}");
    } on MissingPluginException {
      // ignore
    }
  }

  /// 由 Dart 端向原生推送静音状态（server 同步后回写）
  static Future<void> setMute(bool muted) async {
    try {
      await _channel.invokeMethod<bool>("setMute", <String, dynamic>{
        "muted": muted,
      });
    } on PlatformException {
      // ignore
    } on MissingPluginException {
      // ignore
    }
  }

  /// 由 Dart 端向原生推送免提状态
  static Future<void> setSpeaker(bool on) async {
    try {
      await _channel.invokeMethod<bool>("setSpeaker", <String, dynamic>{
        "on": on,
      });
    } on PlatformException {
      // ignore
    } on MissingPluginException {
      // ignore
    }
  }

  /// 控制头像呼吸光晕（true = 正在播放 TTS / 对方在说话）
  static Future<void> setTalking(bool talking) async {
    try {
      await _channel.invokeMethod<bool>("setTalking", <String, dynamic>{
        "talking": talking,
      });
    } on PlatformException {
      // ignore
    } on MissingPluginException {
      // ignore
    }
  }

  /// 重置通话计时（一般接听后立即调用，从 0 开始）
  static Future<void> resetDuration() async {
    try {
      await _channel.invokeMethod<bool>("resetDuration");
    } on PlatformException {
      // ignore
    } on MissingPluginException {
      // ignore
    }
  }

  static String _firstChar(String s, {required String fallback}) {
    if (s.isEmpty) return fallback;
    return String.fromCharCode(s.runes.first);
  }

  // ---- 原生事件派发 ----

  static Future<dynamic> _onNativeMessage(MethodCall call) async {
    if (call.method != "onNativeEvent") return null;
    final args = call.arguments;
    if (args is! Map) return null;
    final event = args["event"]?.toString();
    debugPrint("[ConnectedCall] native event: $event $args");
    switch (event) {
      case "hangup":
        isVisible.value = false;
        _onHangUp?.call();
        break;
      case "muteToggle":
        isVisible.value = true;
        final bool muted = args["muted"] == true;
        _onMuteToggle?.call(muted);
        break;
      case "speakerToggle":
        isVisible.value = true;
        final bool on = args["speakerOn"] == true;
        _onSpeakerToggle?.call(on);
        break;
    }
    return null;
  }
}
