import "dart:async";
import "dart:math" show max, min;
import "dart:ui" as ui;

import "package:flutter/foundation.dart";
import "package:flutter/material.dart";

import "../../core/db/isar_local_history_store.dart";
import "../../core/models/schedule_models.dart";
import "../../core/services/schedule_api_client.dart";
import "../../core/services/schedule_reminder_sync.dart";
import "../../core/theme/app_theme.dart";

/// 日程：本地持久化事项（日历周视图 + 事项管理）。
class SchedulePage extends StatefulWidget {
  const SchedulePage({
    super.key,
    required this.store,
    this.scheduleApi,
    this.sessionId,
    this.reloadListenable,
  });

  final IsarLocalHistoryStore store;
  final ScheduleApiClient? scheduleApi;
  final String? sessionId;
  final ValueListenable<int>? reloadListenable;

  @override
  State<SchedulePage> createState() => _SchedulePageState();
}

class _SchedulePageState extends State<SchedulePage> {
  static const List<String> _weekdayCn = <String>[
    "周一",
    "周二",
    "周三",
    "周四",
    "周五",
    "周六",
    "周日",
  ];
  static const List<String> _weekdayEn = <String>[
    "MON",
    "TUE",
    "WED",
    "THU",
    "FRI",
    "SAT",
    "SUN",
  ];

  /// 0：日历日视图；1：日历周视图；2：事项管理（仅今日列表）。
  int _subTab = 0;

  DateTime _weekStart = _mondayOf(DateTime.now());
  DateTime _focusedDay = _stripTime(DateTime.now());
  
  /// 视图模式：'day' 为日视图，'week' 为周视图
  String _viewMode = 'day';

  List<ScheduleEvent> _todayEvents = <ScheduleEvent>[];
  List<ScheduleEvent> _weekEvents = <ScheduleEvent>[];
  String? _selectedEventId;

  static DateTime _stripTime(DateTime d) => DateTime(d.year, d.month, d.day);

  static DateTime _mondayOf(DateTime d) {
    final DateTime day = _stripTime(d);
    return day.subtract(Duration(days: day.weekday - DateTime.monday));
  }

  @override
  void initState() {
    super.initState();
    _focusedDay = _focusDayForWeek(_weekStart);
    widget.reloadListenable?.addListener(_onExternalReload);
    unawaited(_reloadAll());
  }

  @override
  void dispose() {
    widget.reloadListenable?.removeListener(_onExternalReload);
    super.dispose();
  }

  void _onExternalReload() {
    unawaited(_reloadAll());
  }

  DateTime _focusDayForWeek(DateTime monday) {
    final DateTime today = _stripTime(DateTime.now());
    final DateTime sunday = monday.add(const Duration(days: 6));
    if (!today.isBefore(monday) && !today.isAfter(sunday)) {
      return today;
    }
    return monday;
  }

  Future<void> _reloadAll() async {
    final ScheduleApiClient? api = widget.scheduleApi;
    final String? sessionId = widget.sessionId?.trim();
    if (api != null && sessionId != null && sessionId.isNotEmpty) {
      try {
        await syncServerRemindersToLocal(widget.store, api, sessionId);
      } catch (_) {
        // 离线或主服务不可用时仍展示本地已缓存事项。
      }
    }
    final DateTime wEnd = _weekStart.add(const Duration(days: 7));
    final List<ScheduleEvent> weekList =
        await widget.store.listScheduleEventsInRange(_weekStart, wEnd);
    final List<ScheduleEvent> todayList = await widget.store
        .listScheduleEventsForDay(_stripTime(DateTime.now()));
    if (!mounted) {
      return;
    }
    setState(() {
      _weekEvents = weekList;
      _todayEvents = todayList;
    });
  }

  static String _formatClock(DateTime d) {
    final String hh = d.hour.toString().padLeft(2, "0");
    final String mm = d.minute.toString().padLeft(2, "0");
    return "$hh:$mm";
  }

  static String _formatRangeLabel(DateTime monday) {
    final DateTime sunday = monday.add(const Duration(days: 6));
    if (monday.year == sunday.year && monday.month == sunday.month) {
      return "${monday.year}年${monday.month}月${monday.day}日 - ${sunday.day}日";
    }
    if (monday.year == sunday.year) {
      return "${monday.year}年${monday.month}月${monday.day}日 - "
          "${sunday.month}月${sunday.day}日";
    }
    return "${monday.year}年${monday.month}月${monday.day}日 - "
        "${sunday.year}年${sunday.month}月${sunday.day}日";
  }

  static String _formatDayLabel(DateTime day) {
    return "${day.year}年${day.month}月${day.day}日";
  }

  Map<DateTime, List<ScheduleEvent>> _eventsByDay() {
    final Map<DateTime, List<ScheduleEvent>> map =
        <DateTime, List<ScheduleEvent>>{};
    for (final ScheduleEvent e in _weekEvents) {
      final DateTime k = _stripTime(e.startAt);
      map.putIfAbsent(k, () => <ScheduleEvent>[]).add(e);
    }
    for (final List<ScheduleEvent> list in map.values) {
      list.sort(
        (ScheduleEvent a, ScheduleEvent b) => a.startAt.compareTo(b.startAt),
      );
    }
    return map;
  }

  bool _isEventCompleted(ScheduleEvent e) {
    return !e.startAt.isAfter(DateTime.now());
  }

  void _shiftWeek(int delta) {
    setState(() {
      _weekStart = _weekStart.add(Duration(days: delta * 7));
      _focusedDay = _focusDayForWeek(_weekStart);
      _selectedEventId = null;
    });
    _reloadAll();
  }

  void _shiftDay(int delta) {
    setState(() {
      _focusedDay = _focusedDay.add(Duration(days: delta));
      // 如果焦点日期不在当前周范围内，更新周起始日期
      final DateTime weekEnd = _weekStart.add(const Duration(days: 6));
      if (_focusedDay.isBefore(_weekStart) || _focusedDay.isAfter(weekEnd)) {
        _weekStart = _mondayOf(_focusedDay);
      }
      _selectedEventId = null;
    });
    _reloadAll();
  }

  void _goToCurrentWeek() {
    setState(() {
      _weekStart = _mondayOf(DateTime.now());
      _focusedDay = _stripTime(DateTime.now());
      _selectedEventId = null;
    });
    _reloadAll();
  }

  void _goToToday() {
    setState(() {
      _focusedDay = _stripTime(DateTime.now());
      _weekStart = _mondayOf(_focusedDay);
      _selectedEventId = null;
    });
    _reloadAll();
  }

  Future<void> _pickTimeAndAddForDay(DateTime day) async {
    final TimeOfDay initial = TimeOfDay.fromDateTime(DateTime.now());
    final TimeOfDay? picked = await showTimePicker(
      context: context,
      initialTime: initial,
    );
    if (picked == null || !mounted) {
      return;
    }
    final TextEditingController titleCtrl = TextEditingController();
    final TextEditingController notesCtrl = TextEditingController();
    final bool? ok = await showDialog<bool>(
      context: context,
      builder: (BuildContext ctx) {
        return AlertDialog(
          title: const Text("新建日程"),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Text(
                  "时间：${_formatClock(DateTime(
                    day.year,
                    day.month,
                    day.day,
                    picked.hour,
                    picked.minute,
                  ))}",
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: titleCtrl,
                  decoration: const InputDecoration(
                    labelText: "标题",
                    border: OutlineInputBorder(),
                  ),
                  textInputAction: TextInputAction.next,
                  onSubmitted: (String value) {
                    // 按 Enter 键时，如果标题不为空，则聚焦到备注字段
                    if (value.trim().isNotEmpty) {
                      FocusScope.of(ctx).nextFocus();
                    }
                  },
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: notesCtrl,
                  decoration: const InputDecoration(
                    labelText: "备注（可选）",
                    border: OutlineInputBorder(),
                  ),
                  maxLines: 3,
                  onSubmitted: (String value) {
                    // 按 Enter 键时保存日程
                    Navigator.pop(ctx, true);
                  },
                ),
              ],
            ),
          ),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text("取消"),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text("保存"),
            ),
          ],
        );
      },
    );
    if (ok != true || !mounted) {
      titleCtrl.dispose();
      notesCtrl.dispose();
      return;
    }
    final String title = titleCtrl.text.trim();
    titleCtrl.dispose();
    final String notesRaw = notesCtrl.text.trim();
    notesCtrl.dispose();
    if (title.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("请填写标题")),
      );
      return;
    }
    final ScheduleEvent ev = ScheduleEvent(
      id: "se-${DateTime.now().microsecondsSinceEpoch}",
      startAt: DateTime(
        day.year,
        day.month,
        day.day,
        picked.hour,
        picked.minute,
      ),
      title: title,
      notes: notesRaw.isEmpty ? null : notesRaw,
    );
    await widget.store.saveScheduleEvent(ev);
    await _reloadAll();
  }

  Future<void> _confirmDelete(ScheduleEvent e) async {
    final bool? del = await showDialog<bool>(
      context: context,
      builder: (BuildContext ctx) {
        return AlertDialog(
          title: const Text("删除日程"),
          content: Text("确定删除「${e.title}」？"),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text("取消"),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text("删除"),
            ),
          ],
        );
      },
    );
    if (del == true && mounted) {
      await widget.store.deleteScheduleEvent(e.id);
      _selectedEventId = null;
      await _reloadAll();
    }
  }

  Widget _buildSubTabBar(ThemeData theme) {
    final ColorScheme cs = theme.colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
      child: Row(
        children: <Widget>[
          Flexible(
            child: Row(
              children: <Widget>[
                _subTabPill(theme, 0, "日历"),
                const SizedBox(width: 20),
                _subTabPill(theme, 1, "事项管理"),
              ],
            ),
          ),
          // 在日历视图中添加日/周切换按钮
          if (_subTab == 0)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: ToggleButtons(
                isSelected: [_viewMode == 'day', _viewMode == 'week'],
                onPressed: (int index) {
                  setState(() {
                    _viewMode = index == 0 ? 'day' : 'week';
                  });
                },
                borderRadius: BorderRadius.circular(8),
                selectedColor: cs.onSurface,
                fillColor: cs.surfaceContainerHigh,
                color: cs.onSurfaceVariant,
                borderColor: cs.outline,
                selectedBorderColor: cs.onSurface,
                constraints: const BoxConstraints(minWidth: 48, minHeight: 32),
                children: const <Widget>[
                  Padding(
                    padding: EdgeInsets.symmetric(horizontal: 10),
                    child: Text('日', style: TextStyle(fontSize: 13)),
                  ),
                  Padding(
                    padding: EdgeInsets.symmetric(horizontal: 10),
                    child: Text('周', style: TextStyle(fontSize: 13)),
                  ),
                ],
              ),
            ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: cs.onSurface,
              foregroundColor: cs.surface,
              padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(10),
              ),
            ),
            onPressed: () {
              if (_subTab == 0) {
                _pickTimeAndAddForDay(_focusedDay);
              } else {
                _pickTimeAndAddForDay(_stripTime(DateTime.now()));
              }
            },
            child: const Text("创建日程"),
          ),
        ],
      ),
    );
  }

  Widget _subTabPill(ThemeData theme, int index, String label) {
    final bool on = _subTab == index;
    return InkWell(
      onTap: () {
        setState(() => _subTab = index);
        if (index == 1) {
          // 切换到事项管理时不显示加载状态，直接展示内容
          _reloadAll();
        }
      },
      borderRadius: BorderRadius.circular(4),
      child: Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(
              label,
              style: theme.textTheme.titleSmall?.copyWith(
                color: on
                    ? theme.colorScheme.onSurface
                    : theme.colorScheme.onSurfaceVariant,
                fontWeight: on ? FontWeight.w600 : FontWeight.w400,
              ),
            ),
            const SizedBox(height: 6),
            Container(
              height: 2,
              width: 40,
              decoration: BoxDecoration(
                color: on ? theme.colorScheme.onSurface : Colors.transparent,
                borderRadius: BorderRadius.circular(1),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _weekRangeControls(ThemeData theme) {
    final ColorScheme cs = theme.colorScheme;
    final DateTime today = _stripTime(DateTime.now());
      
    // 根据视图模式判断是否显示"回到今天/本周"按钮
    final bool isCurrentView;
    if (_viewMode == 'day') {
      isCurrentView = _focusedDay == today;
    } else {
      isCurrentView = !_weekStart.isAfter(today) && !today.isAfter(_weekStart.add(const Duration(days: 6)));
    }
      
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          Material(
            color: cs.surfaceContainerLow,
            borderRadius: BorderRadius.circular(10),
            child: SizedBox(
              width: 380, // 固定总宽度，包含日期组件和回到按钮
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  IconButton(
                    tooltip: _viewMode == 'day' ? "上一天" : "上一周",
                    visualDensity: VisualDensity.compact,
                    onPressed: () => _viewMode == 'day' ? _shiftDay(-1) : _shiftWeek(-1),
                    icon: Icon(Icons.chevron_left, color: cs.onSurface),
                  ),
                  SizedBox(
                    width: 200,
                    child: Text(
                      _viewMode == 'day'
                          ? _formatDayLabel(_focusedDay)
                          : _formatRangeLabel(_weekStart),
                      textAlign: TextAlign.center,
                      style: theme.textTheme.titleSmall?.copyWith(
                        color: cs.onSurface,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: _viewMode == 'day' ? "下一天" : "下一周",
                    visualDensity: VisualDensity.compact,
                    onPressed: () => _viewMode == 'day' ? _shiftDay(1) : _shiftWeek(1),
                    icon: Icon(Icons.chevron_right, color: cs.onSurface),
                  ),
                  // 固定占据空间，即使不显示按钮也保持布局稳定
                  SizedBox(
                    width: isCurrentView ? 0 : 100,
                    child: isCurrentView
                        ? null
                        : Row(
                            mainAxisSize: MainAxisSize.min,
                            children: <Widget>[
                              Container(
                                height: 24,
                                width: 1,
                                color: cs.outline.withValues(alpha: 0.3),
                                margin: const EdgeInsets.only(right: 4),
                              ),
                              SizedBox(
                                height: 28,
                                child: OutlinedButton.icon(
                                  onPressed: _viewMode == 'day' ? _goToToday : _goToCurrentWeek,
                                  icon: Icon(_viewMode == 'day' ? Icons.today : Icons.calendar_today, size: 14),
                                  label: Text(_viewMode == 'day' ? "今天" : "本周", style: const TextStyle(fontSize: 11)),
                                  style: OutlinedButton.styleFrom(
                                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                                    shape: RoundedRectangleBorder(
                                      borderRadius: BorderRadius.circular(6),
                                    ),
                                    visualDensity: VisualDensity.compact,
                                    foregroundColor: cs.onSurfaceVariant,
                                    side: BorderSide(color: cs.outline.withValues(alpha: 0.5)),
                                    minimumSize: const Size(0, 0),
                                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                  ),
                                ),
                              ),
                            ],
                          ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _dayGrid(ThemeData theme) {
    final Map<DateTime, List<ScheduleEvent>> byDay = _eventsByDay();
    final DateTime today = _stripTime(DateTime.now());
    final DateTime focusedDay = _stripTime(_focusedDay);
    
    // 获取当前聚焦日期的事项
    final List<ScheduleEvent> events = byDay[focusedDay] ?? <ScheduleEvent>[];
    
    final Color headerBg = focusedDay == today
        ? theme.colorScheme.surfaceContainerHigh
        : theme.colorScheme.surfaceContainerLow;

    return Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          // 日期标题
          Container(
            width: double.infinity,
            color: headerBg,
            padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 16),
            child: Column(
              children: <Widget>[
                Text(
                  "${_weekdayCn[focusedDay.weekday - 1]} / ${_weekdayEn[focusedDay.weekday - 1]}",
                  textAlign: TextAlign.center,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                    fontSize: 12,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  "${focusedDay.year}年${focusedDay.month}月${focusedDay.day}日",
                  textAlign: TextAlign.center,
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                    color: theme.colorScheme.onSurface,
                  ),
                ),
              ],
            ),
          ),
          // 事项列表
          Expanded(
            child: ColoredBox(
              color: theme.colorScheme.surfaceContainerLowest
                  .withValues(alpha: 0.65),
              child: events.isEmpty
                  ? Center(
                      child: Text(
                        '当天暂无事项',
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    )
                  : ListView(
                      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                      children: events
                          .map(
                            (ScheduleEvent e) => Padding(
                              padding: const EdgeInsets.only(bottom: 12),
                              child: _scheduleCard(theme, e),
                            ),
                          )
                          .toList(),
                    ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _weekGrid(ThemeData theme) {
    final Map<DateTime, List<ScheduleEvent>> byDay = _eventsByDay();
    final DateTime today = _stripTime(DateTime.now());
    final double screenW = MediaQuery.sizeOf(context).width;
    final bool useScroll = screenW < 560;
    const double colMin = 104.0;

    Widget dayColumn(int i) {
      final DateTime day = _weekStart.add(Duration(days: i));
      final bool isToday = _stripTime(day) == today;
      final List<ScheduleEvent> events = byDay[_stripTime(day)] ?? <ScheduleEvent>[];
      final Color headerBg = isToday
          ? theme.colorScheme.surfaceContainerHigh
          : theme.colorScheme.surfaceContainerLow;

      return GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => setState(() {
          _focusedDay = _stripTime(day);
          _selectedEventId = null;
        }),
        child: DecoratedBox(
          decoration: BoxDecoration(
            border: Border(
              right: BorderSide(
                color: theme.colorScheme.outline.withValues(alpha: 0.28),
              ),
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Container(
                width: double.infinity,
                color: headerBg,
                padding:
                    const EdgeInsets.symmetric(vertical: 10, horizontal: 6),
                child: Column(
                  children: <Widget>[
                    Text(
                      "${_weekdayCn[i]} / ${_weekdayEn[i]}",
                      textAlign: TextAlign.center,
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                        fontSize: 11,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      day.day.toString().padLeft(2, "0"),
                      textAlign: TextAlign.center,
                      style: theme.textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w600,
                        color: theme.colorScheme.onSurface,
                      ),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: ColoredBox(
                  color: theme.colorScheme.surfaceContainerLowest
                      .withValues(alpha: 0.65),
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(6, 0, 6, 12),
                    children: events
                        .map(
                          (ScheduleEvent e) => Padding(
                            padding: const EdgeInsets.only(bottom: 8),
                            child: _scheduleCard(theme, e),
                          ),
                        )
                        .toList(),
                  ),
                ),
              ),
            ],
          ),
        ),
      );
    }

    final List<Widget> cols =
        List<Widget>.generate(7, dayColumn);

    return Expanded(
      child: useScroll
          ? SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: SizedBox(
                width: colMin * 7,
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: cols
                      .map(
                        (Widget w) => SizedBox(width: colMin, child: w),
                      )
                      .toList(),
                ),
              ),
            )
          : Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: cols
                  .map((Widget w) => Expanded(child: w))
                  .toList(),
            ),
    );
  }

  Widget _scheduleCard(ThemeData theme, ScheduleEvent e) {
    final ColorScheme cs = theme.colorScheme;
    final bool done = _isEventCompleted(e);
    final bool selected = _selectedEventId == e.id;
    final Color statusColor = done
        ? cs.onSurfaceVariant.withValues(alpha: 0.88)
        : const Color(0xFFD4A574);
    final String statusText = done ? "已完成" : "待执行";
    const double radius = 10;

    final Widget body = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          e.title,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: theme.textTheme.bodyMedium?.copyWith(
            color: cs.onSurface,
            fontWeight: FontWeight.w600,
            height: 1.25,
          ),
        ),
        if (e.notes != null && e.notes!.isNotEmpty) ...<Widget>[
          const SizedBox(height: 4),
          Text(
            e.notes!,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.bodySmall?.copyWith(
              color: cs.onSurfaceVariant,
              fontSize: 11,
            ),
          ),
        ],
        const SizedBox(height: 8),
        Row(
          children: <Widget>[
            Icon(
              done ? Icons.check_circle_outline : Icons.hourglass_top_rounded,
              size: 15,
              color: statusColor,
            ),
            const SizedBox(width: 4),
            Expanded(
              child: Text(
                statusText,
                style: theme.textTheme.labelSmall?.copyWith(
                  color: statusColor,
                  fontSize: 12,
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 6),
        Row(
          children: <Widget>[
            Icon(
              Icons.schedule_rounded,
              size: 15,
              color: cs.onSurfaceVariant.withValues(alpha: 0.9),
            ),
            const SizedBox(width: 4),
            Text(
              _formatClock(e.startAt),
              style: theme.textTheme.labelSmall?.copyWith(
                color: cs.onSurfaceVariant,
                fontSize: 12,
              ),
            ),
          ],
        ),
      ],
    );

    return Material(
      color: cs.surfaceContainer,
      borderRadius: BorderRadius.circular(radius),
      elevation: 1,
      shadowColor: Colors.black.withValues(alpha: 0.4),
      child: InkWell(
        onTap: () => setState(() => _selectedEventId = e.id),
        onLongPress: () => _confirmDelete(e),
        borderRadius: BorderRadius.circular(radius),
        child: Stack(
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 10, 10, 10),
              child: body,
            ),
            if (selected)
              Positioned.fill(
                child: IgnorePointer(
                  child: _DashedGoldBorder(radius: radius),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _managementView(ThemeData theme) {
    final DateTime today = _stripTime(DateTime.now());
    final String dateLabel =
        "${today.year}-${today.month.toString().padLeft(2, "0")}-${today.day.toString().padLeft(2, "0")}";

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Text(
            "今日事项 · $dateLabel",
            style: theme.textTheme.titleSmall?.copyWith(
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
        if (_todayEvents.isEmpty)
          Text(
            "今日暂无事项，可点击右上角「创建日程」添加。",
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          )
        else
          ..._todayEvents.map(
            (ScheduleEvent e) => Card(
              margin: const EdgeInsets.only(bottom: 10),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Icon(
                      Icons.event_note_outlined,
                      size: 22,
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Text(
                            e.title,
                            style: theme.textTheme.bodyLarge?.copyWith(
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            "${_formatClock(e.startAt)}"
                            "${(e.notes != null && e.notes!.isNotEmpty) ? " · ${e.notes}" : ""}",
                            maxLines: 3,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: theme.colorScheme.onSurfaceVariant,
                            ),
                          ),
                        ],
                      ),
                    ),
                    TextButton(
                      onPressed: () => _confirmDelete(e),
                      child: const Text("删除"),
                    ),
                  ],
                ),
              ),
            ),
          ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return ColoredBox(
      color: AppPalette.mainPanel,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          _buildSubTabBar(theme),
          if (_subTab == 0) ...<Widget>[
            _weekRangeControls(theme),
            // 根据视图模式显示不同的网格
            if (_viewMode == 'day')
              _dayGrid(theme)
            else
              _weekGrid(theme),
          ] else
            Expanded(child: _managementView(theme)),
        ],
      ),
    );
  }
}

/// 与参考图一致的金色圆角虚线选中框。
class _DashedGoldBorder extends StatelessWidget {
  const _DashedGoldBorder({required this.radius});

  final double radius;

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      painter: _DashedGoldPainter(radius: radius),
    );
  }
}

class _DashedGoldPainter extends CustomPainter {
  _DashedGoldPainter({required this.radius});

  final double radius;
  static const Color _gold = Color(0xFFE8C547);

  @override
  void paint(Canvas canvas, Size size) {
    final double inset = 1.25;
    final RRect rrect = RRect.fromRectAndRadius(
      Rect.fromLTWH(
        inset,
        inset,
        size.width - inset * 2,
        size.height - inset * 2,
      ),
      Radius.circular(max(0, radius - inset)),
    );
    final Path outline = Path()..addRRect(rrect);
    final Paint paint = Paint()
      ..color = _gold
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5;
    const double dash = 5;
    const double gap = 3.5;
    for (final ui.PathMetric metric in outline.computeMetrics()) {
      double distance = 0;
      while (distance < metric.length) {
        final double len = min(dash, metric.length - distance);
        canvas.drawPath(
          metric.extractPath(distance, distance + len),
          paint,
        );
        distance += len + gap;
      }
    }
  }

  @override
  bool shouldRepaint(covariant _DashedGoldPainter oldDelegate) =>
      oldDelegate.radius != radius;
}
