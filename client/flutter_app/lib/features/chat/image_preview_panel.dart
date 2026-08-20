import "package:flutter/material.dart";

import "../../core/config/api_config.dart";

/// 右侧双栏的「图片预览」面板：
/// 在右侧分栏中展示单张网络图片原图，并展示标题/来源。
///
/// 顶栏（标题 + 关闭按钮）由主壳的 common 右分栏 header 提供，这里只需渲染主体。
class ImagePreviewPanel extends StatelessWidget {
  const ImagePreviewPanel({
    super.key,
    required this.url,
    required this.title,
    this.source,
  });

  final String url;
  final String title;
  final String? source;

  String get _resolvedUrl {
    final String u = url.trim();
    if (u.startsWith("http://") || u.startsWith("https://")) return u;
    final String base = ApiConfig.httpBase;
    return u.startsWith("/") ? "$base$u" : "$base/$u";
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        // 原图主体：等比放大展示，居中，可双击缩小/放大
        Expanded(
          child: Container(
            color: cs.surfaceContainerLow,
            alignment: Alignment.center,
            child: InteractiveViewer(
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
                      child: CircularProgressIndicator(strokeWidth: 2.5),
                    );
                  },
                ),
              ),
            ),
          ),
        ),
        // 底部信息条：标题 + 来源
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
              Text(
                title,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 13.5,
                  fontWeight: FontWeight.w700,
                  color: cs.onSurface,
                  height: 1.4,
                ),
              ),
              if (source != null && source!.trim().isNotEmpty) ...<Widget>[
                const SizedBox(height: 4),
                Text(
                  source!,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 12,
                    color: cs.onSurfaceVariant,
                    height: 1.3,
                  ),
                ),
              ],
            ],
          ),
        ),
      ],
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
          style: TextStyle(fontSize: 12.5, color: cs.onSurfaceVariant),
        ),
      ],
    );
  }
}