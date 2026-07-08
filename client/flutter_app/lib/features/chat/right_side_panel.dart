import "dart:async" show unawaited;

import "package:flutter/foundation.dart" show kIsWeb, defaultTargetPlatform;
import "package:flutter/material.dart";

import "../../core/models/schedule_models.dart";
import "../../core/services/desk_pet_session.dart";
import "../../core/services/schedule_floating_launcher.dart";
import "../../core/services/schedule_preference.dart";

const Color _kAccentBlue = Color(0xFF007AFF);
const Color _kAccentGreen = Color(0xFF34C759);
const Color _kAccentOrange = Color(0xFFFF9500);

/// 右侧快捷功能面板的固定宽度。
/// 调用方在 [Positioned] 和占位 [SizedBox] 中都使用同一个值，
/// 保证 AppBar / 聊天区 / 右面板三者对齐。
const double kRightSidePanelWidth = 288.0;

/// 页面右侧快捷功能面板。
///
/// 与 [NextbotChatLayout] 解耦，可在外层 Stack 用 [Positioned] 定位到 top:0，
/// 让面板从屏幕最顶部贯通到底部，把顶部 AppBar 在面板宽度范围内"顶开"。
class RightSidePanel extends StatefulWidget {
  const RightSidePanel({
    super.key,
    this.scheduleFuture,
    this.onAgentLink,
    this.onSchedule,
    this.onWallet,
    this.onPhone,
    this.onNotes,
    this.onMessages,
  });

  final Future<List<ScheduleEvent>>? scheduleFuture;
  final VoidCallback? onAgentLink;
  final VoidCallback? onSchedule;
  final VoidCallback? onWallet;
  final VoidCallback? onPhone;
  final VoidCallback? onNotes;
  final VoidCallback? onMessages;

  @override
  State<RightSidePanel> createState() => _RightSidePanelState();
}

class _RightSidePanelState extends State<RightSidePanel> {
  bool _toolsExpanded = false;
  bool _showFloatingSchedule = false;
  Offset _floatingSchedulePosition = const Offset(120, 120);
  bool _useDesktopFloating = false;
  bool _scheduleWindowActive = false;

  @override
  void initState() {
    super.initState();
    DeskPetSession.instance.addListener(_onDeskPetChanged);
    _loadSchedulePreference();
    ScheduleFloatingLauncher.bindHandlers(
      onCloseClicked: () {
        if (mounted) {
          setState(() {
            _useDesktopFloating = false;
            _scheduleWindowActive = false;
          });
          ScheduleFloatingLauncher.activeNotifier
              .removeListener(_onScheduleWindowChanged);
          SchedulePreference.setDisplayMode(ScheduleDisplayMode.embedded);
        }
      },
    );
  }

  @override
  void dispose() {
    DeskPetSession.instance.removeListener(_onDeskPetChanged);
    ScheduleFloatingLauncher.activeNotifier
        .removeListener(_onScheduleWindowChanged);
    super.dispose();
  }

  void _onDeskPetChanged() {
    if (mounted) setState(() {});
  }

  Future<void> _loadSchedulePreference() async {
    final ScheduleDisplayMode mode = await SchedulePreference.getDisplayMode();
    if (mounted) {
      setState(() {
        _useDesktopFloating = mode == ScheduleDisplayMode.desktopFloating;
      });
    }
  }

  Future<void> _launchDesktopScheduleWindow() async {
    final bool launched = await ScheduleFloatingLauncher.launch();
    if (mounted) {
      setState(() => _scheduleWindowActive = launched);
    }
    ScheduleFloatingLauncher.activeNotifier
        .addListener(_onScheduleWindowChanged);
    if (launched) {
      _pushScheduleToNativeWindow();
    }
  }

  void _pushScheduleToNativeWindow() {
    final Future<List<ScheduleEvent>>? future = widget.scheduleFuture;
    if (future == null) {
      ScheduleFloatingLauncher.setSchedule(<ScheduleFloatingItem>[]);
      return;
    }
    future.then((List<ScheduleEvent> events) {
      final List<ScheduleEvent> sorted =
          List<ScheduleEvent>.from(events)
            ..sort((a, b) => a.startAt.compareTo(b.startAt));
      final List<ScheduleFloatingItem> items = sorted
          .map((e) => ScheduleFloatingItem(
                id: e.id,
                timeText:
                    "${e.startAt.hour.toString().padLeft(2, '0')}:${e.startAt.minute.toString().padLeft(2, '0')}",
                title: e.title,
              ))
          .toList();
      ScheduleFloatingLauncher.setSchedule(items);
    });
  }

  void _onScheduleWindowChanged() {
    if (mounted) {
      setState(() => _scheduleWindowActive = ScheduleFloatingLauncher.isRunning);
    }
  }

  Future<void> _closeDesktopScheduleWindow() async {
    await ScheduleFloatingLauncher.close();
    if (mounted) {
      setState(() => _scheduleWindowActive = false);
    }
    ScheduleFloatingLauncher.activeNotifier
        .removeListener(_onScheduleWindowChanged);
  }

  Future<void> _onDesktopFloatingToggled(bool value) async {
    if (value) {
      _showFloatingSchedule = false;
      final bool launched = await ScheduleFloatingLauncher.launch();
      if (!mounted) return;
      if (launched) {
        setState(() {
          _useDesktopFloating = true;
          _scheduleWindowActive = true;
        });
        ScheduleFloatingLauncher.activeNotifier
            .addListener(_onScheduleWindowChanged);
        _pushScheduleToNativeWindow();
      } else {
        setState(() => _scheduleWindowActive = false);
      }
    } else {
      await _closeDesktopScheduleWindow();
      setState(() => _useDesktopFloating = false);
    }
    await SchedulePreference.setDisplayMode(
      _useDesktopFloating
          ? ScheduleDisplayMode.desktopFloating
          : ScheduleDisplayMode.embedded,
    );
  }

  Color _ink(BuildContext context, double alpha) {
    final bool isDark = Theme.of(context).brightness == Brightness.dark;
    return (isDark ? Colors.white : Colors.black).withValues(alpha: alpha);
  }

  void _logDeskPetEvent(String action) {
    debugPrint(
      '[DeskPet] action=$action | platform=$_currentPlatformTag | timestamp=${DateTime.now().toIso8601String()}',
    );
  }

  String get _currentPlatformTag => kIsWeb
      ? 'web'
      : defaultTargetPlatform.toString().split('.').last.toLowerCase();

  Future<void> _onSummonPet() async {
    _logDeskPetEvent('summon_clicked');
    final bool ok = await DeskPetSession.instance.summon();
    if (!mounted) return;
    _logDeskPetEvent(ok ? 'summon_succeeded' : 'summon_failed');
  }

  Future<void> _onDismissPet() async {
    _logDeskPetEvent('dismiss_clicked');
    await DeskPetSession.instance.dismiss();
    _logDeskPetEvent('dismiss_succeeded');
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      clipBehavior: Clip.none,
      children: <Widget>[
        Container(
          decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.surfaceContainerLow,
            border: Border(
              left: BorderSide(
                color: Theme.of(context)
                    .colorScheme
                    .outline
                    .withValues(alpha: 0.35),
              ),
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(16, 16, 16, 16),
                  children: <Widget>[
                    _buildScheduleCard(),
                    const SizedBox(height: 16),
                    _buildToolsCard(),
                  ],
                ),
              ),
              _buildPetArea(),
            ],
          ),
        ),
        if (_showFloatingSchedule && !_useDesktopFloating)
          _buildFloatingSchedule(),
      ],
    );
  }

  Widget _buildScheduleCard() {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final DateTime now = DateTime.now();
    final String dateLabel =
        "${now.month}月${now.day}日 ${_weekdayLabel(now.weekday)}";

    return Container(
      decoration: BoxDecoration(
        color: cs.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: cs.outline.withValues(alpha: 0.35)),
        boxShadow: <BoxShadow>[
          BoxShadow(
            color: _ink(context, 0.06),
            blurRadius: 12,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Row(
            children: <Widget>[
              const Icon(Icons.calendar_today_outlined,
                  size: 16, color: _kAccentBlue),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  "今日安排",
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: cs.onSurface,
                  ),
                ),
              ),
              Text(
                dateLabel,
                style: const TextStyle(fontSize: 11, color: _kAccentBlue),
              ),
              const SizedBox(width: 4),
              _ScheduleModeCircleButton(
                active: _useDesktopFloating,
                onTap: () => _onDesktopFloatingToggled(!_useDesktopFloating),
              ),
            ],
          ),
          const SizedBox(height: 12),
          if (_useDesktopFloating)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Row(
                children: <Widget>[
                  Icon(Icons.check_circle_outline,
                      size: 14, color: _kAccentGreen),
                  const SizedBox(width: 6),
                  Text(
                    _scheduleWindowActive ? "桌面悬浮窗已开启" : "正在启动桌面悬浮窗…",
                    style: TextStyle(
                      fontSize: 11,
                      color: _scheduleWindowActive
                          ? _kAccentGreen
                          : cs.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
          if (!_useDesktopFloating && widget.scheduleFuture == null)
            Text(
              "暂无日程数据",
              style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
            )
          else if (!_useDesktopFloating)
            FutureBuilder<List<ScheduleEvent>>(
              future: widget.scheduleFuture,
              builder: (
                BuildContext context,
                AsyncSnapshot<List<ScheduleEvent>> snapshot,
              ) {
                if (snapshot.connectionState == ConnectionState.waiting) {
                  return const Center(
                    child: Padding(
                      padding: EdgeInsets.all(12),
                      child: SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    ),
                  );
                }
                final List<ScheduleEvent> items =
                    (snapshot.data ?? <ScheduleEvent>[])
                      ..sort((a, b) => a.startAt.compareTo(b.startAt));
                if (items.isEmpty) {
                  return Padding(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: Text(
                      "今天还没有安排",
                      style: TextStyle(
                          fontSize: 12, color: cs.onSurfaceVariant),
                    ),
                  );
                }
                return Column(
                  mainAxisSize: MainAxisSize.min,
                  children: items.map((ScheduleEvent e) {
                    final String time =
                        "${e.startAt.hour.toString().padLeft(2, '0')}:${e.startAt.minute.toString().padLeft(2, '0')}";
                    return _buildScheduleRow(e, time);
                  }).toList(),
                );
              },
            ),
        ],
      ),
    );
  }

  Widget _buildScheduleRow(ScheduleEvent event, String time) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final Color timeColor;
    final int hour = event.startAt.hour;
    if (hour < 10) {
      timeColor = _kAccentBlue;
    } else if (hour < 14) {
      timeColor = _kAccentOrange;
    } else if (hour < 18) {
      timeColor = _kAccentGreen;
    } else {
      timeColor = cs.onSurfaceVariant;
    }

    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: () {},
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 6),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Column(
                children: <Widget>[
                  Text(
                    time,
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                      color: timeColor,
                    ),
                  ),
                  Container(
                    width: 1,
                    height: 18,
                    margin: const EdgeInsets.only(top: 4),
                    color: cs.outline.withValues(alpha: 0.5),
                  ),
                ],
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      event.title,
                      style: TextStyle(
                        fontSize: 12,
                        color: cs.onSurface,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    if (event.notes != null && event.notes!.isNotEmpty)
                      Text(
                        event.notes!,
                        style: TextStyle(
                          fontSize: 10,
                          color: cs.onSurfaceVariant,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildToolsCard() {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final List<_ToolSpec> allTools = <_ToolSpec>[
      _ToolSpec(
          icon: Icons.people_outline, label: "好友", onTap: widget.onAgentLink),
      _ToolSpec(
          icon: Icons.account_balance_wallet_outlined,
          label: "钱包",
          onTap: widget.onWallet),
      _ToolSpec(
          icon: Icons.phone_iphone, label: "手机", onTap: widget.onPhone),
      _ToolSpec(
          icon: Icons.message_outlined, label: "消息", onTap: widget.onMessages),
      _ToolSpec(
          icon: Icons.note_alt_outlined, label: "笔记", onTap: widget.onNotes),
      _ToolSpec(
          icon: Icons.calendar_today_outlined,
          label: "日程",
          onTap: widget.onSchedule),
    ];
    const int collapsedCount = 3;
    final List<_ToolSpec> visibleTools = _toolsExpanded
        ? allTools
        : allTools.take(collapsedCount).toList();

    return Container(
      decoration: BoxDecoration(
        color: cs.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _ink(context, 0.08)),
        boxShadow: <BoxShadow>[
          BoxShadow(
            color: _ink(context, 0.06),
            blurRadius: 12,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  "常用工具",
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: cs.onSurface,
                  ),
                ),
              ),
              Tooltip(
                message: _toolsExpanded ? "收起" : "展开更多",
                child: Material(
                  color: Colors.transparent,
                  child: InkWell(
                    borderRadius: BorderRadius.circular(8),
                    onTap: () =>
                        setState(() => _toolsExpanded = !_toolsExpanded),
                    child: AnimatedRotation(
                      turns: _toolsExpanded ? 0.25 : 0,
                      duration: const Duration(milliseconds: 300),
                      child: Container(
                        width: 28,
                        height: 28,
                        alignment: Alignment.center,
                        child: Icon(
                          Icons.more_horiz,
                          size: 18,
                          color: cs.onSurfaceVariant,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          AnimatedSize(
            duration: const Duration(milliseconds: 350),
            curve: Curves.easeOut,
            child: _buildToolsGrid(visibleTools),
          ),
        ],
      ),
    );
  }

  Widget _buildToolsGrid(List<_ToolSpec> tools) {
    final int crossAxisCount = tools.length <= 4 ? tools.length : 4;
    return GridView.count(
      crossAxisCount: crossAxisCount,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      mainAxisSpacing: 6,
      crossAxisSpacing: 6,
      childAspectRatio: 0.85,
      children: tools.map((tool) => _ToolButton(spec: tool)).toList(),
    );
  }

  Widget _buildPetArea() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
      child: Center(child: _buildPetToggleButton()),
    );
  }

  Widget _buildPetToggleButton() {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final bool summoned = DeskPetSession.instance.isSummoned;
    final bool supported = DeskPetSession.isSupported;

    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(999),
        onTap: supported
            ? () {
                if (summoned) {
                  unawaited(_onDismissPet());
                } else {
                  unawaited(_onSummonPet());
                }
              }
            : null,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 5),
          decoration: BoxDecoration(
            color: _ink(context, 0.05),
            borderRadius: BorderRadius.circular(999),
            border: Border.all(color: _ink(context, 0.1)),
          ),
          child: Text(
            summoned ? "休眠" : "唤醒",
            style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant),
          ),
        ),
      ),
    );
  }

  Widget _buildFloatingSchedule() {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final bool isDark = Theme.of(context).brightness == Brightness.dark;
    final DateTime now = DateTime.now();
    final String dateLabel =
        "${now.month}月${now.day}日 ${_weekdayLabel(now.weekday)}";

    return Positioned(
      left: _floatingSchedulePosition.dx,
      top: _floatingSchedulePosition.dy,
      child: GestureDetector(
        onPanUpdate: (DragUpdateDetails details) {
          setState(() {
            _floatingSchedulePosition += details.delta;
          });
        },
        child: Material(
          elevation: 16,
          borderRadius: BorderRadius.circular(16),
          clipBehavior: Clip.antiAlias,
          child: Container(
            width: 280,
            decoration: BoxDecoration(
              color: cs.surface.withValues(alpha: isDark ? 0.95 : 0.98),
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: _ink(context, 0.08)),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                GestureDetector(
                  behavior: HitTestBehavior.translucent,
                  onPanUpdate: (DragUpdateDetails details) {
                    setState(() {
                      _floatingSchedulePosition += details.delta;
                    });
                  },
                  child: Container(
                    padding: const EdgeInsets.fromLTRB(14, 12, 8, 12),
                    decoration: BoxDecoration(
                      border: Border(
                        bottom: BorderSide(
                          color: _ink(context, 0.08),
                        ),
                      ),
                    ),
                    child: Row(
                      children: <Widget>[
                        const Icon(
                          Icons.calendar_today_outlined,
                          size: 16,
                          color: _kAccentBlue,
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            "今日安排",
                            style: TextStyle(
                              fontSize: 13,
                              fontWeight: FontWeight.w600,
                              color: cs.onSurface,
                            ),
                          ),
                        ),
                        Text(
                          dateLabel,
                          style: const TextStyle(
                              fontSize: 11, color: _kAccentBlue),
                        ),
                        const SizedBox(width: 4),
                        IconButton(
                          iconSize: 18,
                          padding: EdgeInsets.zero,
                          constraints: const BoxConstraints.tightFor(
                            width: 26,
                            height: 26,
                          ),
                          icon: Icon(Icons.close, color: cs.onSurfaceVariant),
                          onPressed: () =>
                              setState(() => _showFloatingSchedule = false),
                          tooltip: "收起",
                        ),
                      ],
                    ),
                  ),
                ),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 400),
                  child: widget.scheduleFuture == null
                      ? Padding(
                          padding: const EdgeInsets.all(16),
                          child: Text(
                            "暂无日程数据",
                            style: TextStyle(
                                fontSize: 12, color: cs.onSurfaceVariant),
                          ),
                        )
                      : FutureBuilder<List<ScheduleEvent>>(
                          future: widget.scheduleFuture,
                          builder: (
                            BuildContext context,
                            AsyncSnapshot<List<ScheduleEvent>> snapshot,
                          ) {
                            if (snapshot.connectionState ==
                                ConnectionState.waiting) {
                              return const Padding(
                                padding: EdgeInsets.all(24),
                                child: Center(
                                  child: SizedBox(
                                    width: 20,
                                    height: 20,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                    ),
                                  ),
                                ),
                              );
                            }
                            final List<ScheduleEvent> items =
                                (snapshot.data ?? <ScheduleEvent>[])
                                  ..sort((a, b) =>
                                      a.startAt.compareTo(b.startAt));
                            return ListView(
                              padding: const EdgeInsets.all(14),
                              shrinkWrap: true,
                              children: items
                                  .map((e) => _buildScheduleRow(
                                      e,
                                      "${e.startAt.hour.toString().padLeft(2, '0')}:${e.startAt.minute.toString().padLeft(2, '0')}"))
                                  .toList(),
                            );
                          },
                        ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  String _weekdayLabel(int weekday) {
    const List<String> labels = <String>[
      "",
      "周一",
      "周二",
      "周三",
      "周四",
      "周五",
      "周六",
      "周日"
    ];
    return labels[weekday];
  }
}

class _ToolSpec {
  _ToolSpec({required this.icon, required this.label, this.onTap});

  final IconData icon;
  final String label;
  final VoidCallback? onTap;
}

class _ToolButton extends StatefulWidget {
  const _ToolButton({required this.spec});

  final _ToolSpec spec;

  @override
  State<_ToolButton> createState() => _ToolButtonState();
}

class _ToolButtonState extends State<_ToolButton>
    with SingleTickerProviderStateMixin {
  bool _hovering = false;
  late final AnimationController _breatheController;

  @override
  void initState() {
    super.initState();
    _breatheController = AnimationController(
      duration: const Duration(seconds: 2),
      vsync: this,
    );
  }

  @override
  void dispose() {
    _breatheController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_hovering && !_breatheController.isAnimating) {
      _breatheController.repeat(reverse: true);
    } else if (!_hovering && _breatheController.isAnimating) {
      _breatheController.stop();
    }

    final ColorScheme cs = Theme.of(context).colorScheme;
    return MouseRegion(
      onEnter: (_) => setState(() => _hovering = true),
      onExit: (_) => setState(() => _hovering = false),
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: () => widget.spec.onTap?.call(),
        behavior: HitTestBehavior.opaque,
        child: AnimatedBuilder(
          animation: _breatheController,
          builder: (BuildContext context, Widget? child) {
            final double t = _breatheController.value;
            final Color borderColor = _hovering
                ? Color.lerp(
                    _kAccentBlue.withValues(alpha: 0.3),
                    _kAccentBlue.withValues(alpha: 0.7),
                    t,
                  )!
                : Colors.transparent;
            return AnimatedContainer(
              duration: const Duration(milliseconds: 200),
              curve: Curves.easeOut,
              decoration: BoxDecoration(
                color: Colors.transparent,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(
                  color: borderColor,
                  width: 1,
                ),
                boxShadow: _hovering
                    ? <BoxShadow>[
                        BoxShadow(
                          color:
                              _kAccentBlue.withValues(alpha: 0.15 + 0.15 * t),
                          blurRadius: 12 + 13 * t,
                          offset: Offset.zero,
                        ),
                      ]
                    : null,
              ),
              child: child,
            );
          },
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              Icon(
                widget.spec.icon,
                size: 18,
                color: cs.onSurfaceVariant,
              ),
              const SizedBox(height: 5),
              Text(
                widget.spec.label,
                style: TextStyle(
                  fontSize: 10,
                  fontWeight: FontWeight.w500,
                  color: cs.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ScheduleModeCircleButton extends StatelessWidget {
  const _ScheduleModeCircleButton({
    required this.active,
    required this.onTap,
  });

  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Tooltip(
      message: active ? "已开启桌面悬浮窗（点击关闭）" : "开启桌面独立悬浮窗",
      child: Material(
        color: Colors.transparent,
        shape: CircleBorder(
          side: BorderSide(
            color: active ? _kAccentBlue : cs.outline.withValues(alpha: 0.55),
            width: active ? 2 : 1.4,
          ),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          customBorder: const CircleBorder(),
          child: SizedBox(
            width: 26,
            height: 26,
            child: Center(
              child: active
                  ? const Icon(Icons.check, size: 16, color: _kAccentBlue)
                  : Icon(
                      Icons.desktop_windows_outlined,
                      size: 14,
                      color: cs.onSurfaceVariant,
                    ),
            ),
          ),
        ),
      ),
    );
  }
}
