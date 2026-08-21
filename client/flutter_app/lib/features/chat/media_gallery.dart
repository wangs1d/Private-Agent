import "package:flutter/material.dart";

import "../../core/services/image_preview_launcher.dart";
import "media_thumbnail.dart";

/// 自适应媒体图片画廊。
///
/// 基于 [MediaThumbnail] 基座，根据图片数量自动切换版式，让聊天回复里的图片
/// 排布更整洁：
///   - 1 张：全宽大图（hero，默认 16:9），可带一句说明；
///   - 2 张：2 列正方形网格；
///   - ≥3 张：3 列正方形网格（多余行自动换行）。
/// 格子边长由可用宽度实时计算（LayoutBuilder），窄屏/宽屏都铺满不留残差。
///
/// 点击任意图经 [ImagePreviewLauncher] 进入右侧双栏预览，同一画廊内可前后切换。
class MediaGallery extends StatelessWidget {
  const MediaGallery({
    super.key,
    required this.urls,
    required this.cs,
    this.captions,
    this.previewGallery,
    this.spacing = 6,
    this.maxWidth = 420,
    this.borderRadius = 8,
    this.heroAspectRatio = 16 / 9,
  });

  /// 需要展示的图片完整地址（已 resolve）。顺序即展示顺序。
  final List<String> urls;

  /// 与 [urls] 对齐的说明文字（可为空列表）。仅单张大图时展示。
  final List<String>? captions;

  /// 「上一张/下一张」预览切换的图池。不传时沿用 [urls]。
  /// 用于外层需要跨分组/跨网格切换的场景（如实卡内对比与普通网格共享预览）。
  final List<String>? previewGallery;

  final ColorScheme cs;
  final double spacing;
  final double maxWidth;
  final double borderRadius;
  final double heroAspectRatio;

  @override
  Widget build(BuildContext context) {
    // 去空 + 去重（保持顺序），避免重复地址重复渲染。
    final List<String> clean = <String>[];
    for (final String u in urls) {
      final String t = u.trim();
      if (t.isEmpty || clean.contains(t)) continue;
      clean.add(t);
    }
    if (clean.isEmpty) return const SizedBox.shrink();

    final List<String> pool = previewGallery ?? clean;

    return Center(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: maxWidth),
        child: LayoutBuilder(
          builder: (BuildContext context, BoxConstraints constraints) {
            final double w = constraints.maxWidth;
            if (clean.length == 1) {
              return _HeroTile(
                url: clean.first,
                caption: (captions != null && captions!.isNotEmpty)
                    ? captions!.first
                    : "",
                cs: cs,
                width: w,
                borderRadius: borderRadius,
                aspectRatio: heroAspectRatio,
                openUrl: clean.first,
                pool: pool,
                index: pool.indexOf(clean.first),
              );
            }
            final int cols = clean.length >= 3 ? 3 : 2;
            final double cell = (w - spacing * (cols - 1)) / cols;
            return Wrap(
              spacing: spacing,
              runSpacing: spacing,
              children: List<Widget>.generate(clean.length, (int i) {
                final String u = clean[i];
                return GestureDetector(
                  onTap: () => ImagePreviewLauncher.open(
                    url: u,
                    title: "图片预览",
                    gallery: pool,
                    index: pool.indexOf(u),
                  ),
                  child: MediaThumbnail(
                    url: u,
                    cs: cs,
                    width: cell,
                    height: cell,
                    borderRadius: borderRadius,
                  ),
                );
              }),
            );
          },
        ),
      ),
    );
  }
}

/// 单张大图：全宽 hero 图 + 可选底部说明。点击进入预览。
class _HeroTile extends StatelessWidget {
  const _HeroTile({
    required this.url,
    required this.caption,
    required this.cs,
    required this.width,
    required this.borderRadius,
    required this.aspectRatio,
    required this.openUrl,
    required this.pool,
    required this.index,
  });

  final String url;
  final String caption;
  final ColorScheme cs;
  final double width;
  final double borderRadius;
  final double aspectRatio;
  final String openUrl;
  final List<String> pool;
  final int index;

  @override
  Widget build(BuildContext context) {
    final Widget hero = GestureDetector(
      onTap: () => ImagePreviewLauncher.open(
        url: openUrl,
        title: "图片预览",
        gallery: pool,
        index: index,
      ),
      child: AspectRatio(
        aspectRatio: aspectRatio,
        child: MediaThumbnail(
          url: url,
          cs: cs,
          width: width,
          borderRadius: borderRadius,
          fit: BoxFit.cover,
        ),
      ),
    );
    if (caption.isEmpty) return hero;
    return ClipRRect(
      borderRadius: BorderRadius.circular(borderRadius),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          hero,
          Container(
            padding: const EdgeInsets.fromLTRB(12, 9, 12, 9),
            color: cs.surfaceContainerHighest,
            child: Text(
              caption,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 12.5,
                color: cs.onSurface,
                height: 1.3,
              ),
            ),
          ),
        ],
      ),
    );
  }
}