import "package:flutter/material.dart";

import "../../core/config/api_config.dart";

/// 图片预览面板左侧预留的空白侧栏宽度（仅占位留白，为后续侧边栏内容预留位置）。
const double kImagePreviewSidebarWidth = 56.0;

/// 右侧双栏的「图片预览」面板：
/// 在右侧分栏中展示单张网络图片原图，并展示标题/来源。
///
/// [urls] 为同一绿泡内的全部照片，切换按钮居中叠加在图片两侧，
/// 末张点击「下一张」会回到第一张（循环）；若只有单张则不显示按钮。
/// 顶栏（标题 + 关闭按钮）由主壳的 common 右分栏 header 提供。
class ImagePreviewPanel extends StatefulWidget {
  const ImagePreviewPanel({
    super.key,
    required this.urls,
    required this.index,
    required this.title,
    this.source,
  });

  /// 同一绿泡内全部照片（已 resolve 的完整地址列表）。
  final List<String> urls;

  /// 当前要展示的照片位次。
  final int index;

  final String title;
  final String? source;

  @override
  State<ImagePreviewPanel> createState() => _ImagePreviewPanelState();
}

class _ImagePreviewPanelState extends State<ImagePreviewPanel> {
  late int _index;

  int get _count => widget.urls.isEmpty ? 1 : widget.urls.length;

  int _clamp(int i) {
    if (widget.urls.isEmpty) return 0;
    return i.clamp(0, _count - 1);
  }

  @override
  void initState() {
    super.initState();
    _index = _clamp(widget.index);
  }

  @override
  void didUpdateWidget(covariant ImagePreviewPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    // 从聊天列表重新打开其它照片时，同步到新的位置；
    // 面板内部的上一张/下一张切换不会重建 widget，因此不会触发这里。
    if (widget.urls != oldWidget.urls || widget.index != oldWidget.index) {
      final List<String> oldShown = oldWidget.urls;
      final int oldIdx = oldWidget.urls.isEmpty
          ? 0
          : oldWidget.index.clamp(0, oldWidget.urls.length - 1);
      bool sameTarget = false;
      if (oldShown.isNotEmpty && widget.urls.isNotEmpty) {
        final String oldUrl = oldShown[oldIdx.clamp(0, oldShown.length - 1)];
        sameTarget = oldUrl == widget.urls[_clamp(widget.index)];
      }
      if (!sameTarget) {
        _index = _clamp(widget.index);
      }
    }
  }

  bool get _canNav => _count > 1;

  void _prev() {
    if (!_canNav) return;
    setState(() => _index = (_index - 1 + _count) % _count);
  }

  void _next() {
    if (!_canNav) return;
    // 循环：末张点击「下一张」回到第一张
    setState(() => _index = (_index + 1) % _count);
  }

  String get _currentUrl {
    if (widget.urls.isEmpty)
      return widget.urls.isNotEmpty ? widget.urls.first : "";
    return widget.urls[_index];
  }

  String get _resolvedUrl {
    final String u = _currentUrl.trim();
    if (u.isEmpty) return u;
    if (u.startsWith("http://") || u.startsWith("https://")) return u;
    final String base = ApiConfig.httpBase;
    return u.startsWith("/") ? "$base$u" : "$base/$u";
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        // 左侧预留空白侧栏：仅占位留白，为后续侧边栏内容预留位置
        Container(
          width: kImagePreviewSidebarWidth,
          decoration: BoxDecoration(
            color: cs.surface,
            border: Border(
              right: BorderSide(color: cs.outline.withValues(alpha: 0.2)),
            ),
          ),
        ),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              // 原图主体：等比放大展示，居中，可双击缩小/放大；两侧居中叠加切换按钮
              Expanded(
                child: Stack(
                  fit: StackFit.expand,
                  children: <Widget>[
                    Container(
                      color: cs.surfaceContainerLow,
                      alignment: Alignment.center,
                      child: InteractiveViewer(
                        key: ValueKey<String>(_currentUrl),
                        minScale: 0.6,
                        maxScale: 6,
                        child: Center(
                          child: Image.network(
                            _resolvedUrl,
                            fit: BoxFit.contain,
                            errorBuilder: (BuildContext context, Object error,
                                StackTrace? stackTrace) {
                              return _fallback(cs);
                            },
                            loadingBuilder: (BuildContext context, Widget child,
                                ImageChunkEvent? progress) {
                              if (progress == null) return child;
                              return const SizedBox(
                                width: 36,
                                height: 36,
                                child:
                                    CircularProgressIndicator(strokeWidth: 2.5),
                              );
                            },
                          ),
                        ),
                      ),
                    ),
                    if (_canNav)
                      Positioned(
                        left: 8,
                        top: 0,
                        bottom: 0,
                        child: Center(
                            child: _buildNavButton(
                                icon: Icons.chevron_left,
                                onTap: _prev,
                                cs: cs)),
                      ),
                    if (_canNav)
                      Positioned(
                        right: 8,
                        top: 0,
                        bottom: 0,
                        child: Center(
                            child: _buildNavButton(
                                icon: Icons.chevron_right,
                                onTap: _next,
                                cs: cs)),
                      ),
                  ],
                ),
              ),
              // 底部信息条：标题 + 来源 + 计数
              Container(
                padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
                decoration: BoxDecoration(
                  color: cs.surface,
                  border: Border(
                    top: BorderSide(color: cs.outline.withValues(alpha: 0.2)),
                  ),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Row(
                      children: <Widget>[
                        Expanded(
                          child: Text(
                            widget.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.w700,
                              color: cs.onSurface,
                              height: 1.4,
                            ),
                          ),
                        ),
                        if (_count > 1)
                          Text(
                            "${_index + 1} / $_count",
                            style: TextStyle(
                              fontSize: 13,
                              fontFeatures: const <FontFeature>[
                                FontFeature.tabularFigures()
                              ],
                              color: cs.onSurfaceVariant,
                            ),
                          ),
                      ],
                    ),
                    if (widget.source != null &&
                        widget.source!.trim().isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text(
                          widget.source!,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 12,
                            color: cs.onSurfaceVariant,
                            height: 1.3,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildNavButton({
    required IconData icon,
    required VoidCallback onTap,
    required ColorScheme cs,
  }) {
    return Material(
      color: cs.surface.withValues(alpha: 0.75),
      shape: const CircleBorder(),
      elevation: 2,
      child: IconButton(
        onPressed: onTap,
        icon: Icon(icon),
        color: cs.onSurface,
        tooltip: icon == Icons.chevron_left ? "上一张" : "下一张",
        visualDensity: VisualDensity.compact,
      ),
    );
  }

  Widget _fallback(ColorScheme cs) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Icon(Icons.broken_image_outlined, size: 48, color: cs.onSurfaceVariant),
        const SizedBox(height: 8),
        Text(
          "图片加载失败",
          style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant),
        ),
      ],
    );
  }
}
