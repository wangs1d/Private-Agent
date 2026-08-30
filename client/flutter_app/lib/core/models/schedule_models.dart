/// 本地持久化的日程事项（写入 `private_ai_agent_store.json` 的 `scheduleEvents`）。
class ScheduleEvent {
  const ScheduleEvent({
    required this.id,
    required this.startAt,
    required this.title,
    this.shortTitle,
    this.notes,
    this.isRhythm = false,
  });

  final String id;
  final DateTime startAt;
  /// 完整标题（日程页展示）。
  final String title;
  /// 简洁展示标题（「今日安排」紧凑列表用，创建时由 LLM 生成；旧数据为空时回退 title 简化）。
  final String? shortTitle;
  final String? notes;
  /// 节律提醒（喝水/睡觉等）：照常到点推送，但不进「今日安排」紧凑列表（日程页仍展示）。
  final bool isRhythm;
}
