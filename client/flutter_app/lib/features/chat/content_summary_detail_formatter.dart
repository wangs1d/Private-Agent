import "dart:async";
import "package:flutter/gestures.dart";
import "package:flutter/material.dart";
import "package:flutter/services.dart";
import "package:url_launcher/url_launcher.dart";

import "media_thumbnail.dart";

class MarkdownTableCellData {
  const MarkdownTableCellData({
    required this.text,
    this.colspan = 1,
    this.rowspan = 1,
    this.skip = false,
  });

  final String text;
  final int colspan;
  final int rowspan;
  final bool skip;
}

bool isMarkdownTableRow(String line) {
  final String trimmed = line.trim();
  if (!trimmed.contains("|")) return false;
  return parseMarkdownTableCells(trimmed).length >= 2;
}

bool isMarkdownTableSeparator(String line) {
  final String trimmed = line.trim();
  if (!trimmed.contains("|") || !trimmed.contains("-")) return false;
  return RegExp(r"^\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$")
      .hasMatch(trimmed);
}

List<String> parseMarkdownTableCells(String line) {
  String inner = line.trim();
  if (inner.startsWith("|")) inner = inner.substring(1);
  if (inner.endsWith("|")) inner = inner.substring(0, inner.length - 1);
  return inner.split("|").map((String cell) => cell.trim()).toList();
}

MarkdownTableCellData parseMarkdownTableCell(String raw) {
  final String trimmed = raw.trim();
  if (trimmed == "^" || trimmed == "^^") {
    return const MarkdownTableCellData(text: "", skip: true);
  }

  int colspan = 1;
  int rowspan = 1;
  String text = trimmed;

  final RegExp spanPattern = RegExp(
    r"^\{(?:colspan|c)=(\d+)\}(?:\{(?:rowspan|r)=(\d+)\})?\s*",
  );
  final RegExp rowSpanOnly = RegExp(r"^\{(?:rowspan|r)=(\d+)\}\s*");

  RegExpMatch? match = spanPattern.firstMatch(text);
  if (match != null) {
    colspan = int.parse(match.group(1)!);
    if (match.group(2) != null) {
      rowspan = int.parse(match.group(2)!);
    }
    text = text.substring(match.end);
  } else {
    match = rowSpanOnly.firstMatch(text);
    if (match != null) {
      rowspan = int.parse(match.group(1)!);
      text = text.substring(match.end);
    }
  }

  return MarkdownTableCellData(
    text: text,
    colspan: colspan,
    rowspan: rowspan,
  );
}

List<Widget> formatContentSummaryDetailLines(
  String content,
  ColorScheme cs,
  TextTheme textTheme, {
  Map<int, GlobalKey>? sectionKeys,
  List<String>? sectionTitles,
}) {
  final RegExp sectionHeader = RegExp(r"^(一|二|三|四|五|六|七|八|九|十)[、.．]");
  final RegExp markdownHeader = RegExp(r"^(#{1,6})\s+");
  final RegExp listItem = RegExp(r"^[\s]*[-•*→▸‣⁃◦·]\s+");
  final RegExp orderedListItem = RegExp(r"^[\s]*\d+[.)]\s+");

  final List<String> lines = content.split("\n");
  final List<Widget> widgets = <Widget>[];
  int index = 0;

  while (index < lines.length) {
    final String trimmed = lines[index].trim();

    if (trimmed.isEmpty) {
      widgets.add(const SizedBox(height: 6));
      index++;
      continue;
    }

    if (trimmed.startsWith("```")) {
      // 代码块：```lang 可选语言 → 语言头部 + 可复制代码体（分层卡片）
      final String opener = trimmed;
      String? language;
      if (opener.length > 3) {
        final String rest = opener.substring(3).trim();
        final List<String> parts = rest.split(RegExp(r"\s+")).toList()..removeWhere((e) => e.isEmpty);
        language = parts.isEmpty ? null : parts.first;
      }
      final int start = index;
      index++;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        index++;
      }
      if (index < lines.length) index++;
      final String code = lines.sublist(start + 1, index - 1).join("\n");
      widgets.add(
        Padding(
          padding: const EdgeInsets.only(bottom: 10, top: 4),
          child: _CodeBlockWidget(
            code: code,
            language: language,
            cs: cs,
            textTheme: textTheme,
          ),
        ),
      );
      continue;
    }

    if (trimmed.startsWith(">")) {
      final int start = index;
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        index++;
      }
      final String quote = lines
          .sublist(start, index)
          .map((String line) => line.trim().replaceFirst(RegExp(r"^>\s?"), ""))
          .join("\n");
      widgets.add(
        Padding(
          padding: const EdgeInsets.only(bottom: 10, top: 4),
          child: _BlockquoteWidget(text: quote, cs: cs, textTheme: textTheme),
        ),
      );
      continue;
    }

    if (sectionHeader.hasMatch(trimmed) ||
        markdownHeader.hasMatch(trimmed) ||
        _isCompactSectionHeader(trimmed, listItem, orderedListItem)) {
      final String title = markdownHeader.hasMatch(trimmed)
          ? trimmed.replaceFirst(markdownHeader, "").trim()
          : trimmed;
      final int level = _headingLevel(trimmed, markdownHeader, sectionHeader);
      final GlobalKey? key =
          _matchSectionKey(title, sectionTitles, sectionKeys);
      widgets.add(
        Padding(
          key: key,
          padding: EdgeInsets.only(
            top: level == 1 ? 14 : 10,
            bottom: level == 1 ? 7 : 5,
          ),
          child: level == 1
              ? _Level1Heading(
                  title: title,
                  cs: cs,
                  textTheme: textTheme,
                )
              : _Level2Heading(
                  title: title,
                  tertiary: level >= 3,
                  cs: cs,
                  textTheme: textTheme,
                ),
        ),
      );
      index++;
      continue;
    }

    if (listItem.hasMatch(trimmed)) {
      widgets.add(
        Padding(
          padding: const EdgeInsets.only(left: 4, bottom: 5),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text("• ", style: TextStyle(color: cs.onSurfaceVariant)),
              Expanded(
                child: buildInlineMarkdownText(
                  trimmed.replaceFirst(listItem, ""),
                  textTheme.bodyMedium!.copyWith(
                    color: cs.onSurface,
                    height: 1.6,
                  ),
                  cs: cs,
                ),
              ),
            ],
          ),
        ),
      );
      index++;
      continue;
    }

    if (orderedListItem.hasMatch(trimmed)) {
      final String itemText = trimmed.replaceFirst(orderedListItem, "");
      final String marker =
          trimmed.substring(0, trimmed.indexOf(itemText)).trim();
      widgets.add(
        Padding(
          padding: const EdgeInsets.only(left: 4, bottom: 5),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              SizedBox(
                width: 22,
                child:
                    Text(marker, style: TextStyle(color: cs.onSurfaceVariant)),
              ),
              Expanded(
                child: buildInlineMarkdownText(
                  itemText,
                  textTheme.bodyMedium!.copyWith(
                    color: cs.onSurface,
                    height: 1.6,
                  ),
                  cs: cs,
                ),
              ),
            ],
          ),
        ),
      );
      index++;
      continue;
    }

    if (isMarkdownTableRow(trimmed)) {
      final int start = index;
      while (index < lines.length && isMarkdownTableRow(lines[index].trim())) {
        index++;
      }
      widgets.add(
        Padding(
          padding: const EdgeInsets.only(bottom: 12, top: 4),
          child: MarkdownTableWidget(
            lines: lines.sublist(start, index),
            cs: cs,
            textTheme: textTheme,
          ),
        ),
      );
      continue;
    }

    widgets.add(
      Padding(
        padding: const EdgeInsets.only(bottom: 4),
        child: buildInlineMarkdownText(
          trimmed,
          textTheme.bodyMedium!.copyWith(
            color: cs.onSurface,
            height: trimmed.length > 100 ? 1.6 : 1.5,
          ),
          cs: cs,
        ),
      ),
    );
    index++;
  }

  return widgets;
}

bool _isCompactSectionHeader(
  String line,
  RegExp listItem,
  RegExp orderedListItem,
) {
  if (line.length < 4 || line.length > 42) return false;
  if (!(line.contains("：") || line.contains(":"))) return false;
  if (line.contains("。")) return false;
  if (listItem.hasMatch(line) || orderedListItem.hasMatch(line)) return false;
  if (line.startsWith(">") || line.startsWith("```")) return false;
  return true;
}

/// 标题层级判定（用于视觉层级区分）：
///   level 1：# / ## / 一、二、三、 → 大标题（左侧强调条）
///   level 2：### / #### / 「标题：」短行 → 次级标题
///   level 3：#####+ → 三级标题（弱化显示）
int _headingLevel(
  String line,
  RegExp markdownHeader,
  RegExp sectionHeader,
) {
  final RegExpMatch? md = markdownHeader.firstMatch(line);
  if (md != null) {
    final int hashCount = md.group(1)!.length;
    if (hashCount <= 2) return 1;
    if (hashCount <= 4) return 2;
    return 3;
  }
  if (sectionHeader.hasMatch(line)) return 1;
  return 2;
}

/// 一级标题：左侧强调条 + 更大字重（对应「一、」「# / ##」）。
class _Level1Heading extends StatelessWidget {
  const _Level1Heading({
    required this.title,
    required this.cs,
    required this.textTheme,
  });

  final String title;
  final ColorScheme cs;
  final TextTheme textTheme;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.only(left: 9, top: 3, bottom: 3),
      decoration: BoxDecoration(
        border: Border(
          left: BorderSide(
            color: cs.primary.withValues(alpha: 0.55),
            width: 3,
          ),
        ),
        color: cs.primaryContainer.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(6),
      ),
      child: buildInlineMarkdownText(
        title,
        textTheme.titleMedium!.copyWith(
          color: cs.onSurface,
          fontWeight: FontWeight.w800,
          height: 1.3,
          letterSpacing: -0.2,
        ),
        cs: cs,
      ),
    );
  }
}

/// 二级/三级标题：次级字号，三级弱化为 onSurfaceVariant。
class _Level2Heading extends StatelessWidget {
  const _Level2Heading({
    required this.title,
    required this.tertiary,
    required this.cs,
    required this.textTheme,
  });

  final String title;
  final bool tertiary;
  final ColorScheme cs;
  final TextTheme textTheme;

  @override
  Widget build(BuildContext context) {
    return buildInlineMarkdownText(
      title,
      textTheme.titleSmall!.copyWith(
        color: tertiary ? cs.onSurfaceVariant : cs.onSurface,
        fontWeight: FontWeight.w700,
        height: 1.35,
      ),
      cs: cs,
    );
  }
}

GlobalKey? _matchSectionKey(
  String title,
  List<String>? sectionTitles,
  Map<int, GlobalKey>? sectionKeys,
) {
  if (sectionTitles == null || sectionKeys == null) return null;
  for (int i = 0; i < sectionTitles.length; i++) {
    final String sectionTitle = sectionTitles[i].trim();
    if (title.contains(sectionTitle) || sectionTitle.contains(title)) {
      return sectionKeys[i];
    }
  }
  return null;
}

Widget buildInlineMarkdownText(
  String text,
  TextStyle baseStyle, {
  required ColorScheme cs,
}) {
  final List<InlineSpan> spans = parseInlineMarkdownSpans(text, baseStyle, cs);
  if (spans.length == 1 && spans.first is TextSpan) {
    final TextSpan only = spans.first as TextSpan;
    if (only.style == baseStyle && only.recognizer == null) {
      return Text(only.text ?? "", style: baseStyle);
    }
  }
  return Text.rich(TextSpan(style: baseStyle, children: spans));
}

List<InlineSpan> parseInlineMarkdownSpans(
  String text,
  TextStyle baseStyle,
  ColorScheme cs,
) {
  final RegExp tokenPattern = RegExp(
    r"(!\[[^\]]*\]\([^)]+\)|\*\*.+?\*\*|~~.+?~~|`[^`]+`|\[[^\]]+\]\([^)]+\)|(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|_(.+?)_)",
  );

  if (!tokenPattern.hasMatch(text)) {
    return _parsePlainLinks(text, baseStyle, cs);
  }

  final List<InlineSpan> spans = <InlineSpan>[];
  int cursor = 0;

  for (final RegExpMatch match in tokenPattern.allMatches(text)) {
    if (match.start > cursor) {
      spans.addAll(
        _parsePlainLinks(text.substring(cursor, match.start), baseStyle, cs),
      );
    }

    final String token = match.group(0)!;
    if (token.startsWith("**") && token.endsWith("**")) {
      spans.add(
        TextSpan(
          text: token.substring(2, token.length - 2),
          style: baseStyle.copyWith(fontWeight: FontWeight.w700),
        ),
      );
    } else if (token.startsWith("~~") && token.endsWith("~~")) {
      spans.add(
        TextSpan(
          text: token.substring(2, token.length - 2),
          style: baseStyle.copyWith(
            decoration: TextDecoration.lineThrough,
            color: cs.onSurfaceVariant,
          ),
        ),
      );
    } else if (token.startsWith("`") && token.endsWith("`")) {
      spans.add(
        TextSpan(
          text: token.substring(1, token.length - 1),
          style: baseStyle.copyWith(
            fontFamily: "monospace",
            fontSize: (baseStyle.fontSize ?? 14) - 1,
            backgroundColor: cs.surfaceContainerHighest.withValues(alpha: 0.65),
          ),
        ),
      );
    } else if (token.startsWith("![")) {
      // markdown 图片: ![alt](url) → 渲染为内嵌网络图片缩略图，点击打开原图
      final RegExp imgPattern = RegExp(r"^!\[(.+?)\]\((.+?)\)$");
      final RegExpMatch? imgMatch = imgPattern.firstMatch(token);
      if (imgMatch != null) {
        final String url = imgMatch.group(2)!;
        spans.add(
          WidgetSpan(
            alignment: PlaceholderAlignment.top,
            child: _InlineImage(url: url, cs: cs),
          ),
        );
      } else {
        spans.add(TextSpan(text: token));
      }
    } else if (token.startsWith("[")) {
      // markdown 链接: [text](url) → 渲染为文字链接
      final RegExp linkPattern = RegExp(r"^\[(.+?)\]\((.+?)\)$");
      final RegExpMatch? linkMatch = linkPattern.firstMatch(token);
      if (linkMatch != null) {
        final String label = linkMatch.group(1)!;
        final String url = linkMatch.group(2)!;
        spans.add(
          TextSpan(
            text: label,
            style: baseStyle.copyWith(
              color: cs.primary,
              fontWeight: FontWeight.w700,
            ),
            recognizer: TapGestureRecognizer()
              ..onTap = () => launchUrlFromText(url),
          ),
        );
      } else {
        spans.add(TextSpan(text: token));
      }
    } else {
      final String? italic = match.group(2) ?? match.group(3);
      spans.add(
        TextSpan(
          text: italic ?? token,
          style: baseStyle.copyWith(fontStyle: FontStyle.italic),
        ),
      );
    }

    cursor = match.end;
  }

  if (cursor < text.length) {
    spans.add(TextSpan(text: text.substring(cursor)));
  }

  return spans;
}

/// 把纯文本段中的裸 URL（未被 markdown 包裹的 http/https 地址）
/// 转成可点击的文字链接：显示域名、主色加粗、点击打开外部浏览器，
/// 避免一长串原始地址直接暴露在正文里。
List<InlineSpan> _parsePlainLinks(
  String text,
  TextStyle baseStyle,
  ColorScheme cs,
) {
  final RegExp urlRe = RegExp(r'https?://[^\s]+');
  if (!urlRe.hasMatch(text)) {
    return <InlineSpan>[TextSpan(text: text)];
  }

  final List<InlineSpan> spans = <InlineSpan>[];
  int cursor = 0;
  for (final RegExpMatch m in urlRe.allMatches(text)) {
    if (m.start > cursor) {
      spans.add(TextSpan(text: text.substring(cursor, m.start)));
    }
    final String raw = m.group(0)!;
    final String url = raw.replaceAll(RegExp(r'[),.;，。！？、]+$'), '');
    if (url.isEmpty) continue;
    if (_isImageUrl(url)) {
      // 裸图片 URL → 直接渲染为网络图片缩略图
      spans.add(
        WidgetSpan(
          alignment: PlaceholderAlignment.top,
          child: _InlineImage(url: url, cs: cs),
        ),
      );
    } else {
      spans.add(
        TextSpan(
          text: _linkLabel(url),
          style: baseStyle.copyWith(
            color: cs.primary,
            fontWeight: FontWeight.w700,
          ),
          recognizer: TapGestureRecognizer()
            ..onTap = () => launchUrlFromText(url),
        ),
      );
    }
    cursor = m.end;
  }
  if (cursor < text.length) {
    spans.add(TextSpan(text: text.substring(cursor)));
  }
  return spans;
}

/// 从 URL 生成简短文字标签：取域名并去掉 www，作为文字链接的显示文本。
String _linkLabel(String url) {
  final Uri? uri = Uri.tryParse(url);
  final String host = (uri == null || uri.host.isEmpty) ? url : uri.host;
  final String clean = host.replaceFirst(RegExp(r'^www\.'), '');
  return clean.isEmpty ? url : clean;
}

/// 判断 URL 是否指向图片资源（按扩展名）。
bool _isImageUrl(String url) {
  return RegExp(
    r'\.(jpe?g|png|gif|webp|bmp|svg|avif|heic)(\?|#|$)',
    caseSensitive: false,
  ).hasMatch(url);
}

Future<void> launchUrlFromText(String url) async {
  final Uri? uri = Uri.tryParse(url);
  if (uri == null) return;
  await launchUrl(uri, mode: LaunchMode.externalApplication);
}

class _CodeBlockWidget extends StatefulWidget {
  const _CodeBlockWidget({
    required this.code,
    required this.language,
    required this.cs,
    required this.textTheme,
  });

  final String code;
  final String? language;
  final ColorScheme cs;
  final TextTheme textTheme;

  @override
  State<_CodeBlockWidget> createState() => _CodeBlockWidgetState();
}

class _CodeBlockWidgetState extends State<_CodeBlockWidget> {
  bool _copied = false;
  Timer? _resetTimer;

  @override
  void dispose() {
    _resetTimer?.cancel();
    super.dispose();
  }

  Future<void> _copyCode() async {
    await Clipboard.setData(ClipboardData(text: widget.code));
    if (!mounted) return;
    setState(() => _copied = true);
    _resetTimer?.cancel();
    _resetTimer = Timer(const Duration(milliseconds: 1600), () {
      if (mounted) setState(() => _copied = false);
    });
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = widget.cs;
    final TextTheme textTheme = widget.textTheme;
    final bool hasLanguage =
        (widget.language ?? "").isNotEmpty;

    return DecoratedBox(
      decoration: BoxDecoration(
        color: cs.surfaceContainerHighest.withValues(alpha: 0.35),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: cs.outline.withValues(alpha: 0.18)),
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            // 头部：语言徽标 + 复制按钮
            Container(
              padding: const EdgeInsets.only(left: 12, right: 4),
              height: 34,
              decoration: BoxDecoration(
                color: cs.surfaceContainerHighest.withValues(alpha: 0.75),
                border: Border(
                  bottom: BorderSide(
                    color: cs.outline.withValues(alpha: 0.14),
                  ),
                ),
              ),
              child: Row(
                children: <Widget>[
                  Icon(
                    Icons.code_rounded,
                    size: 13,
                    color: cs.onSurfaceVariant,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      hasLanguage ? widget.language! : "代码",
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: textTheme.labelSmall?.copyWith(
                            color: cs.onSurfaceVariant,
                            fontWeight: FontWeight.w600,
                            letterSpacing: 0.3,
                          ) ??
                          const TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w600,
                            letterSpacing: 0.3,
                          ),
                    ),
                  ),
                  TextButton.icon(
                    onPressed: _copyCode,
                    style: TextButton.styleFrom(
                      visualDensity: VisualDensity.compact,
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      minimumSize: const Size(0, 28),
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                    ),
                    icon: Icon(
                      _copied ? Icons.check_rounded : Icons.copy_rounded,
                      size: 13,
                      color: _copied ? Colors.greenAccent : cs.primary,
                    ),
                    label: Text(
                      _copied ? "已复制" : "复制",
                      style: textTheme.labelSmall?.copyWith(
                            color: _copied
                                ? Colors.greenAccent
                                : cs.primary,
                            fontWeight: FontWeight.w600,
                          ) ??
                          TextStyle(
                            fontSize: 11,
                            color: _copied
                                ? Colors.greenAccent
                                : cs.primary,
                            fontWeight: FontWeight.w600,
                          ),
                    ),
                  ),
                ],
              ),
            ),
            // 代码体
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              child: SelectableText(
                widget.code,
                style: textTheme.bodySmall!.copyWith(
                  fontFamily: "monospace",
                  height: 1.5,
                  color: cs.onSurface,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _BlockquoteWidget extends StatelessWidget {
  const _BlockquoteWidget({
    required this.text,
    required this.cs,
    required this.textTheme,
  });

  final String text;
  final ColorScheme cs;
  final TextTheme textTheme;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        border: Border(
          left: BorderSide(color: cs.primary.withValues(alpha: 0.45), width: 3),
        ),
        color: cs.primaryContainer.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
        child: buildInlineMarkdownText(
          text,
          textTheme.bodyMedium!.copyWith(
            color: cs.onSurfaceVariant,
            height: 1.6,
          ),
          cs: cs,
        ),
      ),
    );
  }
}

class MarkdownTableWidget extends StatelessWidget {
  const MarkdownTableWidget({
    super.key,
    required this.lines,
    required this.cs,
    required this.textTheme,
  });

  final List<String> lines;
  final ColorScheme cs;
  final TextTheme textTheme;

  @override
  Widget build(BuildContext context) {
    final List<List<MarkdownTableCellData>> parsedRows = lines
        .map((String line) => parseMarkdownTableCells(line.trim())
            .map(parseMarkdownTableCell)
            .toList())
        .where((List<MarkdownTableCellData> cells) => cells.isNotEmpty)
        .toList();

    if (parsedRows.isEmpty) return const SizedBox.shrink();

    List<MarkdownTableCellData>? headerCells;
    List<List<MarkdownTableCellData>> bodyRows = parsedRows;

    if (parsedRows.length >= 2 && isMarkdownTableSeparator(lines[1].trim())) {
      headerCells = parsedRows.first;
      bodyRows = parsedRows.skip(2).toList();
    }

    final List<List<MarkdownTableCellData>> allRows =
        <List<MarkdownTableCellData>>[
      if (headerCells != null) headerCells,
      ...bodyRows,
    ];

    int columnCount = allRows.fold<int>(
      0,
      (int max, List<MarkdownTableCellData> row) {
        int count = 0;
        for (final MarkdownTableCellData cell in row) {
          if (!cell.skip) count += cell.colspan;
        }
        return count > max ? count : max;
      },
    );
    // Cap columnCount to prevent unbounded layout overflow from malformed markdown tables.
    columnCount = columnCount.clamp(0, 20);

    final List<List<bool>> occupied = List<List<bool>>.generate(
      allRows.length + 4,
      (_) => List<bool>.filled(columnCount + 4, false),
    );

    final List<Widget> tableRows = <Widget>[];

    for (int rowIndex = 0; rowIndex < allRows.length; rowIndex++) {
      final List<MarkdownTableCellData> row = allRows[rowIndex];
      final bool isHeader = headerCells != null && rowIndex == 0;
      final List<Widget> cells = <Widget>[];
      int colIndex = 0;

      for (final MarkdownTableCellData cell in row) {
        while (colIndex < columnCount && occupied[rowIndex][colIndex]) {
          colIndex++;
        }
        if (colIndex >= columnCount) break;

        if (cell.skip) {
          continue;
        }

        for (int r = 0; r < cell.rowspan; r++) {
          for (int c = 0; c < cell.colspan; c++) {
            occupied[rowIndex + r][colIndex + c] = true;
          }
        }

        final TextStyle cellStyle = textTheme.bodySmall!.copyWith(
          color: cs.onSurface,
          height: 1.45,
          fontWeight: isHeader ? FontWeight.w700 : FontWeight.w400,
        );

        cells.add(
          Expanded(
            flex: cell.colspan,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              decoration: BoxDecoration(
                color: isHeader
                    ? cs.primaryContainer.withValues(alpha: 0.28)
                    : null,
                border: Border.all(color: cs.outline.withValues(alpha: 0.14)),
              ),
              child: buildInlineMarkdownText(
                cell.text,
                isHeader ? cellStyle.copyWith(color: cs.primary) : cellStyle,
                cs: cs,
              ),
            ),
          ),
        );

        colIndex += cell.colspan;
      }

      tableRows.add(IntrinsicHeight(
          child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: cells)));
    }

    return DecoratedBox(
      decoration: BoxDecoration(
        color: cs.surfaceContainerLow.withValues(alpha: 0.35),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: cs.outline.withValues(alpha: 0.16)),
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(10),
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: ConstrainedBox(
            constraints:
                BoxConstraints(minWidth: 280, maxWidth: columnCount * 140.0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: tableRows,
            ),
          ),
        ),
      ),
    );
  }
}

/// markdown 图片内嵌组件：渲染网络图片缩略图，点击打开原图。
/// 由 [parseInlineMarkdownSpans] 中的 `![alt](url)` 语法触发。
class _InlineImage extends StatelessWidget {
  const _InlineImage({
    required this.url,
    required this.cs,
  });

  final String url;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: GestureDetector(
        onTap: () => launchUrlFromText(url),
        child: MediaThumbnail(
          url: url,
          cs: cs,
          width: 220,
          height: 150,
          borderRadius: 8,
        ),
      ),
    );
  }
}
