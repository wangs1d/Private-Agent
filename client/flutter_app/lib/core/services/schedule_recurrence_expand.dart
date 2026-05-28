/// 将服务端日程任务按重复规则展开为日历上各天的本地时刻。
List<DateTime> expandScheduleOccurrences({
  required DateTime anchorLocal,
  required String recurrence,
  required DateTime rangeStartInclusive,
  required DateTime rangeEndExclusive,
}) {
  if (recurrence == "none") {
    if (!anchorLocal.isBefore(rangeStartInclusive) &&
        anchorLocal.isBefore(rangeEndExclusive)) {
      return <DateTime>[anchorLocal];
    }
    return <DateTime>[];
  }

  final List<DateTime> out = <DateTime>[];
  DateTime day = DateTime(
    rangeStartInclusive.year,
    rangeStartInclusive.month,
    rangeStartInclusive.day,
  );
  final DateTime lastDay = DateTime(
    rangeEndExclusive.year,
    rangeEndExclusive.month,
    rangeEndExclusive.day,
  ).subtract(const Duration(days: 1));

  while (!day.isAfter(lastDay)) {
    final DateTime occ = DateTime(
      day.year,
      day.month,
      day.day,
      anchorLocal.hour,
      anchorLocal.minute,
      anchorLocal.second,
      anchorLocal.millisecond,
      anchorLocal.microsecond,
    );
    if (!occ.isBefore(rangeStartInclusive) && occ.isBefore(rangeEndExclusive)) {
      if (recurrence == "daily") {
        out.add(occ);
      } else if (recurrence == "weekly" && day.weekday == anchorLocal.weekday) {
        out.add(occ);
      } else if (recurrence == "yearly" &&
          day.month == anchorLocal.month &&
          day.day == anchorLocal.day) {
        out.add(occ);
      }
    }
    day = day.add(const Duration(days: 1));
  }
  return out;
}

String scheduleOccurrenceEventId(String taskId, DateTime occurrence) {
  return "$taskId@${occurrence.toUtc().toIso8601String()}";
}

/// 从本地事项 id 解析服务端 taskId；纯本地 `se-` 事项返回 null。
String? scheduleServerTaskIdFromEventId(String eventId) {
  if (eventId.startsWith("se-")) return null;
  final int at = eventId.indexOf("@");
  if (at > 0) return eventId.substring(0, at);
  return eventId;
}
