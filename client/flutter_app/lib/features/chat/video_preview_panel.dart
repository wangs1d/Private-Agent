import "package:flutter/material.dart";
import "package:url_launcher/url_launcher.dart";
import "package:webview_windows/webview_windows.dart";

import "../../core/services/windows_webview_bootstrap_io.dart";

/// 右侧双栏视频播放面板：WebView2 承载 HTML5 <video> 真内联播放。
///
/// Windows 桌面 video_player 无原生实现（见 inline_video_player.dart 注释），
/// WebView2(Chromium) 是应用内唯一可靠的全格式播放通道。视频流走
/// /agent/media/proxy 代理地址（防跨域/防盗链），与聊天气泡内联卡同源。
///
/// 画面纯视频、零文案（2026-10-02 定稿）：标题/作者只在气泡卡面显示一次，
/// 面板内不再叠加任何信息条——因此本组件不接收 title/author，避免后面手痒
/// 又给画面盖字。
class VideoPreviewPanel extends StatefulWidget {
  const VideoPreviewPanel({
    super.key,
    required this.url,
    this.pageUrl,
  });

  /// 已 resolve 的绝对视频流地址（经 /agent/media/proxy）。
  final String url;

  /// 原始播放页链接（可空；非空时面板右上角提供「去原链接」）。
  final String? pageUrl;

  @override
  State<VideoPreviewPanel> createState() => _VideoPreviewPanelState();
}

class _VideoPreviewPanelState extends State<VideoPreviewPanel> {
  final WebviewController _controller = WebviewController();
  bool _ready = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    try {
      await bootstrapWindowsWebView();
      await _controller.initialize();
      await _controller.setPopupWindowPolicy(WebviewPopupWindowPolicy.deny);
      await _controller.loadStringContent(_buildHtml());
      if (mounted) {
        setState(() {
          _ready = true;
          _error = null;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() => _error = e.toString());
      }
    }
  }

  String _buildHtml() {
    // 2026-10-02 定稿：面板播放画面不叠加任何文案（标题/作者信息条已按用户要求去掉），
    // 纯视频全幅播放；卡面上已有标题，面板顶栏亦有「视频播放」chrome。
    return """
<!doctype html><html><head><meta charset="utf-8">
<style>
html,body{margin:0;height:100%;background:#000;overflow:hidden}
video{width:100vw;height:100vh;object-fit:contain;outline:none}
</style></head><body>
<video src="${_esc(widget.url)}" controls autoplay playsinline></video>
</body></html>""";
  }

  /// HTML 属性/文本转义（URL 里的 & 与引号必须转义，否则 video 标签参数被截断）。
  String _esc(String s) {
    return s
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    if (_error != null) {
      return _PanelMessage(
        icon: Icons.error_outline,
        text: "面板播放器初始化失败：$_error",
        actionLabel: "浏览器打开",
        onAction: () => _launchUrl(widget.url),
      );
    }
    if (!_ready) {
      return Center(
        child: SizedBox(
          width: 22,
          height: 22,
          child: CircularProgressIndicator(strokeWidth: 2.2, color: cs.onSurfaceVariant),
        ),
      );
    }
    return Stack(
      children: <Widget>[
        Webview(_controller),
        if (widget.pageUrl != null)
          Positioned(
            top: 8,
            right: 8,
            child: IconButton(
              tooltip: "去原链接",
              icon: const Icon(Icons.open_in_new_rounded, size: 18, color: Colors.white70),
              onPressed: () => _launchUrl(widget.pageUrl!),
            ),
          ),
      ],
    );
  }
}

class _PanelMessage extends StatelessWidget {
  const _PanelMessage({
    required this.icon,
    required this.text,
    this.actionLabel,
    this.onAction,
  });

  final IconData icon;
  final String text;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(icon, size: 28, color: cs.onSurfaceVariant),
          const SizedBox(height: 10),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24),
            child: Text(
              text,
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
            ),
          ),
          if (actionLabel != null && onAction != null)
            TextButton(onPressed: onAction, child: Text(actionLabel!)),
        ],
      ),
    );
  }
}

Future<void> _launchUrl(String url) async {
  final Uri uri = Uri.parse(url);
  if (await canLaunchUrl(uri)) {
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }
}
