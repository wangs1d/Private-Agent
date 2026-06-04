import "package:flutter/gestures.dart";
import "package:flutter/material.dart";
import "package:url_launcher/url_launcher.dart";

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
  return RegExp(r"^\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$").hasMatch(trimmed);
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
      final int start = index;
      index++;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        index++;
      }
      if (index < lines.length) index++;
      final String code = lines
          .sublist(start + 1, index - 1)
          .join("\n");
      widgets.add(
        Padding(
          padding: const EdgeInsets.only(bottom: 10, top: 4),
          child: _CodeBlockWidget(code: code, cs: cs, textTheme: textTheme),
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

    if (sectionHeader.hasMatch(trimmed) || markdownHeader.hasMatch(trimmed)) {
      final String title = markdownHeader.hasMatch(trimmed)
          ? trimmed.replaceFirst(markdownHeader, "").trim()
          : trimmed;
      final GlobalKey? key = _matchSectionKey(title, sectionTitles, sectionKeys);
      widgets.add(
        Padding(
          key: key,
          padding: const EdgeInsets.only(top: 10, bottom: 6),
          child: buildInlineMarkdownText(
            title,
            textTheme.titleSmall!.copyWith(
              color: cs.onSurface,
              fontWeight: FontWeight.w700,
            ),
            cs: cs,
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
                child: Text(marker, style: TextStyle(color: cs.onSurfaceVariant)),
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
    r"(\*\*.+?\*\*|~~.+?~~|`[^`]+`|\[[^\]]+\]\([^)]+\)|(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|_(.+?)_)",
  );

  if (!tokenPattern.hasMatch(text)) {
    return <InlineSpan>[TextSpan(text: text)];
  }

  final List<InlineSpan> spans = <InlineSpan>[];
  int cursor = 0;

  for (final RegExpMatch match in tokenPattern.allMatches(text)) {
    if (match.start > cursor) {
      spans.add(TextSpan(text: text.substring(cursor, match.start)));
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
            backgroundColor: cs.surfaceContainerHighest.withOpacity(0.65),
          ),
        ),
      );
    } else if (token.startsWith("[")) {
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
              decoration: TextDecoration.underline,
            ),
            recognizer: TapGestureRecognizer()
              ..onTap = () => _launchUrl(url),
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

Future<void> _launchUrl(String url) async {
  final Uri? uri = Uri.tryParse(url);
  if (uri == null) return;
  await launchUrl(uri, mode: LaunchMode.externalApplication);
}

class _CodeBlockWidget extends StatelessWidget {
  const _CodeBlockWidget({
    required this.code,
    required this.cs,
    required this.textTheme,
  });

  final String code;
  final ColorScheme cs;
  final TextTheme textTheme;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: cs.surfaceContainerHighest.withOpacity(0.55),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: cs.outline.withOpacity(0.18)),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: SelectableText(
          code,
          style: textTheme.bodySmall!.copyWith(
            fontFamily: "monospace",
            height: 1.5,
            color: cs.onSurface,
          ),
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
          left: BorderSide(color: cs.primary.withOpacity(0.45), width: 3),
        ),
        color: cs.primaryContainer.withOpacity(0.12),
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

    final List<List<MarkdownTableCellData>> allRows = <List<MarkdownTableCellData>>[
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
                    ? cs.primaryContainer.withOpacity(0.28)
                    : null,
                border: Border.all(color: cs.outline.withOpacity(0.14)),
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

      tableRows.add(IntrinsicHeight(child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: cells)));
    }

    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: cs.outline.withOpacity(0.22)),
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(10),
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: ConstrainedBox(
            constraints: BoxConstraints(minWidth: 280, maxWidth: columnCount * 140.0),
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
