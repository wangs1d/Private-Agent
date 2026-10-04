import "package:flutter/material.dart";

import "../../core/services/sleep_routine_api.dart";

/// 作息提醒分区（设置 · 通用）。
///
/// 分级提醒的睡前备忘会贴着用户的入睡点、起床闹钟尊重起床习惯，所以这里要
/// **如实告诉用户作息是从哪来的**：
///   - 用户自己填过 → 以用户填的为准；
///   - 没填 → 用 agent 观察「用户什么时候在线」推出来的作息，并说明观察了几晚、
///     还差几晚；观察不足时明说当前走默认时刻。
/// 不做静默推断：来源和把握程度都摆在明面上，用户想改随时能改。
class SleepRoutineSection extends StatefulWidget {
  const SleepRoutineSection({super.key});

  @override
  State<SleepRoutineSection> createState() => _SleepRoutineSectionState();
}

class _SleepRoutineSectionState extends State<SleepRoutineSection> {
  final SleepRoutineApi _api = SleepRoutineApi();
  SleepRoutineSnapshot? _snapshot;
  bool _loading = true;
  bool _busy = false;

  SleepRoutine? get _routine => _snapshot?.routine;
  ObservedRoutine? get _observed => _snapshot?.observed;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    setState(() => _loading = true);
    final SleepRoutineSnapshot? snapshot = await _api.fetch();
    if (!mounted) return;
    setState(() {
      _snapshot = snapshot;
      _loading = false;
    });
  }

  static String _fmt(double hour) {
    final double norm = ((hour % 24) + 24) % 24;
    final int h = norm.floor();
    final int m = ((norm - h) * 60).round() % 60;
    return "${h.toString().padLeft(2, "0")}:${m.toString().padLeft(2, "0")}";
  }

  static TimeOfDay _toTimeOfDay(double hour) {
    final double norm = ((hour % 24) + 24) % 24;
    final int h = norm.floor();
    final int m = ((norm - h) * 60).round() % 60;
    return TimeOfDay(hour: h, minute: m);
  }

  /// 当前实际生效的作息说明（来源 + 把握程度都讲清楚）
  String _statusLine() {
    if (_loading) return "读取中…";
    final SleepRoutine? routine = _routine;
    if (routine != null) {
      return "你填的：${_fmt(routine.sleepStartHour)} 入睡 · ${_fmt(routine.wakeHour)} 起床（以此为准）";
    }
    final ObservedRoutine? ob = _observed;
    if (ob == null || ob.dayCount == 0) {
      return "还没观察到你的作息，暂用默认：睡前 21:00 / 起床 06:00";
    }
    if (ob.sleepStartHour != null) {
      final String wake =
          ob.wakeHour != null ? " · ${_fmt(ob.wakeHour!)} 起床" : "";
      return "agent 观察到：你平时约 ${_fmt(ob.sleepStartHour!)} 入睡$wake"
          "（根据最近 ${ob.nightCount} 个晚上）";
    }
    final int need = 3 - ob.nightCount;
    return "还在观察：已有 ${ob.dayCount} 天记录，再看 $need 晚就能定下来"
        "（当前暂用默认：睡前 21:00 / 起床 06:00）";
  }

  /// 观察侧的补充说明（起床点没观察到时说明原因，避免用户以为漏了）
  String? _observedNote() {
    final ObservedRoutine? ob = _observed;
    if (ob == null || ob.sleepStartHour == null) return null;
    if (ob.wakeHour != null) return null;
    return "起床时间还没观察到——你多半白天不用 agent。白天用几次就知道了，也可以直接填上。";
  }

  Future<void> _edit() async {
    final TimeOfDay? sleepT = await showTimePicker(
      context: context,
      initialTime: _toTimeOfDay(
        _routine?.sleepStartHour ?? _observed?.sleepStartHour ?? 23.5,
      ),
      helpText: "平时几点入睡？",
    );
    if (sleepT == null || !mounted) return;
    final TimeOfDay? wakeT = await showTimePicker(
      context: context,
      initialTime: _toTimeOfDay(_routine?.wakeHour ?? _observed?.wakeHour ?? 7),
      helpText: "平时几点起床？",
    );
    if (wakeT == null || !mounted) return;

    setState(() => _busy = true);
    final bool ok = await _api.save(
      sleepStartHour: sleepT.hour + sleepT.minute / 60,
      wakeHour: wakeT.hour + wakeT.minute / 60,
    );
    if (!mounted) return;
    setState(() => _busy = false);
    if (!ok) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("保存失败，请检查与服务端的连接")),
      );
      return;
    }
    await _reload();
  }

  Future<void> _clear() async {
    setState(() => _busy = true);
    final bool ok = await _api.clear();
    if (!mounted) return;
    setState(() => _busy = false);
    if (!ok) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("清除失败，请重试")),
      );
      return;
    }
    await _reload();
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String? note = _observedNote();

    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                const Icon(Icons.bedtime_outlined, size: 18),
                const SizedBox(width: 8),
                Text("作息提醒", style: theme.textTheme.titleMedium),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              "睡前备忘会贴着你的入睡点，起床闹钟也不会早于你的起床习惯。"
              "作息由 agent 观察你平时什么时候在用得出；你也可以自己填，以你填的为准。",
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 8),
            Text(_statusLine(), style: theme.textTheme.bodyMedium),
            if (note != null) ...<Widget>[
              const SizedBox(height: 4),
              Text(
                note,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
            const SizedBox(height: 4),
            Row(
              children: <Widget>[
                TextButton(
                  onPressed: _busy || _loading ? null : _edit,
                  child: Text(_routine == null ? "设置作息" : "修改"),
                ),
                if (_routine != null)
                  TextButton(
                    onPressed: _busy ? null : _clear,
                    child: const Text("清除"),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
