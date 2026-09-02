import "package:flutter/material.dart";

import "../../core/services/image_preview_launcher.dart";
import "media_thumbnail.dart";

/// 自适应媒体图片画廊（竖向大图流版式，2026-09-02）。
///
/// 参考「一图一标题一句描述」的图片流排版：
///   - 单张：全宽大图（优先按自然宽高比渲染，缺数据时 3:4 竖幅），
///     底部带一句说明；
///   - 多张：竖向逐张铺排——每张都是全宽大图 + 下方说明文字，
///     不再压成方形九宫格缩略图（缩略图网格会丢掉每张图的说明、
///     且 16:9 横幅裁切会切掉人像头部）。
/// 格子宽度由可用宽度实时计算（LayoutBuilder），窄屏/宽屏都铺满不留残差。
///
/// 点击任意图经 [ImagePreviewLauncher] 进入右侧双栏预览，同一画廊内可前后切换。
class MediaGallery extends StatelessWidget {
  const MediaGallery({
    super.key,
    required this.urls,
    required this.cs,
    this.captions,
    this.aspects,
    this.previewGallery,
    this.spacing = 10,
    this.maxWidth = 420,
    this.borderRadius = 10,
    this.fallbackAspectRatio = 3 / 4,
  });

  /// 需要展示的图片完整地址（已 resolve）。顺序即展示顺序。
  final List<String> urls;

  /// 与 [urls] 对齐的说明文字（可为空列表）。逐张展示在图片下方。
  final List<String>? captions;

  /// 与 [urls] 对齐的自然宽高比（width/height，可为空）。
  /// 缺数据或比例异常的图片回退 [fallbackAspectRatio]。
  final List<double?>? aspects;

  /// 「上一张/下一张」预览切换的图池。不传时沿用 [urls]。
  /// 用于外层需要跨分组/跨网格切换的场景（如实卡内对比与普通网格共享预览）。
  final List<String>? previewGallery;

  final ColorScheme cs;
  final double spacing;
  final double maxWidth;
  final double borderRadius;

  /// 图片缺自然宽高比时的兜底比例：照片搜索结果以竖幅人像为主，
  /// 3:4 比 16:9 横幅更贴近原图形态（16:9 会把人像裁成一条）。
  final double fallbackAspectRatio;

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

    String captionOf(String url) {
      final int i = clean.indexOf(url);
      if (captions == null || i < 0 || i >= captions!.length) return "";
      return captions![i].trim();
    }

    double aspectOf(String url) {
      final int i = clean.indexOf(url);
      if (aspects == null || i < 0 || i >= aspects!.length) return fallbackAspectRatio;
      return aspects![i] ?? fallbackAspectRatio;
    }

    final List<String> pool = previewGallery ?? clean;

    return Center(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: maxWidth),
        child: LayoutBuilder(
          builder: (BuildContext context, BoxConstraints constraints) {
            final double w = constraints.maxWidth;
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                for (int i = 0; i < clean.length; i++) ...<Widget>[
                  if (i > 0) SizedBox(height: spacing),
                  _PhotoFeedTile(
                    url: clean[i],
                    caption: captionOf(clean[i]),
                    aspect: aspectOf(clean[i]),
                    cs: cs,
                    width: w,
                    borderRadius: borderRadius,
                    openUrl: clean[i],
                    pool: pool,
                    index: pool.indexOf(clean[i]),
                  ),
                ],
              ],
            );
          },
        ),
      ),
    );
  }
}

/// 单张照片块：全宽大图（自然宽高比）+ 可选底部说明。点击进入预览。
class _PhotoFeedTile extends StatelessWidget {
  const _PhotoFeedTile({
    required this.url,
    required this.caption,
    required this.aspect,
    required this.cs,
    required this.width,
    required this.borderRadius,
    required this.openUrl,
    required this.pool,
    required this.index,
  });

  final String url;
  final String caption;
  final double aspect;
  final ColorScheme cs;
  final double width;
  final double borderRadius;
  final String openUrl;
  final List<String> pool;
  final int index;

  @override
  Widget build(BuildContext context) {
    final Widget photo = GestureDetector(
      onTap: () => ImagePreviewLauncher.open(
        url: openUrl,
        title: "图片预览",
        gallery: pool,
        index: index,
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(borderRadius),
        child: AspectRatio(
          aspectRatio: aspect,
          child: MediaThumbnail(
            url: url,
            cs: cs,
            width: width,
            borderRadius: borderRadius,
            fit: BoxFit.cover,
          ),
        ),
      ),
    );
    if (caption.isEmpty) return photo;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        photo,
        const SizedBox(height: 6),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 2),
          child: Text(
            caption,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 12.5,
              color: cs.onSurfaceVariant,
              height: 1.4,
            ),
          ),
        ),
      ],
    );
  }
}
