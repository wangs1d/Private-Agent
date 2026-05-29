import "dart:async";
import "dart:convert";
import "dart:io";

import "package:flutter/foundation.dart";
import "package:flutter/services.dart";

import "../config/api_config.dart";
import "agent_sphere_mood_bridge.dart";

/// 通过 MethodChannel 控制原生层透明悬浮窗（Win32 子窗口 + WebView2）
/// 替代原 Electron 独立进程方案，零额外运行时开销
class SphereOverlayLauncher {
  SphereOverlayLauncher._();

  static const MethodChannel _channel =
      MethodChannel("pai/sphere_overlay");

  static bool _created = false;
  static bool _visible = false;

  static bool get isRunning => _created && _visible;
  static bool get isCreated => _created;

  /// 创建透明悬浮窗并加载 overlay.html
  static Future<bool> create({String? overlayUrl}) async {
    if (kIsWeb || !Platform.isWindows) return false;
    if (_created) return true;

    try {
      final String url = overlayUrl ?? _buildOverlayUrl();
      final bool ok = await _channel.invokeMethod<bool>("create", <String, dynamic>{
        "url": url,
      }) ?? false;

      if (ok) _created = true;
      return ok;
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] create failed: ${e.message}");
      return false;
    }
  }

  /// 构建加载 overlay.html 的 URL（指向构建产物）
  static String _buildOverlayUrl() {
    final String wsUrl = ApiConfig.wsUrl;
    final String sessionId = ApiConfig.effectiveActorId;

    final Uri base = Uri.parse(ApiConfig.httpBase);
    final String path =
        "${base.path}/chat/assets/avatar/overlay.html".replaceAll("//", "/");

    return Uri(
      scheme: base.scheme,
      host: base.host,
      port: base.port,
      path: path,
      queryParameters: <String, String>{
        "ws": wsUrl,
        if (sessionId.isNotEmpty) "sessionId": sessionId,
      },
    ).toString();
  }

  /// 显示悬浮窗
  static Future<void> show() async {
    if (!_created) return;
    try {
      await _channel.invokeMethod<bool>("show");
      _visible = true;
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] show failed: ${e.message}");
    }
  }

  /// 隐藏悬浮窗
  static Future<void> hide() async {
    if (!_created) return;
    try {
      await _channel.invokeMethod<bool>("hide");
      _visible = false;
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] hide failed: ${e.message}");
    }
  }

  /// 销毁悬浮窗
  static Future<void> destroy() async {
    if (!_created) return;
    try {
      await _channel.invokeMethod<bool>("destroy");
      _created = false;
      _visible = false;
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] destroy failed: ${e.message}");
    }
  }

  /// 移动悬浮窗到指定位置（带动画）
  static Future<void> moveTo(int x, int y, {int durationMs = 0}) async {
    if (!_created) return;
    try {
      await _channel.invokeMethod("moveTo", <String, dynamic>{
        "x": x,
        "y": y,
        "duration": durationMs,
      });
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] moveTo failed: ${e.message}");
    }
  }

  /// 设置悬浮窗屏幕位置与尺寸（物理像素）
  static Future<void> setBounds(
    int x,
    int y,
    int width,
    int height, {
    int durationMs = 0,
  }) async {
    if (!_created) return;
    try {
      await _channel.invokeMethod("setBounds", <String, dynamic>{
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "duration": durationMs,
      });
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] setBounds failed: ${e.message}");
    }
  }

  /// 获取主应用窗口屏幕矩形（物理像素）
  static Future<Map<String, int>?> getAppBounds() async {
    if (kIsWeb || !Platform.isWindows) return null;
    try {
      final Map<dynamic, dynamic>? result =
          await _channel.invokeMapMethod("getAppBounds");
      if (result == null) return null;
      return result.map((k, v) => MapEntry(k.toString(), v as int));
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] getAppBounds failed: ${e.message}");
      return null;
    }
  }

  /// 获取悬浮窗当前屏幕矩形（物理像素）
  static Future<Map<String, int>?> getBounds() async {
    if (!_created) return null;
    try {
      final Map<dynamic, dynamic>? result =
          await _channel.invokeMapMethod("getBounds");
      if (result == null) return null;
      return result.map((k, v) => MapEntry(k.toString(), v as int));
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] getBounds failed: ${e.message}");
      return null;
    }
  }

  /// 相对移动悬浮窗
  static Future<void> moveBy(int dx, int dy) async {
    if (!_created) return;
    try {
      await _channel.invokeMethod("moveBy", <String, dynamic>{
        "dx": dx,
        "dy": dy,
      });
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] moveBy failed: ${e.message}");
    }
  }

  /// 触发随机漫游
  static Future<void> roam() async {
    if (!_created) return;
    try {
      await _channel.invokeMethod("roam");
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] roam failed: ${e.message}");
    }
  }

  /// 设置鼠标穿透
  static Future<void> setIgnoreMouseEvents(bool ignore,
      {bool forward = true}) async {
    if (!_created) return;
    try {
      await _channel.invokeMethod("setIgnoreMouseEvents",
          <String, dynamic>{"ignore": ignore, "forward": forward});
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] setIgnoreMouseEvents failed: ${e.message}");
    }
  }

  /// 向悬浮窗注入 mood patch（通过 ExecuteScript，零延迟）
  static Future<void> patchMood(AgentSpherePatch patch) async {
    if (kIsWeb || !Platform.isWindows || !_created) return;
    try {
      await _channel.invokeMethod("patchMood",
          <String, dynamic>{"patch": jsonEncode(patch.toJson())});
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] patchMood failed: ${e.message}");
    }
  }

  /// 获取屏幕工作区
  static Future<Map<String, int>?> getWorkArea() async {
    if (!_created) return null;
    try {
      final Map<dynamic, dynamic>? result =
          await _channel.invokeMapMethod("getWorkArea");
      if (result == null) return null;
      return result.map((k, v) => MapEntry(k.toString(), v as int));
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] getWorkArea failed: ${e.message}");
      return null;
    }
  }

  /// 兼容旧接口：启动悬浮窗（创建 + 显示）
  static Future<bool> launch({String? repoRoot}) async {
    if (kIsWeb || !Platform.isWindows) return false;
    if (_created) {
      await show();
      return true;
    }
    final bool created = await create(overlayUrl: repoRoot);
    if (created) await show();
    return created;
  }

  /// 兼容旧接口：停止悬浮窗
  static Future<void> stop() => destroy();
}
