import "dart:io";

import "package:flutter/foundation.dart";
import "package:flutter/services.dart";

/// 动态切换 Windows 标题栏深色/亮色，跟随 App 内部主题。
class WindowsTitleBarTheme {
  WindowsTitleBarTheme._();

  static const MethodChannel _channel =
      MethodChannel("pai/window_titlebar");

  static bool get isSupported =>
      !kIsWeb && Platform.isWindows;

  /// 设置标题栏深色模式（true = 深色标题栏，false = 亮色标题栏）。
  static Future<void> setDarkMode(bool isDark) async {
    if (!isSupported) return;
    try {
      await _channel.invokeMethod<void>("setDarkMode", <String, dynamic>{
        "isDark": isDark,
      });
    } on PlatformException catch (_) {
      // 忽略异常，不影响主流程
    } on MissingPluginException catch (_) {
      // 插件未注册时静默忽略
    }
  }
}
