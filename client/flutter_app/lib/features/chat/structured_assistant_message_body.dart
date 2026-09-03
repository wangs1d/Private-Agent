import "package:flutter/material.dart";

import "../../core/theme/app_typography.dart";
import "content_summary_detail_formatter.dart";

class StructuredAssistantMessageBody extends StatelessWidget {
  const StructuredAssistantMessageBody({
    super.key,
    required this.text,
    required this.cs,
    required this.textTheme,
    this.showCursor = false,
  });

  final String text;
  final ColorScheme cs;
  final TextTheme textTheme;
  final bool showCursor;

  @override
  Widget build(BuildContext context) {
    final String normalized = text.replaceAll("\r\n", "\n").trimRight();
    if (normalized.isEmpty) {
      return showCursor
          ? Text(
              "▍",
              style: textTheme.bodyMedium?.copyWith(
                color: cs.primary,
                height: AppTypography.uiLineHeight,
              ),
            )
          : const SizedBox.shrink();
    }

    final _StructuredMessageParts parts = _splitStructuredMessage(normalized);
    final TextStyle bodyStyle = textTheme.bodyMedium!.copyWith(
      color: cs.onSurface,
      height: AppTypography.bodyLineHeight,
    );

    if (!parts.structured) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          buildInlineMarkdownText(normalized, bodyStyle, cs: cs),
          if (showCursor)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                "▍",
                style: bodyStyle.copyWith(
                  color: cs.primary,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
        ],
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        if (parts.lead.isNotEmpty)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.fromLTRB(10, 7, 10, 7),
            decoration: BoxDecoration(
              color: cs.primaryContainer.withValues(alpha: 0.08),
              borderRadius: BorderRadius.circular(8),
              border: Border(
                left: BorderSide(
                  color: cs.outline.withValues(alpha: 0.38),
                  width: 2.5,
                ),
              ),
            ),
            child: buildInlineMarkdownText(
              parts.lead,
              bodyStyle.copyWith(
                fontWeight: FontWeight.w500,
                color: cs.onSurfaceVariant,
                height: AppTypography.bodyLineHeight,
              ),
              cs: cs,
            ),
          ),
        if (parts.lead.isNotEmpty && parts.body.isNotEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Divider(
              height: 1,
              thickness: 0.8,
              color: cs.outline.withValues(alpha: 0.18),
            ),
          ),
        if (parts.body.isNotEmpty)
          ...formatContentSummaryDetailLines(
            parts.body,
            cs,
            textTheme,
          ),
        if (showCursor)
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text(
              "▍",
              style: bodyStyle.copyWith(
                color: cs.primary,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
      ],
    );
  }
}

class _StructuredMessageParts {
  const _StructuredMessageParts({
    required this.lead,
    required this.body,
    required this.structured,
  });

  final String lead;
  final String body;
  final bool structured;
}

_StructuredMessageParts _splitStructuredMessage(String text) {
  final List<String> lines = text.split("\n");
  final List<String> nonEmpty =
      lines.where((String line) => line.trim().isNotEmpty).toList();
  if (nonEmpty.length < 2) {
    return _StructuredMessageParts(lead: "", body: text, structured: false);
  }

  final int sectionCount =
      nonEmpty.where((String line) => _isSectionLikeLine(line)).length;
  final int listCount =
      nonEmpty.where((String line) => _isListLikeLine(line)).length;
  final int blankLines =
      lines.where((String line) => line.trim().isEmpty).length;
  final bool hasFenceBlock = nonEmpty.any(
    (String line) =>
        line.trimLeft().startsWith("```") || line.trimLeft().startsWith(">"),
  );
  final bool hasTable = nonEmpty.any(isMarkdownTableRow);
  final bool hasSections = sectionCount > 0;
  final bool hasList = listCount > 0;
  final bool likelyStructured = sectionCount >= 2 ||
      listCount >= 3 ||
      (hasSections && hasList) ||
      hasFenceBlock ||
      hasTable ||
      (blankLines >= 2 &&
          text.length >= 220 &&
          (sectionCount >= 1 || listCount >= 2));
  if (!likelyStructured) {
    return _StructuredMessageParts(lead: "", body: text, structured: false);
  }

  final int firstBlank = lines.indexWhere((String line) => line.trim().isEmpty);
  if (firstBlank <= 0) {
    return _StructuredMessageParts(lead: "", body: text, structured: true);
  }

  final String lead = lines.take(firstBlank).join("\n").trim();
  final String body = lines.skip(firstBlank + 1).join("\n").trim();
  final bool keepLead = lead.isNotEmpty &&
      lead.length <= 120 &&
      body.length >= 60 &&
      (sectionCount >= 2 ||
          listCount >= 3 ||
          (hasSections && hasList) ||
          blankLines >= 2);

  return _StructuredMessageParts(
    lead: keepLead ? lead : "",
    body: keepLead ? body : text,
    structured: true,
  );
}

bool _isListLikeLine(String line) {
  final String trimmed = line.trim();
  return RegExp(r"^[-•*→▸‣⁃◦·]\s+").hasMatch(trimmed) ||
      RegExp(r"^\d+[.)]\s+").hasMatch(trimmed);
}

bool _isSectionLikeLine(String line) {
  final String trimmed = line.trim();
  if (trimmed.isEmpty) return false;
  if (RegExp(r"^(#{1,6})\s+").hasMatch(trimmed)) return true;
  if (RegExp(r"^(一|二|三|四|五|六|七|八|九|十)[、.．]").hasMatch(trimmed)) return true;
  if (trimmed.length > 42) return false;
  if (!(trimmed.contains("：") || trimmed.contains(":"))) return false;
  if (trimmed.contains("。")) return false;
  if (_isListLikeLine(trimmed)) return false;
  return true;
}
