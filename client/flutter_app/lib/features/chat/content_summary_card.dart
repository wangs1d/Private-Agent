import "package:flutter/material.dart";

import "../../core/utils/content_summary_parser.dart";

class ContentSummaryMessageBody extends StatelessWidget {
  const ContentSummaryMessageBody({
    super.key,
    required this.summary,
    required this.briefText,
    this.extraText = "",
    this.onCardTap,
  });

  final ContentSummaryDataV2 summary;
  final String briefText;
  final String extraText;
  final VoidCallback? onCardTap;

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
  });

  final ContentSummaryDataV2 summary;
  final VoidCallback? onTap;

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
              color: cs.outline.withOpacity(0.28),
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
