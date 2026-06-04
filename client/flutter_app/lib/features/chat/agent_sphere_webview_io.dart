import "dart:async";
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
    this.visible = true,
  });

  /// 是否显示「启动桌面悬浮」按钮（语音模式页可关闭）
  final bool showOverlayButton;
  final ValueChanged<Offset>? onDragDelta;
  final VoidCallback? onDragStart;
  final VoidCallback? onDragEnd;
  final bool visible;

  @override
  State<AgentSphereWebView> createState() => _AgentSphereWebViewState();
}

class _AgentSphereWebViewState extends State<AgentSphereWebView> {
  final WebviewController _controller = WebviewController();
  bool _ready = false;
  bool _initialized = false;
  String? _error;
  Timer? _readyFallbackTimer;
  StreamSubscription<WebErrorStatus>? _loadErrorSub;
  StreamSubscription<LoadingState>? _loadingSub;

  static const String _transparentBgScript = """
(function() {
  var style = document.createElement('style');
  style.textContent = 'html,body,#root{background:transparent!important;margin:0;padding:0;overflow:hidden;}';
  (document.documentElement || document.head).appendChild(style);
})();
""";

  @override
  void initState() {
    super.initState();
    AgentSphereMoodBridge.instance.addListener(_onPatch);
    AgentSphereMoodBridge.instance.addMessageListener(_onSphereMessage);
    if (Platform.isWindows && widget.visible) {
      unawaited(_initWebView());
    }
  }

  @override
  void didUpdateWidget(covariant AgentSphereWebView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.visible && !oldWidget.visible && Platform.isWindows && !_initialized) {
      unawaited(_initWebView());
    }
  }

  String _deskPetUrl() {
    final String session = Uri.encodeComponent(ApiConfig.effectiveActorId);
    final String ws = Uri.encodeComponent(ApiConfig.wsUrl);
    return "${ApiConfig.httpBase}/chat/assets/avatar/embed.html?wsOff=1&sessionId=$session&ws=$ws";
  }

  Future<void> _initWebView() async {
    if (_initialized) return;
    try {
      await _controller.initialize();
      await _controller.setBackgroundColor(const Color(0x00000000));
      await _controller.addScriptToExecuteOnDocumentCreated(_transparentBgScript);

      _loadErrorSub?.cancel();
      _loadErrorSub = _controller.onLoadError.listen((WebErrorStatus status) {
        if (!mounted) return;
        setState(() {
          _error =
              "页面加载失败 ($status)\n请确认后端已启动：${ApiConfig.httpBase}";
        });
      });

      _loadingSub?.cancel();
      _loadingSub = _controller.loadingState.listen((LoadingState state) {
        if (state == LoadingState.navigationCompleted) {
          _scheduleReadyFallback();
        }
      });

      _controller.url.listen((String url) {
        if ((url.contains("embed.html") || url.contains("overlay.html")) &&
            mounted) {
          _markReady();
        }
      });

      await _controller.loadUrl(_deskPetUrl());
      _scheduleReadyFallback();
      if (mounted) setState(() => _initialized = true);
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = "WebView 初始化失败\n$e";
        });
      }
    }
  }

  void _scheduleReadyFallback() {
    _readyFallbackTimer?.cancel();
    _readyFallbackTimer = Timer(const Duration(seconds: 2), () {
      if (mounted && !_ready && _error == null) {
        _markReady();
      }
    });
  }

  void _markReady() {
    _readyFallbackTimer?.cancel();
    if (!_ready && mounted) {
      setState(() => _ready = true);
      AgentSphereMoodBridge.instance.idle();
    }
  }

  @override
  void dispose() {
    _readyFallbackTimer?.cancel();
    _loadErrorSub?.cancel();
    _loadingSub?.cancel();
    AgentSphereMoodBridge.instance.removeListener(_onPatch);
    AgentSphereMoodBridge.instance.removeMessageListener(_onSphereMessage);
    _controller.dispose();
    super.dispose();
  }

  Future<void> _onPatch(AgentSpherePatch patch) async {
    if (!_initialized) return;
    final String json = jsonEncode(patch.toJson());
    await _controller.executeScript('window.postMessage($json, "*");');
  }

  Future<void> _onSphereMessage(Map<String, dynamic> message) async {
    if (!_initialized) return;
    final String json = jsonEncode(message);
    await _controller.executeScript('window.postMessage($json, "*");');
  }

  Future<void> _launchOverlay() async {
    final bool ok = await SphereOverlayLauncher.launchElectron();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          ok
              ? "Electron 桌面桌宠已启动（独立窗口）"
              : "启动失败：请确认后端与 sphere-overlay 已就绪",
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.visible) {
      return const SizedBox.shrink();
    }

    if (!Platform.isWindows) {
      return fallback.AgentSphereWebView(showOverlayButton: widget.showOverlayButton);
    }

    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Text(
            "WebView 加载失败\n$_error\n请先运行 npm run build:chat",
            style: TextStyle(
              color: Colors.white.withValues(alpha: 0.7),
              fontSize: 12,
            ),
            textAlign: TextAlign.center,
          ),
        ),
      );
    }

    if (!_initialized) {
      return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    }

    return ColoredBox(
      color: Colors.transparent,
      child: Stack(
        fit: StackFit.expand,
        clipBehavior: Clip.none,
        children: <Widget>[
          Opacity(
            opacity: _ready ? 1 : 0,
            child: Webview(_controller),
          ),
          if (!_ready)
            const Center(child: CircularProgressIndicator(strokeWidth: 2)),
          if (widget.showOverlayButton)
            Positioned(
              left: 8,
              bottom: 8,
              child: IconButton.filledTonal(
                tooltip: "启动 Electron 桌面桌宠",
                onPressed: _launchOverlay,
                icon: const Icon(Icons.open_in_new, size: 18),
                style: IconButton.styleFrom(
                  visualDensity: VisualDensity.compact,
                  backgroundColor: Colors.black.withValues(alpha: 0.35),
                  foregroundColor: Colors.white70,
                ),
              ),
            ),
        ],
      ),
    );
  }
}
