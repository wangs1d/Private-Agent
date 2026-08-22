import "dart:async" show unawaited;
import "dart:convert" show jsonDecode;
import "dart:math" show max, min;

import "package:flutter/foundation.dart" show kIsWeb, defaultTargetPlatform;
import "package:flutter/material.dart";
import "package:http/http.dart" as http;

import "../../core/config/api_config.dart";
import "../../core/models/schedule_models.dart";
import "../../core/services/client_location_service.dart";
import "../../core/services/desk_pet_session.dart";
import "../../core/services/schedule_floating_launcher.dart";
import "../../core/services/schedule_preference.dart";

const Color _kAccentBlue = Color(0xFF18D6F3);
const Color _kAccentGreen = Color(0xFF1ED7A6);
const Color _kAccentOrange = Color(0xFFD7B85A);

/// 右侧快捷功能面板的固定宽度。
/// 优化后收窄到 220px，减少视觉压迫感，让聊天区更开阔。
const double kRightSidePanelWidth = 220.0;

/// 今日安排标题简洁化：剥离「该X啦」提醒式包装、指令前缀、元描述前缀、
/// 以及和左侧时间列重复的时间词，再清理冗余代词词头，只保留核心文案
/// （与日程页完整标题区分，也与桌面悬浮窗的 web 端逻辑保持一致）。
String _simplifyScheduleTitle(String raw) {
  String s = raw.trim();
  if (s.isEmpty) return s;

  // 提醒式包装：“该去游泳啦，带上泳衣和浴巾！” -> “去游泳”
  final RegExp reminderWrapper = RegExp(r'^该([^啦了，。！!?？\s]{1,10})(啦|了)');
  final Match? wrapper = reminderWrapper.firstMatch(s);
  if (wrapper != null) s = wrapper.group(1)!;

  final RegExp instruction = RegExp(
    r'^\s*(请)?(记得|别忘了|不要忘记|不要忘了|提醒用户|提醒我|提醒一下|提醒|帮我|记着|叫我|喊我|给我|让我)'
    r'\s*(提醒|一下)?',
  );
  final RegExp metaPrefix = RegExp(
    r'^\s*(定时|设置|安排|添加|创建|新增)(一个|一下|个|条)?(提醒|日程|事项)?',
  );
  final RegExp timeExpr = RegExp(
    r'(今天|明天|后天|今晚|明晚|凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|半夜)?'
    r'(\d{1,2}(点|[:：])[:：]?\d{0,2}(分|分钟)?(半|整|左右)?'
    r'|[一二三四五六七八九十两]+点(半|整|左右)?'
    r'|\d{1,2}[:：]\d{2})',
  );
  final RegExp pronoun = RegExp(r'^(我(?!们)|帮我|给我)(的)?');

  // 交替剥离指令前缀 / 元描述前缀 / 时间词 / 冗余代词，直到不再变化：
  // “记得提醒我下午3点帮我买咖啡” -> “我下午3点帮我买咖啡” -> “我帮我买咖啡” -> “买咖啡”
  String prev;
  do {
    prev = s;
    s = s
        .replaceAll(instruction, '')
        .replaceAll(metaPrefix, '')
        .replaceAll(timeExpr, '')
        .replaceAll(pronoun, '');
  } while (s != prev);

  // 清理“的提醒：X”这类残留结构，以及开头的日期词（今日安排均为当天事项）
  s = s.replaceFirst(RegExp(r'^[^：:]*的?(提醒|闹钟|日程)[：:]'), '');
  s = s.replaceFirst(RegExp(r'^(今天|明天|后天|明早|明晚|大后天)'), '');

  s = s.replaceAll(RegExp(r'^[\s，,、.。!！?？\-~—－–]+'), '').trim();
  return s.isEmpty ? "待办事项" : s;
}

/// 页面右侧快捷功能面板。
///
/// 设计理念：简洁、轻盈、不抢视线
/// - 去掉厚重卡片阴影，改用细腻的分隔线区分区块
/// - 工具图标更紧凑，一屏展示全部，无需展开/收起
/// - 日程只展示最近 3 条，保持面板精简
class RightSidePanel extends StatefulWidget {
  const RightSidePanel({
    super.key,
    this.scheduleFuture,
    this.onAgentLink,
    this.onSchedule,
    this.onWallet,
    this.onPhone,
    this.onMessages,
    this.onReportLocation,
  });

  final Future<List<ScheduleEvent>>? scheduleFuture;
  final VoidCallback? onAgentLink;
  final VoidCallback? onSchedule;
  final VoidCallback? onWallet;
  final VoidCallback? onPhone;
  final VoidCallback? onMessages;

  /// 天气面板拿到实时位置后回调上报（填充服务端位置缓存，供 Agent 按需复用）。
  final void Function(Map<String, dynamic> location)? onReportLocation;

  @override
  State<RightSidePanel> createState() => _RightSidePanelState();
}

class _RightSidePanelState extends State<RightSidePanel>
    with SingleTickerProviderStateMixin {
  bool _useDesktopFloating = false;
  late AnimationController _breatheController;
  late Animation<double> _breatheOpacity;

  @override
  void initState() {
    super.initState();
    _breatheController = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 2),
    )..repeat(reverse: true);
    _breatheOpacity = Tween<double>(
      begin: 0.08,
      end: 0.35,
    ).animate(CurvedAnimation(
      parent: _breatheController,
      curve: Curves.easeInOut,
    ));
    DeskPetSession.instance.addListener(_onDeskPetChanged);
    ScheduleFloatingLauncher.bindHandlers(
      onCloseClicked: () {
        if (mounted) {
          setState(() {
            _useDesktopFloating = false;
          });
          ScheduleFloatingLauncher.activeNotifier
              .removeListener(_onScheduleWindowChanged);
          SchedulePreference.setDisplayMode(ScheduleDisplayMode.embedded);
        }
      },
    );
    _loadSchedulePreference();
  }

  @override
  void didUpdateWidget(covariant RightSidePanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    // 日程数据刷新（新 future）时，若桌面悬浮窗已开启，同步推送最新安排
    if (_useDesktopFloating &&
        oldWidget.scheduleFuture != widget.scheduleFuture) {
      _pushScheduleToNativeWindow();
    }
  }

  @override
  void dispose() {
    _breatheController.dispose();
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
    if (mode == ScheduleDisplayMode.desktopFloating) {
      await _launchDesktopScheduleWindow();
    }
  }

  Future<void> _launchDesktopScheduleWindow() async {
    final bool launched = await ScheduleFloatingLauncher.launch();
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
      final DateTime now = DateTime.now();
      final List<ScheduleEvent> sorted =
          List<ScheduleEvent>.from(events)
            ..sort((a, b) => a.startAt.compareTo(b.startAt));
      final List<ScheduleFloatingItem> items = sorted
          .map((e) => ScheduleFloatingItem(
                id: e.id,
                timeText:
                    "${e.startAt.hour.toString().padLeft(2, '0')}:${e.startAt.minute.toString().padLeft(2, '0')}",
                title: e.shortTitle ?? _simplifyScheduleTitle(e.title),
                completed: !e.startAt.isAfter(now),
              ))
          .toList();
      ScheduleFloatingLauncher.setSchedule(items);
    });
  }

  void _onScheduleWindowChanged() {
    if (mounted) {
      setState(() {});
    }
  }

  Future<void> _closeDesktopScheduleWindow() async {
    await ScheduleFloatingLauncher.close();
    ScheduleFloatingLauncher.activeNotifier
        .removeListener(_onScheduleWindowChanged);
  }

  Future<void> _onDesktopFloatingToggled(bool value) async {
    if (value) {
      final bool launched = await ScheduleFloatingLauncher.launch();
      if (!mounted) return;
      if (launched) {
        setState(() {
          _useDesktopFloating = true;
        });
        ScheduleFloatingLauncher.activeNotifier
            .addListener(_onScheduleWindowChanged);
        _pushScheduleToNativeWindow();
      } else {
        setState(() {});
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
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Container(
      decoration: BoxDecoration(
        color: cs.surfaceContainer,
        border: Border(
          left: BorderSide(
            color: cs.outline.withValues(alpha: 0.25),
          ),
        ),
      ),
      child: SafeArea(
        right: false,
        top: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            // 顶部天气 Header：与面板融为一体，顶部贴合
            _WeatherHeader(onReportLocation: widget.onReportLocation),
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                physics: const AlwaysScrollableScrollPhysics(),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    if (!_useDesktopFloating) ...<Widget>[
                    AnimatedBuilder(
                      animation: _breatheOpacity,
                      builder: (context, child) {
                        return Container(
                          decoration: BoxDecoration(
                            border: Border(
                              top: BorderSide(
                              color: cs.outline.withValues(
                                  alpha: _breatheOpacity.value,
                                ),
                              ),
                              bottom: BorderSide(
                                color: cs.outline.withValues(
                                  alpha: _breatheOpacity.value,
                                ),
                              ),
                            ),
                          ),
                          padding: const EdgeInsets.symmetric(vertical: 12),
                          child: child,
                        );
                      },
                      child: _buildScheduleSection(cs),
                    ),
                    const SizedBox(height: 16),
                  ],
                  AnimatedBuilder(
                    animation: _breatheOpacity,
                    builder: (context, child) {
                      return Container(
                        decoration: BoxDecoration(
                          border: Border(
                            top: BorderSide(
                              color: cs.outline.withValues(
                                  alpha: _breatheOpacity.value,
                                ),
                            ),
                            bottom: BorderSide(
                                color: cs.outline.withValues(
                                  alpha: _breatheOpacity.value,
                                ),
                            ),
                          ),
                        ),
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        child: child,
                      );
                    },
                    child: _buildToolsSection(cs),
                  ),
                  ],
                ),
              ),
            ),
            _buildPetFooter(cs),
          ],
        ),
      ),
    );
  }

  // ═══════════════════════════════════════════════════════════
  // 日程区块：精简展示最近 3 条，轻量分割线
  // ═══════════════════════════════════════════════════════════
  Widget _buildScheduleSection(ColorScheme cs) {
    final DateTime now = DateTime.now();
    final String dateLabel =
        "${now.month}月${now.day}日 ${_weekdayLabel(now.weekday)}";

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 2),
          child: Row(
            children: <Widget>[
              const Icon(Icons.calendar_today_outlined,
                  size: 14, color: _kAccentBlue),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  "今日安排",
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: cs.onSurface,
                    letterSpacing: 0.2,
                  ),
                ),
              ),
              Text(
                dateLabel,
                style: TextStyle(
                    fontSize: 10,
                    color: cs.onSurfaceVariant,
                    fontWeight: FontWeight.w500),
              ),
              const SizedBox(width: 4),
              _ScheduleModeCircleButton(
                active: _useDesktopFloating,
                onTap: () => _onDesktopFloatingToggled(!_useDesktopFloating),
              ),
            ],
          ),
        ),
        const SizedBox(height: 10),
        if (widget.scheduleFuture == null)
          _buildEmptySchedule(cs)
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
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  ),
                );
              }
              final List<ScheduleEvent> items =
                  (snapshot.data ?? <ScheduleEvent>[])
                    ..sort((a, b) => a.startAt.compareTo(b.startAt));
              if (items.isEmpty) {
                return _buildEmptySchedule(cs);
              }
              // 只展示最近 3 条，保持面板精简
              final List<ScheduleEvent> visible =
                  items.take(3).toList();
              final int hiddenCount = items.length - visible.length;
              return Column(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  ...visible.map((ScheduleEvent e) {
                    final String time =
                        "${e.startAt.hour.toString().padLeft(2, '0')}:${e.startAt.minute.toString().padLeft(2, '0')}";
                    return _buildScheduleRow(e, time, cs);
                  }),
                  if (hiddenCount > 0)
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Material(
                        color: Colors.transparent,
                        child: InkWell(
                          borderRadius: BorderRadius.circular(6),
                          onTap: widget.onSchedule,
                          child: Padding(
                            padding: const EdgeInsets.symmetric(
                                vertical: 4, horizontal: 4),
                            child: Row(
                              children: <Widget>[
                                const SizedBox(width: 84),
                                Text(
                                  "还有 $hiddenCount 项安排",
                                  style: TextStyle(
                                    fontSize: 10,
                                    color: cs.onSurfaceVariant,
                                    fontWeight: FontWeight.w500,
                                  ),
                                ),
                                const Spacer(),
                                Icon(
                                  Icons.chevron_right,
                                  size: 14,
                                  color: cs.onSurfaceVariant,
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                ],
              );
            },
          ),
      ],
    );
  }

  Widget _buildEmptySchedule(ColorScheme cs) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 4),
      child: Row(
        children: <Widget>[
          const SizedBox(width: 84),
          Text(
            "今天还没有安排",
            style: TextStyle(
                fontSize: 11,
                color: cs.onSurfaceVariant,
                fontWeight: FontWeight.w400),
          ),
        ],
      ),
    );
  }

  Widget _buildScheduleRow(ScheduleEvent event, String time, ColorScheme cs) {
    // 已过时间（视为已完成）的事项：删除线 + 变淡，与日程页的完整卡片样式区分
    final bool passed = !event.startAt.isAfter(DateTime.now());
    final Color timeColor;
    if (passed) {
      timeColor = cs.onSurfaceVariant.withValues(alpha: 0.35);
    } else {
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
    }

    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(6),
        onTap: widget.onSchedule,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 5, horizontal: 4),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              SizedBox(
                width: 34,
                child: Text(
                  time,
                  style: TextStyle(
                    fontSize: 10.5,
                    fontWeight: FontWeight.w600,
                    color: timeColor,
                  ),
                ),
              ),
              // 标题与时间保持至少 50px 间距，向右靠不挨着时间
              const SizedBox(width: 50),
              Expanded(
                child: Text(
                  // 优先使用创建时由 LLM 生成的简洁展示标题，旧数据回退到剥离简化
                  event.shortTitle ?? _simplifyScheduleTitle(event.title),
                  style: TextStyle(
                    fontSize: 11.5,
                    color: passed
                        ? cs.onSurface.withValues(alpha: 0.35)
                        : cs.onSurface,
                    fontWeight: FontWeight.w400,
                    decoration: passed ? TextDecoration.lineThrough : null,
                    decorationColor: cs.onSurface.withValues(alpha: 0.4),
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  // ═══════════════════════════════════════════════════════════
  // 工具区块：紧凑网格布局，一屏展示全部 5 个工具
  // ═══════════════════════════════════════════════════════════
  Widget _buildToolsSection(ColorScheme cs) {
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
          icon: Icons.calendar_today_outlined,
          label: "日程",
          onTap: widget.onSchedule),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 2),
          child: Text(
            "常用工具",
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: cs.onSurface,
              letterSpacing: 0.2,
            ),
          ),
        ),
        const SizedBox(height: 10),
        GridView.count(
          crossAxisCount: 3,
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          mainAxisSpacing: 4,
          crossAxisSpacing: 4,
          childAspectRatio: 1.0,
          children: allTools.map((tool) => _ToolButton(spec: tool)).toList(),
        ),
      ],
    );
  }

  // ═══════════════════════════════════════════════════════════
  // 底部：桌宠唤醒按钮
  // ═══════════════════════════════════════════════════════════
  Widget _buildPetFooter(ColorScheme cs) {
    final bool summoned = DeskPetSession.instance.isSummoned;
    final bool supported = DeskPetSession.isSupported;

    return Container(
      padding: const EdgeInsets.fromLTRB(14, 8, 14, 14),
      decoration: BoxDecoration(
        border: Border(
          top: BorderSide(
            color: cs.outline.withValues(alpha: 0.2),
          ),
        ),
      ),
      child: Center(
        child: Material(
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
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
              decoration: BoxDecoration(
                color: cs.surfaceContainerHighest.withValues(alpha: 0.5),
                borderRadius: BorderRadius.circular(999),
                border: Border.all(
                    color: cs.outline.withValues(alpha: 0.3)),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Icon(
                    summoned
                        ? Icons.nightlight_round
                        : Icons.wb_sunny_outlined,
                    size: 13,
                    color: cs.onSurfaceVariant,
                  ),
                  const SizedBox(width: 5),
                  Text(
                    summoned ? "休眠桌宠" : "唤醒桌宠",
                    style: TextStyle(
                        fontSize: 10.5,
                        color: cs.onSurfaceVariant,
                        fontWeight: FontWeight.w500),
                  ),
                ],
              ),
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

class _ToolButtonState extends State<_ToolButton> {
  bool _hovering = false;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return MouseRegion(
      onEnter: (_) => setState(() => _hovering = true),
      onExit: (_) => setState(() => _hovering = false),
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: () => widget.spec.onTap?.call(),
        behavior: HitTestBehavior.opaque,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 180),
          curve: Curves.easeOut,
          decoration: BoxDecoration(
            color: _hovering
                ? cs.surfaceContainerHigh.withValues(alpha: 0.8)
                : Colors.transparent,
            borderRadius: BorderRadius.circular(10),
          ),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              Icon(
                widget.spec.icon,
                size: 17,
                color: _hovering ? cs.onSurface : cs.onSurfaceVariant,
              ),
              const SizedBox(height: 4),
              Text(
                widget.spec.label,
                style: TextStyle(
                  fontSize: 10,
                  fontWeight: FontWeight.w500,
                  color: _hovering ? cs.onSurface : cs.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════
// 天气 Header：作为右侧面板顶部区域，与面板融为一体，顶部贴合
// ═══════════════════════════════════════════════════════════
class _WeatherHeader extends StatefulWidget {
  const _WeatherHeader({this.onReportLocation});

  /// 拿到实时位置后回调上报（填充服务端位置缓存，供 Agent 按需复用）。
  final void Function(Map<String, dynamic> location)? onReportLocation;

  @override
  State<_WeatherHeader> createState() => _WeatherHeaderState();
}

class _WeatherHeaderState extends State<_WeatherHeader>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;
  _WeatherData? _weather;
  bool _loadingWeather = true;

  /// 进程级天气缓存：跨多次界面刷新复用，避免每次进入都退化成
  /// 「定位 → 后端 → Open-Meteo」的全链路外网拉取（通常耗时数秒）。
  static _WeatherData? _cachedWeather;
  static DateTime? _lastFetchAt;

  /// 缓存有效期：期内直接使用缓存，不再发请求。
  static const Duration _weatherTtl = Duration(minutes: 10);

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 10),
    )..repeat();
    _loadWeather();
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  /// 用真实定位（GPS 优先，fallback IP/缓存）请求后端真实天气。
  Future<void> _loadWeather() async {
    // 已有缓存：先立刻渲染旧数据（无需等待），再在后台静默刷新，
    // 避免每次刷新主界面都卡几秒的“加载中…”。
    final _WeatherData? cached = _WeatherHeaderState._cachedWeather;
    if (cached != null && mounted) {
      setState(() {
        _weather = cached;
        _loadingWeather = false;
      });
    }
    // TTL 期内：直接用缓存，跳过整条请求链路。
    final DateTime? last = _WeatherHeaderState._lastFetchAt;
    if (last != null && DateTime.now().difference(last) < _weatherTtl) {
      return;
    }
    try {
      final ClientLocationPayload? loc =
          await ClientLocationService.getCurrentLocation();
      final double lat = loc?.latitude ?? double.nan;
      final double lon = loc?.longitude ?? double.nan;
      if (!lat.isFinite || !lon.isFinite) {
        if (mounted) {
          setState(() => _loadingWeather = false);
        }
        return;
      }
      // 拿到实时位置后回调上报（填充服务端位置缓存，供 Agent 按需复用）。
      if (loc != null) {
        widget.onReportLocation?.call(loc.toJson());
      }
      if (!mounted) return;
      final Uri uri = Uri.parse("${ApiConfig.httpBase}/weather/current").replace(
        queryParameters: <String, String>{
          "latitude": lat.toString(),
          "longitude": lon.toString(),
          "timezone": (loc?.timezone ?? "Asia/Shanghai"),
          "label": (loc?.label ?? ""),
        },
      );
      final http.Response res = await http
          .get(uri, headers: const <String, String>{"Accept": "application/json"})
          .timeout(const Duration(seconds: 15));
      if (!mounted) return;
      if (res.statusCode != 200) {
        setState(() => _loadingWeather = false);
        return;
      }
      final Map<String, dynamic> body =
          jsonDecode(res.body) as Map<String, dynamic>;
      final Map<String, dynamic>? brief =
          (body["brief"] as Map?)?.cast<String, dynamic>();
      final _WeatherData? data =
          brief == null ? null : _WeatherData.fromJson(brief);
      setState(() {
        _weather = data;
        _loadingWeather = false;
      });
      if (data != null) {
        _WeatherHeaderState._cachedWeather = data;
        _WeatherHeaderState._lastFetchAt = DateTime.now();
      }
    } catch (_) {
      if (mounted) {
        setState(() => _loadingWeather = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final bool isDark = cs.brightness == Brightness.dark;

    return Container(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: isDark
              ? <Color>[
                  const Color(0xFF18D6F3).withValues(alpha: 0.12),
                  const Color(0xFF18D6F3).withValues(alpha: 0.04),
                  Colors.transparent,
                ]
              : <Color>[
                  const Color(0xFF18D6F3).withValues(alpha: 0.06),
                  const Color(0xFF18D6F3).withValues(alpha: 0.02),
                  Colors.transparent,
                ],
        ),
      ),
      child: Stack(
        children: <Widget>[
          // 飘动的云朵背景
          _buildCloudLayer(cs),

          // 太阳光晕
          Positioned(
            top: -14,
            right: 4,
            child: AnimatedBuilder(
              animation: _ctrl,
              builder: (_, __) {
                final double t = _ctrl.value;
                final double scale =
                    1 + 0.12 * (t < 0.5 ? t * 2 : 2 - t * 2);
                return Transform.scale(
                  scale: scale,
                  child: Container(
                    width: 60,
                    height: 60,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      gradient: RadialGradient(
                        colors: <Color>[
                          const Color(0xFFFFB432).withValues(alpha: 0.22),
                          const Color(0xFFFFB432).withValues(alpha: 0.05),
                          Colors.transparent,
                        ],
                        stops: const <double>[0.0, 0.4, 0.7],
                      ),
                    ),
                  ),
                );
              },
            ),
          ),

          // 内容
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
            child: Column(
              // stretch 让子 Row 撑满父 Padding 给的 188px 宽度, 否则
              // default center 不会拉伸, Row 宽度=子项总和=180px, 6 根
              // 柱子挤在一起没间距, 数字看起来会贴边.
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                // 天气图标 + 状况/体感（不再显示当前位置）
                Row(
                  crossAxisAlignment: CrossAxisAlignment.center,
                  children: <Widget>[
                    _WeatherIcon(code: _weather?.weatherCode ?? 2, size: 26),
                    const SizedBox(width: 8),
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          _statusText,
                          style: TextStyle(
                            fontSize: 11.5,
                            fontWeight: FontWeight.w500,
                            color: cs.onSurface,
                          ),
                        ),
                        const SizedBox(height: 1),
                        Text(
                          _feelsLikeText,
                          style: TextStyle(
                            fontSize: 10,
                            color: cs.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                    const Spacer(),
                    if (_loadingWeather)
                      const SizedBox(
                        width: 14,
                        height: 14,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                  ],
                ),

                const SizedBox(height: 6),

                // 温度大字 + 最高最低温
                Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: <Widget>[
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.baseline,
                      textBaseline: TextBaseline.alphabetic,
                      children: <Widget>[
                        Text(
                          _tempText,
                          style: TextStyle(
                            fontSize: 32,
                            fontWeight: FontWeight.w300,
                            color: cs.onSurface,
                            height: 1.0,
                            letterSpacing: -1,
                          ),
                        ),
                        Padding(
                          padding: const EdgeInsets.only(left: 1, bottom: 4),
                          child: Text(
                            "°C",
                            style: TextStyle(
                              fontSize: 13,
                              fontWeight: FontWeight.w300,
                              color: cs.onSurfaceVariant,
                              height: 1.0,
                            ),
                          ),
                        ),
                      ],
                    ),
                    const Spacer(),
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: <Widget>[
                        Text(
                          "最高 $_maxTemp°",
                          style: TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.w500,
                            color: cs.onSurfaceVariant,
                          ),
                        ),
                        const SizedBox(height: 1),
                        Text(
                          "最低 $_minTemp°",
                          style: TextStyle(
                            fontSize: 10,
                            color: cs.onSurfaceVariant.withValues(alpha: 0.7),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),

                const SizedBox(height: 6),

                // 预警（降水概率较高时提示）
                if (_hasWarning)
                  Row(
                    children: <Widget>[
                      const Spacer(),
                      Row(
                        mainAxisSize: MainAxisSize.min,
                        children: <Widget>[
                          const Icon(Icons.warning_amber_rounded,
                              size: 10, color: Color(0xFFD7B85A)),
                          const SizedBox(width: 2),
                          Text(
                            _warningText,
                            style: const TextStyle(
                              fontSize: 10,
                              color: Color(0xFFD7B85A),
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),

                if (_hasWarning) const SizedBox(height: 8) else const SizedBox(height: 10),

                // 分时温度柱状图（真实分时预报）
                if (_hourlyPoints.isNotEmpty) _buildHourlyBars(cs),
              ],
            ),
          ),
        ],
      ),
    );
  }

  // ── 由真实天气数据驱动的展示字段 ──────────────────────────
  List<_HourPoint> get _hourlyPoints =>
      _weather?.hourly ?? const <_HourPoint>[];

  String get _statusText {
    if (_loadingWeather) return "加载中…";
    if (_weather == null) return "天气不可用";
    return _weather!.weatherText;
  }

  String get _feelsLikeText {
    if (_weather == null) return "";
    return "体感 ${_weather!.apparentTempC.round()}°";
  }

  String get _tempText {
    if (_weather == null) return "--";
    return _weather!.currentTempC.round().toString();
  }

  String get _maxTemp {
    if (_weather == null) return "--";
    return _weather!.todayMaxC.round().toString();
  }

  String get _minTemp {
    if (_weather == null) return "--";
    return _weather!.todayMinC.round().toString();
  }

  /// 降水概率 ≥40% 时给出预警（与后端穿衣建议的雨天判断一致）。
  bool get _hasWarning =>
      _weather != null && _weather!.peakRainPct >= 40;

  String get _warningText {
    final int pct = (_weather?.peakRainPct ?? 0).round();
    return "降水概率 $pct%";
  }

  /// 分时温度柱状图：按温度映射柱高（10~32px），最高温标峰值。
  Widget _buildHourlyBars(ColorScheme cs) {
    final List<_HourPoint> points = _hourlyPoints;
    if (points.isEmpty) return const SizedBox.shrink();
    final List<double> temps =
        points.map((p) => p.temperatureC).toList();
    final double minT = temps.reduce(min);
    final double maxT = temps.reduce(max);
    double barHeight(double t) {
      if (maxT <= minT) return 22;
      return 10 + (t - minT) / (maxT - minT) * 22;
    }

    return Row(
      mainAxisSize: MainAxisSize.max,
      crossAxisAlignment: CrossAxisAlignment.end,
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: <Widget>[
        for (int i = 0; i < points.length; i++)
          _HourTempBar(
            hour: "${points[i].time.hour}",
            temp: points[i].temperatureC.round().toString(),
            height: barHeight(points[i].temperatureC),
            peak: points[i].temperatureC == maxT,
          ),
      ],
    );
  }

  Widget _buildCloudLayer(ColorScheme cs) {
    return Positioned.fill(
      child: AnimatedBuilder(
        animation: _ctrl,
        builder: (_, __) {
          final double t = _ctrl.value;
          return Stack(
            children: <Widget>[
              Positioned(
                top: 6,
                left: -16 + t * 120,
                child: Opacity(
                  opacity: t < 0.1
                      ? t * 5
                      : t > 0.9
                          ? (1 - t) * 5
                          : 0.35,
                  child: _CloudShape(
                    size: 38,
                    color: cs.onSurface.withValues(alpha: 0.42),
                  ),
                ),
              ),
              Positioned(
                top: 20,
                right: -8 + (1 - t) * 85,
                child: Opacity(
                  opacity: t < 0.15
                      ? t / 0.15 * 0.28
                      : t > 0.85
                          ? (1 - t) / 0.15 * 0.28
                          : 0.28,
                  child: _CloudShape(
                    size: 30,
                    color: cs.onSurface.withValues(alpha: 0.34),
                  ),
                ),
              ),
              Positioned(
                top: 36,
                left: 24 + (t * 22),
                child: Opacity(
                  opacity: t < 0.2
                      ? t / 0.2 * 0.18
                      : t > 0.8
                          ? (1 - t) / 0.2 * 0.18
                          : 0.18,
                  child: _CloudShape(
                    size: 22,
                    color: cs.onSurface.withValues(alpha: 0.26),
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

/// 云朵形状
class _CloudShape extends StatelessWidget {
  const _CloudShape({required this.size, required this.color});
  final double size;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      size: Size(size, size * 0.55),
      painter: _CloudPainter(color: color),
    );
  }
}

class _CloudPainter extends CustomPainter {
  _CloudPainter({required this.color});
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final Paint paint = Paint()..color = color;
    final double w = size.width;
    final double h = size.height;
    // 三个椭圆组成云朵
    canvas.drawOval(
      Rect.fromLTWH(w * 0.05, h * 0.35, w * 0.45, h * 0.6),
      paint,
    );
    canvas.drawOval(
      Rect.fromLTWH(w * 0.3, h * 0.1, w * 0.5, h * 0.8),
      paint,
    );
    canvas.drawOval(
      Rect.fromLTWH(w * 0.55, h * 0.3, w * 0.4, h * 0.6),
      paint,
    );
  }

  @override
  bool shouldRepaint(covariant _CloudPainter oldDelegate) =>
      color != oldDelegate.color;
}

/// 单点分时预报（来自后端 /weather/current 的 hourlyForecast）。
class _HourPoint {
  const _HourPoint({
    required this.time,
    required this.temperatureC,
    required this.weatherCode,
  });

  final DateTime time;
  final double temperatureC;
  final int weatherCode;
}

/// 后端 /weather/current 返回的真实天气简报（Open-Meteo）。
class _WeatherData {
  const _WeatherData({
    required this.currentTempC,
    required this.apparentTempC,
    required this.weatherCode,
    required this.weatherText,
    required this.todayMinC,
    required this.todayMaxC,
    required this.peakRainPct,
    required this.hourly,
  });

  final double currentTempC;
  final double apparentTempC;
  final int weatherCode;
  final String weatherText;
  final double todayMinC;
  final double todayMaxC;
  final double peakRainPct;
  final List<_HourPoint> hourly;

  factory _WeatherData.fromJson(Map<String, dynamic> json) {
    return _WeatherData(
      currentTempC: (json["currentTempC"] as num?)?.toDouble() ?? 0,
      apparentTempC: (json["apparentTempC"] as num?)?.toDouble() ?? 0,
      weatherCode: (json["weatherCode"] as num?)?.toInt() ?? 0,
      weatherText: json["weatherText"]?.toString() ?? "",
      todayMinC: (json["todayMinC"] as num?)?.toDouble() ?? 0,
      todayMaxC: (json["todayMaxC"] as num?)?.toDouble() ?? 0,
      peakRainPct: (json["peakRainPct"] as num?)?.toDouble() ?? 0,
      hourly: <_HourPoint>[
        for (final Object? x
            in json["hourlyForecast"] as List? ?? const <Object?>[])
          if (x is Map)
            _HourPoint(
              time: DateTime.tryParse(x["time"]?.toString() ?? "") ??
                  DateTime.now(),
              temperatureC: (x["temperatureC"] as num?)?.toDouble() ?? 0,
              weatherCode: (x["weatherCode"] as num?)?.toInt() ?? 0,
            ),
      ],
    );
  }
}

/// 按 WMO 天气码映射的天气图标。
class _WeatherIcon extends StatelessWidget {
  const _WeatherIcon({required this.code, required this.size});

  final int code;
  final double size;

  @override
  Widget build(BuildContext context) {
    IconData icon;
    Color color;
    if (code <= 1) {
      // 晴
      icon = Icons.wb_sunny_outlined;
      color = const Color(0xFFFFB340);
    } else if (code <= 2) {
      // 多云
      icon = Icons.wb_cloudy_outlined;
      color = const Color(0xFF8A93A5);
    } else if (code <= 48) {
      // 阴 / 雾
      icon = Icons.cloud_outlined;
      color = const Color(0xFF9AA0A6);
    } else if (code >= 95) {
      // 雷暴
      icon = Icons.thunderstorm_outlined;
      color = const Color(0xFF5B7BE0);
    } else if (code >= 71) {
      // 雪
      icon = Icons.ac_unit;
      color = const Color(0xFF6FC3DF);
    } else if (code >= 61) {
      // 雨
      icon = Icons.water_drop_outlined;
      color = const Color(0xFF4A90D9);
    } else if (code >= 51) {
      // 毛毛雨
      icon = Icons.grain;
      color = const Color(0xFF4A90D9);
    } else {
      icon = Icons.cloud_outlined;
      color = const Color(0xFF9AA0A6);
    }
    return Icon(icon, size: size, color: color);
  }
}

/// 单根分时温度柱
class _HourTempBar extends StatelessWidget {
  const _HourTempBar({
    required this.hour,
    required this.temp,
    required this.height,
    required this.peak,
  });

  final String hour;
  final String temp;
  final double height;
  final bool peak;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    // 用 SizedBox 而非 Flexible: 每根柱固定 30px 净宽 (188/6≈31.33 - 0.66 间隙),
    // 由父 Row spaceBetween 自动均分剩余 1.98px 间隙; 数字/时间 intrinsic
    // ≤18px, 永不超过 30px, 从根上避免 1px 溢出.
    return SizedBox(
      width: 30,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.end,
        children: <Widget>[
          // 温度文字
          Text(
            temp,
            maxLines: 1,
            softWrap: false,
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 9.5,
              fontWeight: peak ? FontWeight.w600 : FontWeight.w500,
              color: peak ? _kAccentBlue : cs.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 2),
          // 柱体居中
          Center(
            child: Container(
              width: peak ? 3.5 : 2.5,
              height: height,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(2),
                gradient: LinearGradient(
                  begin: Alignment.bottomCenter,
                  end: Alignment.topCenter,
                  colors: peak
                      ? <Color>[
                          _kAccentOrange.withValues(alpha: 0.4),
                          _kAccentBlue.withValues(alpha: 0.8),
                        ]
                      : <Color>[
                          _kAccentBlue.withValues(alpha: 0.15),
                          _kAccentBlue.withValues(alpha: 0.45),
                        ],
                ),
              ),
            ),
          ),
          const SizedBox(height: 2),
          // 时间标签
          Text(
            hour,
            maxLines: 1,
            softWrap: false,
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 9.5,
              fontWeight: peak ? FontWeight.w500 : FontWeight.w400,
              color: peak
                  ? cs.onSurfaceVariant
                  : cs.onSurfaceVariant.withValues(alpha: 0.7),
            ),
          ),
        ],
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
            color: active ? _kAccentBlue : cs.outline.withValues(alpha: 0.5),
            width: active ? 1.5 : 1,
          ),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          customBorder: const CircleBorder(),
          child: SizedBox(
            width: 22,
            height: 22,
            child: Center(
              child: active
                  ? const Icon(Icons.check, size: 13, color: _kAccentBlue)
                  : Icon(
                      Icons.desktop_windows_outlined,
                      size: 12,
                      color: cs.onSurfaceVariant,
                    ),
            ),
          ),
        ),
      ),
    );
  }
}
