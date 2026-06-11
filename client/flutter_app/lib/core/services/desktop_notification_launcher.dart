import "dart:async";

import "package:flutter/foundation.dart";
import "package:flutter/services.dart";

class DesktopNotificationLauncher {
  DesktopNotificationLauncher._();

  static const MethodChannel _channel =
      MethodChannel("pai/desktop_notification");

  static final ValueNotifier<bool> isVisible = ValueNotifier<bool>(false);

  static VoidCallback? _onConfirm;
  static VoidCallback? _onDismiss;
  static VoidCallback? _onTimeout;

  static void bindHandlers({
    VoidCallback? onConfirm,
    VoidCallback? onDismiss,
    VoidCallback? onTimeout,
  }) {
    _onConfirm = onConfirm;
    _onDismiss = onDismiss;
    _onTimeout = onTimeout;
    _channel.setMethodCallHandler(_onNativeMessage);
  }

  static void unbind() {
    _onConfirm = null;
    _onDismiss = null;
    _onTimeout = null;
    _channel.setMethodCallHandler(null);
  }

  static Future<bool> show({
    required String title,
    required String message,
    String priority = "normal",
    bool showConfirmButton = false,
    String confirmText = "我知道了",
    int autoCloseMs = 0,
  }) async {
    try {
      final bool ok = await _channel.invokeMethod<bool>("show", <String, dynamic>{
            "title": title,
            "message": message,
            "priority": priority,
            "showConfirmButton": showConfirmButton,
            "confirmText": confirmText,
            "autoCloseMs": autoCloseMs,
          }) ??
          false;
      if (ok) {
        isVisible.value = true;
      }
      return ok;
    } on PlatformException catch (e) {
      debugPrint("[DesktopNotification] show failed: ${e.message}");
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
      debugPrint("[DesktopNotification] hide failed: ${e.message}");
    } on MissingPluginException {
      // ignore
    }
  }

  static Future<dynamic> _onNativeMessage(MethodCall call) async {
    if (call.method != "onNativeEvent") return null;
    final Object? raw = call.arguments;
    if (raw is! Map) return null;
    final String? event = raw["event"]?.toString();
    switch (event) {
      case "confirm":
        isVisible.value = false;
        _onConfirm?.call();
        break;
      case "dismiss":
        isVisible.value = false;
        _onDismiss?.call();
        break;
      case "timeout":
        isVisible.value = false;
        _onTimeout?.call();
        break;
    }
    return null;
  }
}
