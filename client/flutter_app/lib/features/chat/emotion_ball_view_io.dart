import "dart:async";
import "dart:convert";
import "dart:io";

import "package:flutter/material.dart";
import "package:flutter/services.dart" show rootBundle;
import "package:webview_windows/webview_windows.dart";

import "emotion_ball_view_stub.dart" as fallback;

/// EmotionBallView —— Windows WebView2 内嵌 emotion-ball 小球表情动画。
///
/// 来源:https://github.com/sam70361/aora-bot(emotion-ball/,纯 SVG + 原生 JS
/// 实时驱动)。宿主页面 [assets/emotion_ball/host.html] 为自包含单文件
/// (全部引擎 JS 内联),经 `loadStringContent` 加载,无服务器依赖。
///
/// 表情切换:改 [EmotionBallView.emotion] 即可,内部通过
/// `executeScript("window.__ball.setEmotion(id)")` 驱动,带过渡形变动画。
class EmotionBallView extends StatefulWidget {
  const EmotionBallView({
    super.key,
    this.emotion = "02",
    this.size,
    this.bodyColor,
    this.eyeColor,
  });

  /// 当前表情 ID(emotion-ball 的 emotionId)。
  /// 常用:"02" 待机放空 / "30" 思考中 / "40" 检索资料 / "32" 处理中忙碌。
  final String emotion;

  /// 小球显示尺寸(正方形边长),null 时撑满父级约束。
  final double? size;

  /// 球体主题色(传入后眼球默认白色);null 时使用 emotion-ball 默认配色。
  final Color? bodyColor;
  final Color? eyeColor;

  @override
  State<EmotionBallView> createState() => _EmotionBallViewState();
}

class _EmotionBallViewState extends State<EmotionBallView> {
  static Future<String>? _hostHtmlFuture;

  WebviewController? _controller;
  bool _initializing = false;
  String? _error;

  Future<String> _loadHostHtml() {
    // 宿主 HTML 是静态资源,全进程只读一次。
    return _hostHtmlFuture ??= rootBundle.loadString(
      "assets/emotion_ball/host.html",
    );
  }

  /// 生成注入 boot 配置后的宿主 HTML(初始表情 / 体色在加载时一次性写入)。
  Future<String> _buildHostHtml() async {
    final String html = await _loadHostHtml();
    final Map<String, String> boot = <String, String>{
      "emotion": widget.emotion,
      if (widget.bodyColor != null)
        "bodyColor": _hex(widget.bodyColor!),
      if (widget.eyeColor != null) "eyeColor": _hex(widget.eyeColor!),
    };
    return html.replaceAll("__BALL_BOOT_JSON__", jsonEncode(boot));
  }

  static String _hex(Color color) {
    return "#${(color.toARGB32() & 0xFFFFFF).toRadixString(16).padLeft(6, "0")}";
  }

  Future<void> _initWebView() async {
    if (_initializing || _controller != null) return;
    _initializing = true;
    final WebviewController controller = WebviewController();
    try {
      await controller.initialize();
      await controller.setBackgroundColor(const Color(0x00000000));
      await controller.loadStringContent(await _buildHostHtml());
      if (!mounted) {
        controller.dispose();
        return;
      }
      setState(() {
        _controller = controller;
        _error = null;
      });
    } catch (e) {
      controller.dispose();
      if (mounted) setState(() => _error = "$e");
    } finally {
      _initializing = false;
    }
  }

  @override
  void initState() {
    super.initState();
    if (Platform.isWindows) {
      unawaited(_initWebView());
    }
  }

  @override
  void didUpdateWidget(covariant EmotionBallView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!Platform.isWindows) return;
    if (widget.bodyColor != oldWidget.bodyColor ||
        widget.eyeColor != oldWidget.eyeColor) {
      // 主题色只在引擎构造时生效,颜色变化需要重建页面。
      _controller?.dispose();
      _controller = null;
      unawaited(_initWebView());
      return;
    }
    final WebviewController? controller = _controller;
    if (widget.emotion != oldWidget.emotion && controller != null) {
      final String id = widget.emotion.replaceAll("'", "");
      unawaited(
        controller.executeScript(
          "window.__ball && window.__ball.setEmotion('$id');",
        ),
      );
    }
  }

  @override
  void dispose() {
    _controller?.dispose();
    _controller = null;
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!Platform.isWindows) {
      return fallback.EmotionBallView(
        emotion: widget.emotion,
        size: widget.size,
        bodyColor: widget.bodyColor,
        eyeColor: widget.eyeColor,
      );
    }
    final WebviewController? controller = _controller;
    if (_error != null || controller == null) {
      // 初始化中或失败:渲染静态占位圆点,避免布局跳动。
      return fallback.EmotionBallView(
        emotion: widget.emotion,
        size: widget.size,
        bodyColor: widget.bodyColor,
        eyeColor: widget.eyeColor,
      );
    }
    return SizedBox(
      width: widget.size,
      height: widget.size,
      child: Webview(controller),
    );
  }
}
