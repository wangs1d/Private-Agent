import "package:flutter/material.dart";
import "package:url_launcher/url_launcher.dart";

import "../../core/config/api_config.dart";
import "../../core/services/image_preview_launcher.dart";
import "../../core/utils/agent_result_parser.dart";
import "travel_plan_launcher.dart";
import "content_summary_detail_formatter.dart";
import "display_effects/compare_slider.dart";
import "display_effects/display_effects.dart";
import "display_effects/soft_icon_chip.dart";
import "media_gallery.dart";
import "media_thumbnail.dart";

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

    // 展示效果独立模块（display_effects/）：服务端 display-effect-router
    // 纯程序路由出 cardType，这里按 cardType 分发到对应效果组件
    //（steps/metric/carousel/chips/fold_list/compare 滑杆），无 LLM 参与。
    // 返回 null 的类型走下方既有专用卡，行为与历史版本一致。
    if (data.cardType.isNotEmpty) {
      final Widget? effect = displayEffectsCard(data: data, cs: cs);
      if (effect != null) return effect;
      switch (data.cardType) {
        case "search_result":
          return _SearchResultCard(data: data, cs: cs);
        case "timeline":
          return _TimelineCard(data: data, cs: cs);
        case "progress":
          return _ProgressCard(data: data, cs: cs);
        case "quote":
          return _QuoteCard(data: data, cs: cs);
        case "media":
          return _MediaCard(data: data, cs: cs);
        case "travel_itinerary":
          return _TravelItineraryCard(data: data, cs: cs);
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
        // 卡片宽度自然跟随内容(由外层 bubble 约束),最大 390,
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

/// 列表项标记：与卡片标题图标块同一套「浅底圆角芯片 + 实色图标」语言，
/// 只是走 item 小档（16px 芯片），✓/•/! 从文本符号改为 Material 图标，
/// 让列表行与专用卡图标块视觉同源。
class _ItemMark extends StatelessWidget {
  const _ItemMark({required this.type, required this.colorScheme});

  final String type;
  final ColorScheme colorScheme;

  @override
  Widget build(BuildContext context) {
    final (IconData icon, Color color) = switch (type) {
      "warn" => (Icons.priority_high_rounded, const Color(0xFFFBBF24)),
      "num" || "bullet" => (
          Icons.fiber_manual_record_rounded,
          colorScheme.primary
        ),
      _ => (Icons.check_rounded, const Color(0xFF34D399)),
    };
    return SoftIconChip(
      icon: icon,
      color: color,
      chipSize: 16,
      iconSize: 11,
      radius: 5,
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
      constraints: const BoxConstraints(maxWidth: 390),
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
                SoftIconChip(icon: icon, color: color),
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
                    child: buildInlineMarkdownText(
                      it.text,
                      TextStyle(
                        fontSize: 13,
                        color: cs.onSurface.withValues(alpha: 0.82),
                        height: 1.55,
                      ),
                      cs: cs,
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
              child: buildInlineMarkdownText(
                data.footer,
                TextStyle(
                  fontSize: 12.5,
                  color: cs.onSurfaceVariant,
                  height: 1.5,
                ),
                cs: cs,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// 文字进度条/图表卡：把数值型结论可视化为进度条，比纯列表更直观。
///
/// 约定（服务端 `AgentResultFormatter` 输出）：
///   - item 文本形如 `任务 A 45%` / `完成度 75%` / `效率 90/100`，
///     正则提取末尾的百分比或 `x/总分`，渲染为横向进度条；
///   - 提不出数值的 item 回退为普通列表行。
/// 适合：任务完成度、预算使用、评分对比、达成率等「带数字」的结论。
class _ProgressCard extends StatelessWidget {
  const _ProgressCard({required this.data, required this.cs});

  final AgentResultData data;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(maxWidth: 390),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
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
                SoftIconChip(icon: Icons.donut_small, color: cs.primary),
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
            const SizedBox(height: 10),
          ],
          ...data.items.map((AgentResultItem it) {
            return _ProgressRow(text: it.text, cs: cs);
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
              child: buildInlineMarkdownText(
                data.footer,
                TextStyle(
                  fontSize: 12.5,
                  color: cs.onSurfaceVariant,
                  height: 1.5,
                ),
                cs: cs,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// 进度卡单行：`标签 xx%`（或 `x/总分`）→ 标签 + 进度条 + 百分比。
class _ProgressRow extends StatelessWidget {
  const _ProgressRow({required this.text, required this.cs});

  final String text;
  final ColorScheme cs;

  /// 提取形如 `75%`、`45 %`、`90/100`、`0.85` 的数值。percent>1 时按 x/max 归一。
  (String label, double? value, String? tail)? _parse() {
    final RegExpMatch? m =
        RegExp(r"^(.*?)\s*(?:[（(]?(\d+(?:\.\d+)?)\s*%[)）]?|(\d+(?:\.\d+)?)\s*/\s*(\d+(?:\.\d+)?))\s*$")
            .firstMatch(text);
    if (m == null) return null;
    final String label = m.group(1)!.trim();
    double? v;
    String? tail;
    if (m.group(2) != null) {
      v = double.tryParse(m.group(2)!);
      tail = "${m.group(2)!}%";
    } else if (m.group(3) != null && m.group(4) != null) {
      final double? cur = double.tryParse(m.group(3)!);
      final double? max = double.tryParse(m.group(4)!);
      if (cur != null && max != null && max > 0) {
        v = cur / max;
        tail = "${m.group(3)!}/${m.group(4)!}";
      }
    }
    if (v == null) return (label, null, tail);
    return (label, v.clamp(0.0, 1.0), tail);
  }

  @override
  Widget build(BuildContext context) {
    final (String label, double? value, String? tail)? parsed = _parse();
    if (parsed == null || parsed.$2 == null) {
      // 非数值行 → 回退普通列表行
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            _ItemMark(type: "bullet", colorScheme: cs),
            const SizedBox(width: 8),
            Expanded(
              child: buildInlineMarkdownText(
                text,
                TextStyle(
                  fontSize: 13,
                  color: cs.onSurface.withValues(alpha: 0.82),
                  height: 1.55,
                ),
                cs: cs,
              ),
            ),
          ],
        ),
      );
    }
    final double pct = parsed.$2!;
    // 两态配色：100% 完成绿，其余主色。颜色只表达「完成/未完成」，
    // 不做三色过载的信号编码，视觉更克制、直接了当。
    final Color barColor = pct >= 1 ? const Color(0xFF10B981) : cs.primary;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  parsed.$1,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 13,
                    color: cs.onSurface.withValues(alpha: 0.85),
                    height: 1.3,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                parsed.$3 ?? "${(pct * 100).round()}%",
                style: TextStyle(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w700,
                  color: barColor,
                ),
              ),
            ],
          ),
          const SizedBox(height: 5),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: pct,
              minHeight: 6,
              backgroundColor: cs.surfaceContainerHighest,
              valueColor: AlwaysStoppedAnimation<Color>(barColor),
            ),
          ),
        ],
      ),
    );
  }
}

/// 引用卡：把 agent 的一句话结论做成醒目的引用强调，视觉上区别于普通正文。
///
/// 约定：`data.title` 为引述正文，`data.footer` 可选作为来源/出处。
/// 适合：核心结论、金句、警告提示、强调重点。
class _QuoteCard extends StatelessWidget {
  const _QuoteCard({required this.data, required this.cs});

  final AgentResultData data;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    final String body = data.title.isNotEmpty ? data.title : data.footer;
    final String source =
        data.title.isNotEmpty ? data.footer : (data.items.isNotEmpty ? data.items.first.text : "");
    return Container(
      constraints: const BoxConstraints(maxWidth: 390),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: cs.primary.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(12),
        border: Border(
          left: BorderSide(color: cs.primary, width: 3),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              SoftIconChip(icon: Icons.format_quote, color: cs.primary),
              const SizedBox(width: 8),
              Expanded(
                child: buildInlineMarkdownText(
                  body,
                  TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    color: cs.onSurface,
                    height: 1.55,
                  ),
                  cs: cs,
                ),
              ),
            ],
          ),
          if (source.isNotEmpty) ...<Widget>[
            const SizedBox(height: 8),
            Padding(
              padding: const EdgeInsets.only(left: 36),
              child: buildInlineMarkdownText(
                "— $source",
                TextStyle(
                  fontSize: 12,
                  color: cs.onSurfaceVariant,
                  height: 1.4,
                ),
                cs: cs,
              ),
            ),
          ],
        ],
      ),
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
                SoftIconChip(icon: Icons.timeline_outlined, color: cs.primary),
                const SizedBox(width: 8),
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
                            buildInlineMarkdownText(
                              body,
                              TextStyle(
                                fontSize: 13,
                                color: cs.onSurface.withValues(alpha: 0.82),
                                height: 1.5,
                              ),
                              cs: cs,
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
              child: buildInlineMarkdownText(
                data.footer,
                TextStyle(
                  fontSize: 12.5,
                  color: cs.onSurfaceVariant,
                  height: 1.5,
                ),
                cs: cs,
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

/// 图片/媒体结果卡：纯图廊。
///
/// 单张照片以大图重点展示（底部带一句说明），多张照片以网格并排、顶部标注
/// 总数。点击任意照片在右侧双栏打开大图，同一绿泡内可前后切换
/// （见 [ImagePreviewPanel]）。视频条目仍展示缩略图 + 来源 + 播放角标。
class _MediaCard extends StatelessWidget {
  const _MediaCard({required this.data, required this.cs});

  final AgentResultData data;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    final List<AgentResultItem> items = data.items;
    final String groupTitle = (data.groupTitle ?? "").trim();
    final bool isGrouped = groupTitle.isNotEmpty;

    // 收集照片（解析 thumbnail/media/pageUrl 任一可用地址并统一 resolve）+ 说明 + 对比侧
    final List<({String url, String caption, String side})> photos =
        <({String url, String caption, String side})>[];
    final List<String> allPhotoUrls = <String>[];
    // 收集视频（缩略图可空：后端已保证不把播放页/搜索页 URL 当图下发；
    // 无缩略图时前端显示视频占位图标，点击仍可打开播放页）
    final List<
        ({
          String title,
          String? source,
          String? thumbnailUrl,
          String? openUrl,
        })> videos = <({String title, String? source, String? thumbnailUrl, String? openUrl})>[];
    for (final AgentResultItem it in items) {
      final String text = it.text.trim();
      final String? textUrl = extractUrlFromText(text);
      final String? previewUrl = _firstNonEmpty(<String?>[
        it.thumbnailUrl,
        it.mediaType == "video" ? null : it.mediaUrl,
        it.url,
        textUrl,
      ]);
      final String? openUrl = _firstNonEmpty(<String?>[
        it.pageUrl,
        it.url,
        it.mediaUrl,
        textUrl,
      ]);
      final bool isVideo = (it.mediaType ?? "").toLowerCase() == "video" ||
          (openUrl != null &&
              RegExp(r"(youtube\.com|youtu\.be|bilibili\.com|/video/)",
                      caseSensitive: false)
                  .hasMatch(openUrl));
      if (previewUrl == null && openUrl == null) continue;
      if (isVideo) {
        videos.add((
          title: text.isNotEmpty && text != "图片" ? text : (it.source ?? "相关视频"),
          source: it.source,
          thumbnailUrl: previewUrl,
          openUrl: openUrl,
        ));
      } else {
        final String resolved = _resolveMediaUrl(previewUrl!);
        // 同一张图不重复展示：地址已在集内则跳过（服务端已去重，此处双保险）
        if (allPhotoUrls.contains(resolved)) continue;
        photos.add((
          url: resolved,
          caption: _photoCaption(it.text),
          side: (it.side ?? "").trim(),
        ));
        allPhotoUrls.add(resolved);
      }
    }

    if (photos.isEmpty && videos.isEmpty) return const SizedBox.shrink();

    // 分组/对比模式：左侧(A) + 右侧(B) 分栏；无侧的归入常规网格
    final List<({String url, String caption, String side})> leftPhotos =
        photos.where((p) => p.side == "A").toList();
    final List<({String url, String caption, String side})> rightPhotos =
        photos.where((p) => p.side == "B").toList();
    final List<({String url, String caption, String side})> plainPhotos =
        photos.where((p) => p.side != "A" && p.side != "B").toList();
    final bool hasColumns =
        isGrouped && (leftPhotos.isNotEmpty || rightPhotos.isNotEmpty);
    // A/B 任一列有独立标签时，渲染对比列头；否则省略表头。
    final bool hasColumnHeaders =
        (data.sideA?.trim().isNotEmpty ?? false) ||
            (data.sideB?.trim().isNotEmpty ?? false);

    // A/B 对比逐行配对：A[i] 与 B[i] 同一行并排，便于肉眼逐张对比。
    // 顶部先渲染 A/B 列头，后续每行图片填满各自列宽（方形自适应），
    // 保证两列等宽整齐；某侧缺图时该格显示「—」占位。
    List<Widget> buildCompareRows(
      List<({String url, String caption, String side})> aList,
      List<({String url, String caption, String side})> bList,
    ) {
      final bool showHeader = hasColumnHeaders;
      final int count = aList.length > bList.length ? aList.length : bList.length;
      final List<Widget> rows = <Widget>[
        if (showHeader) ...<Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Expanded(child: _compareColumnHeader(data.sideA)),
              const SizedBox(width: 8),
              Expanded(child: _compareColumnHeader(data.sideB)),
            ],
          ),
          const SizedBox(height: 8),
        ],
        for (int i = 0; i < count; i++) ...<Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Expanded(
                child: _compareCell(
                  i < aList.length ? aList[i] : null,
                  allPhotoUrls,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _compareCell(
                  i < bList.length ? bList[i] : null,
                  allPhotoUrls,
                ),
              ),
            ],
          ),
          if (i < count - 1) const SizedBox(height: 8),
        ],
      ];
      return rows;
    }

    return Container(
      constraints: const BoxConstraints(maxWidth: 390),
      padding: const EdgeInsets.fromLTRB(10, 10, 10, 10),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: cs.outline.withValues(alpha: 0.22)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          // 分组维度标题（如「颜色持久度」）
          if (isGrouped && groupTitle.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(left: 2, right: 2, bottom: 8),
              child: Row(
                children: <Widget>[
                  Container(
                    width: 4,
                    height: 14,
                    decoration: BoxDecoration(
                      color: cs.primary,
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      groupTitle,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 13.5,
                        fontWeight: FontWeight.w700,
                        color: cs.onSurface,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          // A/B 对比：恰好两侧各一张图 → 拖动对比滑杆（逐像素对比原图，
          // 如持妆前后对比）；多张 → 逐行配对并排（A[i] ↔ B[i]）。
          if (hasColumns && leftPhotos.length == 1 && rightPhotos.length == 1)
            CompareSlider(
              urlA: leftPhotos.first.url,
              urlB: rightPhotos.first.url,
              labelA: (data.sideA ?? "").trim(),
              labelB: (data.sideB ?? "").trim(),
              gallery: allPhotoUrls,
              cs: cs,
            )
          else if (hasColumns)
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: buildCompareRows(leftPhotos, rightPhotos),
            ),
          if (hasColumns && plainPhotos.isNotEmpty) const SizedBox(height: 8),
          // 无侧/常规照片网格
          if (plainPhotos.isNotEmpty || !hasColumns)
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                if (photos.length > 1 && !hasColumns)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8, left: 2),
                    child: Text(
                      "共 ${photos.length} 张图片",
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: cs.onSurfaceVariant,
                      ),
                    ),
                  ),
                if (plainPhotos.length == 1 && photos.length == 1)
                  // 单张：重点大图 + 说明条，点击预览
                  MediaGallery(
                    urls: <String>[plainPhotos.first.url],
                    captions: <String>[plainPhotos.first.caption],
                    previewGallery: allPhotoUrls,
                    cs: cs,
                  )
                else
                  // 多张：自适应网格（2 列方图 / ≥3 列小图），每格可点击，
                  // 同一绿泡内可前后切换（预览图池用全部照片）。
                  MediaGallery(
                    urls: plainPhotos.map((p) => p.url).toList(),
                    previewGallery: allPhotoUrls,
                    cs: cs,
                  ),
              ],
            ),
          if (videos.isNotEmpty) ...<Widget>[
            if (photos.isNotEmpty) const SizedBox(height: 6),
            _VideoPanel(videos: videos, cs: cs),
          ],
        ],
      ),
    );
  }

  /// 从 item 文本提取一句话作为照片说明；纯链接 / 占位符则不展示。
  String _photoCaption(String text) {
    final String t = text.trim();
    if (t.isEmpty ||
        t == "图片" ||
        RegExp(r'^https?://\S+$').hasMatch(t)) {
      return "";
    }
    return t;
  }

  String? _firstNonEmpty(List<String?> values) {
    for (final String? value in values) {
      final String trimmed = value?.trim() ?? "";
      if (trimmed.isNotEmpty) return trimmed;
    }
    return null;
  }

  /// 对比列表头胶囊：左侧 A、右侧 B，突出对比维度，空标签显示「—」保持两列对齐。
  Widget _compareColumnHeader(String? label) {
    final String t = (label ?? "").trim();
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 5),
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: cs.primary.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        t.isEmpty ? "—" : t,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          fontSize: 11.5,
          fontWeight: FontWeight.w700,
          color: cs.primary,
        ),
      ),
    );
  }

  /// A/B 对比单格：图片按列宽等比占满（方形自适应），下方带来源说明，点击可预览；
  /// 该侧缺图时显示统一浅色「—」占位，与有图一侧等高对齐。
  Widget _compareCell(
    ({String url, String caption, String side})? entry,
    List<String> gallery,
  ) {
    if (entry == null) {
      return AspectRatio(
        aspectRatio: 1,
        child: Container(
          decoration: BoxDecoration(
            color: cs.surfaceContainerLowest,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: cs.outline.withValues(alpha: 0.22)),
          ),
          alignment: Alignment.center,
          child: Text(
            "—",
            style: TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.w400,
              color: cs.onSurfaceVariant.withValues(alpha: 0.5),
            ),
          ),
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        GestureDetector(
          onTap: () {
            ImagePreviewLauncher.open(
              url: entry.url,
              title: "图片预览",
              gallery: gallery,
              index: gallery.indexOf(entry.url),
            );
          },
          child: AspectRatio(
            aspectRatio: 1,
            child: MediaThumbnail(
              url: entry.url,
              cs: cs,
              width: double.infinity,
              borderRadius: 8,
            ),
          ),
        ),
        if (entry.caption.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              entry.caption,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 11,
                height: 1.35,
                color: cs.onSurfaceVariant,
              ),
            ),
          ),
      ],
    );
  }
}

/// 旅游行程双面板卡：行程概览 + 「打开行程规划」入口。
///
/// 与媒体卡同样采用静态回调桥接（[TravelPlanLauncher.open]）：点击入口后
/// 在右侧双栏打开行程规划界面（左天数 + 右当日行程），界面内另有全屏按钮。
class _TravelItineraryCard extends StatelessWidget {
  const _TravelItineraryCard({required this.data, required this.cs});

  final AgentResultData data;
  final ColorScheme cs;

  /// 行程卡强调色（与右栏双面板界面一致）。
  static const Color _accent = Color(0xFF18D6F3);

  @override
  Widget build(BuildContext context) {
    final List<String> lines = <String>[
      for (final AgentResultItem it in data.items)
        if (it.text.trim().isNotEmpty) it.text.trim(),
    ];

    // 拆分「Day N / 第N天」标题行与具体行程条目
    final List<String> dayLines = <String>[];
    final List<String> detailLines = <String>[];
    for (final String line in lines) {
      if (RegExp(
        r'^(?:第\s*[0-9一二三四五六七八九十百]+\s*天|[dD]ay\s*[0-9一二三四五六七八九十百]+)',
      ).hasMatch(line)) {
        dayLines.add(line);
      } else {
        detailLines.add(line);
      }
    }

    final String title = data.title.trim();
    final String destination = _inferDestination(title, lines);
    final bool hasPlan = dayLines.isNotEmpty || detailLines.isNotEmpty;

    return Container(
      constraints: const BoxConstraints(maxWidth: 390),
      padding: const EdgeInsets.fromLTRB(12, 11, 12, 12),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: cs.outline.withValues(alpha: 0.22)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          // ── 顶行：目的地徽章 + 天数 + 全屏入口 ──
          Row(
            children: <Widget>[
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: _accent.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(999),
                  border: Border.all(color: _accent.withValues(alpha: 0.35)),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    const Icon(Icons.map_outlined,
                        size: 13, color: _accent),
                    const SizedBox(width: 4),
                    Text(
                      destination,
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: _accent,
                      ),
                    ),
                  ],
                ),
              ),
              if (dayLines.isNotEmpty) ...<Widget>[
                const SizedBox(width: 8),
                Text(
                  "${dayLines.length} 天行程",
                  style: TextStyle(
                    fontSize: 11,
                    color: cs.onSurfaceVariant,
                  ),
                ),
              ],
            ],
          ),
          if (title.isNotEmpty) ...<Widget>[
            const SizedBox(height: 6),
            Text(
              title,
              style: TextStyle(
                fontSize: 13.5,
                fontWeight: FontWeight.w600,
                color: cs.onSurface,
                height: 1.4,
              ),
            ),
          ],
          // ── 行程概要预览（最多 3 条天摘要 + 2 条具体条目）──
          if (hasPlan) ...<Widget>[
            const SizedBox(height: 8),
            ..._buildPreviewLines(dayLines, detailLines),
          ],
          // ── 主入口按钮 ──
          if (hasPlan) ...<Widget>[
            const SizedBox(height: 10),
            SizedBox(
              width: double.infinity,
              child: FilledButton.tonalIcon(
                onPressed: () => TravelPlanLauncher.open(data),
                style: FilledButton.styleFrom(
                  backgroundColor: _accent.withValues(alpha: 0.14),
                  foregroundColor: _accent,
                  padding:
                      const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  minimumSize: const Size(0, 34),
                ),
                icon: const Icon(Icons.splitscreen, size: 15),
                label: const Text(
                  "打开行程规划（双面板·可全屏）",
                  style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
                ),
              ),
            ),
          ],
          if (data.footer.trim().isNotEmpty) ...<Widget>[
            const SizedBox(height: 8),
            Text(
              data.footer.trim(),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 11,
                height: 1.45,
                color: cs.onSurfaceVariant,
              ),
            ),
          ],
        ],
      ),
    );
  }

  List<Widget> _buildPreviewLines(
    List<String> dayLines,
    List<String> detailLines,
  ) {
    final List<Widget> widgets = <Widget>[];
    // 天摘要：最多 3 个胶囊
    final int dayCount =
        dayLines.length > 3 ? 3 : dayLines.length;
    for (int i = 0; i < dayCount; i++) {
      widgets.add(
        Padding(
          padding: const EdgeInsets.only(bottom: 4),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Icon(Icons.calendar_today_outlined,
                  size: 11, color: _accent.withValues(alpha: 0.85)),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  dayLines[i],
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 11.5,
                    fontWeight: FontWeight.w600,
                    color: cs.onSurface,
                  ),
                ),
              ),
            ],
          ),
        ),
      );
    }
    // 具体条目：最多 2 条
    final int detailCount =
        detailLines.length > 2 ? 2 : detailLines.length;
    for (int i = 0; i < detailCount; i++) {
      final String line = detailLines[i];
      final String shown =
          line.length > 30 ? "${line.substring(0, 29)}…" : line;
      widgets.add(
        Padding(
          padding: const EdgeInsets.only(bottom: 3),
          child: Text(
            "• $shown",
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 11.5,
              height: 1.4,
              color: cs.onSurfaceVariant,
            ),
          ),
        ),
      );
    }
    return widgets;
  }

  /// 目的地推断：优先「目的地：XXX」行；否则从标题剥离天数/后缀词。
  static String _inferDestination(String title, List<String> lines) {
    for (final String line in lines) {
      final RegExpMatch? m = RegExp(
        r'目的地\s*[:：]\s*([\u4e00-\u9fa5A-Za-z·]{2,12})',
      ).firstMatch(line);
      if (m != null) return m.group(1)!.trim();
    }
    final String cleaned = title
        .replaceAll(
            RegExp(
                r'\d+\s*日游|\d+\s*天\s*游|日游|行程|规划|计划|自由行|攻略|旅游|安排|[·\-—|]\s*.*$'),
            '')
        .trim();
    if (cleaned.length >= 2 && cleaned.length <= 12) return cleaned;
    return title.isEmpty ? "行程规划" : title.substring(0, title.length.clamp(1, 8));
  }
}

/// 从任意文本中提取第一个 http(s) URL，去掉尾部标点。
String? extractUrlFromText(String text) {
  final RegExpMatch? m = RegExp(r'https?://\S+').firstMatch(text);
  if (m == null) return null;
  return m.group(0)!.replaceAll(RegExp(r'[),.;，。！？、]+$'), '');
}

/// 轻量内联媒体行（无外层 card 边框）——给「renderBlocks 小簇」用。
///
/// 设计：服务端 `buildInterleavedRenderBlocks` 会把一次 `search_images` 的 N 张
/// 图自动按正文段落切分成 2-3 张的小簇（普通图墙不再一次性铺底）。
/// 这种小簇适合**紧贴文字**展示，不要再外面套一个完整 `AgentResultCard` 卡框，
/// 否则会出现「段落文字 → 大边框卡 → 段落文字」的割裂感，违反用户
/// 「一段介绍文字然后挨着放一两张图」的产品诉求。
///
/// 交给自适应画廊 [MediaGallery]：单张→Hero 大图（可带说明）；2 张→2 列方图；
/// ≥3 张→3 列小图。跟正文共用一个气泡，视觉上才是「文字+图」的自然交错。
class MediaInlineRow extends StatelessWidget {
  const MediaInlineRow({
    super.key,
    required this.items,
    required this.cs,
  });

  final List<AgentResultItem> items;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) return const SizedBox.shrink();
    // 解析每张图的可用地址 + caption + 侧标签；视频单独收集走视频面板
    final List<({String url, String caption, String side})> photos =
        <({String url, String caption, String side})>[];
    final List<String> allUrls = <String>[];
    final List<
        ({
          String title,
          String? source,
          String? thumbnailUrl,
          String? openUrl,
        })> videos = <({String title, String? source, String? thumbnailUrl, String? openUrl})>[];
    for (final AgentResultItem it in items) {
      final String text = it.text.trim();
      final String? textUrl = extractUrlFromText(text);
      final String? previewUrl = _firstNonEmpty(<String?>[
        it.thumbnailUrl,
        it.mediaType == "video" ? null : it.mediaUrl,
        it.url,
        textUrl,
      ]);
      final String? openUrl = _firstNonEmpty(<String?>[
        it.pageUrl,
        it.url,
        it.mediaUrl,
        textUrl,
      ]);
      final bool isVideo = (it.mediaType ?? "").toLowerCase() == "video" ||
          (openUrl != null &&
              RegExp(r"(youtube\.com|youtu\.be|bilibili\.com|/video/)",
                      caseSensitive: false)
                  .hasMatch(openUrl));
      if (previewUrl == null && openUrl == null) continue;
      if (isVideo) {
        videos.add((
          title: text.isNotEmpty && text != "图片" ? text : (it.source ?? "相关视频"),
          source: it.source,
          thumbnailUrl: previewUrl,
          openUrl: openUrl,
        ));
      } else {
        final String resolved = _resolveMediaUrl(previewUrl!);
        if (allUrls.contains(resolved)) continue;
        photos.add((
          url: resolved,
          caption: _photoCaption(text),
          side: (it.side ?? "").trim(),
        ));
        allUrls.add(resolved);
      }
    }
    if (photos.isEmpty && videos.isEmpty) return const SizedBox.shrink();
    // 照片走自适应画廊：单张→Hero 大图；2 张→2 列方图；≥3 张→3 列小图。
    // 视频走与照片同风格的面板：单条→16:9 大图带播放角标；多条→2 列网格。
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        if (photos.isNotEmpty)
          MediaGallery(
            urls: allUrls,
            captions: photos.map((p) => p.caption).toList(),
            previewGallery: allUrls,
            cs: cs,
          ),
        if (videos.isNotEmpty)
          Padding(
            padding: EdgeInsets.only(top: photos.isNotEmpty ? 6 : 0),
            child: _VideoPanel(videos: videos, cs: cs),
          ),
      ],
    );
  }

  String? _firstNonEmpty(List<String?> values) {
    for (final String? v in values) {
      final String t = (v ?? "").trim();
      if (t.isNotEmpty) return t;
    }
    return null;
  }

  String _photoCaption(String text) {
    final String t = text.trim();
    if (t.isEmpty ||
        t == "图片" ||
        RegExp(r'^https?://\S+$').hasMatch(t)) {
      return "";
    }
    return t;
  }
}

/// 视频面板：与照片画廊同风格的网格/大图展示（替代旧的「左图右文字」列表行）。
///
/// 设计：视频结果也走「同照片一样面板展示」的产品诉求——
///   - 单条：全宽 16:9 hero 大图，带播放角标；
///   - 多条：2 列方图网格（与照片网格一致），每格带播放角标 + 标题。
/// 缩略图为空时显示视频占位图标（后端已保证不下发播放页/搜索页 URL 当图），
/// 点击整卡打开播放页。
class _VideoPanel extends StatelessWidget {
  const _VideoPanel({required this.videos, required this.cs});

  final List<
      ({String title, String? source, String? thumbnailUrl, String? openUrl})>
      videos;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    if (videos.isEmpty) return const SizedBox.shrink();
    if (videos.length == 1) {
      return _VideoTile(video: videos.first, cs: cs, hero: true);
    }
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        const double spacing = 6;
        const int cols = 2;
        final double cell =
            (constraints.maxWidth - spacing * (cols - 1)) / cols;
        return Wrap(
          spacing: spacing,
          runSpacing: 8,
          children: <Widget>[
            for (final v in videos)
              SizedBox(
                width: cell,
                child: _VideoTile(video: v, cs: cs),
              ),
          ],
        );
      },
    );
  }
}

class _VideoTile extends StatelessWidget {
  const _VideoTile({required this.video, required this.cs, this.hero = false});

  final ({String title, String? source, String? thumbnailUrl, String? openUrl})
      video;
  final ColorScheme cs;
  final bool hero;

  @override
  Widget build(BuildContext context) {
    final Widget thumb = ClipRRect(
      borderRadius: BorderRadius.circular(8),
      child: AspectRatio(
        aspectRatio: hero ? 16 / 9 : 1,
        child: Stack(
          fit: StackFit.expand,
          children: <Widget>[
            if (video.thumbnailUrl != null &&
                video.thumbnailUrl!.trim().isNotEmpty)
              MediaThumbnail(
                url: _resolveMediaUrl(video.thumbnailUrl!),
                cs: cs,
                errorIcon: Icons.video_file_outlined,
                borderRadius: 0,
              )
            else
              Container(
                color: cs.surfaceContainerHighest,
                alignment: Alignment.center,
                child: Icon(
                  Icons.video_file_outlined,
                  color: cs.onSurfaceVariant,
                  size: 30,
                ),
              ),
            Center(
              child: Container(
                width: 34,
                height: 34,
                decoration: BoxDecoration(
                  color: Colors.black.withValues(alpha: 0.45),
                  shape: BoxShape.circle,
                ),
                child: const Icon(
                  Icons.play_arrow_rounded,
                  color: Colors.white,
                  size: 26,
                ),
              ),
            ),
          ],
        ),
      ),
    );

    final Widget body = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        thumb,
        if (video.title.trim().isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              video.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 11.5,
                fontWeight: FontWeight.w600,
                color: cs.onSurface,
                height: 1.3,
              ),
            ),
          ),
      ],
    );

    if (video.openUrl == null) return body;
    return InkWell(
      onTap: () => _launchUrl(video.openUrl!),
      borderRadius: BorderRadius.circular(8),
      child: body,
    );
  }
}

String _resolveMediaUrl(String url) {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  final String base = ApiConfig.httpBase;
  if (url.startsWith("/")) return "$base$url";
  return "$base/$url";
}

Future<void> _launchUrl(String url) async {
  final Uri? uri = Uri.tryParse(_resolveMediaUrl(url));
  if (uri == null) return;
  try {
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  } catch (_) {}
}

/// 搜索结果卡片 —— 把搜索工具返回的列表项渲染为垂直排列的新闻条目。
///
/// 每个 item 解析为「标题 —— 描述」格式，渲染为：
///   - 标题（粗体，可点击跳转）
///   - 摘要（灰色小字）
///   - 来源/时间（更小文字）
///
/// 适合搜索/资讯聚合场景，3~10 条垂直排列，清晰可读。
class _SearchResultCard extends StatelessWidget {
  const _SearchResultCard({required this.data, required this.cs});

  final AgentResultData data;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    final TextTheme textTheme = Theme.of(context).textTheme;

    return Container(
      constraints: const BoxConstraints(maxWidth: 390),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: cs.outline.withValues(alpha: 0.22)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          // 标题头
          if (data.title.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Row(
                children: <Widget>[
                  SoftIconChip(
                    icon: Icons.travel_explore_outlined,
                    color: cs.primary,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      data.title,
                      style: textTheme.bodyMedium?.copyWith(
                        fontWeight: FontWeight.w700,
                        color: cs.onSurface,
                        height: 1.4,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          // 条目列表
          ...data.items.map((AgentResultItem it) {
            final (String t, String d) = _splitSearchItem(it.text);
            final bool hasUrl = it.url != null && it.url!.isNotEmpty;
            final String? detectedUrl = hasUrl ? it.url : _detectUrl(d);
            return Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: InkWell(
                onTap: detectedUrl == null
                    ? null
                    : () => _launchUrl(detectedUrl),
                borderRadius: BorderRadius.circular(6),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 2),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      // 标题行
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Container(
                            margin: const EdgeInsets.only(top: 5),
                            width: 5,
                            height: 5,
                            decoration: BoxDecoration(
                              color: cs.primary.withValues(alpha: 0.55),
                              shape: BoxShape.circle,
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text.rich(
                              TextSpan(
                                style: textTheme.bodyMedium?.copyWith(
                                  fontWeight: FontWeight.w700,
                                  height: 1.35,
                                ),
                                children: parseInlineMarkdownSpans(
                                  t,
                                  textTheme.bodyMedium!.copyWith(
                                    fontWeight: FontWeight.w700,
                                    height: 1.35,
                                  ),
                                  cs,
                                ),
                              ),
                            ),
                          ),
                        ],
                      ),
                      // 摘要/描述
                      if (d.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(left: 13, top: 3),
                          child: Text.rich(
                            TextSpan(
                              style: textTheme.bodySmall?.copyWith(
                                color: cs.onSurfaceVariant,
                                height: 1.45,
                                fontSize: 12.8,
                              ),
                              children: parseInlineMarkdownSpans(
                                d,
                                textTheme.bodySmall!.copyWith(
                                  color: cs.onSurfaceVariant,
                                  height: 1.45,
                                  fontSize: 12.8,
                                ),
                                cs,
                              ),
                            ),
                            maxLines: 3,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                    ],
                  ),
                ),
              ),
            );
          }),
          if (data.footer.isNotEmpty)
            Container(
              padding: const EdgeInsets.only(top: 6),
              decoration: BoxDecoration(
                border: Border(
                  top: BorderSide(
                    color: cs.outline.withValues(alpha: 0.28),
                    width: 1,
                  ),
                ),
              ),
              child: buildInlineMarkdownText(
                data.footer,
                textTheme.bodySmall!.copyWith(
                  color: cs.onSurfaceVariant,
                  height: 1.5,
                ),
                cs: cs,
              ),
            ),
        ],
      ),
    );
  }

  /// 把 item 文本拆成「标题 —— 描述」。
  (String, String) _splitSearchItem(String raw) {
    final int sep = _findTitleSep(raw);
    if (sep <= 0) return (raw, "");
    return (raw.substring(0, sep).trim(), raw.substring(sep).trim());
  }

  /// 从文本中检测 http/https URL。
  String? _detectUrl(String text) {
    final RegExpMatch? m = RegExp(r'https?://\S+').firstMatch(text);
    return m?.group(0);
  }

  Future<void> _launchUrl(String url) async {
    final Uri? uri = Uri.tryParse(url);
    if (uri == null) return;
    try {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {}
  }
}
