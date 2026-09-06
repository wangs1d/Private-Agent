import "dart:async";
import "dart:io" show Platform;
import "dart:ui" show Color;

import "package:flutter/services.dart" show rootBundle;
import "package:webview_windows/webview_windows.dart";

import "travel_web_panel_controller.dart";

/// 整页 WebView 行程面板的进程级共享宿主（单例）。
///
/// webview_windows 为 Composition 模式：控制器持有渲染纹理，可被不同挂载点
/// （右侧面板 / 全屏页）按需渲染同一内容。面板与全屏共用同一实例 ——
/// 打开/关闭面板、进出全屏都不再重新加载地图（HTML + MapLibre 常驻），
/// 仅在 loadPlan 时切换数据。
///
/// 预加载：[preload] 在 App 启动即后台初始化（隐藏渲染），首次打开面板零等待。
class TravelWebPanelHost {
  TravelWebPanelHost._();

  static final TravelWebPanelHost instance = TravelWebPanelHost._();

  final TravelWebPanelController controller = TravelWebPanelController();

  WebviewController? _webviewController;
  StreamSubscription<dynamic>? _messageSub;
  Future<void>? _starting;
  String? _error;

  /// WebView 是否已初始化完成（可挂载 Webview 渲染）。
  bool get isInitialized => _webviewController != null;

  /// 共享 WebView 控制器（未初始化完成时为 null）。
  WebviewController? get webviewController => _webviewController;

  /// 初始化错误（宿主渲染占位提示用）。
  String? get error => _error;

  /// 幂等启动：App 启动/首次使用时调用，后台加载 panel.html + 地图。
  Future<void> ensureStarted() {
    final Future<void>? starting = _starting;
    if (starting != null) return starting;
    if (!Platform.isWindows) {
      _starting = Future<void>.value();
      return _starting!;
    }
    _starting = _start();
    return _starting!;
  }

  /// 进程级预加载入口（幂等，可在任意时机调用）。
  static void preload() {
    unawaited(instance.ensureStarted());
  }

  Future<void> _start() async {
    try {
      final WebviewController webviewController = WebviewController();
      await webviewController.initialize();
      await webviewController.setBackgroundColor(const Color(0xFF0B1220));
      await webviewController.setPopupWindowPolicy(
        WebviewPopupWindowPolicy.deny,
      );

      // JS → Dart：webMessage 事件转发给控制器分发
      _messageSub?.cancel();
      _messageSub = webviewController.webMessage.listen(
        controller.handleWebMessage,
      );

      // 加载内嵌整页面板（MapLibre 走 CDN）
      final String html = await rootBundle.loadString(
        "assets/travel_map/panel.html",
      );
      await webviewController.loadStringContent(html);

      // Dart → JS：注入脚本执行器（loadPlan 由各面板挂载点下发，未就绪时入队）
      await controller.attach(
        (String script) => webviewController.executeScript(script),
      );

      _webviewController = webviewController;
    } catch (e) {
      _error = "面板 WebView 初始化失败\n$e";
    }
  }
}
