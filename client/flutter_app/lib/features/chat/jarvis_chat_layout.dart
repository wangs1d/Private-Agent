import "package:flutter/material.dart";

import "../../core/models/schedule_models.dart";
import "../../core/services/desk_pet_session.dart";
import "../../core/services/schedule_floating_launcher.dart";
import "../../core/services/schedule_preference.dart";

/// 强调色（品牌色）：与主题无关，深浅都保留辨识度。
const Color _kAccentBlue = Color(0xFF007AFF);
const Color _kAccentGreen = Color(0xFF34C759);
const Color _kAccentOrange = Color(0xFFFF9500);

/// 复刻 jarvis-agent-ui.html 的桌面端聊天主内容区布局。
///
/// 包含：中间聊天区、右侧快捷功能面板、桌面悬浮日程窗、底部悬浮桌宠。
///
/// 配色完全跟随 [Theme.of] / [ColorScheme]，深色 / 暖色 / 米色主题下
/// 背景、卡片、文字、阴影/叠加色都会一并切换。强调色（蓝/绿/橙）保留为
/// 品牌色，不随主题翻转。
class JarvisChatLayout extends StatefulWidget {
  const JarvisChatLayout({
    super.key,
    required this.child,
    this.scheduleFuture,
    this.onAgentLink,
    this.onGames,
    this.onSchedule,
    this.onWallet,
    this.onPhone,
    this.onTranslate,
    this.onNotes,
  });

  /// 中间的聊天页（通常为 ChatPage）。
  final Widget child;

  /// 今日日程数据 Future；为 null 时显示空状态。
  final Future<List<ScheduleEvent>>? scheduleFuture;

  /// 点击常用工具「好友」：打开 Agent Link。
  final VoidCallback? onAgentLink;

  /// 点击常用工具「搜索」：打开游戏中心。
  final VoidCallback? onGames;

  /// 点击常用工具「日程」：打开日程面板。
  final VoidCallback? onSchedule;

  /// 点击常用工具「钱包」：打开钱包对话框。
  final VoidCallback? onWallet;

  /// 点击常用工具「手机」：打开虚拟电话拨号页。
  final VoidCallback? onPhone;

  /// 点击常用工具「翻译」：打开翻译工具。
  final VoidCallback? onTranslate;

  /// 点击常用工具「笔记」：打开与笔记 Agent 的独立对话页。
  final VoidCallback? onNotes;

  @override
  State<JarvisChatLayout> createState() => _JarvisChatLayoutState();
}

class _JarvisChatLayoutState extends State<JarvisChatLayout>
    with TickerProviderStateMixin {
  late final AnimationController _petFloatController;
  late final AnimationController _shadowPulseController;

  bool _toolsExpanded = false;
  bool _showFloatingSchedule = false;
  bool _petAwake = false;
  Offset _floatingSchedulePosition = const Offset(120, 120);

  /// 是否使用桌面独立悬浮窗模式（vs 应用内嵌）
  bool _useDesktopFloating = false;

  /// 桌面悬浮窗当前是否已激活
  bool _scheduleWindowActive = false;

  @override
  void initState() {
    super.initState();
    _petFloatController = AnimationController(
      duration: const Duration(seconds: 4),
      vsync: this,
    )..repeat(reverse: true);

    _shadowPulseController = AnimationController(
      duration: const Duration(seconds: 3),
      vsync: this,
    )..repeat(reverse: true);

    DeskPetSession.instance.addListener(_onDeskPetChanged);

    // 加载用户日程显示偏好，如果是桌面悬浮模式则自动启动
    _loadSchedulePreference();
  }

  /// 加载保存的日程显示偏好
  Future<void> _loadSchedulePreference() async {
    final ScheduleDisplayMode mode = await SchedulePreference.getDisplayMode();
    if (mounted) {
      setState(() {
        _useDesktopFloating = mode == ScheduleDisplayMode.desktopFloating;
      });
      // 如果用户之前选择了桌面悬浮窗模式，自动启动
      if (_useDesktopFloating) {
        _launchDesktopScheduleWindow();
      }
    }
  }

  @override
  void dispose() {
    DeskPetSession.instance.removeListener(_onDeskPetChanged);
    ScheduleFloatingLauncher.activeNotifier.removeListener(_onScheduleWindowChanged);
    _petFloatController.dispose();
    _shadowPulseController.dispose();
    super.dispose();
  }

  void _onDeskPetChanged() {
    if (mounted) setState(() {});
  }

  /// 启动桌面独立悬浮窗
  Future<void> _launchDesktopScheduleWindow() async {
    final bool launched = await ScheduleFloatingLauncher.launch();
    if (mounted) {
      setState(() => _scheduleWindowActive = launched);
    }
    // 监听窗口状态变化
    ScheduleFloatingLauncher.activeNotifier.addListener(_onScheduleWindowChanged);
  }

  /// 监听悬浮窗状态变化
  void _onScheduleWindowChanged() {
    if (mounted) {
      setState(() => _scheduleWindowActive = ScheduleFloatingLauncher.isRunning);
    }
  }

  /// 关闭桌面悬浮窗
  Future<void> _closeDesktopScheduleWindow() async {
    await ScheduleFloatingLauncher.close();
    if (mounted) {
      setState(() => _scheduleWindowActive = false);
    }
    ScheduleFloatingLauncher.activeNotifier.removeListener(_onScheduleWindowChanged);
  }

  /// 切换桌面悬浮窗模式（用户手动切换开关时调用）
  Future<void> _onDesktopFloatingToggled(bool value) async {
    setState(() => _useDesktopFloating = value);

    // 保存偏好
    await SchedulePreference.setDisplayMode(
      value ? ScheduleDisplayMode.desktopFloating : ScheduleDisplayMode.embedded,
    );

    if (value) {
      // 切换到桌面模式：启动独立窗口，隐藏应用内浮动面板
      _showFloatingSchedule = false;
      await _launchDesktopScheduleWindow();
    } else {
      // 切换回应用内嵌：关闭独立窗口
      await _closeDesktopScheduleWindow();
    }
  }

  // 浅色主题下表示"描边 / 文字 / 叠加"应使用黑色系，
  // 深色主题下应使用白色系，整体保持一致的相对亮度。
  Color _ink(BuildContext context, double alpha) {
    final bool isDark = Theme.of(context).brightness == Brightness.dark;
    return (isDark ? Colors.white : Colors.black).withValues(alpha: alpha);
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return ColoredBox(
      color: cs.surface,
      child: Stack(
        clipBehavior: Clip.none,
        children: <Widget>[
          Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Expanded(
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    Expanded(child: widget.child),
                    Container(
                      width: 288,
                      decoration: BoxDecoration(
                        color: cs.surfaceContainerLow,
                        border: Border(
                          left: BorderSide(
                              color: cs.outline.withValues(alpha: 0.35)),
                        ),
                      ),
                      child: _buildRightPanel(),
                    ),
                  ],
                ),
              ),
            ],
          ),
          if (_showFloatingSchedule && !_useDesktopFloating)
              _buildFloatingSchedule(),
        ],
      ),
    );
  }

  // ========== 右侧快捷功能面板 ==========

  Widget _buildRightPanel() {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          decoration: BoxDecoration(
            border: Border(
              bottom: BorderSide(color: cs.outline.withValues(alpha: 0.35)),
            ),
          ),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  "快捷功能",
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    color: cs.onSurface,
                  ),
                ),
              ),
              // 桌面日程模式圆圈按钮 — 桌面模式开启时作为关闭入口
              _ScheduleModeCircleButton(
                active: _useDesktopFloating,
                onTap: () => _onDesktopFloatingToggled(!_useDesktopFloating),
              ),
            ],
          ),
        ),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: <Widget>[
              // 桌面悬浮窗模式开启时，应用内今日安排卡片整体隐藏
              if (!_useDesktopFloating) _buildScheduleCard(),
              const SizedBox(height: 16),
              _buildToolsCard(),
            ],
          ),
        ),
        _buildPetArea(),
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
              // 桌面悬浮窗模式开关在右侧"快捷功能"标题栏内（避免应用内卡片隐藏后无法关闭）
            ],
          ),
          const SizedBox(height: 12),
          if (widget.scheduleFuture == null)
            Text(
              "暂无日程数据",
              style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
            )
          else
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
                final List<ScheduleEvent> items = (snapshot.data ?? <ScheduleEvent>[])
                  ..sort((a, b) => a.startAt.compareTo(b.startAt));
                if (items.isEmpty) {
                  return Padding(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: Text(
                      "今天还没有安排",
                      style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
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
    // 钱包是常用入口，默认放在第一行直接可见；其他工具按频次排列。
    final List<_ToolSpec> firstRow = <_ToolSpec>[
      _ToolSpec(icon: Icons.people_outline, label: "好友", onTap: widget.onAgentLink),
      _ToolSpec(icon: Icons.account_balance_wallet_outlined, label: "钱包", onTap: widget.onWallet),
      _ToolSpec(icon: Icons.translate, label: "翻译", onTap: widget.onTranslate),
      _ToolSpec(icon: Icons.phone_iphone, label: "手机", onTap: widget.onPhone),
    ];
    final List<_ToolSpec> secondRow = <_ToolSpec>[
      _ToolSpec(icon: Icons.sports_esports_outlined, label: "游戏", onTap: widget.onGames),
      _ToolSpec(icon: Icons.home_outlined, label: "家居"),
      _ToolSpec(icon: Icons.note_alt_outlined, label: "笔记"),
      _ToolSpec(icon: Icons.calendar_today_outlined, label: "日程", onTap: widget.onSchedule),
    ];

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
                    onTap: () => setState(() => _toolsExpanded = !_toolsExpanded),
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
          _buildToolsGrid(firstRow),
          AnimatedSize(
            duration: const Duration(milliseconds: 350),
            curve: Curves.easeOut,
            child: _toolsExpanded
                ? Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: _buildToolsGrid(secondRow),
                  )
                : const SizedBox.shrink(),
          ),
        ],
      ),
    );
  }

  Widget _buildToolsGrid(List<_ToolSpec> tools) {
    return GridView.count(
      crossAxisCount: 4,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      mainAxisSpacing: 6,
      crossAxisSpacing: 6,
      childAspectRatio: 0.85,
      children: tools.map((tool) => _ToolButton(spec: tool)).toList(),
    );
  }

  Widget _buildPetArea() {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return AnimatedBuilder(
      animation: Listenable.merge(<Listenable>[
        _petFloatController,
        _shadowPulseController,
      ]),
      builder: (BuildContext context, Widget? child) {
        final bool summoned = DeskPetSession.instance.isSummoned;
        final double floatOffset = summoned ? -10 : -6;
        final double shadowOpacity = summoned
            ? 0.5 + 0.5 * _shadowPulseController.value
            : 0.3 + 0.3 * _shadowPulseController.value;
        final double shadowScale = summoned
            ? 1 + 0.2 * _shadowPulseController.value
            : 0.9 + 0.2 * _shadowPulseController.value;

        return Container(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Transform.translate(
                offset: Offset(0, floatOffset),
                child: Container(
                  width: 56,
                  height: 56,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    gradient: const RadialGradient(
                      center: Alignment(-0.3, -0.3),
                      colors: <Color>[
                        _kAccentBlue,
                        Color(0xCC007AFF),
                        Color(0xE60056D2),
                      ],
                    ),
                    boxShadow: <BoxShadow>[
                      BoxShadow(
                        color: _kAccentBlue.withValues(
                            alpha: summoned ? 0.35 : 0.25),
                        blurRadius: 20,
                        offset: Offset.zero,
                      ),
                    ],
                    border: Border.all(
                      color: cs.onSurface.withValues(alpha: 0.2),
                      width: 1,
                    ),
                  ),
                  alignment: Alignment.center,
                  child: Icon(
                    Icons.smart_toy_outlined,
                    size: 26,
                    color: cs.onInverseSurface,
                  ),
                ),
              ),
              const SizedBox(height: 4),
              Transform.scale(
                scale: shadowScale,
                child: Container(
                  width: 50,
                  height: 10,
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(999),
                    gradient: RadialGradient(
                      colors: <Color>[
                        _kAccentBlue.withValues(alpha: shadowOpacity),
                        _kAccentBlue.withValues(alpha: shadowOpacity * 0.3),
                        Colors.transparent,
                      ],
                      stops: const <double>[0.0, 0.4, 0.7],
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 12),
              _buildPetToggleButton(),
            ],
          ),
        );
      },
    );
  }

  Widget _buildPetToggleButton() {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(999),
        onTap: () => setState(() => _petAwake = !_petAwake),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 5),
          decoration: BoxDecoration(
            color: _ink(context, 0.05),
            borderRadius: BorderRadius.circular(999),
            border: Border.all(color: _ink(context, 0.1)),
          ),
          child: Text(
            _petAwake ? "休眠" : "唤醒",
            style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant),
          ),
        ),
      ),
    );
  }

  // ========== 桌面悬浮日程窗 ==========

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
    const List<String> labels = <String>["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
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

/// 桌面日程模式圆圈切换按钮
///
/// - `active = false`：空心圆圈，hover/focus 时显示蓝色描边
/// - `active = true`：实心蓝色圆圈带勾选标记
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
