import "dart:convert";
import "dart:io";

import "package:file_picker/file_picker.dart";

import "travel_plan_models.dart";

/// 行程导出 —— 移植自 3D-Travel 的 TravelUtilityToolkit.exportItinerary
/// （JSON / TXT / ICS 日历三种格式；桌面端经系统「另存为」对话框落盘）。
class TravelExportUtil {
  TravelExportUtil._();

  /// 导出行程。format: json / text / calendar。
  /// 返回给用户的提示文案；取消保存返回 null。
  static Future<String?> exportItinerary(TravelPlanData plan, String format) async {
    final String? path = await FilePicker.platform.saveFile(
      dialogTitle: "导出行程",
      fileName: "itinerary-${DateTime.now().millisecondsSinceEpoch}.${_extOf(format)}",
      type: FileType.custom,
      allowedExtensions: <String>[_extOf(format)],
    );
    if (path == null || path.isEmpty) return null;
    final String content = switch (format) {
      "json" => _buildExportJson(plan),
      "calendar" => _formatAsICS(plan),
      _ => _formatAsText(plan),
    };
    await File(path).writeAsString(content, flush: true);
    return switch (format) {
      "json" => "JSON 格式已保存",
      "calendar" => "日历文件已保存（可导入 Google/Apple 日历）",
      _ => "文本格式已保存",
    };
  }

  static String _extOf(String format) =>
      format == "json" ? "json" : (format == "calendar" ? "ics" : "txt");

  static String _buildExportJson(TravelPlanData plan) {
    final Map<String, dynamic> exportData = <String, dynamic>{
      "title": plan.title.isEmpty ? "我的行程" : plan.title,
      "destination": plan.destination,
      "dateRange": "${plan.startDate} ~ ${plan.endDate}",
      "exportedAt": DateTime.now().toIso8601String(),
      "days": <Map<String, dynamic>>[
        for (int i = 0; i < plan.days.length; i++)
          <String, dynamic>{
            "dayNumber": i + 1,
            "date": plan.days[i].date,
            "items": <Map<String, dynamic>>[
              for (final TravelDayEntry item in plan.days[i].entries)
                <String, dynamic>{
                  "time": item.time.isEmpty ? "--:--" : item.time,
                  "name": item.title,
                  "type": item.type,
                  "address": item.address,
                  "priceInfo": item.priceInfo,
                  "notes": item.description.length > 100
                      ? item.description.substring(0, 100)
                      : item.description,
                },
            ],
          },
      ],
    };
    return const JsonEncoder.withIndent("  ").convert(exportData);
  }

  static String _formatAsText(TravelPlanData plan) {
    final StringBuffer text = StringBuffer();
    text.writeln(plan.title.isEmpty ? "我的行程" : plan.title);
    text.writeln("=" * 40);
    text.writeln("目的地: ${plan.destination}");
    text.writeln(
        "日期: ${plan.startDate} ~ ${plan.endDate}");
    text.writeln("导出时间: ${DateTime.now().toLocal()}");
    for (int i = 0; i < plan.days.length; i++) {
      final TravelPlanDay day = plan.days[i];
      text.writeln();
      text.writeln("--- Day ${i + 1} (${day.date}) ---");
      for (final TravelDayEntry item in day.entries) {
        text.writeln("[${item.time.isEmpty ? "--:--" : item.time}] "
            "${item.title} (${item.type})");
        if (item.address.isNotEmpty) text.writeln("   📍 ${item.address}");
        if (item.priceInfo.isNotEmpty) text.writeln("   💰 ${item.priceInfo}");
        if (item.description.isNotEmpty) text.writeln("   📝 ${item.description}");
      }
    }
    text.writeln();
    text.writeln("=" * 40);
    text.write("由 Private-Agent 智能生成");
    return text.toString();
  }

  static String _formatAsICS(TravelPlanData plan) {
    final StringBuffer ics = StringBuffer();
    ics.writeln("BEGIN:VCALENDAR");
    ics.writeln("VERSION:2.0");
    ics.writeln("PRODID:-//Private-Agent Travel Planner//CN");
    ics.writeln("CALSCALE:GREGORIAN");
    ics.writeln("METHOD:PUBLISH");
    for (int i = 0; i < plan.days.length; i++) {
      final TravelPlanDay day = plan.days[i];
      if (day.date.isEmpty) continue;
      for (final TravelDayEntry item in day.entries) {
        final String time =
            item.time.replaceAll(RegExp(r"[^0-9]"), "").padRight(4, "0").substring(0, 4);
        final String dtstart = "${day.date.replaceAll("-", "")}T${time}00";
        ics.writeln("BEGIN:VEVENT");
        ics.writeln("DTSTART:$dtstart");
        ics.writeln("DTEND:$dtstart"); // 与原版一致：简化处理
        ics.writeln("SUMMARY:${item.title}");
        ics.writeln("DESCRIPTION:${item.address}\\n${item.description}");
        ics.writeln("LOCATION:${item.address}");
        ics.writeln("END:VEVENT");
      }
    }
    ics.writeln("END:VCALENDAR");
    return ics.toString();
  }
}
