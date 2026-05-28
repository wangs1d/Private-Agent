import "dart:convert";
import "dart:io";

import "package:flutter/material.dart";
import "package:webview_windows/webview_windows.dart";

import "../../core/config/api_config.dart";
import "../../core/services/agent_sphere_mood_bridge.dart";
import "../../core/services/sphere_overlay_launcher.dart";
import "agent_sphere_webview_impl.dart" as fallback;

/// Windows 桌面 — WebView2 内嵌 3D Agent
class AgentSphereWebView extends StatefulWidget {
  const AgentSphereWebView({
    super.key,
    this.showOverlayButton = true,
    this.onDragDelta,
    this.onDragStart,
    this.onDragEnd,
  });

  /// 是否显示「启动桌面悬浮」按钮（语音模式页可关闭）
  final bool showOverlayButton;
  final ValueChanged<Offset>? onDragDelta;
  final VoidCallback? onDragStart;
  final VoidCallback? onDragEnd;

  @override
  State<AgentSphereWebView> createState() => _AgentSphereWebViewState();
}

class _AgentSphereWebViewState extends State<AgentSphereWebView> {
  final WebviewController _controller = WebviewController();
  bool _ready = false;
  bool _initialized = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    AgentSphereMoodBridge.instance.addListener(_onPatch);
    if (Platform.isWindows) {
      _initWebView();
    }
  }

  Future<void> _initWebView() async {
    try {
      await _controller.initialize();
      _controller.url.listen((String url) {
        if (url.contains("embed.html") && mounted) {
          setState(() => _ready = true);
          AgentSphereMoodBridge.instance.idle();
        }
      });
      final String url =
          "${ApiConfig.httpBase}/chat/assets/avatar/embed.html?wsOff=1&sessionId=${Uri.encodeComponent(ApiConfig.effectiveActorId)}";
      await _controller.loadUrl(url);
      if (mounted) setState(() => _initialized = true);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  @override
  void dispose() {
    AgentSphereMoodBridge.instance.removeListener(_onPatch);
    _controller.dispose();
    super.dispose();
  }

  Future<void> _onPatch(AgentSpherePatch patch) async {
    if (!_initialized) return;
    final String json = jsonEncode(patch.toJson());
    await _controller.executeScript('window.postMessage($json, "*");');
  }

  Future<void> _launchOverlay() async {
    final bool ok = await SphereOverlayLauncher.launch();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(ok ? "桌面悬浮 Agent 已启动" : "启动失败")),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (!Platform.isWindows) {
      return fallback.AgentSphereWebView(showOverlayButton: widget.showOverlayButton);
    }

    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Text(
            "WebView 加载失败\n$_error\n请先运行 npm run build:chat",
            style: TextStyle(color: Colors.white.withOpacity(0.7), fontSize: 12),
            textAlign: TextAlign.center,
          ),
        ),
      );
    }

    if (!_initialized) {
      return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    }

    return ClipRect(
      child: Stack(
        fit: StackFit.expand,
        clipBehavior: Clip.hardEdge,
        children: <Widget>[
          Webview(_controller),
          if (!_ready)
            const Center(child: CircularProgressIndicator(strokeWidth: 2)),
          if (widget.showOverlayButton)
            Positioned(
              left: 8,
              bottom: 8,
              child: IconButton.filledTonal(
                tooltip: "启动桌面悬浮 Agent",
                onPressed: _launchOverlay,
                icon: const Icon(Icons.open_in_new, size: 18),
                style: IconButton.styleFrom(
                  visualDensity: VisualDensity.compact,
                  backgroundColor: Colors.black.withOpacity(0.35),
                  foregroundColor: Colors.white70,
                ),
              ),
            ),
        ],
      ),
    );
  }
}
