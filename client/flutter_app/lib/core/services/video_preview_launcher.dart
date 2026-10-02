import "package:flutter/foundation.dart";

/// 视频预览的数据快照（由视频卡点击时携带）。
///
/// 只带播放必需数据：面板画面纯视频、不渲染任何文案，故不存 title/author。
class VideoPreviewSnapshot {
  const VideoPreviewSnapshot({
    required this.url,
    this.pageUrl,
  });

  /// 要播放的视频地址（已 resolve 的绝对地址，经 /agent/media/proxy 防盗链）。
  final String url;

  /// 原始播放页链接（面板「去原链接」入口用，可空）。
  final String? pageUrl;
}

/// 视频预览启动器：视频卡(气泡内) → 右侧双栏视频播放面板 的桥接。
///
/// 与 `image_preview_launcher.dart` 同款「静态回调注册」方案：
/// - 主壳(main.dart)启动时调用 [setHandler] 注册一个打开右面板的方法；
/// - 卡片等深层 widget 不关心面板如何实现，只需调用 [open] 触发打开。
class VideoPreviewLauncher {
  VideoPreviewLauncher._();

  static void Function(VideoPreviewSnapshot item)? _handler;

  /// 当前最近一次请求的预览数据（面板打开后可读取）。
  static VideoPreviewSnapshot? _last;

  static VideoPreviewSnapshot? get last => _last;

  /// 每次请求自增，供面板判断「是否换了视频（重载播放器）」。
  static int version = 0;

  /// 主壳在启动时注册右面板打开回调。
  static void setHandler(void Function(VideoPreviewSnapshot item) handler) {
    _handler = handler;
  }

  /// 请求在右侧双栏中播放视频（画面不带文案，故不传标题/作者）。
  static void open({
    required String url,
    String? pageUrl,
  }) {
    final VideoPreviewSnapshot item = VideoPreviewSnapshot(
      url: url,
      pageUrl: pageUrl,
    );
    _last = item;
    version++;
    _handler?.call(item);
  }

  @visibleForTesting
  static void reset() {
    _handler = null;
    _last = null;
  }
}
