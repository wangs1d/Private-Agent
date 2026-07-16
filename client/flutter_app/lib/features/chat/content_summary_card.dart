import "package:flutter/material.dart";
import "package:url_launcher/url_launcher.dart";

import "../../core/utils/content_summary_parser.dart";

class ContentSummaryMessageBody extends StatelessWidget {
  const ContentSummaryMessageBody({
    super.key,
    required this.summary,
    required this.briefText,
    this.extraText = "",
    this.structuredItems = const <ContentSummaryItem>[],
    this.onCardTap,
  });

  final ContentSummaryDataV2 summary;
  final String briefText;
  final String extraText;
  final List<ContentSummaryItem> structuredItems;
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
        if (briefText.trim().isNotEmpty) const SizedBox(height: 10),
        if (structuredItems.isNotEmpty) ...<Widget>[
          _StructuredItemsPanel(items: structuredItems),
          const SizedBox(height: 10),
        ],
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
            color: cs.surfaceContainerHighest.withValues(alpha: 0.72),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
              color: cs.outline.withValues(alpha: 0.28),
            ),
          ),
          child: Row(
            children: <Widget>[
              Container(
                width: 34,
                height: 34,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: cs.primaryContainer.withValues(alpha: 0.45),
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
                color: cs.onSurfaceVariant.withValues(alpha: 0.7),
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
          color: cs.primaryContainer.withValues(alpha: 0.15),
          borderRadius: BorderRadius.circular(8),
          border: Border(
            left: BorderSide(
              color: cs.primary.withValues(alpha: 0.3),
              width: 3,
            ),
          ),
        ),
        child: Text(
          content,
          style: style.copyWith(
            color: cs.onSurface.withValues(alpha: 0.9),
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
                    color: cs.primary.withValues(alpha: 0.7),
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    itemText,
                    style: style.copyWith(
                      color: cs.onSurface.withValues(alpha: 0.9),
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

/// 内嵌结构化条目面板：用于把 `search_web` 等工具回显的 items 数组渲染为可点击的卡片列表。
/// 取代旧版「raw JSON 塞进 _BriefContentPreview」导致的乱码渲染。
class _StructuredItemsPanel extends StatelessWidget {
  const _StructuredItemsPanel({required this.items});

  final List<ContentSummaryItem> items;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    // 上限 6 条：避免长列表压塌对话气泡；超过 6 条时在面板底部追加「+N 更多」提示
    const int maxVisible = 6;
    final List<ContentSummaryItem> visible = items.take(maxVisible).toList();
    final int overflow = items.length - visible.length;

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
      decoration: BoxDecoration(
        color: cs.primaryContainer.withValues(alpha: 0.18),
        borderRadius: BorderRadius.circular(10),
        border: Border(
          left: BorderSide(
            color: cs.primary.withValues(alpha: 0.45),
            width: 3,
          ),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.only(left: 2, top: 2, bottom: 6),
            child: Row(
              children: <Widget>[
                Icon(
                  Icons.travel_explore_outlined,
                  size: 14,
                  color: cs.primary.withValues(alpha: 0.75),
                ),
                const SizedBox(width: 6),
                Text(
                  "检索结果（${items.length}）",
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: cs.primary.withValues(alpha: 0.85),
                    height: 1.2,
                  ),
                ),
              ],
            ),
          ),
          ...visible.map(
            (ContentSummaryItem item) => Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: _StructuredItemRow(item: item),
            ),
          ),
          if (overflow > 0)
            Padding(
              padding: const EdgeInsets.only(left: 4, top: 2),
              child: Text(
                "…还有 $overflow 条，详见详情卡",
                style: TextStyle(
                  fontSize: 11.5,
                  color: cs.onSurfaceVariant.withValues(alpha: 0.8),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _StructuredItemRow extends StatelessWidget {
  const _StructuredItemRow({required this.item});

  final ContentSummaryItem item;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final TextTheme textTheme = Theme.of(context).textTheme;
    final String? meta = _formatMeta();

    return InkWell(
      onTap: item.url == null ? null : () => _launch(item.url!),
      borderRadius: BorderRadius.circular(6),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Container(
              margin: const EdgeInsets.only(top: 6),
              width: 5,
              height: 5,
              decoration: BoxDecoration(
                color: cs.primary.withValues(alpha: 0.55),
                shape: BoxShape.circle,
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Text(
                    item.title.isNotEmpty ? item.title : "(无标题)",
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: textTheme.bodyMedium?.copyWith(
                      color: item.url != null
                          ? cs.primary.withValues(alpha: 0.95)
                          : cs.onSurface.withValues(alpha: 0.9),
                      fontWeight: FontWeight.w600,
                      decoration: item.url != null
                          ? TextDecoration.underline
                          : TextDecoration.none,
                      decorationColor: cs.primary.withValues(alpha: 0.5),
                      height: 1.35,
                    ),
                  ),
                  if ((item.snippet ?? "").isNotEmpty) ...<Widget>[
                    const SizedBox(height: 2),
                    Text(
                      item.snippet!,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: textTheme.bodySmall?.copyWith(
                        color: cs.onSurfaceVariant,
                        height: 1.45,
                      ),
                    ),
                  ],
                  if (meta != null) ...<Widget>[
                    const SizedBox(height: 3),
                    Text(
                      meta,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: textTheme.labelSmall?.copyWith(
                        color: cs.onSurfaceVariant.withValues(alpha: 0.72),
                        fontSize: 10.5,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  String? _formatMeta() {
    final List<String> parts = <String>[];
    if ((item.source ?? "").isNotEmpty) parts.add(item.source!);
    if ((item.publishedAt ?? "").isNotEmpty) parts.add(item.publishedAt!);
    if (parts.isEmpty) return null;
    return parts.join(" · ");
  }

  Future<void> _launch(String url) async {
    final Uri? uri = Uri.tryParse(url);
    if (uri == null) return;
    try {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      // 静默失败：避免打不开链接时阻塞聊天
    }
  }
}
