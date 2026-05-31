import "dart:io";

import "package:flutter/foundation.dart";
import "package:flutter/services.dart";

/// Windows 全屏/区域截图（GDI+ PNG），供 desktop bridge 与 embodiment.observe 使用。
class DesktopScreenCapture {
  DesktopScreenCapture._();

  static const MethodChannel _channel =
      MethodChannel("pai/desktop_bridge");

  static bool get isSupported =>
      !kIsWeb && Platform.isWindows;

  static Future<Map<String, dynamic>> capture({
    List<int>? region,
  }) async {
    if (!isSupported) {
      return <String, dynamic>{"ok": false, "error": "仅 Windows 桌面端支持截图"};
    }
    final Map<String, dynamic> args = <String, dynamic>{};
    if (region != null && region.length == 4) {
      args["left"] = region[0];
      args["top"] = region[1];
      args["width"] = region[2];
      args["height"] = region[3];
    }
    try {
      final Map<dynamic, dynamic>? raw = await _channel.invokeMapMethod(
        "captureScreen",
        args.isEmpty ? null : args,
      );
      if (raw == null) {
        return <String, dynamic>{"ok": false, "error": "captureScreen 无返回"};
      }
      return raw.map(
        (dynamic k, dynamic v) => MapEntry<String, dynamic>(k.toString(), v),
      );
    } on PlatformException catch (e) {
      return <String, dynamic>{"ok": false, "error": e.message ?? e.code};
    } on MissingPluginException catch (e) {
      return <String, dynamic>{"ok": false, "error": e.toString()};
    }
  }
}
