import "package:flutter/material.dart";

import "../../core/utils/content_summary_parser.dart";

/// 弹窗左侧竖向书签导航，便于快速跳转到各板块。
class ContentSummaryBookmarkRail extends StatefulWidget {
  const ContentSummaryBookmarkRail({
    super.key,
    required this.sections,
    required this.activeIndex,
    required this.onSectionTap,
  });

  final List<ContentSummarySectionInfo> sections;
  final int activeIndex;
  final ValueChanged<int> onSectionTap;

  @override
  State<ContentSummaryBookmarkRail> createState() =>
      _ContentSummaryBookmarkRailState();
}

class _ContentSummaryBookmarkRailState extends State<ContentSummaryBookmarkRail> {
  final ScrollController _scrollController = ScrollController();
  bool _canScrollUp = false;
  bool _canScrollDown = false;

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(_updateScrollHints);
    WidgetsBinding.instance.addPostFrameCallback((_) => _updateScrollHints());
  }

  @override
  void didUpdateWidget(ContentSummaryBookmarkRail oldWidget) {
    super.didUpdateWidget(oldWidget);
    WidgetsBinding.instance.addPostFrameCallback((_) => _updateScrollHints());
  }

  @override
  void dispose() {
    _scrollController.removeListener(_updateScrollHints);
    _scrollController.dispose();
    super.dispose();
  }

  void _updateScrollHints() {
    if (!_scrollController.hasClients) return;
    final double maxExtent = _scrollController.position.maxScrollExtent;
    final double offset = _scrollController.offset;
    final bool canUp = offset > 2;
    final bool canDown = offset < maxExtent - 2;
    if (canUp != _canScrollUp || canDown != _canScrollDown) {
      setState(() {
        _canScrollUp = canUp;
        _canScrollDown = canDown;
      });
    }
  }

  void _scrollBy(double delta) {
    if (!_scrollController.hasClients) return;
    final double target = (_scrollController.offset + delta)
        .clamp(0.0, _scrollController.position.maxScrollExtent);
    _scrollController.animateTo(
      target,
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOutCubic,
    );
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;

    return Container(
      width: 168,
      decoration: BoxDecoration(
        color: cs.surfaceContainerHighest.withOpacity(0.35),
        border: Border(
          right: BorderSide(color: cs.outline.withOpacity(0.12)),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 14, 14, 8),
            child: Text(
              "目录",
              style: Theme.of(context).textTheme.labelLarge?.copyWith(
                    color: cs.onSurfaceVariant,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 0.4,
                  ),
            ),
          ),
          Expanded(
            child: Stack(
              children: <Widget>[
                Scrollbar(
                  controller: _scrollController,
                  thumbVisibility: true,
                  child: ListView.builder(
                    controller: _scrollController,
                    padding: const EdgeInsets.fromLTRB(10, 4, 10, 12),
                    itemCount: widget.sections.length,
                    itemBuilder: (BuildContext context, int index) {
                      final ContentSummarySectionInfo section =
                          widget.sections[index];
                      final bool active = index == widget.activeIndex;
                      return Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: _BookmarkItem(
                          title: section.title,
                          pointCount: section.pointCount,
                          active: active,
                          cs: cs,
                          onTap: () => widget.onSectionTap(index),
                        ),
                      );
                    },
                  ),
                ),
                if (_canScrollUp)
                  Positioned(
                    top: 0,
                    left: 0,
                    right: 0,
                    child: _VerticalScrollHint(
                      cs: cs,
                      up: true,
                      onTap: () => _scrollBy(-100),
                    ),
                  ),
                if (_canScrollDown)
                  Positioned(
                    bottom: 0,
                    left: 0,
                    right: 0,
                    child: _VerticalScrollHint(
                      cs: cs,
                      up: false,
                      onTap: () => _scrollBy(100),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _BookmarkItem extends StatelessWidget {
  const _BookmarkItem({
    required this.title,
    required this.pointCount,
    required this.active,
    required this.cs,
    required this.onTap,
  });

  final String title;
  final int pointCount;
  final bool active;
  final ColorScheme cs;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(10),
        child: Ink(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(10),
            color: active
                ? cs.primaryContainer.withOpacity(0.55)
                : cs.surface.withOpacity(0.35),
            border: Border.all(
              color: active
                  ? cs.primary.withOpacity(0.42)
                  : cs.outline.withOpacity(0.14),
            ),
          ),
          child: Stack(
            children: <Widget>[
              if (active)
                Positioned(
                  left: 0,
                  top: 8,
                  bottom: 8,
                  child: Container(
                    width: 3,
                    decoration: BoxDecoration(
                      color: cs.primary,
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                ),
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 10, 10, 10),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      title,
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.labelMedium?.copyWith(
                            color: active ? cs.primary : cs.onSurface,
                            fontWeight:
                                active ? FontWeight.w700 : FontWeight.w500,
                            height: 1.35,
                          ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      "$pointCount 条",
                      style: Theme.of(context).textTheme.labelSmall?.copyWith(
                            color: cs.onSurfaceVariant,
                          ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _VerticalScrollHint extends StatelessWidget {
  const _VerticalScrollHint({
    required this.cs,
    required this.up,
    required this.onTap,
  });

  final ColorScheme cs;
  final bool up;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        child: Container(
          height: 28,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: up ? Alignment.topCenter : Alignment.bottomCenter,
              end: up ? Alignment.bottomCenter : Alignment.topCenter,
              colors: <Color>[
                cs.surfaceContainerHighest.withOpacity(0.98),
                cs.surfaceContainerHighest.withOpacity(0),
              ],
            ),
          ),
          child: Icon(
            up ? Icons.keyboard_arrow_up : Icons.keyboard_arrow_down,
            size: 18,
            color: cs.onSurfaceVariant.withOpacity(0.85),
          ),
        ),
      ),
    );
  }
}
