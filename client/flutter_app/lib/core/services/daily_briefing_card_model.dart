/// 今日简报悬浮窗卡片内容模型（纯逻辑，可单测）。
///
/// 服务端 `GET /api/morning-briefing?format=narration` 返回
/// `{ narrationText, briefing }`；本文件把结构化 briefing 组装成
/// WebView 悬浮窗（features/briefing/daily_briefing_window.dart）所需的内容。
class DailyBriefingStat {
  const DailyBriefingStat({required this.count, required this.label});

  final int count;
  final String label;

  Map<String, dynamic> toMap() => <String, dynamic>{
        "count": count,
        "label": label,
      };
}

class DailyBriefingCardContent {
  const DailyBriefingCardContent({
    required this.greeting,
    required this.meta,
    required this.script,
    required this.stats,
  });

  /// 问候语，如「早上好」。
  final String greeting;

  /// 元信息行，如「9月10日 周四 · 阵雨 21~26°C」。
  final String meta;

  /// 口播稿正文（TTS 与卡片共用同一份文本）。
  final String script;

  /// 统计行（最多 3 项，0 值项省略）。
  final List<DailyBriefingStat> stats;

  Map<String, dynamic> toMap() => <String, dynamic>{
        "greeting": greeting,
        "meta": meta,
        "script": script,
        "stats": stats.map((DailyBriefingStat s) => s.toMap()).toList(),
      };
}

const List<String> _kWeekdayLabels = <String>[
  "周一",
  "周二",
  "周三",
  "周四",
  "周五",
  "周六",
  "周日",
];

/// 按小时返回问候语（与悬浮窗顶行「早上好」对齐）。
String dailyBriefingGreeting([DateTime? now]) {
  final int hour = (now ?? DateTime.now()).hour;
  if (hour >= 5 && hour < 12) return "早上好";
  if (hour >= 12 && hour < 18) return "下午好";
  if (hour >= 18 && hour < 23) return "晚上好";
  return "夜深了";
}

/// 「9月10日 周四」日期段。
String dailyBriefingDateLabel(DateTime now) {
  return "${now.month}月${now.day}日 ${_kWeekdayLabels[now.weekday - 1]}";
}

/// 天气段：「阵雨 21~26°C」/「26°C」/ 空串。
String dailyBriefingWeatherLabel(Map<String, dynamic>? weather) {
  if (weather == null) return "";
  final Object? rawCondition = weather["condition"];
  final String condition =
      rawCondition is String ? rawCondition.trim() : "";
  final Object? rawMax = weather["maxC"];
  final Object? rawMin = weather["minC"];
  final Object? rawTemp = weather["temperature"];
  final double? maxC = rawMax is num ? rawMax.toDouble() : null;
  final double? minC = rawMin is num ? rawMin.toDouble() : null;
  final double? tempC = rawTemp is num ? rawTemp.toDouble() : null;

  final String tempPart;
  if (maxC != null && minC != null) {
    tempPart = "${minC.round()}~${maxC.round()}°C";
  } else if (tempC != null) {
    tempPart = "${tempC.round()}°C";
  } else {
    tempPart = "";
  }
  if (condition.isNotEmpty && tempPart.isNotEmpty) {
    return "$condition $tempPart";
  }
  return condition.isNotEmpty ? condition : tempPart;
}

/// 从服务端 briefing JSON 组装悬浮窗卡片内容。
///
/// [narrationText] 为口播稿；缺失时退化为 meta 行本身（保证卡片仍有内容）。
DailyBriefingCardContent buildDailyBriefingCard({
  required Map<String, dynamic> briefing,
  String? narrationText,
  String appellation = "",
  DateTime? now,
}) {
  final DateTime time = now ?? DateTime.now();
  final String dateLabel = dailyBriefingDateLabel(time);
  final Object? rawWeather = briefing["weather"];
  final Map<String, dynamic>? weather =
      rawWeather is Map ? rawWeather.cast<String, dynamic>() : null;
  final String weatherLabel = dailyBriefingWeatherLabel(weather);
  final String meta = weatherLabel.isEmpty
      ? dateLabel
      : "$dateLabel · $weatherLabel";

  int listLen(String key) {
    final Object? raw = briefing[key];
    return raw is List ? raw.length : 0;
  }

  int todoPendingCount() {
    final Object? rawTodo = briefing["todoFollowups"];
    if (rawTodo is! Map) return 0;
    final Object? rawPending = rawTodo["pending"];
    return rawPending is List ? rawPending.length : 0;
  }

  final List<DailyBriefingStat> stats = <DailyBriefingStat>[
    DailyBriefingStat(count: listLen("todaySchedule"), label: "日程"),
    DailyBriefingStat(count: todoPendingCount(), label: "待办"),
    DailyBriefingStat(count: listLen("pendingNotes"), label: "笔记"),
    if (listLen("interestHits") > 0)
      DailyBriefingStat(count: listLen("interestHits"), label: "热搜"),
    if (listLen("upcomingImportantDays") > 0)
      DailyBriefingStat(count: listLen("upcomingImportantDays"), label: "纪念日"),
  ].where((DailyBriefingStat s) => s.count > 0).toList();

  final String script = (narrationText ?? "").trim();
  // 称呼（注册 displayName，如「王先生」）：非空时问候带称呼
  final String trimmedAppellation = appellation.trim();
  final String baseGreeting = dailyBriefingGreeting(time);

  return DailyBriefingCardContent(
    greeting: trimmedAppellation.isEmpty
        ? baseGreeting
        : "$baseGreeting，$trimmedAppellation",
    meta: meta,
    script: script,
    stats: stats,
  );
}
