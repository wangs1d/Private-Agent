import "../db/isar_local_history_store.dart";
import "../models/schedule_models.dart";
import "schedule_api_client.dart";
import "schedule_offline_delete_queue.dart";
import "schedule_recurrence_expand.dart";

const Set<String> _scheduleReminderTools = <String>{
  "reminder.plan",
  "calendar.create_from_text",
  "calendar.create_task",
  "reminder_plan",
  "calendar_create_from_text",
  "calendar_create_task",
};

/// 服务端节律任务标记（与 server/src/services/schedule-task-service.ts 的 RHYTHM_MARK 对应）。
/// 仅作为旧数据兜底：新任务由 category=trivia 识别。
const String kRhythmTaskMark = "[节律提醒:";

/// 琐事提醒（喝水/睡觉等）：照常到点推送，但不进「今日安排」紧凑列表。
bool _isTriviaTask(Map<String, dynamic> task) {
  final String category = task["category"]?.toString() ?? "";
  if (category == "trivia") return true;
  final String description = task["description"]?.toString() ?? "";
  return description.startsWith(kRhythmTaskMark);
}

bool isScheduleReminderToolName(String toolName) {
  final String n = toolName.trim();
  if (_scheduleReminderTools.contains(n)) return true;
  return _scheduleReminderTools.contains(n.replaceAll("_", "."));
}

Future<bool> upsertLocalScheduleFromToolResult(
  IsarLocalHistoryStore store,
  String toolName,
  Map<String, dynamic>? result,
) async {
  try {
    if (result == null || result["ok"] != true) return false;
    if (!isScheduleReminderToolName(toolName)) return false;
    if (result["matched"] == false) return false;
    if (result["needsRecurrenceConfirm"] == true) return false;

    final String? taskId = result["taskId"]?.toString().trim();
    final String? nextRunAt =
        result["nextRunAt"]?.toString() ?? result["runAt"]?.toString();
    if (taskId == null ||
        taskId.isEmpty ||
        nextRunAt == null ||
        nextRunAt.isEmpty) {
      return false;
    }

    final DateTime? startAt = DateTime.tryParse(nextRunAt);
    if (startAt == null) return false;

    final String recurrence = result["recurrence"]?.toString() ?? "none";
    final DateTime now = DateTime.now();
    final DateTime rangeStart = DateTime(now.year, now.month, now.day);
    final DateTime rangeEnd = rangeStart.add(const Duration(days: 14));

    return _persistExpandedTask(
      store,
      taskId: taskId,
      anchorLocal: startAt.toLocal(),
      recurrence: recurrence,
      rangeStart: rangeStart,
      rangeEnd: rangeEnd,
      title: _pickTitle(result),
      shortTitle: _pickShortTitle(result),
      notes: _buildNotes(result),
      isTrivia: _isTriviaTask(result),
    );
  } catch (_) {
    return false;
  }
}

Future<bool> removeLocalScheduleForDeletedTask(
  IsarLocalHistoryStore store,
  String taskId,
) async {
  final String id = taskId.trim();
  if (id.isEmpty) return false;
  await store.hideScheduleTask(id);
  await store.deleteScheduleEventsForTask(id);
  await store.dequeuePendingScheduleDelete(id);
  return true;
}

Future<int> syncServerRemindersToLocal(
  IsarLocalHistoryStore store,
  ScheduleApiClient api,
  String sessionId, {
  DateTime? rangeStart,
  DateTime? rangeEnd,
}) async {
  try {
    final DateTime start = rangeStart ??
        DateTime(DateTime.now().year, DateTime.now().month, DateTime.now().day)
            .subtract(const Duration(days: 1));
    final DateTime end = rangeEnd ?? start.add(const Duration(days: 14));

    final ScheduleApiResult<List<Map<String, dynamic>>> listResult =
        await api.listScheduleTasksResult(sessionId, from: start, to: end);
    if (!listResult.ok) {
      return 0;
    }

    await flushScheduleOfflineDeleteQueue(store, api);

    final List<ScheduleEvent> localOnlyEvents = (await store
            .listAllScheduleEvents())
        .where(
            (ScheduleEvent e) => scheduleServerTaskIdFromEventId(e.id) == null)
        .toList();

    await store.clearAllScheduleEvents();

    final List<Map<String, dynamic>> tasks =
        listResult.value ?? <Map<String, dynamic>>[];
    final Set<String> hidden = await store.getHiddenScheduleTaskIds();
    int n = 0;
    for (final Map<String, dynamic> t in tasks) {
      try {
        final String? taskId = t["taskId"]?.toString().trim();
        final String? runAtIso =
            t["nextRunAt"]?.toString() ?? t["runAt"]?.toString();
        if (taskId == null ||
            taskId.isEmpty ||
            runAtIso == null ||
            runAtIso.isEmpty) {
          continue;
        }
        if (hidden.contains(taskId)) continue;
        final DateTime? anchor = DateTime.tryParse(runAtIso);
        if (anchor == null) continue;
        final String recurrence = t["recurrence"]?.toString() ?? "none";
        n += await _persistExpandedTask(
          store,
          taskId: taskId,
          anchorLocal: anchor.toLocal(),
          recurrence: recurrence,
          rangeStart: start,
          rangeEnd: end,
          title: _pickTitle(t),
          shortTitle: _pickShortTitle(t),
          notes: _buildNotes(t),
          isTrivia: _isTriviaTask(t),
        )
            ? 1
            : 0;
      } catch (_) {
        continue;
      }
    }

    for (final ScheduleEvent local in localOnlyEvents) {
      await store.saveScheduleEvent(local);
      n += 1;
    }
    return n;
  } catch (_) {
    return 0;
  }
}

Future<bool> _persistExpandedTask(
  IsarLocalHistoryStore store, {
  required String taskId,
  required DateTime anchorLocal,
  required String recurrence,
  required DateTime rangeStart,
  required DateTime rangeEnd,
  required String title,
  required String? shortTitle,
  required String? notes,
  bool isTrivia = false,
}) async {
  final List<DateTime> occurrences = expandScheduleOccurrences(
    anchorLocal: anchorLocal,
    recurrence: recurrence,
    rangeStartInclusive: rangeStart,
    rangeEndExclusive: rangeEnd,
  );
  if (occurrences.isEmpty) return false;

  await store.deleteScheduleEvent(taskId);
  for (final DateTime occ in occurrences) {
    await store.saveScheduleEvent(
      ScheduleEvent(
        id: scheduleOccurrenceEventId(taskId, occ),
        startAt: occ,
        title: title,
        shortTitle: shortTitle,
        notes: notes,
        isTrivia: isTrivia,
      ),
    );
  }
  return true;
}

/// 简洁展示标题（「今日安排」紧凑列表用，创建时由 LLM 生成）。
String? _pickShortTitle(Map<String, dynamic> result) {
  final String shortTitle = result["shortTitle"]?.toString().trim() ?? "";
  if (shortTitle.isNotEmpty) return shortTitle;
  // 旧数据无 shortTitle：仅在能确定得到干净短标题时兜底，否则交给展示端剥离简化
  final String title = result["title"]?.toString().trim() ?? "";
  if (title.isNotEmpty && title != "AI 提醒任务") {
    final String simplified = _displayReminderTitle(title);
    if (simplified != title && simplified != "定时提醒") return simplified;
  }
  return null;
}

String _pickTitle(Map<String, dynamic> result) {
  final String title = result["title"]?.toString().trim() ?? "";
  if (title.isNotEmpty && title != "AI 提醒任务") {
    return _displayReminderTitle(title);
  }
  final String msg = result["reminderMessage"]?.toString().trim() ?? "";
  if (msg.isNotEmpty) return _displayReminderTitle(msg);
  return "定时提醒";
}

String _displayReminderTitle(String raw) {
  final String s = raw.trim();
  if (s.isEmpty) return "定时提醒";
  if (RegExp(r"叫我起床|喊我起床").hasMatch(s)) return "起床提醒";
  if (s == "叫我" || s == "喊我") return "起床提醒";
  if (RegExp(r"吃药").hasMatch(s)) return "吃药提醒";
  return s;
}

String? _buildNotes(Map<String, dynamic> result) {
  final String recurrence = result["recurrence"]?.toString() ?? "none";
  final String recurrenceLabel = switch (recurrence) {
    "daily" => "每天重复",
    "weekly" => "每周重复",
    "yearly" => "每年重复",
    _ => "单次提醒",
  };
  final String msg = result["reminderMessage"]?.toString().trim() ?? "";
  if (msg.isNotEmpty && msg != _pickTitle(result)) {
    return "$recurrenceLabel · $msg";
  }
  return recurrenceLabel;
}
