import "package:flutter/material.dart";

import "../../core/utils/content_summary_parser.dart";
import "content_summary_detail_view.dart";

/// 豆包风格：点击详情卡后以独立弹窗展示完整内容。
/// 宽屏下详情卡默认在右侧双面板展开（main.dart contentSummary 分支，
/// 顶栏由面板 chrome 展示主体标签），弹窗保留给窄窗口/无面板宿主的场景，
/// 内容区与面板共用 [ContentSummaryDetailView]。
class ContentSummaryDetailModal {
  ContentSummaryDetailModal._();

  static Future<void> show(
    BuildContext context,
    ContentSummaryDataV2 summary,
  ) {
    return showGeneralDialog<void>(
      context: context,
      barrierDismissible: true,
      barrierLabel: "关闭详情",
      barrierColor: Colors.black.withValues(alpha: 0.52),
      transitionDuration: const Duration(milliseconds: 260),
      pageBuilder: (
        BuildContext context,
        Animation<double> animation,
        Animation<double> secondaryAnimation,
      ) {
        return _ContentSummaryDetailModalBody(summary: summary);
      },
      transitionBuilder: (
        BuildContext context,
        Animation<double> animation,
        Animation<double> secondaryAnimation,
        Widget child,
      ) {
        final Size size = MediaQuery.sizeOf(context);
        final bool wide = size.width >= 720;
        final Offset begin = wide ? const Offset(-0.08, 0) : const Offset(0, 0.06);
        final CurvedAnimation curved = CurvedAnimation(
          parent: animation,
          curve: Curves.easeOutCubic,
          reverseCurve: Curves.easeInCubic,
        );
        return FadeTransition(
          opacity: curved,
          child: SlideTransition(
            position: Tween<Offset>(begin: begin, end: Offset.zero).animate(curved),
            child: child,
          ),
        );
      },
    );
  }
}

class _ContentSummaryDetailModalBody extends StatefulWidget {
  const _ContentSummaryDetailModalBody({required this.summary});

  final ContentSummaryDataV2 summary;

  @override
  State<_ContentSummaryDetailModalBody> createState() =>
      _ContentSummaryDetailModalBodyState();
}

class _ContentSummaryDetailModalBodyState
    extends State<_ContentSummaryDetailModalBody> {
  Offset _dragOffset = Offset.zero;

  void _close() => Navigator.of(context).pop();

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final Size size = MediaQuery.sizeOf(context);
    final bool wide = size.width >= 720;
    final ContentSummaryDataV2 summary = widget.summary;
    final List<ContentSummarySectionInfo>? sections = summary.sections;
    final bool showBookmarks = sections != null && sections.length > 1;

    // 标题只展示任务主体标签（如「科技新闻」），不展示 LLM 导语式的卡片标题
    // （如「王哥，我扒了一圈……」，与右侧双面板顶栏一致）；副标题仅板块数。
    final String title = ContentSummaryParser.taskSubject(summary);
    final String subtitle = showBookmarks ? "${sections.length} 个板块" : "";

    final double panelWidth = wide
        ? (size.width * (showBookmarks ? 0.62 : 0.52)).clamp(520.0, 860.0)
        : size.width * 0.94;
    final double panelHeight = wide
        ? size.height * 0.92
        : size.height * 0.88;

    final Widget panel = Material(
      color: cs.surfaceContainerLow,
      elevation: wide ? 24 : 16,
      shadowColor: Colors.black.withValues(alpha: 0.45),
      borderRadius: BorderRadius.circular(wide ? 16 : 18),
      clipBehavior: Clip.antiAlias,
      child: SizedBox(
        width: panelWidth,
        height: panelHeight,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            _buildHeader(context, cs, summary.cardIcon, title, subtitle),
            Expanded(child: ContentSummaryDetailView(summary: summary)),
          ],
        ),
      ),
    );

    final Offset basePosition = wide
        ? Offset(20 + _dragOffset.dx, _dragOffset.dy)
        : _dragOffset;

    return SafeArea(
      child: Stack(
        children: <Widget>[
          Positioned.fill(
            child: GestureDetector(
              onTap: _close,
              behavior: HitTestBehavior.opaque,
              child: const SizedBox.expand(),
            ),
          ),
          if (wide)
            Align(
              alignment: Alignment.centerLeft,
              child: Transform.translate(
                offset: basePosition,
                child: panel,
              ),
            )
          else
            Center(
              child: Transform.translate(
                offset: basePosition,
                child: panel,
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildHeader(
    BuildContext context,
    ColorScheme cs,
    String cardIcon,
    String title,
    String subtitle,
  ) {
    return GestureDetector(
      onPanUpdate: (DragUpdateDetails details) {
        setState(() => _dragOffset += details.delta);
      },
      child: Container(
        padding: const EdgeInsets.fromLTRB(16, 16, 12, 14),
        decoration: BoxDecoration(
          color: cs.surfaceContainerHighest.withValues(alpha: 0.55),
          border: Border(
            bottom: BorderSide(color: cs.outline.withValues(alpha: 0.12)),
          ),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            MouseRegion(
              cursor: SystemMouseCursors.grab,
              child: Container(
                width: 28,
                height: 40,
                alignment: Alignment.center,
                child: Icon(
                  Icons.drag_indicator,
                  size: 22,
                  color: cs.onSurfaceVariant.withValues(alpha: 0.75),
                ),
              ),
            ),
            Container(
              width: 40,
              height: 40,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: cs.primaryContainer.withValues(alpha: 0.5),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Text(cardIcon, style: const TextStyle(fontSize: 20)),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    title,
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                          fontWeight: FontWeight.w700,
                          color: cs.onSurface,
                          height: 1.35,
                        ),
                  ),
                  if (subtitle.isNotEmpty) ...<Widget>[
                    const SizedBox(height: 4),
                    Text(
                      subtitle,
                      style: Theme.of(context).textTheme.labelMedium?.copyWith(
                            color: cs.onSurfaceVariant,
                          ),
                    ),
                  ],
                ],
              ),
            ),
            IconButton(
              onPressed: _close,
              icon: Icon(Icons.close, size: 22, color: cs.onSurfaceVariant),
              tooltip: "关闭",
            ),
          ],
        ),
      ),
    );
  }
}

List<Widget> contentSummaryMetadataTags(Map<String, dynamic>? metadata) {
  if (metadata == null || metadata.isEmpty) {
    return const <Widget>[];
  }

  // 仅保留「来源」：字数/板块数属于统计噪音（板块数已在标题栏副标题展示），
  // 经用户反馈从详情底部移除。
  final List<Widget> tags = <Widget>[];

  final Object? source = metadata["source"];
  if (source != null && source.toString().trim().isNotEmpty) {
    tags.add(_ContentSummaryMetaTag(label: "来源", value: source.toString()));
  }

  return tags;
}

class _ContentSummaryMetaTag extends StatelessWidget {
  const _ContentSummaryMetaTag({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHighest.withValues(alpha: 0.65),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text.rich(
        TextSpan(
          children: <InlineSpan>[
            TextSpan(
              text: "$label ",
              style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    color: cs.onSurfaceVariant,
                  ),
            ),
            TextSpan(
              text: value,
              style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    color: cs.onSurface,
                    fontWeight: FontWeight.w600,
                  ),
            ),
          ],
        ),
      ),
    );
  }
}
