import "dart:async" show Timer, unawaited;
import "dart:convert";

import "package:flutter/foundation.dart" show kIsWeb, defaultTargetPlatform;
import "package:flutter/material.dart";
import "package:http/http.dart" as http;

import "../../core/models/schedule_models.dart";
import "../../core/config/api_config.dart";
import "../../core/services/client_location_service.dart";
import "../../core/services/desk_pet_session.dart";
import "../../core/services/schedule_floating_launcher.dart";
import "../../core/services/schedule_preference.dart";

const Color _kAccentBlue = Color(0xFF007AFF);
const Color _kAccentGreen = Color(0xFF34C759);
const Color _kAccentOrange = Color(0xFFFF9500);

/// 右侧快捷功能面板的固定宽度。
/// 优化后收窄到 220px，减少视觉压迫感，让聊天区更开阔。
const double kRightSidePanelWidth = 220.0;

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
  bool _scheduleWindowActive = false;
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
            _scheduleWindowActive = false;
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
      final List<ScheduleEvent> sorted = List<ScheduleEvent>.from(events)
        ..sort((a, b) => a.startAt.compareTo(b.startAt));
      final List<ScheduleFloatingItem> items = sorted
          .map((e) => ScheduleFloatingItem(
                id: e.id,
                timeText:
                    "${e.startAt.hour.toString().padLeft(2, '0')}:${e.startAt.minute.toString().padLeft(2, '0')}",
                title: e.title,
                notes: (e.notes ?? '').trim(),
              ))
          .toList();
      ScheduleFloatingLauncher.setSchedule(items);
    });
  }

  void _onScheduleWindowChanged() {
    if (mounted) {
      setState(
          () => _scheduleWindowActive = ScheduleFloatingLauncher.isRunning);
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
        color: cs.surfaceContainerLow,
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
                                  color: Colors.white.withValues(
                                    alpha: _breatheOpacity.value,
                                  ),
                                ),
                                bottom: BorderSide(
                                  color: Colors.white.withValues(
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
                                color: Colors.white.withValues(
                                  alpha: _breatheOpacity.value,
                                ),
                              ),
                              bottom: BorderSide(
                                color: Colors.white.withValues(
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
              final List<ScheduleEvent> items = (snapshot.data ??
                  <ScheduleEvent>[])
                ..sort((a, b) => a.startAt.compareTo(b.startAt));
              if (items.isEmpty) {
                return _buildEmptySchedule(cs);
              }
              // 只展示最近 3 条，保持面板精简
              final List<ScheduleEvent> visible = items.take(3).toList();
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
                                const SizedBox(width: 34),
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
          const SizedBox(width: 34),
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
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    const SizedBox(height: 1),
                    Text(
                      event.title,
                      style: TextStyle(
                        fontSize: 11.5,
                        color: cs.onSurface,
                        fontWeight: FontWeight.w400,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    if (event.notes != null && event.notes!.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text(
                          event.notes!,
                          style: TextStyle(
                            fontSize: 9.5,
                            color: cs.onSurfaceVariant,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
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
      _ToolSpec(icon: Icons.phone_iphone, label: "手机", onTap: widget.onPhone),
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
                border: Border.all(color: cs.outline.withValues(alpha: 0.3)),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Icon(
                    summoned ? Icons.nightlight_round : Icons.wb_sunny_outlined,
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
class _WeatherBriefData {
  const _WeatherBriefData({
    required this.currentTempC,
    required this.apparentTempC,
    required this.weatherText,
    required this.todayMinC,
    required this.todayMaxC,
    required this.peakRainPct,
    required this.hourlyForecast,
    required this.updatedAt,
  });

  final double currentTempC;
  final double apparentTempC;
  final String weatherText;
  final double todayMinC;
  final double todayMaxC;
  final int peakRainPct;
  final List<_WeatherHourData> hourlyForecast;
  final DateTime updatedAt;

  factory _WeatherBriefData.fromJson(Map<String, dynamic> json) {
    final List<dynamic> hourly =
        (json["hourlyForecast"] as List?) ?? const <dynamic>[];
    final double currentTemp = _asDouble(json["currentTempC"], 26);
    final String weatherText = (json["weatherText"] as String?)?.trim() ?? "";
    return _WeatherBriefData(
      currentTempC: currentTemp,
      apparentTempC: _asDouble(json["apparentTempC"], currentTemp),
      weatherText: weatherText.isNotEmpty ? weatherText : "多云",
      todayMinC: _asDouble(json["todayMinC"], 21),
      todayMaxC: _asDouble(json["todayMaxC"], 30),
      peakRainPct: _asDouble(json["peakRainPct"], 0).round(),
      hourlyForecast: hourly
          .whereType<Map>()
          .map((Map item) =>
              _WeatherHourData.fromJson(item.cast<String, dynamic>()))
          .toList(growable: false),
      updatedAt: DateTime.now(),
    );
  }
}

class _WeatherHourData {
  const _WeatherHourData({
    required this.hour,
    required this.temperatureC,
  });

  final String hour;
  final double temperatureC;

  factory _WeatherHourData.fromJson(Map<String, dynamic> json) {
    final String hour = (json["hour"] as String?)?.trim() ?? "";
    return _WeatherHourData(
      hour: hour.isNotEmpty ? hour : "--",
      temperatureC: _asDouble(json["temperatureC"], 0),
    );
  }
}

double _asDouble(Object? value, double fallback) {
  if (value is num) return value.toDouble();
  if (value is String) return double.tryParse(value) ?? fallback;
  return fallback;
}

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
  Timer? _refreshTimer;
  _WeatherBriefData? _weather;
  bool _refreshingWeather = false;
  String? _weatherError;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 10),
    )..repeat();
    unawaited(_refreshWeather());
    _refreshTimer = Timer.periodic(
      const Duration(minutes: 10),
      (_) => unawaited(_refreshWeather()),
    );
  }

  @override
  void dispose() {
    _refreshTimer?.cancel();
    _ctrl.dispose();
    super.dispose();
  }

  /// 面板打开/重建时拉一次实时 GPS（实时位置数据），并上报服务端填充位置缓存，
  /// 供 Agent 需要位置时（如天气工具）按需复用。面板本身不再展示位置文本。
  Future<void> _refreshWeather() async {
    if (_refreshingWeather) return;
    _refreshingWeather = true;
    try {
      final ClientLocationPayload? loc =
          await ClientLocationService.getCurrentLocationForChat();
      if (loc != null) {
        widget.onReportLocation?.call(loc.toJson());
        final _WeatherBriefData brief = await _fetchWeather(loc);
        if (!mounted) return;
        setState(() {
          _weather = brief;
          _weatherError = null;
        });
      } else if (mounted) {
        setState(() {
          _weatherError = "定位不可用";
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _weatherError = e.toString();
      });
    } finally {
      _refreshingWeather = false;
    }
  }

  Future<_WeatherBriefData> _fetchWeather(ClientLocationPayload loc) async {
    final Uri uri = Uri.parse("${ApiConfig.httpBase}/weather/current").replace(
      queryParameters: <String, String>{
        "latitude": loc.latitude.toString(),
        "longitude": loc.longitude.toString(),
        if (loc.timezone?.isNotEmpty == true) "timezone": loc.timezone!,
        if (loc.label?.isNotEmpty == true) "label": loc.label!,
      },
    );
    final http.Response res = await http.get(uri,
        headers: const <String, String>{
          "Accept": "application/json"
        }).timeout(const Duration(seconds: 15));
    if (res.statusCode != 200) {
      throw Exception("天气接口返回 ${res.statusCode}");
    }
    final Map<String, dynamic> body =
        jsonDecode(res.body) as Map<String, dynamic>;
    if (body["ok"] != true) {
      throw Exception(body["message"]?.toString() ?? "天气接口异常");
    }
    final Map<String, dynamic>? brief =
        (body["brief"] as Map?)?.cast<String, dynamic>();
    if (brief == null) {
      throw Exception("天气接口缺少数据");
    }
    return _WeatherBriefData.fromJson(brief);
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final bool isDark = cs.brightness == Brightness.dark;
    final _WeatherBriefData? weather = _weather;
    final String currentTempText =
        weather?.currentTempC.round().toString() ?? "26";
    final String weatherText =
        weather?.weatherText ?? (_weatherError == null ? "更新中" : "更新失败");
    final String feelsLikeText =
        "体感 ${weather?.apparentTempC.round().toString() ?? "28"}°";
    final String highText =
        "H ${weather?.todayMaxC.round().toString() ?? "30"}°";
    final String lowText =
        "L ${weather?.todayMinC.round().toString() ?? "21"}°";
    final int rainPct = weather?.peakRainPct ?? 0;
    final bool hasRainAlert = rainPct >= 40;
    final String alertText = hasRainAlert
        ? "降雨 $rainPct%"
        : weather == null
            ? "实时同步"
            : "刚更新";
    final Color alertColor =
        hasRainAlert ? const Color(0xFFFF9500) : _kAccentGreen;

    return Container(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: isDark
              ? <Color>[
                  const Color(0xFF007AFF).withValues(alpha: 0.12),
                  const Color(0xFF007AFF).withValues(alpha: 0.04),
                  Colors.transparent,
                ]
              : <Color>[
                  const Color(0xFF007AFF).withValues(alpha: 0.06),
                  const Color(0xFF007AFF).withValues(alpha: 0.02),
                  Colors.transparent,
                ],
        ),
      ),
      child: Stack(
        children: <Widget>[
          // 飘动的云朵背景
          _buildCloudLayer(),

          // 太阳光晕
          Positioned(
            top: -14,
            right: 4,
            child: AnimatedBuilder(
              animation: _ctrl,
              builder: (_, __) {
                final double t = _ctrl.value;
                final double scale = 1 + 0.12 * (t < 0.5 ? t * 2 : 2 - t * 2);
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
                // 天气图标（右对齐；「显示当前位置」组件已按需求移除）
                Row(
                  crossAxisAlignment: CrossAxisAlignment.center,
                  children: <Widget>[
                    const Spacer(),
                    SizedBox(
                      width: 26,
                      height: 26,
                      child: CustomPaint(
                        painter: _WeatherIconPainter(),
                      ),
                    ),
                  ],
                ),

                const SizedBox(height: 4),

                // 温度大字 + 天气状况
                Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: <Widget>[
                    // must be min: 否则默认 .max 会吃掉全部 Row 宽度,
                    // 右侧 Spacer+Column 拿到 0 宽度 → "多云转晴"溢出
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.baseline,
                      textBaseline: TextBaseline.alphabetic,
                      children: <Widget>[
                        Text(
                          currentTempText,
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
                          weatherText,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 11.5,
                            fontWeight: FontWeight.w500,
                            color: cs.onSurface,
                          ),
                        ),
                        const SizedBox(height: 1),
                        Text(
                          feelsLikeText,
                          style: TextStyle(
                            fontSize: 10,
                            color: cs.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                  ],
                ),

                const SizedBox(height: 6),

                // 最高最低温 + 预警
                Row(
                  children: <Widget>[
                    Text.rich(
                      TextSpan(
                        children: <InlineSpan>[
                          TextSpan(
                            text: highText,
                            style: TextStyle(
                              fontSize: 10,
                              fontWeight: FontWeight.w500,
                              color: cs.onSurfaceVariant,
                            ),
                          ),
                          TextSpan(
                            text: " · ",
                            style: TextStyle(
                              fontSize: 10,
                              color: cs.onSurfaceVariant.withValues(alpha: 0.5),
                            ),
                          ),
                          TextSpan(
                            text: lowText,
                            style: TextStyle(
                              fontSize: 10,
                              color: cs.onSurfaceVariant.withValues(alpha: 0.7),
                            ),
                          ),
                        ],
                      ),
                    ),
                    const Spacer(),
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        Icon(Icons.warning_amber_rounded,
                            size: 10, color: alertColor),
                        const SizedBox(width: 2),
                        Text(
                          alertText,
                          style: TextStyle(
                            fontSize: 10,
                            color: alertColor,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                      ],
                    ),
                  ],
                ),

                const SizedBox(height: 8),

                // 分时温度柱状图:
                //   - Row 不限定 42px 固定高度(原来是 ConstrainedBox, 引起
                //     底部高度溢出 3px: Column intrinsic 高度 32+2+13.6+2+13.6
                //     ≈ 63 > 42, 文字被切)
                //   - 用 SizedBox(width: 30) 给每根柱固定列宽, 由 Row 自身
                //     拿父 stretch 传来的 188px 宽度, 6 根 30px = 180, 剩余
                //     8px 走 spaceBetween 均分 5 个间隔(1.6px/间隔)
                //   - 不再需要 FittedBox: 数字 intrinsic ~16-18px < 30px 净宽
                Row(
                  mainAxisSize: MainAxisSize.max,
                  crossAxisAlignment: CrossAxisAlignment.end,
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: _buildHourlyBars(weather),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  List<Widget> _buildHourlyBars(_WeatherBriefData? weather) {
    final List<_WeatherHourData> hours =
        weather?.hourlyForecast.take(6).toList(growable: false) ??
            const <_WeatherHourData>[
              _WeatherHourData(hour: "9", temperatureC: 23),
              _WeatherHourData(hour: "12", temperatureC: 27),
              _WeatherHourData(hour: "15", temperatureC: 30),
              _WeatherHourData(hour: "18", temperatureC: 28),
              _WeatherHourData(hour: "21", temperatureC: 24),
              _WeatherHourData(hour: "0", temperatureC: 22),
            ];
    if (hours.isEmpty) {
      return const <Widget>[
        _HourTempBar(hour: "9", temp: "23", height: 12, peak: false),
        _HourTempBar(hour: "12", temp: "27", height: 22, peak: false),
        _HourTempBar(hour: "15", temp: "30", height: 32, peak: true),
        _HourTempBar(hour: "18", temp: "28", height: 25, peak: false),
        _HourTempBar(hour: "21", temp: "24", height: 15, peak: false),
        _HourTempBar(hour: "0", temp: "22", height: 10, peak: false),
      ];
    }

    final double minTemp =
        hours.map((h) => h.temperatureC).reduce((a, b) => a < b ? a : b);
    final double maxTemp =
        hours.map((h) => h.temperatureC).reduce((a, b) => a > b ? a : b);
    final double range = (maxTemp - minTemp).abs();

    return hours.map((h) {
      final bool peak = h.temperatureC == maxTemp;
      final double normalized =
          range <= 0 ? 0.5 : (h.temperatureC - minTemp) / range;
      return _HourTempBar(
        hour: h.hour,
        temp: h.temperatureC.round().toString(),
        height: 10 + normalized * 22,
        peak: peak,
      );
    }).toList(growable: false);
  }

  Widget _buildCloudLayer() {
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
                  child: _CloudShape(size: 38),
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
                  child: _CloudShape(size: 30),
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
                  child: _CloudShape(size: 22),
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
  const _CloudShape({required this.size});
  final double size;

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      size: Size(size, size * 0.55),
      painter: _CloudPainter(
        color: Colors.white.withValues(alpha: 0.85),
      ),
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

/// 天气图标（太阳+云）
class _WeatherIconPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    // 太阳
    final Paint sunPaint = Paint()..color = const Color(0xFFFFB340);
    final Paint sunInnerPaint = Paint()..color = const Color(0xFFFFD275);
    final double sunR = size.width * 0.22;
    final Offset sunCenter = Offset(size.width * 0.35, size.height * 0.4);
    canvas.drawCircle(sunCenter, sunR, sunPaint);
    canvas.drawCircle(sunCenter, sunR * 0.62, sunInnerPaint);

    // 云
    final Paint cloudPaint = Paint()
      ..color = Colors.white
      ..style = PaintingStyle.fill;
    final Paint cloudShadowPaint = Paint()
      ..color = const Color(0xFFE8E8ED).withValues(alpha: 0.8)
      ..style = PaintingStyle.fill;

    final double cy = size.height * 0.62;

    // 云底阴影
    canvas.drawOval(
      Rect.fromLTWH(
          size.width * 0.15, cy + 2, size.width * 0.5, size.height * 0.3),
      cloudShadowPaint,
    );
    canvas.drawOval(
      Rect.fromLTWH(
          size.width * 0.38, cy - 2, size.width * 0.45, size.height * 0.35),
      cloudShadowPaint,
    );
    canvas.drawOval(
      Rect.fromLTWH(
          size.width * 0.55, cy + 2, size.width * 0.35, size.height * 0.25),
      cloudShadowPaint,
    );

    // 云主体
    canvas.drawOval(
      Rect.fromLTWH(size.width * 0.15, cy, size.width * 0.5, size.height * 0.3),
      cloudPaint,
    );
    canvas.drawOval(
      Rect.fromLTWH(
          size.width * 0.38, cy - 4, size.width * 0.45, size.height * 0.35),
      cloudPaint,
    );
    canvas.drawOval(
      Rect.fromLTWH(
          size.width * 0.55, cy, size.width * 0.35, size.height * 0.25),
      cloudPaint,
    );
  }

  @override
  bool shouldRepaint(covariant _WeatherIconPainter oldDelegate) => false;
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
