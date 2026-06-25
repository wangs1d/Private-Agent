import "package:flutter/material.dart";

import "../../core/utils/agent_result_parser.dart";

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

    return Container(
      // 卡片宽度自然跟随内容(由外层 bubble 约束),最大不超过 360,
      // 避免宽屏下拉成"横幅",实现"刚好包住每行最后那个字"的紧凑效果。
      constraints: const BoxConstraints(maxWidth: 360),
      padding: padding,
      decoration: BoxDecoration(
        color: cs.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: cs.outline.withValues(alpha: 0.28)),
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
              ),
            ),
          if (data.items.isNotEmpty)
            ...data.items.map((AgentResultItem it) {
              return Padding(
                padding: EdgeInsets.symmetric(vertical: listItemGap),
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
                          fontSize: itemSize,
                          color: itemColor,
                          height: 1.55,
                        ),
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
    );
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
