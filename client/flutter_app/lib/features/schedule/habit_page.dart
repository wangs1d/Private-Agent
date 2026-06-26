import "dart:async";

import "package:flutter/material.dart";

import "../../core/services/schedule_api_client.dart";

/// 习惯追踪页：列出习惯（含连续打卡天数）、单条打卡、本周打卡日历。
///
/// 数据来源为 [ScheduleApiClient]；习惯由日程任务中 `kind == "habit"`（或回退到全部任务）解析。
class HabitPage extends StatefulWidget {
  const HabitPage({
    super.key,
    this.scheduleApi,
    this.sessionId,
  });

  final ScheduleApiClient? scheduleApi;
  final String? sessionId;

  @override
  State<HabitPage> createState() => _HabitPageState();
}

class _HabitPageState extends State<HabitPage> {
  static const List<String> _weekdayCn = <String>["一", "二", "三", "四", "五", "六", "日"];

  bool _loading = true;
  String? _error;
  List<HabitItem> _habits = <HabitItem>[];

  @override
  void initState() {
    super.initState();
    unawaited(_refresh());
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final ScheduleApiClient? api = widget.scheduleApi;
    final String? sid = widget.sessionId?.trim();
    if (api == null || sid == null || sid.isEmpty) {
      if (!mounted) return;
      setState(() => _loading = false);
      return;
    }
    try {
      final List<Map<String, dynamic>> tasks = await api.listScheduleTasks(sid);
      if (!mounted) return;
      setState(() {
        _habits = _parseHabits(tasks);
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = e.toString();
      });
    }
  }

  List<HabitItem> _parseHabits(List<Map<String, dynamic>> tasks) {
    final List<HabitItem> out = <HabitItem>[];
    for (final Map<String, dynamic> t in tasks) {
      final String kind = t["kind"]?.toString() ?? "";
      // 仅展示习惯类（无 kind 字段时回退忽略，避免把普通日程当作习惯）。
      if (kind.isNotEmpty && kind != "habit") continue;
      final String id = t["id"]?.toString() ?? "";
      final String title = t["title"]?.toString() ?? "";
      if (title.isEmpty) continue;
      final int streak = (t["streak"] as num?)?.round() ?? 0;
      final bool checkedToday = t["checkedToday"] == true;
      final List<DateTime> history = <DateTime>[];
      final Object? raw = t["history"];
      if (raw is List) {
        for (final Object? x in raw) {
          if (x is String && x.isNotEmpty) {
            final DateTime? d = DateTime.tryParse(x);
            if (d != null) history.add(DateTime(d.year, d.month, d.day));
          }
        }
      }
      out.add(HabitItem(
        id: id,
        title: title,
        streak: streak,
        checkedToday: checkedToday,
        history: history,
      ));
    }
    return out;
  }

  void _toggleCheckIn(HabitItem h) {
    setState(() {
      final int idx = _habits.indexOf(h);
      if (idx < 0) return;
      final HabitItem cur = _habits[idx];
      final DateTime today = _stripTime(DateTime.now());
      final bool willCheck = !cur.checkedToday;
      final List<DateTime> history = List<DateTime>.from(cur.history);
      if (willCheck) {
        if (!history.any((DateTime d) => d == today)) history.add(today);
      } else {
        history.removeWhere((DateTime d) => d == today);
      }
      _habits[idx] = HabitItem(
        id: cur.id,
        title: cur.title,
        streak: willCheck ? cur.streak + 1 : (cur.streak > 0 ? cur.streak - 1 : 0),
        checkedToday: willCheck,
        history: history,
      );
    });
  }

  static DateTime _stripTime(DateTime d) => DateTime(d.year, d.month, d.day);

  DateTime _mondayOf(DateTime d) {
    final DateTime day = _stripTime(d);
    return day.subtract(Duration(days: day.weekday - DateTime.monday));
  }

  bool _habitCheckedOn(HabitItem h, DateTime day) {
    final DateTime k = _stripTime(day);
    return h.history.any((DateTime d) => d == k);
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final DateTime monday = _mondayOf(DateTime.now());
    return Scaffold(
      appBar: AppBar(
        title: const Text("习惯打卡"),
        actions: <Widget>[
          IconButton(onPressed: _refresh, icon: const Icon(Icons.refresh)),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: <Widget>[
                        Text(_error!, textAlign: TextAlign.center),
                        const SizedBox(height: 16),
                        FilledButton(onPressed: _refresh, child: const Text("重试")),
                      ],
                    ),
                  ),
                )
              : RefreshIndicator(
                  onRefresh: _refresh,
                  child: ListView(
                    padding: const EdgeInsets.all(16),
                    children: <Widget>[
                      _weekCalendar(theme, monday),
                      const SizedBox(height: 16),
                      Text("习惯 · ${_habits.length}", style: theme.textTheme.titleMedium),
                      const SizedBox(height: 8),
                      if (_habits.isEmpty)
                        Text(
                          "暂无习惯，去日程里添加重复型任务试试。",
                          style: theme.textTheme.bodyMedium?.copyWith(
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                        )
                      else
                        for (final HabitItem h in _habits)
                          _HabitCard(
                            habit: h,
                            weekStart: monday,
                            checkedOn: (DateTime d) => _habitCheckedOn(h, d),
                            onToggle: () => _toggleCheckIn(h),
                            theme: theme,
                          ),
                    ],
                  ),
                ),
    );
  }

  Widget _weekCalendar(ThemeData theme, DateTime monday) {
    final ColorScheme cs = theme.colorScheme;
    final DateTime today = _stripTime(DateTime.now());
    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 8),
        child: Row(
          children: List<Widget>.generate(7, (int i) {
            final DateTime day = monday.add(Duration(days: i));
            final bool isToday = day == today;
            final int count = _habits.where((HabitItem h) => _habitCheckedOn(h, day)).length;
            return Expanded(
              child: Column(
                children: <Widget>[
                  Text(_weekdayCn[i], style: theme.textTheme.labelSmall?.copyWith(color: cs.onSurfaceVariant)),
                  const SizedBox(height: 4),
                  Container(
                    width: 28,
                    height: 28,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: isToday ? cs.primary : Colors.transparent,
                      border: Border.all(
                        color: isToday ? cs.primary : cs.outline.withValues(alpha: 0.4),
                      ),
                    ),
                    child: Text(
                      "${day.day}",
                      style: theme.textTheme.labelMedium?.copyWith(
                        color: isToday ? cs.onPrimary : cs.onSurface,
                      ),
                    ),
                  ),
                  const SizedBox(height: 4),
                  if (count > 0)
                    Text("×$count", style: theme.textTheme.labelSmall?.copyWith(color: cs.primary))
                  else
                    Text("·", style: theme.textTheme.labelSmall?.copyWith(color: cs.outline)),
                ],
              ),
            );
          }),
        ),
      ),
    );
  }
}

class HabitItem {
  const HabitItem({
    required this.id,
    required this.title,
    required this.streak,
    required this.checkedToday,
    required this.history,
  });

  final String id;
  final String title;
  final int streak;
  final bool checkedToday;
  final List<DateTime> history;
}

class _HabitCard extends StatelessWidget {
  const _HabitCard({
    required this.habit,
    required this.weekStart,
    required this.checkedOn,
    required this.onToggle,
    required this.theme,
  });

  final HabitItem habit;
  final DateTime weekStart;
  final bool Function(DateTime) checkedOn;
  final VoidCallback onToggle;
  final ThemeData theme;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = theme.colorScheme;
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Icon(Icons.local_fire_department_outlined, color: cs.primary, size: 20),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    habit.title,
                    style: theme.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w600),
                  ),
                ),
                Text(
                  "连续 ${habit.streak} 天",
                  style: theme.textTheme.labelMedium?.copyWith(color: cs.primary),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Row(
              children: List<Widget>.generate(7, (int i) {
                final DateTime day = weekStart.add(Duration(days: i));
                final bool done = checkedOn(day);
                return Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 2),
                    child: Tooltip(
                      message: "${day.month}/${day.day}",
                      child: Container(
                        height: 8,
                        decoration: BoxDecoration(
                          color: done ? cs.primary : cs.outline.withValues(alpha: 0.18),
                          borderRadius: BorderRadius.circular(4),
                        ),
                      ),
                    ),
                  ),
                );
              }),
            ),
            const SizedBox(height: 10),
            Align(
              alignment: Alignment.centerRight,
              child: FilledButton.tonalIcon(
                onPressed: onToggle,
                icon: Icon(habit.checkedToday ? Icons.check_circle : Icons.radio_button_unchecked),
                label: Text(habit.checkedToday ? "今日已打卡" : "今日打卡"),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
