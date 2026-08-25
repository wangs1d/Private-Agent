import "package:flutter/material.dart";

import "../../core/utils/markdown_strip.dart";
import "content_summary_detail_formatter.dart";

class AssistantBriefMessage extends StatelessWidget {
  const AssistantBriefMessage({
    super.key,
    required this.text,
    required this.colorScheme,
    this.compact = false,
  });

  final String text;
  final ColorScheme colorScheme;
  final bool compact;

  static bool shouldEnhance(String rawText) {
    final List<_BriefBlock> blocks = _parseBriefBlocks(rawText);
    final int itemCount = blocks.whereType<_BriefItemBlock>().length;
    final bool hasLead = blocks.any((block) => block is _BriefLeadBlock);
    final bool hasNote = blocks.any((block) => block is _BriefNoteBlock);
    return itemCount >= 2 || (itemCount >= 1 && (hasLead || hasNote));
  }

  @override
  Widget build(BuildContext context) {
    final List<_BriefBlock> blocks = _parseBriefBlocks(text);
    final TextTheme textTheme = Theme.of(context).textTheme;
    final ColorScheme cs = colorScheme;

    final List<Widget> children = <Widget>[
      // 简报日期头部（正文前 2 行解析出的日期；无则回退今天）
      _DateHeader(
        dateText: _extractDateHeader(text) ?? _todayDateHeader(),
        cs: cs,
        textTheme: textTheme,
        compact: compact,
      ),
    ];

    // 模块分区：同类模块连续出现时，只在该组首项前渲染一次分区标题
    _BriefModule? shownModule;
    for (final _BriefBlock block in blocks) {
      if (block is _BriefItemBlock) {
        final _BriefModule module = _moduleOf(block);
        if (module != _BriefModule.other && module != shownModule) {
          shownModule = module;
          children.add(_ModuleHeader(
            module: module,
            cs: cs,
            textTheme: textTheme,
            compact: compact,
          ));
        }
        children.add(_BriefItemCard(
          block: block,
          colorScheme: cs,
          compact: compact,
        ));
        continue;
      }

      if (block is _BriefLeadBlock) {
        children.add(Padding(
          padding: EdgeInsets.only(bottom: compact ? 8 : 10),
          child: buildInlineMarkdownText(
            block.text,
            textTheme.titleSmall?.copyWith(
                  fontWeight: FontWeight.w800,
                  color: cs.onSurface,
                  height: 1.35,
                  letterSpacing: -0.1,
                ) ??
                TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w800,
                  color: cs.onSurface,
                  height: 1.35,
                ),
            cs: cs,
          ),
        ));
        continue;
      }

      if (block is _BriefNoteBlock) {
        children.add(Container(
          width: double.infinity,
          margin: EdgeInsets.only(
            top: compact ? 2 : 4,
            bottom: compact ? 6 : 8,
          ),
          padding: EdgeInsets.symmetric(
            horizontal: compact ? 10 : 11,
            vertical: compact ? 8 : 9,
          ),
          decoration: BoxDecoration(
            color: cs.primary.withValues(alpha: 0.08),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: cs.primary.withValues(alpha: 0.16)),
          ),
          child: buildInlineMarkdownText(
            block.text,
            textTheme.bodySmall?.copyWith(
                  color: cs.onSurface.withValues(alpha: 0.82),
                  height: 1.45,
                  fontWeight: FontWeight.w600,
                ) ??
                TextStyle(
                  fontSize: 12,
                  color: cs.onSurface.withValues(alpha: 0.82),
                  height: 1.45,
                  fontWeight: FontWeight.w600,
                ),
            cs: cs,
          ),
        ));
        continue;
      }

      final bool isQuestion = block is _BriefClosingQuestionBlock;
      children.add(Padding(
        padding:
            EdgeInsets.only(top: isQuestion ? 2 : 0, bottom: compact ? 5 : 6),
        child: buildInlineMarkdownText(
          block.text,
          textTheme.bodyMedium?.copyWith(
                color: isQuestion
                    ? cs.onSurface
                    : cs.onSurface.withValues(alpha: 0.86),
                height: 1.45,
                fontWeight: isQuestion ? FontWeight.w600 : FontWeight.w400,
              ) ??
              TextStyle(
                fontSize: 14,
                color: isQuestion
                    ? cs.onSurface
                    : cs.onSurface.withValues(alpha: 0.86),
                height: 1.45,
                fontWeight: isQuestion ? FontWeight.w600 : FontWeight.w400,
              ),
          cs: cs,
        ),
      ));
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: children,
    );
  }
}

/// 简报日期头部：日期 + 星期 + 分隔线，作为简报卡的开场。
class _DateHeader extends StatelessWidget {
  const _DateHeader({
    required this.dateText,
    required this.cs,
    required this.textTheme,
    required this.compact,
  });

  final String dateText;
  final ColorScheme cs;
  final TextTheme textTheme;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(bottom: compact ? 8 : 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Icon(
                Icons.calendar_today_outlined,
                size: 13,
                color: cs.onSurfaceVariant.withValues(alpha: 0.8),
              ),
              const SizedBox(width: 6),
              Text(
                dateText,
                style: textTheme.labelMedium?.copyWith(
                      color: cs.onSurfaceVariant,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 0.3,
                    ) ??
                    TextStyle(
                      fontSize: 12,
                      color: cs.onSurfaceVariant,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 0.3,
                    ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Divider(
            height: 1,
            color: cs.outline.withValues(alpha: 0.16),
          ),
        ],
      ),
    );
  }
}

/// 简报模块分区标题：如「☀️ 天气」「📌 日程」「📰 资讯」「⚠️ 提醒」。
class _ModuleHeader extends StatelessWidget {
  const _ModuleHeader({
    required this.module,
    required this.cs,
    required this.textTheme,
    required this.compact,
  });

  final _BriefModule module;
  final ColorScheme cs;
  final TextTheme textTheme;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        top: compact ? 0 : 2,
        bottom: compact ? 4 : 6,
      ),
      child: Row(
        children: <Widget>[
          Text(
            _moduleLabels[module] ?? "",
            style: textTheme.labelMedium?.copyWith(
                  color: cs.primary,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 0.2,
                ) ??
                TextStyle(
                  fontSize: 12,
                  color: cs.primary,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 0.2,
                ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Container(height: 1, color: cs.outline.withValues(alpha: 0.14)),
          ),
        ],
      ),
    );
  }
}

class _BriefItemCard extends StatelessWidget {
  const _BriefItemCard({
    required this.block,
    required this.colorScheme,
    required this.compact,
  });

  final _BriefItemBlock block;
  final ColorScheme colorScheme;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final TextTheme textTheme = Theme.of(context).textTheme;
    final TextStyle titleStyle = textTheme.bodyMedium?.copyWith(
          fontWeight: FontWeight.w700,
          color: colorScheme.onSurface,
          height: 1.35,
        ) ??
        TextStyle(
          fontSize: 14,
          fontWeight: FontWeight.w700,
          color: colorScheme.onSurface,
          height: 1.35,
        );
    final TextStyle detailStyle = textTheme.bodySmall?.copyWith(
          color: colorScheme.onSurface.withValues(alpha: 0.84),
          height: 1.48,
          fontSize: 12.8,
        ) ??
        TextStyle(
          fontSize: 12.8,
          color: colorScheme.onSurface.withValues(alpha: 0.84),
          height: 1.48,
        );

    return Container(
      width: double.infinity,
      margin: EdgeInsets.only(bottom: compact ? 7 : 8),
      padding: EdgeInsets.fromLTRB(
        compact ? 9 : 10,
        compact ? 8 : 9,
        compact ? 10 : 11,
        compact ? 8 : 9,
      ),
      decoration: BoxDecoration(
        color: colorScheme.surfaceContainerHighest.withValues(alpha: 0.24),
        borderRadius: BorderRadius.circular(13),
        border: Border.all(
          color: colorScheme.outline.withValues(alpha: 0.12),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Container(
                constraints: const BoxConstraints(minWidth: 26),
                margin: const EdgeInsets.only(right: 9, top: 1),
                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                decoration: BoxDecoration(
                  color: colorScheme.primary.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(
                  block.marker,
                  textAlign: TextAlign.center,
                  style: textTheme.labelSmall?.copyWith(
                        color: colorScheme.primary,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 0.1,
                      ) ??
                      TextStyle(
                        fontSize: 11,
                        color: colorScheme.primary,
                        fontWeight: FontWeight.w800,
                      ),
                ),
              ),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    buildInlineMarkdownText(
                      block.title,
                      titleStyle,
                      cs: colorScheme,
                    ),
                    if (block.subtitle.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: buildInlineMarkdownText(
                          block.subtitle,
                          detailStyle.copyWith(
                            fontWeight: FontWeight.w600,
                            color: colorScheme.onSurface.withValues(alpha: 0.9),
                          ),
                          cs: colorScheme,
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
          for (final String detail in block.details)
            Padding(
              padding: const EdgeInsets.only(top: 6, left: 36),
              child: buildInlineMarkdownText(
                detail,
                detailStyle,
                cs: colorScheme,
              ),
            ),
        ],
      ),
    );
  }
}

abstract class _BriefBlock {
  const _BriefBlock(this.text);

  final String text;
}

class _BriefLeadBlock extends _BriefBlock {
  const _BriefLeadBlock(super.text);
}

class _BriefParagraphBlock extends _BriefBlock {
  const _BriefParagraphBlock(super.text);
}

class _BriefNoteBlock extends _BriefBlock {
  const _BriefNoteBlock(super.text);
}

class _BriefClosingQuestionBlock extends _BriefBlock {
  const _BriefClosingQuestionBlock(super.text);
}

class _BriefItemBlock extends _BriefBlock {
  const _BriefItemBlock({
    required this.marker,
    required this.title,
    required this.subtitle,
    required this.details,
  }) : super(title);

  final String marker;
  final String title;
  final String subtitle;
  final List<String> details;
}

final RegExp _orderedItemRe = RegExp(r"^\s*(\d+[.)、])\s*(.+)$");
final RegExp _bulletItemRe = RegExp(r"^\s*([\-*•])\s*(.+)$");
final RegExp _symbolHeadingRe = RegExp(
  r"^\s*([🔥📌📍📎📱📺📷💡⚠⭐🎯📰🌪✅🔍📈📣💬🧭])\s*(.+)$",
);
final RegExp _noteLineRe = RegExp(r"^(关于|补充|顺带|另外|备注|提醒)[:：]?\s*");

/// 简报条目模块归类（模块分区用）。
enum _BriefModule { weather, schedule, news, remind, other }

const Map<_BriefModule, String> _moduleLabels = <_BriefModule, String>{
  _BriefModule.weather: "☀️ 天气",
  _BriefModule.schedule: "📌 日程",
  _BriefModule.news: "📰 资讯",
  _BriefModule.remind: "⚠️ 提醒",
};

final RegExp _weatherKeywords =
    RegExp(r"天气|气温|温度|降雨|降水|晴|多云|阴|雨|雪|风力|湿度|预警");
final RegExp _scheduleKeywords =
    RegExp(r"日程|会议|评审|安排|计划|行程|预约|待办|事项|上班|加班|出差");
final RegExp _newsKeywords =
    RegExp(r"资讯|新闻|热点|快讯|报道|热搜|排行|榜单|消息");
final RegExp _remindKeywords =
    RegExp(r"提醒|注意|别忘|记得|温馨提示|小心|务必");
final RegExp _weatherMarkers = RegExp(r"[☀️🌧⛅☁️❄️🌡️🌈]");
final RegExp _scheduleMarkers = RegExp(r"[📌📍📅🗓️🕐🕘⏰]");
final RegExp _newsMarkers = RegExp(r"[📰🔥📣💬📈]");
final RegExp _remindMarkers = RegExp(r"[⚠️💡❗❕]");

/// 根据「标记 + 标题 + 副标题」判定条目所属模块。关键词优先（更具体），
/// emoji 标记兜底；无法归类的走 [\_BriefModule.other]（不渲染分区标题）。
_BriefModule _moduleOf(_BriefItemBlock block) {
  final String hay =
      "${block.marker} ${block.title} ${block.subtitle} ${block.details.join(' ')}";
  if (_remindKeywords.hasMatch(hay)) return _BriefModule.remind;
  if (_weatherKeywords.hasMatch(hay)) return _BriefModule.weather;
  if (_newsKeywords.hasMatch(hay)) return _BriefModule.news;
  if (_scheduleKeywords.hasMatch(hay)) return _BriefModule.schedule;
  if (_weatherMarkers.hasMatch(hay)) return _BriefModule.weather;
  if (_newsMarkers.hasMatch(hay)) return _BriefModule.news;
  if (_scheduleMarkers.hasMatch(hay)) return _BriefModule.schedule;
  if (_remindMarkers.hasMatch(hay)) return _BriefModule.remind;
  return _BriefModule.other;
}

const List<String> _weekdayNames = <String>[
  "星期一",
  "星期二",
  "星期三",
  "星期四",
  "星期五",
  "星期六",
  "星期日",
];

String _formatDateHeader(int year, int month, int day) {
  final DateTime d = DateTime(year, month, day);
  final String weekday = _weekdayNames[d.weekday - 1];
  final String datePart = year == DateTime.now().year
      ? "$month月$day日"
      : "$year年$month月$day日";
  return "$datePart · $weekday";
}

String _todayDateHeader() {
  final DateTime n = DateTime.now();
  return _formatDateHeader(n.year, n.month, n.day);
}

/// 从正文前 2 行解析日期（形如「8月25日 / 2026-08-25」），避免误抓正文里的行程日期；
/// 未命中返回 null（调用方回退今天）。
String? _extractDateHeader(String text) {
  final List<String> heads =
      text.replaceAll("\r\n", "\n").split("\n").take(2).toList();
  for (final String line in heads) {
    final RegExpMatch? m1 =
        RegExp(r"(?:(20\d{2})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日")
            .firstMatch(line);
    if (m1 != null) {
      return _formatDateHeader(
        int.tryParse(m1.group(1) ?? "") ?? DateTime.now().year,
        int.parse(m1.group(2)!),
        int.parse(m1.group(3)!),
      );
    }
    final RegExpMatch? m2 =
        RegExp(r"(20\d{2})[-/](\d{1,2})[-/](\d{1,2})").firstMatch(line);
    if (m2 != null) {
      return _formatDateHeader(
        int.parse(m2.group(1)!),
        int.parse(m2.group(2)!),
        int.parse(m2.group(3)!),
      );
    }
  }
  return null;
}

List<_BriefBlock> _parseBriefBlocks(String rawText) {
  final List<String> lines = rawText
      .replaceAll("\r\n", "\n")
      .split("\n")
      .map((line) => line.trim())
      .where((line) => line.isNotEmpty)
      .toList();
  if (lines.isEmpty) return const <_BriefBlock>[];

  final List<_BriefBlock> blocks = <_BriefBlock>[];
  int index = 0;

  if (_looksLikeLeadLine(lines.first, lines.length > 1 ? lines[1] : null)) {
    blocks.add(_BriefLeadBlock(_cleanLeadText(lines.first)));
    index = 1;
  }

  while (index < lines.length) {
    final _ParsedHeading? heading = _tryParseHeading(lines[index]);
    if (heading != null) {
      final List<String> details = <String>[];
      int cursor = index + 1;
      while (cursor < lines.length) {
        if (_tryParseHeading(lines[cursor]) != null) break;
        if (_looksLikeStandaloneBlock(lines[cursor], isLast: cursor == lines.length - 1)) break;
        details.add(lines[cursor]);
        cursor += 1;
      }
      blocks.add(
        _BriefItemBlock(
          marker: heading.marker,
          title: heading.title,
          subtitle: heading.subtitle,
          details: details,
        ),
      );
      index = cursor;
      continue;
    }

    final String line = lines[index];
    if (_noteLineRe.hasMatch(line)) {
      blocks.add(_BriefNoteBlock(line));
      index += 1;
      continue;
    }

    if (_looksLikeClosingQuestion(line, isLast: index == lines.length - 1)) {
      blocks.add(_BriefClosingQuestionBlock(line));
      index += 1;
      continue;
    }

    blocks.add(_BriefParagraphBlock(line));
    index += 1;
  }

  return blocks;
}

bool _looksLikeLeadLine(String line, String? nextLine) {
  final String plain = stripMarkdown(line).trim();
  if (plain.isEmpty || plain.length > 30) return false;
  if (!plain.endsWith("：") && !plain.endsWith(":")) return false;
  return nextLine == null || _tryParseHeading(nextLine) != null;
}

String _cleanLeadText(String line) {
  return line.trim().replaceAll(RegExp(r"[：:]\s*$"), "：");
}

bool _looksLikeStandaloneBlock(String line, {required bool isLast}) {
  return _noteLineRe.hasMatch(line) || _looksLikeClosingQuestion(line, isLast: isLast);
}

bool _looksLikeClosingQuestion(String line, {required bool isLast}) {
  if (!isLast) return false;
  return line.endsWith("？") || line.endsWith("?");
}

_ParsedHeading? _tryParseHeading(String line) {
  final String normalizedLine = _stripHeadingMarkup(line);
  final RegExpMatch? ordered = _orderedItemRe.firstMatch(normalizedLine);
  if (ordered != null) {
    return _buildHeading(ordered.group(1)!, ordered.group(2)!);
  }

  final RegExpMatch? bullet = _bulletItemRe.firstMatch(normalizedLine);
  if (bullet != null) {
    return _buildHeading("•", bullet.group(2)!);
  }

  final RegExpMatch? symbol = _symbolHeadingRe.firstMatch(normalizedLine);
  if (symbol != null) {
    return _buildHeading(symbol.group(1)!, symbol.group(2)!);
  }

  return null;
}

String _stripHeadingMarkup(String line) {
  return line
      .trim()
      .replaceFirst(RegExp(r"^#{1,4}\s*"), "")
      .replaceFirst(RegExp(r"^\*\*"), "")
      .replaceFirst(RegExp(r"\*\*$"), "")
      .trim();
}

_ParsedHeading _buildHeading(String marker, String body) {
  final _HeadlineSplit split = _splitHeadline(body);
  return _ParsedHeading(
    marker: marker,
    title: split.title,
    subtitle: split.subtitle,
  );
}

_HeadlineSplit _splitHeadline(String raw) {
  final String body = raw.trim();
  const List<String> separators = <String>["——", "—", "：", ":"];
  for (final String separator in separators) {
    final int index = body.indexOf(separator);
    if (index <= 0) continue;
    final String left = body.substring(0, index).trim();
    final String right = body.substring(index + separator.length).trim();
    if (left.isEmpty || right.isEmpty) continue;
    if (left.length <= 28) {
      return _HeadlineSplit(title: left, subtitle: right);
    }
  }
  return _HeadlineSplit(title: body, subtitle: "");
}

class _ParsedHeading {
  const _ParsedHeading({
    required this.marker,
    required this.title,
    required this.subtitle,
  });

  final String marker;
  final String title;
  final String subtitle;
}

class _HeadlineSplit {
  const _HeadlineSplit({
    required this.title,
    required this.subtitle,
  });

  final String title;
  final String subtitle;
}
