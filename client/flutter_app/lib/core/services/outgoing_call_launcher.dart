import "dart:async";

import "package:flutter/foundation.dart";
import "package:flutter/services.dart";

class OutgoingCallLauncher {
  OutgoingCallLauncher._();

  static const MethodChannel _channel = MethodChannel("pai/outgoing_call");

  static final ValueNotifier<bool> isVisible = ValueNotifier<bool>(false);

  static VoidCallback? _onHangUp;

  static void bindHandlers({VoidCallback? onHangUp}) {
    _onHangUp = onHangUp;
    _channel.setMethodCallHandler(_onNativeMessage);
  }

  static void unbind() {
    _onHangUp = null;
    _channel.setMethodCallHandler(null);
  }

  static Future<bool> show({
    required String callerName,
    String subtitle = "正在呼叫",
    String? callerInitial,
    int accentColor = 0xFF22C55E,
  }) async {
    try {
      final bool ok = await _channel.invokeMethod<bool>("show", <String, dynamic>{
            "callerName": callerName,
            "subtitle": subtitle,
            "callerInitial": callerInitial ?? _firstChar(callerName),
            "accentColor": accentColor,
          }) ??
          false;
      if (ok) {
        isVisible.value = true;
      }
      return ok;
    } on PlatformException catch (e) {
      debugPrint("[OutgoingCall] show failed: ${e.message}");
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  static Future<void> hide() async {
    try {
      await _channel.invokeMethod<bool>("hide");
      isVisible.value = false;
    } on PlatformException catch (e) {
      debugPrint("[OutgoingCall] hide failed: ${e.message}");
    } on MissingPluginException {
      // ignore
    }
  }

  static String _firstChar(String input) {
    if (input.isEmpty) return "A";
    return String.fromCharCode(input.runes.first);
  }

  static Future<dynamic> _onNativeMessage(MethodCall call) async {
    if (call.method != "onNativeEvent") return null;
    final Object? raw = call.arguments;
    if (raw is! Map) return null;
    if (raw["event"]?.toString() == "hangup") {
      isVisible.value = false;
      _onHangUp?.call();
    }
    return null;
  }
}
