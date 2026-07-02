import "dart:async";

import "package:flutter/foundation.dart";
import "package:flutter/services.dart";

import "../../features/chat/agent_profile_page.dart";

/// Agent 主页信息弹出窗启动器。
///
/// 实现：同进程 HWND + GDI 自绘，WS_POPUP + WS_EX_TOPMOST + WS_EX_TOOLWINDOW。
/// 通过 MethodChannel `pai/agent_profile` 与
/// windows/runner/agent_profile_overlay_window.cpp 通信。
class AgentProfileOverlayLauncher {
  AgentProfileOverlayLauncher._();

  static const MethodChannel _channel = MethodChannel("pai/agent_profile");

  static VoidCallback? onClose;

  static bool _handlersBound = false;
  static bool _created = false;

  static void bindHandlers({VoidCallback? onCloseClicked}) {
    onClose = onCloseClicked;
    if (!_handlersBound) {
      _channel.setMethodCallHandler(_onNativeMessage);
      _handlersBound = true;
    }
  }

  static Future<bool> create() async {
    if (kIsWeb) return false;
    try {
      final bool? ok = await _channel.invokeMethod<bool>("create");
      if (ok == true) _created = true;
      return ok ?? false;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  static Future<bool> show({
    required int x,
    required int y,
    int width = 320,
    int height = 160,
    required AgentProfileData profile,
  }) async {
    if (kIsWeb) return false;
    try {
      if (!_created) {
        final bool? cr = await _channel.invokeMethod<bool>("create");
        if (cr != true) return false;
        _created = true;
      }
      await _channel.invokeMethod<bool>("setBounds", <String, dynamic>{
        "x": x,
        "y": y,
        "width": width,
        "height": height,
      });
      await _channel.invokeMethod<bool>("setProfile", <String, dynamic>{
        "displayName": profile.displayName,
        "handle": profile.handle,
        "signature": profile.signature,
        "moodStyle": profile.moodStyle,
        "statusText": profile.statusText,
        "avatarPreset": profile.avatarPreset,
        "lastProfileEvent": profile.lastProfileEvent,
      });
      await _channel.invokeMethod<bool>("show");
      return true;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  static Future<bool> hide() async {
    if (!_created) return false;
    try {
      await _channel.invokeMethod<bool>("hide");
      return true;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  static Future<bool> destroy() async {
    try {
      await _channel.invokeMethod<bool>("destroy");
      _created = false;
      return true;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  static Future<dynamic> _onNativeMessage(MethodCall call) async {
    if (call.method != "onNativeEvent") return null;
    try {
      final Map<dynamic, dynamic> args =
          (call.arguments as Map).cast<dynamic, dynamic>();
      final String? event = args["event"] as String?;
      switch (event) {
        case "close":
          onClose?.call();
          break;
      }
    } catch (_) {}
    return null;
  }
}
