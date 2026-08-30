import "dart:async";
import "dart:io" show Platform;

import "package:flutter/material.dart";
import "package:flutter/services.dart" show rootBundle;
import "package:webview_windows/webview_windows.dart";

import "../../core/config/api_config.dart";
import "travel_map_controller.dart";

/// 旅游行程地图视图：全尺寸 WebView 承载 MapLibre GL JS 页面
/// （assets/travel_map/map.html，能力移植自 3D-Travel 项目）。
///
/// - Windows：WebView2 加载内嵌 HTML，webMessage 双向桥接；
/// - 非 Windows / 初始化失败：显示占位提示，控制器方法静默 no-op。
class TravelMapView extends StatefulWidget {
  const TravelMapView({
    super.key,
    required this.controller,
    this.maptilerKey = "",
  });

  /// 共享控制器（面板集成方通过它下发 POI / 路线并接收事件回调）。
  final TravelMapController controller;

  /// 可选 MapTiler 密钥（有则启用 3D 地形 + 3D 建筑源）。
  final String maptilerKey;

  @override
  State<TravelMapView> createState() => _TravelMapViewState();
}

class _TravelMapViewState extends State<TravelMapView> {
  final WebviewController _webviewController = WebviewController();
  bool _initialized = false;
  bool _pageReady = false;
  String? _error;
  StreamSubscription<dynamic>? _messageSub;

  @override
  void initState() {
    super.initState();
    widget.controller.onReady = _onPageReady;
    if (Platform.isWindows) {
      unawaited(_initWebView());
    }
  }

  @override
  void dispose() {
    widget.controller.onReady = null;
    widget.controller.detach();
    _messageSub?.cancel();
    _webviewController.dispose();
    super.dispose();
  }

  Future<void> _initWebView() async {
    try {
      await _webviewController.initialize();
      await _webviewController.setBackgroundColor(const Color(0xFF0B1220));
      await _webviewController.setPopupWindowPolicy(
        WebviewPopupWindowPolicy.deny,
      );

      // JS → Dart：webMessage 事件转发给控制器分发
      _messageSub?.cancel();
      _messageSub = _webviewController.webMessage.listen((dynamic message) {
        widget.controller.handleWebMessage(message);
      });

      // 加载内嵌单文件地图页（全部 JS/CSS 内联，MapLibre 走 CDN）
      final String html = await rootBundle.loadString(
        "assets/travel_map/map.html",
      );
      await _webviewController.loadStringContent(html);

      // Dart → JS：注入脚本执行器并发送宿主配置（httpBase / maptilerKey）
      await widget.controller.attach(
        (String script) => _webviewController.executeScript(script),
        httpBase: ApiConfig.httpBase,
        maptilerKey: widget.maptilerKey,
      );

      if (mounted) setState(() => _initialized = true);
    } catch (e) {
      if (mounted) {
        setState(() => _error = "地图 WebView 初始化失败\n$e");
      }
    }
  }

  void _onPageReady() {
    if (mounted && !_pageReady) setState(() => _pageReady = true);
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    if (!Platform.isWindows) {
      return _buildPlaceholder(cs, "当前平台不支持内嵌地图（仅 Windows 桌面）");
    }
    if (_error != null) {
      return _buildPlaceholder(cs, _error!);
    }
    if (!_initialized) {
      return _buildLoading(cs, "地图组件初始化中…");
    }
    return Stack(
      fit: StackFit.expand,
      children: <Widget>[
        // 深色底衬：避免 WebView 纹理加载前闪白
        ColoredBox(color: cs.surfaceContainerLowest),
        Webview(_webviewController),
        if (!_pageReady)
          _buildLoading(cs, "地图加载中…"),
      ],
    );
  }

  Widget _buildLoading(ColorScheme cs, String text) {
    return Container(
      color: cs.surfaceContainerLowest,
      alignment: Alignment.center,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          const SizedBox(
            width: 22,
            height: 22,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          const SizedBox(height: 10),
          Text(
            text,
            style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
          ),
        ],
      ),
    );
  }

  Widget _buildPlaceholder(ColorScheme cs, String text) {
    return Container(
      color: cs.surfaceContainerLowest,
      alignment: Alignment.center,
      padding: const EdgeInsets.all(16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(Icons.map_outlined, size: 28, color: cs.onSurfaceVariant),
          const SizedBox(height: 10),
          Text(
            text,
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}
