import "package:flutter/foundation.dart";
import "package:flutter/widgets.dart" show BuildContext;

/// 图片预览的数据快照（由媒体卡点击时携带）。
class ImagePreviewSnapshot {
  const ImagePreviewSnapshot({
    required this.url,
    required this.title,
    this.source,
    this.gallery,
    this.index = 0,
  });

  /// 当前要展示的照片地址。
  final String url;

  final String title;
  final String? source;

  /// 同一绿泡内的全部照片（已 resolve 的完整地址列表）。
  ///
  /// 非空时预览面板支持「上一张 / 下一张」在绿泡内切换。
  final List<String>? gallery;

  /// 当前照片在 [gallery] 中的位次。
  final int index;
}

/// 图片预览启动器：媒体卡(Bubble 内) → 右侧双栏图片预览面板 的桥接。
///
/// 与 `agent_profile_overlay_launcher.dart` 同款「静态回调注册」方案：
/// - 主壳(main.dart)启动时调用 [setHandler] 注册一个打开右面板的方法；
/// - 卡片等深层 widget 不关心面板如何实现，只需调用 [open] 触发打开。
///
/// 这样避免把 `onOpenImagePreview` 逐层下传穿透消息流/气泡，最小侵入。
class ImagePreviewLauncher {
  ImagePreviewLauncher._();

  static void Function(ImagePreviewSnapshot item)? _handler;

  /// 当前最近一次请求的预览数据（面板打开后可读取）。
  static ImagePreviewSnapshot? _last;

  static ImagePreviewSnapshot? get last => _last;

  /// 每次请求自增，供面板/外层判断「是否换了一批图（内容变化）」。
  static int version = 0;

  /// 主壳在启动时注册右面板打开回调。
  static void setHandler(void Function(ImagePreviewSnapshot item) handler) {
    _handler = handler;
  }

  /// 打开预览前的钩子（聊天页用于记录滚动锚点，避免打开面板后列表跳到最底部）。
  ///
  /// 第二参数是媒体卡点击处的 [BuildContext]：聊天页据此在消息流中定位
  /// 「被点照片」的渲染盒，做内容级锚点恢复；弹层等不在聊天列表内的
  /// 调用方可不传（null），此时聊天页退化为像素级恢复。
  static void Function(ImagePreviewSnapshot item, BuildContext? anchorContext)?
      beforeOpen;

  /// 请求在右侧双栏中预览某张图片。
  ///
  /// [gallery] 传入同一绿泡内的全部照片，[index] 指定当前位次，
  /// 供预览面板做「上一张 / 下一张」切换；不传则仅预览单张。
  ///
  /// [anchorContext] 传入点击处 context（见 [beforeOpen] 说明），聊天内
  /// 媒体卡应尽量传入，保证打开面板后聊天视图锚定在照片位置不跳动。
  static void open({
    required String url,
    String title = "图片预览",
    String? source,
    List<String>? gallery,
    int index = 0,
    BuildContext? anchorContext,
  }) {
    final ImagePreviewSnapshot item = ImagePreviewSnapshot(
      url: url,
      title: title.isNotEmpty ? title : "图片预览",
      source: source,
      gallery: gallery,
      index: index,
    );
    _last = item;
    version++;
    beforeOpen?.call(item, anchorContext);
    _handler?.call(item);
  }

  @visibleForTesting
  static void reset() {
    _handler = null;
    _last = null;
    beforeOpen = null;
  }
}