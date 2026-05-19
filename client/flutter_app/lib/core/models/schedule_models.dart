/// 本地持久化的日程事项（写入 `private_ai_agent_store.json` 的 `scheduleEvents`）。
class ScheduleEvent {
  const ScheduleEvent({
    required this.id,
    required this.startAt,
    required this.title,
    this.notes,
  });

  final String id;
  final DateTime startAt;
  final String title;
  final String? notes;
}
