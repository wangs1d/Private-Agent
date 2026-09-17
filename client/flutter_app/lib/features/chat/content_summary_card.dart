import "package:flutter/material.dart";
import "package:url_launcher/url_launcher.dart";

import "../../core/theme/app_typography.dart";
import "../../core/utils/content_summary_parser.dart";
import "accent_panel.dart";
import "content_summary_detail_formatter.dart";

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
    final TextStyle bodyStyle = AppTypography.assistantBody(
      Theme.of(context).textTheme,
      cs,
    );

    // 冗余守卫：历史消息的 brief 可能就是卡片的「label：title」原文（旧版
    // 服务端会在卡前重复输出同一行文案），此时不再渲染，标题由卡片自身展示；
    // 新消息服务端已不再输出该行，brief 通常为空或为真实的前导说明。
    final String brief = briefText.trim();
    final String cardTitle = summary.title.trim();
    final bool briefDuplicatesCard =
        cardTitle.isNotEmpty && brief.contains(cardTitle);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        if (brief.isNotEmpty && !briefDuplicatesCard) ...<Widget>[
          _BriefContentPreview(
            content: brief,
            style: bodyStyle,
          ),
          const SizedBox(height: AppTypography.space3),
        ],
        // 简洁要点（服务端 briefPoints）：折叠卡外的概要正文，
        // 详细内容点卡片在右侧面板/弹窗查看
        if (summary.briefPoints.isNotEmpty) ...<Widget>[
          _BriefPointsList(points: summary.briefPoints),
          const SizedBox(height: AppTypography.space3),
        ],
        if (structuredItems.isNotEmpty) ...<Widget>[
          _StructuredItemsPanel(items: structuredItems),
          const SizedBox(height: AppTypography.space3),
        ],
        ContentSummaryDetailCard(
          summary: summary,
          onTap: onCardTap,
        ),
        if (extraText.trim().isNotEmpty &&
            extraText.trim() != briefText.trim()) ...<Widget>[
          const SizedBox(height: AppTypography.space2),
          buildInlineMarkdownText(extraText.trim(), bodyStyle, cs: cs),
        ],
      ],
    );
  }
}

/// 简洁要点列表：折叠卡上方的概要正文（icon + 单行内联 markdown）。
class _BriefPointsList extends StatelessWidget {
  const _BriefPointsList({required this.points});

  final List<ContentSummaryBriefPoint> points;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final TextStyle style = Theme.of(context).textTheme.bodyMedium!.copyWith(
          color: cs.onSurface,
          height: AppTypography.bodyLineHeight,
        );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        for (final ContentSummaryBriefPoint point in points)
          Padding(
            padding: const EdgeInsets.only(bottom: AppTypography.space1),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                SizedBox(
                  width: 20,
                  child: Text(
                    point.icon,
                    style: const TextStyle(fontSize: 13),
                    textAlign: TextAlign.start,
                  ),
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: buildInlineMarkdownText(point.text, style, cs: cs),
                ),
              ],
            ),
          ),
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
      // 纯文本模式：直接显示，轻微底色突出摘要性质（与引用块同源面板组件）
      return AccentPanel(
        cs: cs,
        accentAlpha: 0.45,
        fillAlpha: 0.12,
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        child: buildInlineMarkdownText(content, style, cs: cs),
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
                  child: buildInlineMarkdownText(
                    itemText,
                    style.copyWith(
                      height: AppTypography.bodyLineHeight,
                    ),
                    cs: cs,
                  ),
                ),
              ],
            ),
          );
        }

        return Padding(
          padding: const EdgeInsets.only(bottom: AppTypography.space1),
          child: buildInlineMarkdownText(
            trimmed,
            style.copyWith(
              color: cs.onSurfaceVariant,
              fontSize: style.fontSize != null ? style.fontSize! - 1 : 13,
            ),
            cs: cs,
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

    return AccentPanel(
      cs: cs,
      accentAlpha: 0.45,
      fillAlpha: 0.18,
      radius: 10,
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
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
              padding: const EdgeInsets.only(bottom: AppTypography.space1),
              child: _StructuredItemRow(item: item),
            ),
          ),
          if (overflow > 0)
            Padding(
              padding: const EdgeInsets.only(left: 4, top: 2),
              child: Text(
                "…还有 $overflow 条，详见详情卡",
                style: TextStyle(
                  fontSize: AppTypography.caption,
                  color: cs.onSurfaceVariant,
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
                      color: item.url != null ? cs.primary : cs.onSurface,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  if ((item.snippet ?? "").isNotEmpty) ...<Widget>[
                    const SizedBox(height: 2),
                    buildInlineMarkdownText(
                      item.snippet!,
                      textTheme.bodySmall!.copyWith(
                        color: cs.onSurfaceVariant,
                        height: AppTypography.bodyLineHeight,
                      ),
                      cs: cs,
                    ),
                  ],
                  if (meta != null) ...<Widget>[
                    const SizedBox(height: 3),
                    Text(
                      meta,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: textTheme.labelSmall?.copyWith(
                        color: cs.onSurfaceVariant,
                        fontSize: AppTypography.micro,
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
