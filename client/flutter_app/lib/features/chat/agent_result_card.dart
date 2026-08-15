import "package:flutter/material.dart";

import "../../core/utils/agent_result_parser.dart";
import "content_summary_detail_formatter.dart";

/// 智能体结果卡片 —— 用于呈现「任务执行总结」「工具调用结果」
/// 这类**短而固定结构**的轻量数据(3~7 条 ✓/• 项 + 可选追问)。
///
/// 与 `ContentSummaryMessageBody` 的边界(后者用于"长内容/可折叠/可查看详情"):
///   - 数据量小: ≤ 7 条短条目,且不需要完整正文
///   - 结构固定: 标题 + 列表(+ 可选一行 footer)
///   - **不可折叠**: 数据已在卡片内完整展示,无需"查看详情"入口
///   - 不需要头像(图标随标题层级即可)
///   - 通常用于:任务完成/失败汇报、工具调用结果、行程/清单类小结构
///
/// 直接使用:
/// ```dart
/// AgentResultCard(
///   data: AgentResultData(
///     title: '周末行程已为你规划:',
///     items: [
///       AgentResultItem(type: 'check', text: '周六上午:你说过的那家新店探店'),
///       AgentResultItem(type: 'check', text: '周六下午:健身 + 采购下周食材'),
///       AgentResultItem(type: 'check', text: '周日:在家看你收藏的那部电影'),
///     ],
///     footer: '需要调整吗?',
///   ),
/// )
/// ```
class AgentResultCard extends StatelessWidget {
  const AgentResultCard({
    super.key,
    required this.data,
    this.compact = true,
  });

  final AgentResultData data;

  /// 紧凑模式:行高/字号/内边距整体更小,适合聊天消息流。默认 `true`。
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;

    // 工具专用卡片：cardType 非空时委托给专用 UI
    //（天气/日程/钱包/订单/文件/轮播/对比/时间轴/媒体），
    // 否则走下方通用列表卡（与历史行为一致）。
    if (data.cardType.isNotEmpty) {
      switch (data.cardType) {
        case "carousel":
          return _CarouselCard(data: data, cs: cs);
        case "compare":
          return _CompareCard(data: data, cs: cs);
        case "timeline":
          return _TimelineCard(data: data, cs: cs);
        case "media":
          return _MediaCard(data: data, cs: cs);
        default:
          return _SpecializedCard(data: data, cs: cs);
      }
    }

    // 紧凑尺寸(贴近聊天消息流的实际密度)
    final EdgeInsets padding = const EdgeInsets.fromLTRB(14, 12, 14, 12);
    final double titleGap = 8;
    final double listItemGap = 3;
    final double footerGap = 8;
    final double titleSize = 14;
    final double itemSize = 13;
    final double footerSize = 12.5;
    final Color titleColor = cs.onSurface;
    final Color itemColor = cs.onSurface.withValues(alpha: 0.82);
    final Color footerColor = cs.onSurfaceVariant;

    return SizedBox(
      width: double.infinity,
      child: Container(
        // 卡片宽度自然跟随内容(由外层 bubble 约束),最大不超过 360,
        // 避免宽屏下拉成"横幅",实现"刚好包住每行最后那个字"的紧凑效果。
        constraints: const BoxConstraints(maxWidth: 390),
        padding: padding,
        decoration: BoxDecoration(
          color: cs.surfaceContainerHigh,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: cs.outline.withValues(alpha: 0.22)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            if (data.title.isNotEmpty)
              Padding(
                padding: EdgeInsets.only(bottom: titleGap),
                child: Text(
                  data.title,
                  style: TextStyle(
                    fontSize: titleSize,
                    fontWeight: FontWeight.w600,
                    color: titleColor,
                    height: 1.45,
                  ),
                  softWrap: true,
                ),
              ),
            if (data.items.isNotEmpty)
              ...data.items.map((AgentResultItem it) {
                return Padding(
                  padding: EdgeInsets.symmetric(vertical: listItemGap),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      _ItemMark(type: it.type, colorScheme: cs),
                      const SizedBox(width: 8),
                      Expanded(
                        child: _InlineMarkdownBody(
                          it.text,
                          style: TextStyle(
                            fontSize: itemSize,
                            color: itemColor,
                            height: 1.55,
                          ),
                          colorScheme: cs,
                        ),
                      ),
                    ],
                  ),
                );
              }),
            if (data.footer.isNotEmpty) ...<Widget>[
              SizedBox(height: footerGap),
              Container(
                padding: EdgeInsets.only(top: footerGap),
                decoration: BoxDecoration(
                  border: Border(
                    top: BorderSide(
                      color: cs.outline.withValues(alpha: 0.28),
                      width: 1,
                    ),
                  ),
                ),
                child: _InlineFooterText(
                  text: data.footer,
                  color: footerColor,
                  fontSize: footerSize,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _InlineMarkdownBody extends StatelessWidget {
  const _InlineMarkdownBody(
    this.text, {
    required this.style,
    required this.colorScheme,
  });

  final String text;
  final TextStyle style;
  final ColorScheme colorScheme;

  @override
  Widget build(BuildContext context) {
    return buildInlineMarkdownText(text, style, cs: colorScheme);
  }
}

/// 列表项前缀符号（✓ / • / !）。
class _ItemMark extends StatelessWidget {
  const _ItemMark({required this.type, required this.colorScheme});

  final String type;
  final ColorScheme colorScheme;

  @override
  Widget build(BuildContext context) {
    final String glyph;
    final Color color;
    final double size;
    switch (type) {
      case "warn":
        glyph = "!";
        color = const Color(0xFFFBBF24);
        size = 13;
        break;
      case "num":
        glyph = "•";
        color = colorScheme.primary;
        size = 16;
        break;
      case "check":
      default:
        glyph = "✓";
        color = const Color(0xFF34D399);
        size = 13;
        break;
    }
    return Container(
      width: 16,
      alignment: Alignment.center,
      child: Text(
        glyph,
        style: TextStyle(
          color: color,
          fontSize: size,
          fontWeight: FontWeight.w700,
          height: 1.4,
        ),
      ),
    );
  }
}

/// 支持 `[tag] 文本` 这种简单 inline 标签语法的轻量渲染：
///   - `[main]` 渲染为带强调色背景的小标签
///   - 其余文本按原色输出
/// 仅用于 footer 提示行，避免引入 markdown 依赖。
class _InlineFooterText extends StatelessWidget {
  const _InlineFooterText({
    required this.text,
    required this.color,
    required this.fontSize,
  });

  final String text;
  final Color color;
  final double fontSize;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final List<TextSpan> spans = <TextSpan>[];
    final RegExp tagRe = RegExp(r'\[([^\[\]\n]+)\]');
    int cursor = 0;
    for (final RegExpMatch m in tagRe.allMatches(text)) {
      if (m.start > cursor) {
        spans.add(TextSpan(text: text.substring(cursor, m.start)));
      }
      spans.add(
        TextSpan(
          text: " ${m.group(1)} ",
          style: TextStyle(
            color: cs.primary,
            backgroundColor: cs.primary.withValues(alpha: 0.12),
            fontWeight: FontWeight.w600,
            fontSize: fontSize - 1,
          ),
        ),
      );
      cursor = m.end;
    }
    if (cursor < text.length) {
      spans.add(TextSpan(text: text.substring(cursor)));
    }

    return RichText(
      text: TextSpan(
        style: TextStyle(color: color, fontSize: fontSize, height: 1.5),
        children: spans,
      ),
    );
  }
}

/// 工具专用卡片：按 cardType 切换图标/主色/装饰。
/// 数据仍是工具返回的 items 文本，专用化主要体现在视觉类型上
/// （天气/日程/钱包/订单/文件），让不同工具的结果一眼可辨。
class _SpecializedCard extends StatelessWidget {
  const _SpecializedCard({required this.data, required this.cs});

  final AgentResultData data;
  final ColorScheme cs;

  (IconData, Color) get _style {
    switch (data.cardType) {
      case "weather":
        return (Icons.wb_sunny_outlined, const Color(0xFFF59E0B));
      case "schedule":
        return (Icons.event_note_outlined, cs.primary);
      case "wallet":
        return (Icons.account_balance_wallet_outlined, const Color(0xFF10B981));
      case "order":
        return (Icons.receipt_long_outlined, const Color(0xFF3B82F6));
      case "file":
        return (Icons.insert_drive_file_outlined, const Color(0xFF8B5CF6));
      default:
        return (Icons.check_circle_outline, cs.primary);
    }
  }

  @override
  Widget build(BuildContext context) {
    final (IconData icon, Color color) = _style;
    return Container(
      constraints: const BoxConstraints(maxWidth: 360),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color.withValues(alpha: 0.35)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (data.title.isNotEmpty) ...<Widget>[
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Container(
                  padding: const EdgeInsets.all(6),
                  decoration: BoxDecoration(
                    color: color.withValues(alpha: 0.14),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Icon(icon, size: 18, color: color),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    data.title,
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w700,
                      color: cs.onSurface,
                      height: 1.4,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
          ],
          ...data.items.map((AgentResultItem it) {
            return Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  _ItemMark(type: it.type, colorScheme: cs),
                  const SizedBox(width: 8),
                  Flexible(
                    child: Text(
                      it.text,
                      style: TextStyle(
                        fontSize: 13,
                        color: cs.onSurface.withValues(alpha: 0.82),
                        height: 1.55,
                      ),
                    ),
                  ),
                ],
              ),
            );
          }),
          if (data.footer.isNotEmpty) ...<Widget>[
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.only(top: 8),
              decoration: BoxDecoration(
                border: Border(
                  top: BorderSide(
                    color: cs.outline.withValues(alpha: 0.28),
                    width: 1,
                  ),
                ),
              ),
              child: Text(
                data.footer,
                style: TextStyle(
                  fontSize: 12.5,
                  color: cs.onSurfaceVariant,
                  height: 1.5,
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// 横向卡片轮播：把「标题：描述」列表项渲染为横滑卡片组（搜索/资讯场景）。
class _CarouselCard extends StatelessWidget {
  const _CarouselCard({required this.data, required this.cs});

  final AgentResultData data;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    final List<({String title, String desc})> cards =
        data.items.map((AgentResultItem it) {
      final String raw = it.text.trim();
      final int sep = _findTitleSep(raw);
      if (sep <= 0) return (title: raw, desc: "");
      return (
        title: raw.substring(0, sep).trim(),
        desc: raw.substring(sep).trim(),
      );
    }).toList(growable: false);

    if (cards.isEmpty) return const SizedBox.shrink();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        if (data.title.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text(
              data.title,
              style: TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w700,
                color: cs.onSurface,
                height: 1.4,
              ),
            ),
          ),
        SizedBox(
          height: 96,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 2),
            itemCount: cards.length,
            separatorBuilder: (_, __) => const SizedBox(width: 8),
            itemBuilder: (BuildContext context, int i) {
              final ({String title, String desc}) card = cards[i];
              return Container(
                width: 180,
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: cs.surfaceContainerHigh,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: cs.outline.withValues(alpha: 0.22)),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      card.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w700,
                        color: cs.primary,
                        height: 1.3,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Expanded(
                      child: Text(
                        card.desc,
                        maxLines: 3,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 11.5,
                          color: cs.onSurfaceVariant,
                          height: 1.4,
                        ),
                      ),
                    ),
                  ],
                ),
              );
            },
          ),
        ),
        if (data.footer.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(
              data.footer,
              style: TextStyle(
                  fontSize: 12.5, color: cs.onSurfaceVariant, height: 1.5),
            ),
          ),
      ],
    );
  }
}

/// 在「标题：描述」/「标题 —— 描述」/「标题 — 描述」/「标题 - 描述」中找分隔位置。
int _findTitleSep(String raw) {
  final RegExp sepRe = RegExp(r"[:：]|——|—|\s-\s|｜|\|");
  final RegExpMatch? m = sepRe.firstMatch(raw);
  if (m == null) return -1;
  final int sep = m.start;
  return sep > 0 ? sep : -1;
}

/// 左右对比卡：把「A vs B」的每个列表项渲染为左右两列对比行。
///
/// 约定：每个 item 文本用 `A vs B` / `A｜B` / `A / B` 分隔左右两列值，
/// title 作为对比标题，footer 作为结论。适合商品/方案 pk 场景。
class _CompareCard extends StatelessWidget {
  const _CompareCard({required this.data, required this.cs});

  final AgentResultData data;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    const EdgeInsets padding = EdgeInsets.fromLTRB(14, 12, 14, 12);
    final Color titleColor = cs.onSurface;
    final Color valueColor = cs.onSurface.withValues(alpha: 0.82);
    final Color borderColor = cs.outline.withValues(alpha: 0.22);

    return Container(
      constraints: const BoxConstraints(maxWidth: 390),
      padding: padding,
      decoration: BoxDecoration(
        color: cs.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: borderColor),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (data.title.isNotEmpty) ...<Widget>[
            Row(
              children: <Widget>[
                Icon(Icons.alt_route_outlined, size: 16, color: cs.primary),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    data.title,
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w700,
                      color: titleColor,
                      height: 1.4,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
          ],
          // 对比行：每行是「属性 + 左右两值」
          ...data.items.map((AgentResultItem it) {
            final (String left, String right) = _splitCompare(it.text);
            return Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Expanded(
                    child: Text(
                      left,
                      style: TextStyle(
                        fontSize: 13,
                        color: valueColor,
                        height: 1.5,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  const Padding(
                    padding: EdgeInsets.symmetric(horizontal: 6),
                    child: Text("|", style: TextStyle(color: Color(0xFF9CA3AF))),
                  ),
                  Expanded(
                    child: Text(
                      right,
                      style: TextStyle(
                        fontSize: 13,
                        color: cs.primary,
                        height: 1.5,
                      ),
                    ),
                  ),
                ],
              ),
            );
          }),
          if (data.footer.isNotEmpty) ...<Widget>[
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.only(top: 8),
              decoration: BoxDecoration(
                border: Border(
                  top: BorderSide(color: borderColor, width: 1),
                ),
              ),
              child: Text(
                data.footer,
                style: TextStyle(
                  fontSize: 12.5,
                  color: cs.onSurfaceVariant,
                  height: 1.5,
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  /// 把「A vs B」/「A｜B」/「A / B」拆成左右两值；无分隔时左值=整句、右值=空。
  (String, String) _splitCompare(String raw) {
    final RegExp sepRe = RegExp(r"\s+(?:vs|VS|对比)\s+|｜|\|\s*|\s+/\s+");
    final RegExpMatch? m = sepRe.firstMatch(raw);
    if (m == null) {
      return (raw.trim(), "");
    }
    final int sep = m.start;
    return (
      raw.substring(0, sep).trim(),
      raw.substring(m.end).trim(),
    );
  }
}

/// 时间轴卡：把每个 item 渲染为时间轴上的一个节点（点 + 时间 + 描述）。
///
/// 约定：item 文本形如 `09:00 起床` 或 `周六 09:00 起床`（时间/日期在开头），
/// 前端按第一个空格切出时间戳与正文。适合行程/计划/日程场景。
class _TimelineCard extends StatelessWidget {
  const _TimelineCard({required this.data, required this.cs});

  final AgentResultData data;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    const EdgeInsets padding = EdgeInsets.fromLTRB(14, 12, 14, 12);
    final Color titleColor = cs.onSurface;
    final Color borderColor = cs.outline.withValues(alpha: 0.22);

    return Container(
      constraints: const BoxConstraints(maxWidth: 390),
      padding: padding,
      decoration: BoxDecoration(
        color: cs.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: borderColor),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (data.title.isNotEmpty) ...<Widget>[
            Row(
              children: <Widget>[
                Icon(Icons.timeline_outlined, size: 16, color: cs.primary),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    data.title,
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w700,
                      color: titleColor,
                      height: 1.4,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
          ],
          // 时间轴主体：竖线 + 节点
          ...data.items.asMap().entries.map((MapEntry<int, AgentResultItem> e) {
            final bool isLast = e.key == data.items.length - 1;
            final (String time, String body) = _splitTimeline(e.value.text);
            return IntrinsicHeight(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  // 节点列：圆点 + 竖线
                  SizedBox(
                    width: 20,
                    child: Column(
                      children: <Widget>[
                        Container(
                          width: 9,
                          height: 9,
                          margin: const EdgeInsets.only(top: 4),
                          decoration: BoxDecoration(
                            color: cs.primary,
                            shape: BoxShape.circle,
                          ),
                        ),
                        if (!isLast)
                          Expanded(
                            child: Container(
                              width: 2,
                              margin: const EdgeInsets.only(top: 2),
                              color: cs.outline.withValues(alpha: 0.3),
                            ),
                          ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  // 内容列
                  Expanded(
                    child: Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          if (time.isNotEmpty)
                            Text(
                              time,
                              style: TextStyle(
                                fontSize: 11.5,
                                fontWeight: FontWeight.w700,
                                color: cs.primary,
                                height: 1.3,
                              ),
                            ),
                          if (body.isNotEmpty)
                            Text(
                              body,
                              style: TextStyle(
                                fontSize: 13,
                                color: cs.onSurface.withValues(alpha: 0.82),
                                height: 1.5,
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            );
          }),
          if (data.footer.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                data.footer,
                style: TextStyle(
                  fontSize: 12.5,
                  color: cs.onSurfaceVariant,
                  height: 1.5,
                ),
              ),
            ),
        ],
      ),
    );
  }

  /// 把「时间 + 正文」从 item 文本中切出。
  /// 时间戳匹配：`HH:mm`、`HH:mm-HH:mm`、`周六/周日/明天`、`MM-dd` 等开头。
  (String, String) _splitTimeline(String raw) {
    final RegExpMatch? m = RegExp(
      r"^((?:\d{1,2}[:：]\d{2}(?:[-~]\d{1,2}[:：]\d{2})?)|(?:周[一二三四五六日天])|(?:明天|今天|后天)|(?:\d{1,2}[-/]\d{1,2}))[:： ]\s*",
    ).firstMatch(raw);
    if (m == null) {
      return ("", raw.trim());
    }
    return (
      m.group(1)!.trim(),
      raw.substring(m.end).trim(),
    );
  }
}

/// 图片/媒体结果卡：把每个 item 渲染为一张缩略图 + 描述。
///
/// 约定：item 文本若是 URL（http/https）则渲染为图片缩略图，
/// 否则按普通列表项渲染。适合识图/图片搜索结果。
class _MediaCard extends StatelessWidget {
  const _MediaCard({required this.data, required this.cs});

  final AgentResultData data;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    const EdgeInsets padding = EdgeInsets.fromLTRB(14, 12, 14, 12);
    final Color titleColor = cs.onSurface;
    final Color itemColor = cs.onSurface.withValues(alpha: 0.82);

    return Container(
      constraints: const BoxConstraints(maxWidth: 390),
      padding: padding,
      decoration: BoxDecoration(
        color: cs.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: cs.outline.withValues(alpha: 0.22)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (data.title.isNotEmpty) ...<Widget>[
            Row(
              children: <Widget>[
                Icon(Icons.image_outlined, size: 16, color: cs.primary),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    data.title,
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w700,
                      color: titleColor,
                      height: 1.4,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
          ],
          ...data.items.map((AgentResultItem it) {
            final String text = it.text.trim();
            final bool isUrl = RegExp(r"^https?://").hasMatch(text);
            if (!isUrl) {
              // 非 URL：按普通列表项渲染
              return Padding(
                padding: const EdgeInsets.symmetric(vertical: 3),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    _ItemMark(type: it.type, colorScheme: cs),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        text,
                        style: TextStyle(
                          fontSize: 13,
                          color: itemColor,
                          height: 1.55,
                        ),
                      ),
                    ),
                  ],
                ),
              );
            }
            // URL：渲染为图片缩略图（横向排列，最多一行）
            return Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: _NetworkThumb(url: text, cs: cs),
            );
          }),
          if (data.footer.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                data.footer,
                style: TextStyle(
                  fontSize: 12.5,
                  color: cs.onSurfaceVariant,
                  height: 1.5,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// 网络图片缩略图：加载失败时降级为灰色占位图标。
class _NetworkThumb extends StatelessWidget {
  const _NetworkThumb({required this.url, required this.cs});

  final String url;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(8),
      child: Image.network(
        url,
        width: 120,
        height: 88,
        fit: BoxFit.cover,
        errorBuilder: (BuildContext context, Object error, StackTrace? st) {
          return Container(
            width: 120,
            height: 88,
            color: cs.surfaceContainerHighest,
            alignment: Alignment.center,
            child: Icon(Icons.broken_image_outlined, color: cs.onSurfaceVariant),
          );
        },
        loadingBuilder: (BuildContext context, Widget child,
            ImageChunkEvent? loadingProgress) {
          if (loadingProgress == null) return child;
          return Container(
            width: 120,
            height: 88,
            color: cs.surfaceContainerHighest,
            alignment: Alignment.center,
            child: const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          );
        },
      ),
    );
  }
}
