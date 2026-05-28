import "dart:convert";

class ContentSummarySectionInfo {
  const ContentSummarySectionInfo({
    required this.title,
    required this.pointCount,
  });

  final String title;
  final int pointCount;

  factory ContentSummarySectionInfo.fromJson(Map<String, dynamic> json) {
    return ContentSummarySectionInfo(
      title: json["title"]?.toString() ?? "",
      pointCount: _asInt(json["pointCount"]),
    );
  }
}

class ContentSummaryDataV2 {
  const ContentSummaryDataV2({
    required this.id,
    required this.category,
    required this.title,
    required this.cardIcon,
    required this.cardLabel,
    required this.briefCount,
    this.detailContent,
    this.sections,
    this.metadata,
  });

  final String id;
  final String category;
  final String title;
  final String cardIcon;
  final String cardLabel;
  final int briefCount;
  final String? detailContent;
  final List<ContentSummarySectionInfo>? sections;
  final Map<String, dynamic>? metadata;

  factory ContentSummaryDataV2.fromJson(Map<String, dynamic> json) {
    final List<dynamic>? rawSections = json["sections"] as List<dynamic>?;
    return ContentSummaryDataV2(
      id: json["id"]?.toString() ?? "",
      category: json["category"]?.toString() ?? "general",
      title: json["title"]?.toString() ?? "",
      cardIcon: json["cardIcon"]?.toString() ?? "☰",
      cardLabel: json["cardLabel"]?.toString() ?? "详情",
      briefCount: _asInt(json["briefCount"]),
      detailContent: json["detailContent"]?.toString(),
      sections: rawSections
          ?.whereType<Map<String, dynamic>>()
          .map(ContentSummarySectionInfo.fromJson)
          .toList(),
      metadata: (json["metadata"] as Map?)?.cast<String, dynamic>(),
    );
  }
}

class ContentSummaryParseResult {
  const ContentSummaryParseResult({
    required this.summary,
    required this.briefText,
    required this.cleanedText,
  });

  final ContentSummaryDataV2? summary;
  final String briefText;
  final String cleanedText;
}

class ContentSummaryParser {
  ContentSummaryParser._();

  static const String startMarker = "[CONTENT_SUMMARY_V2_START]";
  static const String endMarker = "[CONTENT_SUMMARY_V2_END]";
  static final RegExp cardMarker = RegExp(
    r'<details_card\s+ref="([^"]+)"\s*/>',
  );

  static const Map<String, String> categoryLabels = <String, String>{
    "news": "资讯日报",
    "article": "长文详情",
    "search_result": "搜索结果",
    "webpage": "网页内容",
    "document": "文档资料",
    "code": "代码片段",
    "data": "调研报告",
    "list": "清单列表",
    "multi_section": "分类汇总",
    "table": "数据表格",
    "general": "详细内容",
  };

  /// 任务主体文案（优先服务端推断的 cardLabel / subjectLabel，如「科技新闻」「旅游计划」）
  static String taskSubject(ContentSummaryDataV2 summary) {
    final Object? fromMeta = summary.metadata?["subjectLabel"];
    if (fromMeta != null && fromMeta.toString().trim().isNotEmpty) {
      return fromMeta.toString().trim();
    }
    final String fromCard = summary.cardLabel.trim();
    if (fromCard.isNotEmpty && !_legacyGenericLabels.contains(fromCard)) {
      return fromCard;
    }
    return categoryLabels[summary.category] ?? "内容详情";
  }

  static const Set<String> _legacyGenericLabels = <String>{
    "详情",
    "资讯",
    "文章",
    "网页",
    "文档",
    "代码",
    "清单",
    "汇总",
    "数据表",
  };

  @Deprecated("Use taskSubject(summary) for display copy")
  static String categoryLabel(String category, String cardLabel) {
    final String fromCard = cardLabel.trim();
    if (fromCard.isNotEmpty && !_legacyGenericLabels.contains(fromCard)) {
      return fromCard;
    }
    return categoryLabels[category] ?? (fromCard.isNotEmpty ? fromCard : "详情");
  }

  static ContentSummaryParseResult parse(String text) {
    final int startIndex = text.indexOf(startMarker);
    final int endIndex = text.indexOf(endMarker);
    if (startIndex == -1 || endIndex == -1 || endIndex <= startIndex) {
      return ContentSummaryParseResult(
        summary: null,
        briefText: "",
        cleanedText: text,
      );
    }

    try {
      final String jsonStr = text
          .substring(startIndex + startMarker.length, endIndex)
          .trim();
      final Map<String, dynamic> data =
          jsonDecode(jsonStr) as Map<String, dynamic>;
      final ContentSummaryDataV2 summary = ContentSummaryDataV2.fromJson(data);

      final String afterEnd =
          text.substring(endIndex + endMarker.length).trim();
      final RegExpMatch? cardMatch = cardMarker.firstMatch(afterEnd);

      String briefText = "";
      String displayText = afterEnd;
      if (cardMatch != null) {
        briefText = afterEnd.substring(0, cardMatch.start).trim();
        displayText = briefText;
      }

      // 精简区缺失时生成概括性介绍（不复用详情正文结构）
      if (briefText.trim().isEmpty && summary.detailContent?.isNotEmpty == true) {
        briefText = _generateOverviewBrief(summary);
      } else if (briefText.trim().length < 24 &&
          summary.detailContent?.isNotEmpty == true) {
        final String overview = _generateOverviewBrief(summary);
        if (overview.length > briefText.trim().length) {
          briefText = overview;
        }
      }

      return ContentSummaryParseResult(
        summary: summary,
        briefText: briefText,
        cleanedText: displayText,
      );
    } catch (_) {
      return ContentSummaryParseResult(
        summary: null,
        briefText: "",
        cleanedText: text,
      );
    }
  }

  /// 生成概括性介绍（非详情正文摘录）
  static String _generateOverviewBrief(ContentSummaryDataV2 summary) {
    final String? detailContent = summary.detailContent;
    if (detailContent == null || detailContent.trim().isEmpty) {
      return "";
    }

    final String subject = ContentSummaryParser.taskSubject(summary);
    final int wordCount = summary.metadata?["wordCount"] as int? ??
        detailContent.length;
    final List<String> parts = <String>[];

    final String title = summary.title.trim();
    final bool hasHeadline =
        title.isNotEmpty &&
        title.length > 2 &&
        !title.contains("_") &&
        title != subject;

    final String headlineHint =
        hasHeadline ? "（${_truncate(title, 36)}）" : "";

    parts.add("【$subject】全文约 $wordCount 字$headlineHint。以下为概要，完整内容见下方详情卡。");

    if (summary.sections != null && summary.sections!.length > 1) {
      final List<String> titles = summary.sections!
          .map((ContentSummarySectionInfo s) => s.title.trim())
          .where((String t) => t.isNotEmpty)
          .toList();
      if (titles.length <= 4) {
        parts.add("主要涵盖：${titles.join("、")}。");
      } else {
        parts.add(
          "主要涵盖 ${titles.length} 个部分：${titles.take(3).join("、")}等。",
        );
      }
    }

    return parts.join("\n");
  }

  static String _truncate(String text, int maxLen) {
    if (text.length <= maxLen) return text;
    return "${text.substring(0, maxLen - 3)}...";
  }
}

int _asInt(Object? value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? "") ?? 0;
}
