import "package:flutter/material.dart";

import "../core/services/schedule_api_client.dart";
import "mobile_theme.dart";

/// 手机端行程表：只读展示接下来的事项，当天优先。
///
/// 与桌面端 [../features/schedule/schedule_page.dart] 完全独立：
/// - 默认只展示今天的安排（含今天已完成/已过去的条目）；
/// - 页面底部一个「查看之后的安排」按钮切换到未来 30 天的按日分组视图；
/// - 无日历、无视图切换、无创建/删除/编辑等任何管理入口——管理归桌面端与对话。
class MobileSchedulePage extends StatefulWidget {
  const MobileSchedulePage({
    super.key,
    required this.scheduleApi,
    required this.sessionId,
    this.onGoToChat,
  });

  final ScheduleApiClient scheduleApi;
  final String sessionId;

  /// 空态引导点击时跳回对话 tab。
  final VoidCallback? onGoToChat;

  @override
  State<MobileSchedulePage> createState() => _MobileSchedulePageState();
}

class _MobileSchedulePageState extends State<MobileSchedulePage> {
  /// 展示范围：从今天零点起往后 30 天。
  static const int _lookaheadDays = 30;

  bool _loading = true;
  String? _error;

  /// 解析后的全部条目（今天零点起 30 天内，已滤掉 cancelled 与无法解析时刻的）。
  List<_ScheduleEntry> _entries = <_ScheduleEntry>[];

  /// false = 只看今天（默认）；true = 接下来的安排（按日分组）。
  bool _showUpcoming = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final DateTime now = DateTime.now();
    final DateTime from = DateTime(now.year, now.month, now.day);
    final DateTime to = from.add(const Duration(days: _lookaheadDays));
    final ScheduleApiResult<List<Map<String, dynamic>>> result =
        await widget.scheduleApi.listScheduleTasksResult(
      widget.sessionId,
      from: from,
      to: to,
    );
    if (!mounted) return;
    if (!result.ok) {
      setState(() {
        _loading = false;
        _error = result.error ?? "拉取日程失败";
      });
      return;
    }
    setState(() {
      _entries = _parse(result.value ?? const <Map<String, dynamic>>[], from);
      _loading = false;
    });
  }

  /// 服务端任务记录 → 展示条目。时刻口径与后台一致：
  /// 已完成看 lastRunAt（实际执行时刻），未完成看 nextRunAt（下一次触发）。
  List<_ScheduleEntry> _parse(
    List<Map<String, dynamic>> tasks,
    DateTime rangeFrom,
  ) {
    final List<_ScheduleEntry> out = <_ScheduleEntry>[];
    for (final Map<String, dynamic> t in tasks) {
      final String status = t["status"]?.toString() ?? "active";
      if (status == "cancelled") continue;
      final bool completed = status == "completed";
      final String? iso = completed
          ? ((t["lastRunAt"] ?? t["runAt"]) as String?)
          : ((t["nextRunAt"] ?? t["runAt"]) as String?);
      if (iso == null || iso.isEmpty) continue;
      final DateTime? at = DateTime.tryParse(iso)?.toLocal();
      if (at == null) continue;
      if (at.isBefore(rangeFrom)) continue;
      final String title = (t["shortTitle"] ?? t["reminderMessage"] ?? t["title"] ?? t["description"] ?? "")
          .toString()
          .trim();
      if (title.isEmpty) continue;
      out.add(_ScheduleEntry(
        id: t["taskId"]?.toString() ?? "",
        at: at,
        title: title,
        location: t["location"]?.toString(),
        completed: completed,
      ));
    }
    out.sort((_ScheduleEntry a, _ScheduleEntry b) => a.at.compareTo(b.at));
    return out;
  }

  bool _isSameDay(DateTime a, DateTime b) =>
      a.year == b.year && a.month == b.month && a.day == b.day;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Scaffold(
      backgroundColor: p.background,
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: _load,
          child: _buildBody(p),
        ),
      ),
    );
  }

  Widget _buildBody(MobilePalette p) {
    if (_loading && _entries.isEmpty) {
      return ListView(children: <Widget>[
        _header(p),
        const SizedBox(height: 160),
        Center(
          child: SizedBox(
            width: 22,
            height: 22,
            child: CircularProgressIndicator(
              strokeWidth: 2,
              color: p.textMuted,
            ),
          ),
        ),
      ]);
    }
    if (_error != null) {
      return ListView(children: <Widget>[
        _header(p),
        const SizedBox(height: 160),
        Center(
          child: Text(
            _error!,
            style: TextStyle(color: p.textMuted, fontSize: 14),
          ),
        ),
      ]);
    }
    return _showUpcoming ? _buildUpcomingList(p) : _buildTodayList(p);
  }

  Widget _header(MobilePalette p) {
    final String subtitle =
        _showUpcoming ? "接下来 $_lookaheadDays 天" : _formatToday(DateTime.now());
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 20, 20, 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            "行程",
            style: TextStyle(
              color: p.textPrimary,
              fontSize: 28,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.3,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            subtitle,
            style: TextStyle(color: p.textSecondary, fontSize: 13),
          ),
        ],
      ),
    );
  }

  /// 默认视图：今天全部条目（含已过去的），按时刻排序。
  Widget _buildTodayList(MobilePalette p) {
    final DateTime now = DateTime.now();
    final List<_ScheduleEntry> today = _entries
        .where((_ScheduleEntry e) => _isSameDay(e.at, now))
        .toList(growable: false);
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.only(bottom: 32),
      children: <Widget>[
        _header(p),
        if (today.isEmpty)
          _emptyHint(p, "今天没有安排", "接下来 $_lookaheadDays 天还有 ${_futureCount(now)} 件安排")
        else
          _daySection(p, null, today),
        _switchButton(p),
      ],
    );
  }

  /// 「之后的安排」视图：今天之外按日分组。
  Widget _buildUpcomingList(MobilePalette p) {
    final DateTime now = DateTime.now();
    final Map<String, List<_ScheduleEntry>> groups =
        <String, List<_ScheduleEntry>>{};
    final List<String> dayKeys = <String>[];
    for (final _ScheduleEntry e in _entries) {
      if (_isSameDay(e.at, now)) continue;
      final String key =
          "${e.at.year}-${e.at.month.toString().padLeft(2, "0")}-${e.at.day.toString().padLeft(2, "0")}";
      if (!groups.containsKey(key)) {
        groups[key] = <_ScheduleEntry>[];
        dayKeys.add(key);
      }
      groups[key]!.add(e);
    }
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.only(bottom: 32),
      children: <Widget>[
        _header(p),
        if (dayKeys.isEmpty)
          _emptyHint(p, "接下来没有安排", null)
        else
          for (final String key in dayKeys)
            _daySection(p, _formatDayHeader(DateTime.parse(key), now), groups[key]!),
        _switchButton(p),
      ],
    );
  }

  int _futureCount(DateTime now) => _entries
      .where((_ScheduleEntry e) => !_isSameDay(e.at, now))
      .length;

  Widget _daySection(MobilePalette p, String? dayHeader, List<_ScheduleEntry> items) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (dayHeader != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Text(
                dayHeader,
                style: TextStyle(color: p.textMuted, fontSize: 12.5),
              ),
            ),
            for (int i = 0; i < items.length; i++) ...<Widget>[
              _entryRow(p, items[i]),
              if (i < items.length - 1)
                Divider(color: p.divider, height: 1),
            ],
        ],
      ),
    );
  }

  Widget _entryRow(MobilePalette p, _ScheduleEntry e) {
    final Color titleColor = e.completed ? p.textMuted : p.textPrimary;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 14),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          SizedBox(
            width: 48,
            child: Text(
              _formatTime(e.at),
              style: TextStyle(color: p.textMuted, fontSize: 14, height: 1.3),
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  e.title,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: titleColor,
                    fontSize: 15.5,
                    height: 1.35,
                    decoration:
                        e.completed ? TextDecoration.lineThrough : null,
                  ),
                ),
                if (e.location != null && e.location!.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 3),
                    child: Text(
                      e.location!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: p.textMuted, fontSize: 12.5),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _switchButton(MobilePalette p) {
    return Padding(
      padding: const EdgeInsets.only(top: 24),
      child: Center(
        child: TextButton(
          onPressed: () => setState(() => _showUpcoming = !_showUpcoming),
          style: TextButton.styleFrom(
            foregroundColor: p.textSecondary,
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(20),
              side: BorderSide(color: p.divider),
            ),
          ),
          child: Text(
            _showUpcoming ? "只看今天" : "查看之后的安排",
            style: const TextStyle(fontSize: 13.5),
          ),
        ),
      ),
    );
  }

  Widget _emptyHint(MobilePalette p, String title, String? hint) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 80),
      child: Column(
        children: <Widget>[
          Text(
            title,
            style: TextStyle(
              color: p.textSecondary,
              fontSize: 15,
              fontWeight: FontWeight.w500,
            ),
          ),
          if (hint != null)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Text(
                hint,
                style: TextStyle(color: p.textMuted, fontSize: 13),
              ),
            ),
          if (widget.onGoToChat != null)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: GestureDetector(
                onTap: widget.onGoToChat,
                child: Text(
                  "在对话里说一声，我帮你记下时间",
                  style: TextStyle(color: p.link, fontSize: 13),
                ),
              ),
            ),
        ],
      ),
    );
  }

  String _formatTime(DateTime dt) =>
      "${dt.hour.toString().padLeft(2, "0")}:${dt.minute.toString().padLeft(2, "0")}";

  static const List<String> _weekdays = <String>[
    "周一", "周二", "周三", "周四", "周五", "周六", "周日",
  ];

  String _formatToday(DateTime dt) =>
      "今天 · ${dt.month}月${dt.day}日 ${_weekdays[dt.weekday - 1]}";

  /// 之后视图的分组头：明天带「明天」前缀，更远的只显日期。
  String _formatDayHeader(DateTime dt, DateTime now) {
    final String base = "${dt.month}月${dt.day}日 ${_weekdays[dt.weekday - 1]}";
    if (_isSameDay(dt, now.add(const Duration(days: 1)))) return "明天 · $base";
    return base;
  }
}

class _ScheduleEntry {
  const _ScheduleEntry({
    required this.id,
    required this.at,
    required this.title,
    this.location,
    this.completed = false,
  });

  final String id;
  final DateTime at;
  final String title;
  final String? location;
  final bool completed;
}
