import "package:flutter/material.dart";

import "../../core/utils/content_summary_parser.dart";
import "content_summary_detail_formatter.dart";
import "content_summary_section_nav.dart";

/// 豆包风格：点击详情卡后以独立弹窗展示完整内容。
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
      barrierColor: Colors.black.withOpacity(0.52),
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
  final ScrollController _scrollController = ScrollController();
  final Map<int, GlobalKey> _sectionKeys = <int, GlobalKey>{};
  int _activeSectionIndex = 0;
  Offset _dragOffset = Offset.zero;

  @override
  void initState() {
    super.initState();
    final List<ContentSummarySectionInfo>? sections = widget.summary.sections;
    if (sections != null) {
      for (int i = 0; i < sections.length; i++) {
        _sectionKeys[i] = GlobalKey();
      }
    }
    _scrollController.addListener(_syncActiveSectionFromScroll);
  }

  @override
  void dispose() {
    _scrollController.removeListener(_syncActiveSectionFromScroll);
    _scrollController.dispose();
    super.dispose();
  }

  void _close() => Navigator.of(context).pop();

  void _syncActiveSectionFromScroll() {
    final List<ContentSummarySectionInfo>? sections = widget.summary.sections;
    if (sections == null || sections.isEmpty) return;

    int? nearestIndex;
    double nearestDistance = double.infinity;

    for (int i = 0; i < sections.length; i++) {
      final GlobalKey? key = _sectionKeys[i];
      final BuildContext? ctx = key?.currentContext;
      if (ctx == null) continue;
      final RenderObject? renderObject = ctx.findRenderObject();
      if (renderObject is! RenderBox || !renderObject.hasSize) continue;

      final Offset position = renderObject.localToGlobal(Offset.zero);
      final double distance = (position.dy - 160).abs();
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = i;
      }
    }

    if (nearestIndex != null && nearestIndex != _activeSectionIndex) {
      setState(() => _activeSectionIndex = nearestIndex!);
    }
  }

  void _scrollToSection(int index) {
    setState(() => _activeSectionIndex = index);
    final GlobalKey? key = _sectionKeys[index];
    final BuildContext? ctx = key?.currentContext;
    if (ctx != null) {
      Scrollable.ensureVisible(
        ctx,
        duration: const Duration(milliseconds: 280),
        curve: Curves.easeOutCubic,
        alignment: 0.08,
      );
      return;
    }

    _scrollToSectionFallback(index);
  }

  void _scrollToSectionFallback(int index) {
    final List<ContentSummarySectionInfo>? sections = widget.summary.sections;
    if (sections == null || sections.isEmpty) return;

    final String targetTitle = sections[index].title.trim();
    final String content = widget.summary.detailContent?.trim() ?? "";
    if (content.isEmpty) return;

    final RegExp sectionHeader = RegExp(r"^(一|二|三|四|五|六|七|八|九|十)[、.．]");
    final RegExp markdownHeader = RegExp(r"^#{1,6}\s+");
    final List<String> lines = content.split("\n");

    double offset = 0;
    const double lineHeight = 28;
    bool found = false;

    for (final String line in lines) {
      final String trimmed = line.trim();
      if (trimmed.isEmpty) {
        offset += 6;
        continue;
      }

      final bool isHeader =
          sectionHeader.hasMatch(trimmed) || markdownHeader.hasMatch(trimmed);
      if (isHeader) {
        final String title = markdownHeader.hasMatch(trimmed)
            ? trimmed.replaceFirst(markdownHeader, "").trim()
            : trimmed;
        if (title.contains(targetTitle) || targetTitle.contains(title)) {
          found = true;
          break;
        }
      }
      offset += lineHeight;
    }

    if (!found || !_scrollController.hasClients) return;
    _scrollController.animateTo(
      offset.clamp(0.0, _scrollController.position.maxScrollExtent),
      duration: const Duration(milliseconds: 280),
      curve: Curves.easeOutCubic,
    );
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final Size size = MediaQuery.sizeOf(context);
    final bool wide = size.width >= 720;
    final ContentSummaryDataV2 summary = widget.summary;
    final List<ContentSummarySectionInfo>? sections = summary.sections;
    final bool showBookmarks = sections != null && sections.length > 1;

    final String displayLabel = ContentSummaryParser.categoryLabel(
      summary.category,
      summary.cardLabel,
    );
    final String subtitle = showBookmarks
        ? "$displayLabel · ${sections.length}个板块"
        : displayLabel;
    final String content = summary.detailContent?.trim().isNotEmpty == true
        ? summary.detailContent!.trim()
        : "暂无详细内容";

    final double panelWidth = wide
        ? (size.width * (showBookmarks ? 0.62 : 0.52)).clamp(520.0, 860.0)
        : size.width * 0.94;
    final double panelHeight = wide
        ? size.height * 0.92
        : size.height * 0.88;

    final Widget panel = Material(
      color: cs.surfaceContainerLow,
      elevation: wide ? 24 : 16,
      shadowColor: Colors.black.withOpacity(0.45),
      borderRadius: BorderRadius.circular(wide ? 16 : 18),
      clipBehavior: Clip.antiAlias,
      child: SizedBox(
        width: panelWidth,
        height: panelHeight,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            _buildHeader(context, cs, summary, subtitle),
            Expanded(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  if (showBookmarks)
                    ContentSummaryBookmarkRail(
                      sections: sections,
                      activeIndex: _activeSectionIndex,
                      onSectionTap: _scrollToSection,
                    ),
                  Expanded(
                    child: Scrollbar(
                      controller: _scrollController,
                      thumbVisibility: true,
                      child: SingleChildScrollView(
                        controller: _scrollController,
                        padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            ...formatContentSummaryDetailLines(
                              content,
                              cs,
                              Theme.of(context).textTheme,
                              sectionKeys: _sectionKeys,
                              sectionTitles: sections
                                  ?.map((ContentSummarySectionInfo s) => s.title)
                                  .toList(),
                            ),
                            if (contentSummaryMetadataTags(summary.metadata)
                                .isNotEmpty)
                              ...<Widget>[
                                const SizedBox(height: 16),
                                Wrap(
                                  spacing: 10,
                                  runSpacing: 8,
                                  children: contentSummaryMetadataTags(
                                    summary.metadata,
                                  ),
                                ),
                              ],
                          ],
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
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
    ContentSummaryDataV2 summary,
    String subtitle,
  ) {
    return GestureDetector(
      onPanUpdate: (DragUpdateDetails details) {
        setState(() => _dragOffset += details.delta);
      },
      child: Container(
        padding: const EdgeInsets.fromLTRB(16, 16, 12, 14),
        decoration: BoxDecoration(
          color: cs.surfaceContainerHighest.withOpacity(0.55),
          border: Border(
            bottom: BorderSide(color: cs.outline.withOpacity(0.12)),
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
                  color: cs.onSurfaceVariant.withOpacity(0.75),
                ),
              ),
            ),
            Container(
              width: 40,
              height: 40,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: cs.primaryContainer.withOpacity(0.5),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Text(summary.cardIcon, style: const TextStyle(fontSize: 20)),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    summary.title,
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                          fontWeight: FontWeight.w700,
                          color: cs.onSurface,
                          height: 1.35,
                        ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    subtitle,
                    style: Theme.of(context).textTheme.labelMedium?.copyWith(
                          color: cs.onSurfaceVariant,
                        ),
                  ),
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

  final List<Widget> tags = <Widget>[];
  final Object? wordCount = metadata["wordCount"];
  if (wordCount != null) {
    tags.add(_ContentSummaryMetaTag(label: "字数", value: wordCount.toString()));
  }

  final Object? sectionCount = metadata["sectionCount"];
  if (sectionCount != null &&
      int.tryParse(sectionCount.toString()) != null &&
      int.parse(sectionCount.toString()) > 1) {
    tags.add(_ContentSummaryMetaTag(label: "板块", value: "$sectionCount个"));
  }

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
        color: cs.surfaceContainerHighest.withOpacity(0.65),
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
