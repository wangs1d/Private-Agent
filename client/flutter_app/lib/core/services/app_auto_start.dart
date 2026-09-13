import "package:flutter/services.dart";

/// 开机自动启动（仅 Windows）：读写 HKCU Run 注册表键，原生侧实现。
///
/// 开机自启是「简报随开机播报」的前提——应用随系统登录启动，WS 连上后
/// 触发启动简报（开启摄像头门禁时等在座检测通过再播）。
class AppAutoStart {
  AppAutoStart._();

  static const MethodChannel _channel = MethodChannel("pai/app_lifecycle");

  /// 当前是否已注册开机自启；插件缺失（非 Windows/子进程）/异常 → false。
  static Future<bool> isEnabled() async {
    try {
      return await _channel.invokeMethod<bool>("getAutoStart") ?? false;
    } on MissingPluginException {
      return false;
    } catch (_) {
      return false;
    }
  }

  /// 设置开机自启；成功返回 true，失败（注册表不可写等）返回 false。
  static Future<bool> setEnabled(bool enable) async {
    try {
      return await _channel.invokeMethod<bool>(
            "setAutoStart",
            <String, dynamic>{"enable": enable},
          ) ??
          false;
    } on MissingPluginException {
      return false;
    } catch (_) {
      return false;
    }
  }
}
