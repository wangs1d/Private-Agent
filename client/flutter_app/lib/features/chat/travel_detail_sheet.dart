import "package:flutter/material.dart";
import "package:url_launcher/url_launcher.dart";

import "../../core/services/image_preview_launcher.dart";
import "media_thumbnail.dart";
import "travel_favorites.dart";
import "travel_plan_models.dart";
import "travel_theme.dart";


/// 条目详情弹窗 —— 移植自 3D-Travel 的详情面板：
/// 图片画廊（点击大图）、价格卡、地址/描述/贴士、全部评论、视频入口、收藏、导航。
class TravelDetailSheet extends StatefulWidget {
  const TravelDetailSheet({super.key, required this.entry, this.dayLabel = ""});

  final TravelDayEntry entry;
  final String dayLabel;

  /// 弹出详情。
  static Future<void> show(
    BuildContext context, {
    required TravelDayEntry entry,
    String dayLabel = "",
  }) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (BuildContext context) => TravelDetailSheet(
        entry: entry,
        dayLabel: dayLabel,
      ),
    );
  }

  @override
  State<TravelDetailSheet> createState() => _TravelDetailSheetState();
}

class _TravelDetailSheetState extends State<TravelDetailSheet> {
  bool _fav = false;
  bool _favLoading = true;

  @override
  void initState() {
    super.initState();
    _loadFav();
  }

  Future<void> _loadFav() async {
    final bool fav = await TravelFavorites.instance
        .isFavorite(TravelFavorites.keyOf(widget.entry.type, widget.entry.title));
    if (!mounted) return;
    setState(() {
      _fav = fav;
      _favLoading = false;
    });
  }

  Future<void> _toggleFav() async {
    final bool now = await TravelFavorites.instance
        .toggle(TravelFavorites.keyOf(widget.entry.type, widget.entry.title));
    if (!mounted) return;
    setState(() => _fav = now);
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final TravelDayEntry entry = widget.entry;
    return DraggableScrollableSheet(
      initialChildSize: 0.75,
      maxChildSize: 0.92,
      minChildSize: 0.4,
      builder: (BuildContext context, ScrollController scrollController) {
        return Container(
          decoration: BoxDecoration(
            color: cs.surfaceContainer,
            borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
          ),
          child: ListView(
            controller: scrollController,
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 24),
            children: <Widget>[
              // 顶部拖拽指示 + 头部
              Center(
                child: Container(
                  width: 36,
                  height: 4,
                  margin: const EdgeInsets.only(bottom: 10),
                  decoration: BoxDecoration(
                    color: cs.outline.withValues(alpha: 0.3),
                    borderRadius: BorderRadius.circular(999),
                  ),
                ),
              ),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        if (widget.dayLabel.isNotEmpty)
                          Text(widget.dayLabel,
                              style: TextStyle(
                                  fontSize: 11, color: cs.onSurfaceVariant)),
                        SizedBox(height: 2),
                        Text(entry.title,
                            style: const TextStyle(
                                fontSize: 17, fontWeight: FontWeight.w800)),
                      ],
                    ),
                  ),
                  IconButton(
                    tooltip: _fav ? "取消收藏" : "收藏",
                    visualDensity: VisualDensity.compact,
                    icon: _favLoading
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2))
                        : Icon(
                            _fav ? Icons.star_rounded : Icons.star_outline,
                            size: 22,
                            color: _fav ? const Color(0xFFF5B942) : cs.onSurfaceVariant,
                          ),
                    onPressed: _toggleFav,
                  ),
                  IconButton(
                    tooltip: "关闭",
                    visualDensity: VisualDensity.compact,
                    icon: const Icon(Icons.close, size: 18),
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
              // 图片画廊
              if (entry.images.isNotEmpty) ...<Widget>[
                const SizedBox(height: 8),
                SizedBox(
                  height: 130,
                  child: ListView.separated(
                    scrollDirection: Axis.horizontal,
                    itemCount: entry.images.length,
                    separatorBuilder: (_, __) => const SizedBox(width: 8),
                    itemBuilder: (BuildContext context, int i) => GestureDetector(
                      onTap: () => ImagePreviewLauncher.open(
                        url: entry.images[i],
                        title: entry.title,
                        gallery: entry.images,
                        index: i,
                      ),
                      child: MediaThumbnail(
                        url: entry.images[i],
                        cs: cs,
                        width: 172,
                        height: 130,
                        borderRadius: 10,
                      ),
                    ),
                  ),
                ),
              ],
              // 价格卡
              if (entry.priceInfo.isNotEmpty) ...<Widget>[
                const SizedBox(height: 12),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: TravelPalette.of(context).orange.withValues(alpha: 0.08),
                    borderRadius: BorderRadius.circular(10),
                    border:
                        Border.all(color: TravelPalette.of(context).orange.withValues(alpha: 0.3)),
                  ),
                  child: Row(
                    children: <Widget>[
                      Icon(Icons.sell_outlined,
                          size: 16, color: TravelPalette.of(context).orange),
                      SizedBox(width: 8),
                      Expanded(
                        child: Text(entry.priceInfo,
                            style: TextStyle(
                                fontSize: 13,
                                fontWeight: FontWeight.w600,
                                color: TravelPalette.of(context).orange)),
                      ),
                    ],
                  ),
                ),
              ],
              // 地址 / 描述 / 贴士
              if (entry.address.isNotEmpty) ...<Widget>[
                SizedBox(height: 12),
                _infoRow(cs, Icons.place_outlined, entry.address),
              ],
              if (entry.description.isNotEmpty) ...<Widget>[
                const SizedBox(height: 8),
                _infoRow(cs, Icons.info_outline, entry.description),
              ],
              if (entry.tips.isNotEmpty) ...<Widget>[
                const SizedBox(height: 8),
                Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: cs.surfaceContainerHigh,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Row(
                        children: <Widget>[
                          Icon(Icons.tips_and_updates_outlined,
                              size: 14, color: TravelPalette.of(context).orange),
                          const SizedBox(width: 6),
                          Text("实用贴士",
                              style: TextStyle(
                                  fontSize: 12,
                                  fontWeight: FontWeight.w700,
                                  color: cs.onSurfaceVariant)),
                        ],
                      ),
                      const SizedBox(height: 6),
                      for (final String tip in entry.tips)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 3),
                          child: Text("· $tip",
                              style: TextStyle(
                                  fontSize: 12,
                                  height: 1.45,
                                  color: cs.onSurfaceVariant)),
                        ),
                    ],
                  ),
                ),
              ],
              // 全部评论
              if (entry.reviews.isNotEmpty) ...<Widget>[
                const SizedBox(height: 14),
                Text("评论 (${entry.reviews.length})",
                    style: const TextStyle(
                        fontSize: 13, fontWeight: FontWeight.w700)),
                const SizedBox(height: 6),
                for (final TravelEntryReview review in entry.reviews)
                  Container(
                    margin: const EdgeInsets.only(bottom: 6),
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: cs.surfaceContainerHigh,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Row(
                          children: <Widget>[
                            const Icon(Icons.star_rounded,
                                size: 14, color: Color(0xFFF5B942)),
                            const SizedBox(width: 4),
                            Text(
                                "${review.rating.toStringAsFixed(1)} · "
                                "${review.author.isEmpty ? "旅友" : review.author}",
                                style: TextStyle(
                                    fontSize: 11, color: cs.onSurfaceVariant)),
                          ],
                        ),
                        const SizedBox(height: 4),
                        Text(review.text,
                            style:
                                const TextStyle(fontSize: 12, height: 1.45)),
                      ],
                    ),
                  ),
              ],
              // 视频
              if (entry.videos.isNotEmpty) ...<Widget>[
                const SizedBox(height: 10),
                Text("相关视频",
                    style: const TextStyle(
                        fontSize: 13, fontWeight: FontWeight.w700)),
                const SizedBox(height: 6),
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: <Widget>[
                    for (final TravelEntryVideo video in entry.videos)
                      if (video.playPageUrl.isNotEmpty)
                        InkWell(
                          borderRadius: BorderRadius.circular(999),
                          onTap: () {
                            final Uri? uri = Uri.tryParse(video.playPageUrl);
                            if (uri != null) {
                              launchUrl(uri,
                                  mode: LaunchMode.externalApplication);
                            }
                          },
                          child: Container(
                            padding: const EdgeInsets.symmetric(
                                horizontal: 10, vertical: 6),
                            decoration: BoxDecoration(
                              color: TravelPalette.of(context).accent.withValues(alpha: 0.08),
                              borderRadius: BorderRadius.circular(999),
                              border: Border.all(
                                  color: TravelPalette.of(context).accent.withValues(alpha: 0.3)),
                            ),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: <Widget>[
                                Icon(Icons.play_circle_outline,
                                    size: 14, color: TravelPalette.of(context).accent),
                                SizedBox(width: 5),
                                ConstrainedBox(
                                  constraints:
                                      const BoxConstraints(maxWidth: 220),
                                  child: Text(
                                    video.title.isEmpty
                                        ? (video.platform.isEmpty
                                            ? "相关视频"
                                            : video.platform)
                                        : "${video.platform.isEmpty ? "" : "${video.platform} · "}${video.title}",
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(
                                        fontSize: 11, color: TravelPalette.of(context).accent),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                  ],
                ),
              ],
              // 导航按钮
              if (entry.latitude != null && entry.longitude != null) ...<Widget>[
                SizedBox(height: 16),
                FilledButton.icon(
                  style: FilledButton.styleFrom(
                    backgroundColor: TravelPalette.of(context).accent.withValues(alpha: 0.15),
                    foregroundColor: TravelPalette.of(context).accent,
                  ),
                  icon: const Icon(Icons.navigation_outlined, size: 16),
                  label: const Text("在高德地图中导航",
                      style: TextStyle(fontSize: 13)),
                  onPressed: () {
                    final Uri uri = Uri.parse(
                        "https://uri.amap.com/marker?position=${entry.longitude},${entry.latitude}&callnative=0");
                    launchUrl(uri, mode: LaunchMode.externalApplication);
                  },
                ),
              ],
            ],
          ),
        );
      },
    );
  }

  Widget _infoRow(ColorScheme cs, IconData icon, String text) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Icon(icon, size: 14, color: cs.onSurfaceVariant),
        const SizedBox(width: 8),
        Expanded(
          child: Text(text,
              style: TextStyle(
                  fontSize: 12, height: 1.5, color: cs.onSurfaceVariant)),
        ),
      ],
    );
  }
}
