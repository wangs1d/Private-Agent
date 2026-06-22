import "package:flutter/material.dart";

import "../../core/utils/agent_result_parser.dart";

/// 智能体结果卡片 —— 用于呈现「任务执行总结」「工具调用结果」
/// 这类只需少量文字/数字呈现的轻量结构化数据。
///
/// 视觉规范与项目其它聊天卡片保持一致：
///   - 跟随 [ColorScheme] 主题（深色 / 暖色两套自动适配）
///   - 头像为可配置缩写（智能体标识），支持 default / gradient / accent / success
///   - 列表项用 ✓ / • / ! 三种符号
///   - 底部可选 footer（虚线分隔），支持 `[tag]` inline 标签
///
/// 直接使用：
/// ```dart
/// AgentResultCard(
///   data: AgentResultData(
///     avatar: 'NB',
///     avatarStyle: 'gradient',
///     title: '已完成分析,核心数据如下:',
///     items: [
///       AgentResultItem(type: 'check', text: '核心功能完成度 87%'),
///       AgentResultItem(type: 'check', text: 'Bug 修复 12 个,新增 3 个'),
///     ],
///     footer: '报告已生成,需要发送至你的邮箱吗?',
///   ),
/// )
/// ```
class AgentResultCard extends StatelessWidget {
  const AgentResultCard({super.key, required this.data, this.compact = false});

  final AgentResultData data;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;

    final EdgeInsets padding = compact
        ? const EdgeInsets.symmetric(horizontal: 14, vertical: 12)
        : const EdgeInsets.fromLTRB(16, 14, 16, 14);
    final double avatarSize = compact ? 30 : 36;
    final double avatarRadius = compact ? 7 : 9;
    final double titleGap = compact ? 6 : 10;
    final double listItemGap = compact ? 1 : 3;
    final double footerGap = compact ? 8 : 12;
    final double titleSize = compact ? 13.5 : 14.5;
    final double itemSize = compact ? 12.5 : 13.5;
    final double footerSize = compact ? 12 : 13;

    return Container(
      padding: padding,
      decoration: BoxDecoration(
        // 与项目原 agent 气泡一致：surfaceContainerHigh + outline 描边
        color: cs.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(compact ? 12 : 14),
        border: Border.all(color: cs.outline.withValues(alpha: 0.35)),
        boxShadow: <BoxShadow>[
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.18),
            blurRadius: 14,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              _Avatar(
                text: data.avatar,
                style: data.avatarStyle,
                size: avatarSize,
                radius: avatarRadius,
              ),
              const SizedBox(width: 12),
              Expanded(
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
                            color: cs.onSurface,
                            height: 1.4,
                          ),
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
                                child: Text(
                                  it.text,
                                  style: TextStyle(
                                    fontSize: itemSize,
                                    color: cs.onSurface.withValues(alpha: 0.82),
                                    height: 1.5,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        );
                      }),
                  ],
                ),
              ),
            ],
          ),
          if (data.footer.isNotEmpty) ...<Widget>[
            SizedBox(height: footerGap),
            Container(
              padding: EdgeInsets.only(top: footerGap),
              decoration: BoxDecoration(
                border: Border(
                  top: BorderSide(
                    color: cs.outline.withValues(alpha: 0.35),
                    width: 1,
                  ),
                ),
              ),
              child: _InlineFooterText(
                text: data.footer,
                color: cs.onSurfaceVariant,
                fontSize: footerSize,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// 头像：可配置配色（智能体标识）。
class _Avatar extends StatelessWidget {
  const _Avatar({
    required this.text,
    required this.style,
    required this.size,
    required this.radius,
  });

  final String text;
  final String style;
  final double size;
  final double radius;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;

    final Color bg;
    final Color fg;
    final Gradient? gradient;
    switch (style) {
      case "gradient":
        gradient = const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[Color(0xFF4F8CFF), Color(0xFF8B5CF6)],
        );
        bg = Colors.transparent;
        fg = Colors.white;
        break;
      case "accent":
        gradient = null;
        bg = cs.primary;
        fg = cs.onPrimary;
        break;
      case "success":
        gradient = null;
        bg = const Color(0xFF34D399);
        fg = const Color(0xFF052E1C);
        break;
      default:
        // default：白底深字（深色主题）/ 深底浅字（暖色主题）
        gradient = null;
        bg = cs.brightness == Brightness.dark
            ? Colors.white
            : cs.onSurface;
        fg = cs.brightness == Brightness.dark
            ? const Color(0xFF0F1115)
            : cs.surface;
    }

    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(radius),
        color: gradient == null ? bg : null,
        gradient: gradient,
        boxShadow: <BoxShadow>[
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.22),
            blurRadius: 5,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      alignment: Alignment.center,
      child: Text(
        text,
        style: TextStyle(
          fontSize: size * 0.38,
          fontWeight: FontWeight.w700,
          color: fg,
          letterSpacing: 0.3,
        ),
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
