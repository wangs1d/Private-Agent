import "package:flutter/material.dart";

import "../../core/utils/content_summary_parser.dart";

class ContentSummaryMessageBody extends StatelessWidget {
  const ContentSummaryMessageBody({
    super.key,
    required this.summary,
    required this.briefText,
    this.extraText = "",
    this.onCardTap,
    this.isCardSelected = false,
  });

  final ContentSummaryDataV2 summary;
  final String briefText;
  final String extraText;
  final VoidCallback? onCardTap;
  final bool isCardSelected;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final TextStyle bodyStyle = Theme.of(context).textTheme.bodyMedium!.copyWith(
          color: cs.onSurface,
          height: 1.6,
        );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        if (briefText.trim().isNotEmpty)
          _BriefContentPreview(
            content: briefText.trim(),
            style: bodyStyle,
          ),
        if (briefText.trim().isNotEmpty) const SizedBox(height:10),
        ContentSummaryDetailCard(
          summary: summary,
          onTap: onCardTap,
          isSelected: isCardSelected,
        ),
        if (extraText.trim().isNotEmpty &&
            extraText.trim() != briefText.trim()) ...<Widget>[
          const SizedBox(height: 8),
          Text(extraText.trim(), style: bodyStyle),
        ],
      ],
    );
  }
}

class ContentSummaryDetailCard extends StatelessWidget {
  const ContentSummaryDetailCard({
    super.key,
    required this.summary,
    this.onTap,
    this.isSelected = false,
  });

  final ContentSummaryDataV2 summary;
  final VoidCallback? onTap;
  final bool isSelected;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final String displayLabel = ContentSummaryParser.taskSubject(summary);
    final String subtitle = summary.sections != null &&
            summary.sections!.length > 1
        ? "$displayLabel · ${summary.sections!.length}个板块"
        : displayLabel;

    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Ink(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
          decoration: BoxDecoration(
            color: cs.surfaceContainerHighest.withOpacity(0.72),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
              color: isSelected
                  ? cs.primary.withOpacity(0.45)
                  : cs.outline.withOpacity(0.28),
            ),
          ),
          child: Row(
            children: <Widget>[
              Container(
                width: 34,
                height: 34,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: cs.primaryContainer.withOpacity(0.45),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  summary.cardIcon,
                  style: const TextStyle(fontSize: 16),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      summary.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style:
                          Theme.of(context).textTheme.bodyMedium?.copyWith(
                                fontWeight: FontWeight.w600,
                                color: cs.onSurface,
                              ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      style:
                          Theme.of(context).textTheme.labelSmall?.copyWith(
                                color: cs.onSurfaceVariant,
                              ),
                    ),
                  ],
                ),
              ),
              Icon(
                Icons.chevron_right,
                size: 20,
                color: cs.onSurfaceVariant.withOpacity(0.7),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

List<Widget> _formatDetailLines(String content, ColorScheme cs, TextTheme textTheme) {
  final RegExp sectionHeader = RegExp(r"^(一|二|三|四|五|六|七|八|九|十)[、.．]");
  final RegExp markdownHeader = RegExp(r"^#{1,3}\s+");
  final RegExp listItem = RegExp(r"^[\s]*[-•*→▸‣⁃◦·]\s+");

  return content.split("\n").map((String line) {
    final String trimmed = line.trim();
    if (trimmed.isEmpty) {
      return const SizedBox(height: 6);
    }

    if (sectionHeader.hasMatch(trimmed) || markdownHeader.hasMatch(trimmed)) {
      final String title = markdownHeader.hasMatch(trimmed)
          ? trimmed.replaceFirst(markdownHeader, "")
          : trimmed;
      return Padding(
        padding: const EdgeInsets.only(top: 8, bottom: 4),
        child: Text(
          title,
          style: textTheme.titleSmall?.copyWith(
            color: cs.onSurface,
            fontWeight: FontWeight.w700,
          ),
        ),
      );
    }

    if (listItem.hasMatch(trimmed)) {
      return Padding(
        padding: const EdgeInsets.only(left: 4, bottom: 4),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text("• ", style: TextStyle(color: cs.onSurfaceVariant)),
            Expanded(
              child: Text(
                trimmed.replaceFirst(listItem, ""),
                style: textTheme.bodySmall?.copyWith(
                  color: cs.onSurface,
                  height: 1.5,
                ),
              ),
            ),
          ],
        ),
      );
    }

    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Text(
        trimmed,
        style: textTheme.bodySmall?.copyWith(
          color: cs.onSurface,
          height: trimmed.length > 100 ? 1.55 : 1.45,
        ),
      ),
    );
  }).toList();
}

List<Widget> _metadataTags(Map<String, dynamic>? metadata) {
  if (metadata == null || metadata.isEmpty) {
    return const <Widget>[];
  }

  final List<Widget> tags = <Widget>[];
  final Object? wordCount = metadata["wordCount"];
  if (wordCount != null) {
    tags.add(_MetaTag(label: "字数", value: wordCount.toString()));
  }

  final Object? sectionCount = metadata["sectionCount"];
  if (sectionCount != null && int.tryParse(sectionCount.toString()) != null &&
      int.parse(sectionCount.toString()) > 1) {
    tags.add(_MetaTag(label: "板块", value: "$sectionCount个"));
  }

  final Object? source = metadata["source"];
  if (source != null && source.toString().trim().isNotEmpty) {
    tags.add(_MetaTag(label: "来源", value: source.toString()));
  }

  return tags;
}

class _DetailContentPanel extends StatelessWidget {
  const _DetailContentPanel({required this.summary});

  final ContentSummaryDataV2 summary;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final String content = summary.detailContent?.trim().isNotEmpty == true
        ? summary.detailContent!.trim()
        : "暂无详细内容";

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: cs.surface.withOpacity(0.55),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: cs.outline.withOpacity(0.18)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (summary.sections != null && summary.sections!.length > 1)
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: summary.sections!
                  .map(
                    (ContentSummarySectionInfo section) => Chip(
                      label: Text(
                        "${section.title} (${section.pointCount})",
                        style: Theme.of(context).textTheme.labelSmall,
                      ),
                      visualDensity: VisualDensity.compact,
                      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      padding: EdgeInsets.zero,
                    ),
                  )
                  .toList(),
            ),
          if (summary.sections != null && summary.sections!.length > 1)
            const SizedBox(height: 10),
          ..._formatDetailLines(content, cs, Theme.of(context).textTheme),
          if (_metadataTags(summary.metadata).isNotEmpty) ...<Widget>[
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 6,
              children: _metadataTags(summary.metadata),
            ),
          ],
        ],
      ),
    );
  }
}

class _MetaTag extends StatelessWidget {
  const _MetaTag({required this.label, required this.value});

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

/// 简洁内容预览组件 - 智能格式化概括性文本
class _BriefContentPreview extends StatelessWidget {
  const _BriefContentPreview({
    required this.content,
    required this.style,
  });

  final String content;
  final TextStyle style;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final List<String> lines = content.split("\n");
    final bool hasBulletPoints = lines.any((line) => line.trim().startsWith("•"));

    if (!hasBulletPoints) {
      // 纯文本模式：直接显示，添加轻微背景色突出摘要性质
      return Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(
          color: cs.primaryContainer.withOpacity(0.15),
          borderRadius: BorderRadius.circular(8),
          border: Border(
            left: BorderSide(
              color: cs.primary.withOpacity(0.3),
              width: 3,
            ),
          ),
        ),
        child: Text(
          content,
          style: style.copyWith(
            color: cs.onSurface.withOpacity(0.9),
          ),
        ),
      );
    }

    // 列表项模式：格式化显示每个要点
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: lines.map((String line) {
        final String trimmed = line.trim();
        if (trimmed.isEmpty) return const SizedBox(height: 4);

        if (trimmed.startsWith("•")) {
          final String itemText = trimmed.substring(1).trim();
          return Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  margin: const EdgeInsets.only(top: 6),
                  width: 6,
                  height: 6,
                  decoration: BoxDecoration(
                    color: cs.primary.withOpacity(0.7),
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    itemText,
                    style: style.copyWith(
                      color: cs.onSurface.withOpacity(0.9),
                      height: 1.5,
                    ),
                  ),
                ),
              ],
            ),
          );
        }

        return Padding(
          padding: const EdgeInsets.only(bottom: 4),
          child: Text(
            trimmed,
            style: style.copyWith(
              color: cs.onSurfaceVariant,
              fontSize: style.fontSize != null ? style.fontSize! - 1 : 13,
            ),
          ),
        );
      }).toList(),
    );
  }
}
