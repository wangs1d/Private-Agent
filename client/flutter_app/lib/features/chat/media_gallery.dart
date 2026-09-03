import "dart:math" as math;

import "package:flutter/material.dart";

import "../../core/services/image_preview_launcher.dart";
import "media_thumbnail.dart";

/// 自适应媒体图片画廊（半宽贴左版式，2026-09-03）。
///
/// 此前是「全宽大图流」（一图占满整行），照片视觉过大；现改为：
///   - 每张照片宽度 = 可用宽度（上限 [maxWidth]）的一半再扩大 1/4
///     （即原上限的 5/8），高度随自然宽高比等比；
///   - 传入 [captions] 时，每张照片下方渲染对该照片的描述文字
///     （Coze 式「一图一句」，2026-09-03）——描述由服务端视觉模型
///     看图生成、随媒体卡片逐张下发；不传或某张为空时该照片不带文字；
///   - 整体靠左对齐——照片贴 agent 回复描边框的最左侧，
///     与边框只留容器的一点内边距（参考用户提供的贴左排版截图）。
///
/// 点击任意图经 [ImagePreviewLauncher] 进入右侧双栏预览，同一画廊内可前后切换。
class MediaGallery extends StatelessWidget {
  const MediaGallery({
    super.key,
    required this.urls,
    required this.cs,
    this.aspects,
    this.captions,
    this.previewGallery,
    this.spacing = 10,
    this.maxWidth = 420,
    this.borderRadius = 10,
    this.fallbackAspectRatio = 3 / 4,
  });

  /// 需要展示的图片完整地址（已 resolve）。顺序即展示顺序。
  final List<String> urls;

  /// 与 [urls] 对齐的自然宽高比（width/height，可为空）。
  /// 缺数据或比例异常的图片回退 [fallbackAspectRatio]。
  final List<double?>? aspects;

  /// 与 [urls] 对齐的图片描述文字（可为空/部分为空）。
  /// 非空时渲染在对应照片下方，描述这张照片的画面内容。
  final List<String?>? captions;

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

    double aspectOf(String url) {
      final int i = clean.indexOf(url);
      if (aspects == null || i < 0 || i >= aspects!.length) return fallbackAspectRatio;
      return aspects![i] ?? fallbackAspectRatio;
    }

    String? captionOf(String url) {
      final int i = clean.indexOf(url);
      if (captions == null || i < 0 || i >= captions!.length) return null;
      final String c = (captions![i] ?? "").trim();
      return c.isEmpty ? null : c;
    }

    final List<String> pool = previewGallery ?? clean;

    // 靠左对齐：照片贴回复描边框的最左（外层容器只留一点内边距）。
    return Align(
      alignment: Alignment.centerLeft,
      child: LayoutBuilder(
        builder: (BuildContext context, BoxConstraints constraints) {
          // 2026-09-03：半宽版式（可用宽度与上限取小后的一半）基础上
          // 再扩大 1/4——即原全宽上限的 5/8；高度随自然宽高比等比放大，
          // 描述文字与照片同宽。
          final double w =
              math.min(constraints.maxWidth, maxWidth) / 2 * 1.25;
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              for (int i = 0; i < clean.length; i++) ...<Widget>[
                if (i > 0) SizedBox(height: spacing),
                // 必须用 SizedBox 把宽度变成紧约束：内部照片走 AspectRatio，
                // 它会撑满可用宽度、无视子组件自报的 width——不锁死布局盒，
                // 照片会被放大到整个回复框（2026-09-03 修「越改越大」的回归）。
                SizedBox(
                  width: w,
                  child: _PhotoFeedTile(
                    url: clean[i],
                    aspect: aspectOf(clean[i]),
                    caption: captionOf(clean[i]),
                    cs: cs,
                    width: w,
                    borderRadius: borderRadius,
                    openUrl: clean[i],
                    pool: pool,
                    index: pool.indexOf(clean[i]),
                  ),
                ),
              ],
            ],
          );
        },
      ),
    );
  }
}

/// 单张照片块：半宽照片（自然宽高比），靠左放置，可选下方描述文字。点击进入预览。
class _PhotoFeedTile extends StatelessWidget {
  const _PhotoFeedTile({
    required this.url,
    required this.aspect,
    required this.cs,
    required this.width,
    required this.borderRadius,
    required this.openUrl,
    required this.pool,
    required this.index,
    this.caption,
  });

  final String url;
  final double aspect;
  final ColorScheme cs;
  final double width;
  final double borderRadius;
  final String openUrl;
  final List<String> pool;
  final int index;

  /// 这张照片的描述文字（服务端视觉模型生成）；null/空时不渲染文字行。
  final String? caption;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () => ImagePreviewLauncher.open(
        url: openUrl,
        title: "图片预览",
        gallery: pool,
        index: index,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          ClipRRect(
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
          // 一图一句：描述文字与照片同宽，紧贴照片下方（Coze 式图说）。
          if (caption != null) ...<Widget>[
            const SizedBox(height: 5),
            Text(
              caption!,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 12,
                height: 1.35,
                color: cs.onSurfaceVariant,
              ),
            ),
          ],
        ],
      ),
    );
  }
}
