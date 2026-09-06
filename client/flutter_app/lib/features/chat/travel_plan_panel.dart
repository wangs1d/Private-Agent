import "dart:async";
import "dart:io" show Platform;

import "package:flutter/material.dart";
import "package:url_launcher/url_launcher.dart";
import "package:webview_windows/webview_windows.dart";

import "../../core/theme/app_theme.dart";
import "../../core/utils/agent_result_parser.dart";
import "intelligent_route_planner.dart";
import "travel_detail_sheet.dart";
import "travel_map_controller.dart";
import "travel_map_view.dart";
import "travel_plan_models.dart";
import "travel_web_panel_controller.dart";
import "travel_web_panel_host.dart";
import "travel_theme.dart";

// ═══════════════════════════════════════════════════════════════════
// 行程规划界面（地图为中心的精简布局）。
//
// Windows：整页 WebView 承载深色玻璃拟态面板（assets/travel_map/panel.html，
// 地图 + 天数栏 + 详情卡 + 路线卡同一网页，经 TravelWebPanelController 桥接）；
// 非 Windows / WebView 不可用：回退原生 Material 面板（同信息架构）。
// ═══════════════════════════════════════════════════════════════════


/// 行程规划面板入口：按平台分发 WebView 版 / 原生版。
class TravelPlanPanel extends StatefulWidget {
  const TravelPlanPanel({
    super.key,
    required this.data,
    this.fullscreen = false,
    this.onClose,
  });

  final AgentResultData data;

  /// 是否为全屏模式（全屏页时隐藏内部全屏入口）。
  final bool fullscreen;

  /// 关闭回调（宿主容器需要内部关闭按钮时传入；全屏页自身有返回键）。
  final VoidCallback? onClose;

  /// Windows（WebView2 可用）走整页 WebView 面板；其余平台回退原生面板。
  /// 测试可覆写以强制走原生路径。
  static bool webPanelSupported = Platform.isWindows;

  @override
  State<TravelPlanPanel> createState() => _TravelPlanPanelState();
}

class _TravelPlanPanelState extends State<TravelPlanPanel> {
  @override
  Widget build(BuildContext context) {
    if (TravelPlanPanel.webPanelSupported) {
      return _WebTravelPanel(
        data: widget.data,
        fullscreen: widget.fullscreen,
        onClose: widget.onClose,
      );
    }
    return _NativeTravelPanel(
      data: widget.data,
      fullscreen: widget.fullscreen,
      onClose: widget.onClose,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// WebView 整页面板（Windows）
// ═══════════════════════════════════════════════════════════════════

class _WebTravelPanel extends StatefulWidget {
  const _WebTravelPanel({
    required this.data,
    this.fullscreen = false,
    this.onClose,
  });

  final AgentResultData data;
  final bool fullscreen;
  final VoidCallback? onClose;

  @override
  State<_WebTravelPanel> createState() => _WebTravelPanelState();
}

class _WebTravelPanelState extends State<_WebTravelPanel> {
  late final TravelPlanData _plan = TravelPlanData.from(widget.data);

  /// 面板与全屏页共用进程级 WebView 宿主（单例，App 启动即预加载）：
  /// 打开面板 / 进出全屏复用同一纹理，地图不再重新加载。
  TravelWebPanelController get _controller => TravelWebPanelHost.instance.controller;

  /// 全屏路由打开期间置真：卸载本挂载点的 Webview，让全屏页独占渲染同一纹理
  ///（同一控制器的 Webview 多处同时挂载会导致输入事件双发）。
  bool _fullscreenOpen = false;

  // 智能路线规划仍在 Dart 侧（单一事实源），结果经桥接下发网页渲染
  final IntelligentRoutePlanner _planner = IntelligentRoutePlanner();
  TravelPreferences _prefs = const TravelPreferences();
  List<RouteWaypoint> _lastWaypoints = const <RouteWaypoint>[];

  @override
  void initState() {
    super.initState();
    // 主题对齐：同步当前变体并监听热切换（网页令牌组 + 地图底图明暗）
    AppThemeController.instance.addListener(_onThemeChanged);
    unawaited(TravelWebPanelHost.instance.ensureStarted().then((_) {
      if (!mounted) return;
      _bindController();
      _syncTheme();
      _pushPlan();
    }));
  }

  @override
  void dispose() {
    AppThemeController.instance.removeListener(_onThemeChanged);
    _unbindController(); // 共享宿主不 detach（生命周期 = App）
    super.dispose();
  }

  void _onThemeChanged() {
    if (!mounted) return;
    _syncTheme();
  }

  void _syncTheme() {
    _controller.setTheme(AppThemeController.instance.value.name);
  }

  /// 绑定网页 → Dart 事件回调（WebView 挂载点切换后需重新绑定）。
  void _bindController() {
    final TravelWebPanelController c = _controller;
    c.onReady = _onWebReady;
    c.onPlanRoute = _planRoute;
    c.onSwitchRouteMode = _switchTransportMode;
    c.onHideRouteCard = _clearRoute;
    c.onOpenUrl = _launchExternal;
    c.onClose = () => widget.onClose?.call();
    c.onFullscreen = _openFullscreen;
  }

  /// 仅解绑属于自己的回调（不同 State 实例的方法 tearoff 不相等，互不误伤）。
  /// onClose 闭包无法比较，交由下一个挂载点绑定时覆盖。
  void _unbindController() {
    final TravelWebPanelController c = _controller;
    if (c.onReady == _onWebReady) c.onReady = null;
    if (c.onPlanRoute == _planRoute) c.onPlanRoute = null;
    if (c.onSwitchRouteMode == _switchTransportMode) c.onSwitchRouteMode = null;
    if (c.onHideRouteCard == _clearRoute) c.onHideRouteCard = null;
    if (c.onOpenUrl == _launchExternal) c.onOpenUrl = null;
    if (c.onFullscreen == _openFullscreen) c.onFullscreen = null;
  }

  /// 下发当前行程载荷（共享 WebView 未就绪时由控制器排队，就绪后自动送达）。
  void _pushPlan() {
    _controller.loadPlan(TravelWebPanelPayload.build(
      _plan,
      fullscreen: widget.fullscreen,
      closable: widget.onClose != null,
    ));
  }

  void _onWebReady() {
    _pushPlan();
  }

  // ── 全屏 / 外链 ──────────────────────────────────────────────────
  Future<void> _openFullscreen() async {
    // 全屏页复用同一共享 WebView 纹理（不重新加载地图）；
    // 先卸载本挂载点避免同一控制器被双份转发输入事件
    setState(() => _fullscreenOpen = true);
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (BuildContext context) => TravelPlanFullscreenPage(
          data: widget.data,
        ),
      ),
    );
    if (!mounted) return;
    _bindController(); // 全屏页挂载点曾覆盖回调，返回后夺回
    _pushPlan();       // 恢复面板态载荷（隐藏网页内全屏按钮等）
    setState(() => _fullscreenOpen = false);
  }

  Future<void> _launchExternal(String url) async {
    if (url.isEmpty) return;
    final Uri? uri = Uri.tryParse(url);
    if (uri == null) return;
    try {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      _toast("无法打开外部链接", error: true);
    }
  }

  void _toast(String msg, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(msg, style: const TextStyle(fontSize: 12)),
        backgroundColor: error ? Theme.of(context).colorScheme.error : null,
        duration: const Duration(seconds: 2),
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  // ═════════════════════════════════════════════════════════════════
  // 智能路线规划（Dart 计算 → 网页渲染）
  // ═════════════════════════════════════════════════════════════════

  void _planRoute(int dayIndex) {
    final int d = dayIndex.clamp(0, _plan.days.length - 1);
    final List<RouteWaypoint> waypoints = <RouteWaypoint>[
      for (final TravelDayEntry e in _plan.days[d].entries)
        if (e.latitude != null && e.longitude != null && e.kind != TravelEntryKind.transport)
          RouteWaypoint(
              name: e.title,
              latitude: e.latitude!,
              longitude: e.longitude!,
              type: e.type),
    ];
    if (waypoints.length < 2) {
      _toast("当天可规划路线的地点不足（至少 2 个带坐标的行程点）", error: true);
      return;
    }
    _lastWaypoints = waypoints;
    _applyRoute(_planner.planIntelligentRoute(waypoints, _prefs));
  }

  void _switchTransportMode(String mode) {
    _prefs = TravelPreferences(
      sceneryPreference: _prefs.sceneryPreference,
      transportMode: mode,
      departureTime: _prefs.departureTime,
      budgetLevel: _prefs.budgetLevel,
      physicalEffort: _prefs.physicalEffort,
      avoidCrowds: _prefs.avoidCrowds,
      prioritizeSpeed: _prefs.prioritizeSpeed,
    );
    if (_lastWaypoints.length >= 2) {
      _applyRoute(_planner.planIntelligentRoute(_lastWaypoints, _prefs));
    }
  }

  void _applyRoute(SmartRouteResult result) {
    _controller.drawRoute(<TravelRouteSegment>[
      for (final SmartRouteSegment seg in result.segments)
        TravelRouteSegment(
          mode: _mapModeOf(seg.transportMode),
          points: <TravelMapPoint>[
            TravelMapPoint(latitude: seg.fromLatitude, longitude: seg.fromLongitude),
            TravelMapPoint(latitude: seg.toLatitude, longitude: seg.toLongitude),
          ],
          fromName: seg.fromName,
          toName: seg.toName,
        ),
    ]);
    _controller.showRouteCard(_routeCardPayload(result));
  }

  void _clearRoute() {
    _lastWaypoints = const <RouteWaypoint>[];
    _controller.clearRoute();
  }

  static String _mapModeOf(String mode) {
    switch (mode) {
      case "public_transit":
        return "transit";
      case "walking":
        return "walking";
      case "cycling":
        return "cycling";
      case "taxi":
        return "taxi";
      default:
        return "driving"; // driving / rental_car
    }
  }

  static String _modeName(String mode) {
    const Map<String, String> names = <String, String>{
      "driving": "驾车",
      "rental_car": "租车",
      "taxi": "网约车",
      "public_transit": "公交",
      "cycling": "骑行",
      "walking": "步行",
    };
    return names[mode] ?? mode;
  }

  Map<String, dynamic> _routeCardPayload(SmartRouteResult route) {
    return TravelWebPanelPayload.routeCard(
      totalDistanceText: route.totalDistanceText,
      totalDurationText: route.totalDurationText,
      averageCrowdIndex: route.averageCrowdIndex,
      optimizationScore: route.optimizationScore,
      assessment: route.assessment,
      segments: <Map<String, dynamic>>[
        for (final SmartRouteSegment seg in route.segments)
          <String, dynamic>{
            "instruction": seg.instruction,
            "distanceText": "${(seg.distanceMeters / 1000).toStringAsFixed(1)}km",
            "durationMinutes": seg.durationMinutes,
          },
      ],
      warnings: <Map<String, dynamic>>[
        for (final SmartRouteWarning w in route.warnings)
          <String, dynamic>{"message": w.message, "severity": w.severity},
      ],
      alternatives: <Map<String, dynamic>>[
        for (final TransportRecommendation alt
            in route.segments.firstOrNull?.alternatives ?? const <TransportRecommendation>[])
          <String, dynamic>{
            "mode": alt.mode,
            "label": _modeName(alt.mode),
            "reason": alt.reason,
          },
      ],
      links: route.serviceLinks(),
    );
  }

  @override
  Widget build(BuildContext context) {
    // 全屏覆盖期间以深色占位（本挂载点的 Webview 已卸载，共享纹理由全屏页渲染）
    if (_fullscreenOpen) {
      return const ColoredBox(color: Color(0xFF0B1220));
    }
    return const _WebPanelView();
  }
}

/// 共享 WebView 宿主的挂载点：等待初始化完成后渲染同一纹理。
class _WebPanelView extends StatelessWidget {
  const _WebPanelView();

  @override
  Widget build(BuildContext context) {
    final TravelWebPanelHost host = TravelWebPanelHost.instance;
    return FutureBuilder<void>(
      future: host.ensureStarted(),
      builder: (BuildContext context, AsyncSnapshot<void> snapshot) {
        if (host.error != null) {
          return Container(
            color: const Color(0xFF0B1220),
            alignment: Alignment.center,
            padding: const EdgeInsets.all(16),
            child: Text(
              host.error!,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 12, color: Color(0xFF8FA3BF)),
            ),
          );
        }
        if (snapshot.connectionState != ConnectionState.done ||
            !host.isInitialized) {
          return Container(
            color: const Color(0xFF0B1220),
            alignment: Alignment.center,
            child: const Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                SizedBox(
                  width: 22,
                  height: 22,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
                SizedBox(height: 10),
                Text(
                  "行程面板加载中…",
                  style: TextStyle(fontSize: 12, color: Color(0xFF8FA3BF)),
                ),
              ],
            ),
          );
        }
        return Webview(host.webviewController!);
      },
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// 原生兜底面板（非 Windows / WebView 不可用）
// ═══════════════════════════════════════════════════════════════════

class _NativeTravelPanel extends StatefulWidget {
  const _NativeTravelPanel({
    required this.data,
    this.fullscreen = false,
    this.onClose,
  });

  final AgentResultData data;
  final bool fullscreen;
  final VoidCallback? onClose;

  @override
  State<_NativeTravelPanel> createState() => _NativeTravelPanelState();
}

class _NativeTravelPanelState extends State<_NativeTravelPanel> {
  late final TravelPlanData _plan = TravelPlanData.from(widget.data);
  int _selectedDay = 0;

  // 左栏天数列表收起状态（收起后为窄边栏，仅显示天数序号）
  bool _dayListCollapsed = false;

  // 地图（WebView + MapLibre，能力移植自 3D-Travel Map3DController）
  final TravelMapController _mapController = TravelMapController();

  // 智能路线规划（移植自 IntelligentRoutePlanner）
  final IntelligentRoutePlanner _planner = IntelligentRoutePlanner();
  TravelPreferences _prefs = const TravelPreferences();
  SmartRouteResult? _route;
  List<RouteWaypoint> _lastWaypoints = const <RouteWaypoint>[];

  @override
  void initState() {
    super.initState();
    _mapController.onPoiTap = _onPoiTap;
    WidgetsBinding.instance.addPostFrameCallback((_) => _syncMap());
  }

  @override
  void dispose() {
    _mapController.onPoiTap = null;
    super.dispose();
  }

  // ── 地图联动 ─────────────────────────────────────────────────────
  List<TravelMapPoi> _collectPois() {
    final List<TravelMapPoi> pois = <TravelMapPoi>[];
    for (int d = 0; d < _plan.days.length; d++) {
      for (final TravelDayEntry e in _plan.days[d].entries) {
        if (e.latitude == null || e.longitude == null) continue;
        pois.add(TravelMapPoi(
          name: e.title,
          type: _mapTypeOf(e.kind),
          latitude: e.latitude!,
          longitude: e.longitude!,
          splatUrl: e.splatUrl,
          dayIndex: d,
          address: e.address,
        ));
      }
    }
    return pois;
  }

  static String _mapTypeOf(TravelEntryKind kind) {
    switch (kind) {
      case TravelEntryKind.attraction:
        return "attraction";
      case TravelEntryKind.restaurant:
        return "restaurant";
      case TravelEntryKind.hotel:
        return "hotel";
      case TravelEntryKind.transport:
        return "transport";
      case TravelEntryKind.other:
        return "transport";
    }
  }

  void _syncMap() {
    // 真实目的地中心先行下发：POI 缺失/无坐标时地图也不会漂到无关城市
    final double? centerLat = _plan.centerLatitude;
    final double? centerLng = _plan.centerLongitude;
    if (centerLat != null && centerLng != null) {
      _mapController.setDefaultCenter(centerLat, centerLng);
    }
    _mapController.setPois(_collectPois());
    _mapController.showDay(_plan.days.length > 1 ? _selectedDay : null);
  }

  void _onPoiTap(String name) {
    // 地图标记点击 → 飞行定位 + 弹出条目详情（时间线面板移除后的详情入口）
    for (int d = 0; d < _plan.days.length; d++) {
      for (final TravelDayEntry e in _plan.days[d].entries) {
        if (e.title == name && e.latitude != null && e.longitude != null) {
          _mapController.flyTo(e.latitude!, e.longitude!, zoom: 16.5);
          TravelDetailSheet.show(context, entry: e, dayLabel: _plan.days[d].label);
          return;
        }
      }
    }
  }

  void _selectDay(int index) {
    setState(() => _selectedDay = index);
    _mapController.showDay(_plan.days.length > 1 ? index : null);
    if (_route != null) _clearRoute();
  }

  // ── 全屏 ─────────────────────────────────────────────────────────
  void _openFullscreen() {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (BuildContext context) => TravelPlanFullscreenPage(
          data: widget.data,
        ),
      ),
    );
  }

  void _toast(String msg, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(msg, style: const TextStyle(fontSize: 12)),
        backgroundColor: error ? Theme.of(context).colorScheme.error : null,
        duration: const Duration(seconds: 2),
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  // ═════════════════════════════════════════════════════════════════
  // 智能路线规划（移植自 planRoute + _showIntelligentRouteResult）
  // ═════════════════════════════════════════════════════════════════

  void _planRoute() {
    final List<RouteWaypoint> waypoints = <RouteWaypoint>[
      for (final TravelDayEntry e
          in _plan.days[_selectedDay.clamp(0, _plan.days.length - 1)].entries)
        if (e.latitude != null && e.longitude != null && e.kind != TravelEntryKind.transport)
          RouteWaypoint(
              name: e.title,
              latitude: e.latitude!,
              longitude: e.longitude!,
              type: e.type),
    ];
    if (waypoints.length < 2) {
      _toast("当天可规划路线的地点不足（至少 2 个带坐标的行程点）", error: true);
      return;
    }
    _lastWaypoints = waypoints;
    final SmartRouteResult result = _planner.planIntelligentRoute(waypoints, _prefs);
    setState(() => _route = result);
    _mapController.drawRoute(<TravelRouteSegment>[
      for (final SmartRouteSegment seg in result.segments)
        TravelRouteSegment(
          mode: _mapModeOf(seg.transportMode),
          points: <TravelMapPoint>[
            TravelMapPoint(latitude: seg.fromLatitude, longitude: seg.fromLongitude),
            TravelMapPoint(latitude: seg.toLatitude, longitude: seg.toLongitude),
          ],
          fromName: seg.fromName,
          toName: seg.toName,
        ),
    ]);
    _mapController.resetView();
  }

  static String _mapModeOf(String mode) {
    switch (mode) {
      case "public_transit":
        return "transit";
      case "walking":
        return "walking";
      case "cycling":
        return "cycling";
      case "taxi":
        return "taxi";
      default:
        return "driving"; // driving / rental_car
    }
  }

  /// 切换交通方式并重新规划（对应 _switchTransportMode）。
  void _switchTransportMode(String mode) {
    _prefs = TravelPreferences(
      sceneryPreference: _prefs.sceneryPreference,
      transportMode: mode,
      departureTime: _prefs.departureTime,
      budgetLevel: _prefs.budgetLevel,
      physicalEffort: _prefs.physicalEffort,
      avoidCrowds: _prefs.avoidCrowds,
      prioritizeSpeed: _prefs.prioritizeSpeed,
    );
    if (_lastWaypoints.length >= 2) {
      final SmartRouteResult result =
          _planner.planIntelligentRoute(_lastWaypoints, _prefs);
      setState(() => _route = result);
      _mapController.drawRoute(<TravelRouteSegment>[
        for (final SmartRouteSegment seg in result.segments)
          TravelRouteSegment(
            mode: _mapModeOf(seg.transportMode),
            points: <TravelMapPoint>[
              TravelMapPoint(latitude: seg.fromLatitude, longitude: seg.fromLongitude),
              TravelMapPoint(latitude: seg.toLatitude, longitude: seg.toLongitude),
            ],
            fromName: seg.fromName,
            toName: seg.toName,
          ),
      ]);
    }
  }

  void _clearRoute() {
    setState(() {
      _route = null;
      _lastWaypoints = const <RouteWaypoint>[];
    });
    _mapController.clearRoute();
  }

  // ═════════════════════════════════════════════════════════════════
  // 渲染
  // ═════════════════════════════════════════════════════════════════

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final bool full = widget.fullscreen;
    final double leftWidth = full ? 250 : 200;

    return ColoredBox(
      color: full ? cs.surface : cs.surfaceContainer,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          _buildHeader(cs, full),
          const Divider(height: 1),
          Expanded(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                if (_plan.days.length > 1) ...<Widget>[
                  _dayListCollapsed
                      ? SizedBox(width: 44, child: _buildDayRail(cs))
                      : SizedBox(width: leftWidth, child: _buildDayList(cs)),
                  VerticalDivider(width: 1, color: cs.outline.withValues(alpha: 0.18)),
                ],
                Expanded(child: _buildMainArea(cs)),
              ],
            ),
          ),
        ],
      ),
    );
  }

  // ── 顶栏：目的地 + 标题 + 全屏 / 关闭 ─────────────────────────────
  Widget _buildHeader(ColorScheme cs, bool full) {
    final String dest =
        _plan.destination.isNotEmpty ? _plan.destination : "行程规划";
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 8, 6, 8),
      decoration: BoxDecoration(
        color: cs.surfaceContainerLow,
        border: Border(
          bottom: BorderSide(color: cs.outline.withValues(alpha: 0.18)),
        ),
      ),
      child: Row(
        children: <Widget>[
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              color: TravelPalette.of(context).accent.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(999),
              border: Border.all(
                  color: TravelPalette.of(context).accent.withValues(alpha: 0.35)),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Icon(Icons.flag_outlined, size: 13, color: TravelPalette.of(context).accent),
                SizedBox(width: 4),
                Text(
                  dest,
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: TravelPalette.of(context).accent,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              _plan.title.isNotEmpty ? _plan.title : "$dest 行程",
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w600,
                color: cs.onSurface,
              ),
            ),
          ),
          const SizedBox(width: 4),
          if (!full)
            _headerIconBtn(cs, icon: Icons.open_in_full, tooltip: "全屏查看",
                onTap: _openFullscreen),
          if (widget.onClose != null)
            _headerIconBtn(cs, icon: Icons.close, tooltip: "关闭",
                onTap: widget.onClose!),
        ],
      ),
    );
  }

  Widget _headerIconBtn(
    ColorScheme cs, {
    required IconData icon,
    required String tooltip,
    required VoidCallback onTap,
    Color? color,
  }) {
    return Tooltip(
      message: tooltip,
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(6),
          child: Icon(icon, size: 17, color: color ?? cs.onSurfaceVariant),
        ),
      ),
    );
  }

  // ── 主区：地图（当前天指示 + 路线规划 + 路线结果卡）────────────────
  Widget _buildMainArea(ColorScheme cs) {
    return Stack(
      fit: StackFit.expand,
      children: <Widget>[
        TravelMapView(controller: _mapController),
        // 当前天指示徽章（多天时显示，替代原右侧时间线的天标题）
        if (_plan.days.length > 1)
          Positioned(left: 10, top: 48, child: _dayBadge()),
        // 规划路线悬浮按钮（对应 3D-Travel 的 #plan-route-btn）
        Positioned(
          left: 10,
          top: 10,
          child: _mapFabButton(
            icon: Icons.route_outlined,
            label: _route == null ? "规划路线" : "重新规划",
            onTap: _planRoute,
          ),
        ),
        // 智能路线结果卡（对应 _showIntelligentRouteResult）
        if (_route != null)
          Positioned(
            left: 10,
            right: 10,
            bottom: 10,
            child: _buildRouteResultCard(cs),
          ),
      ],
    );
  }

  /// 当前选中天的指示徽章（地图左上角，路线按钮下方）。
  Widget _dayBadge() {
    final TravelPlanDay day =
        _plan.days[_selectedDay.clamp(0, _plan.days.length - 1)];
    final String text = day.subtitle.isNotEmpty
        ? "${day.label} · ${day.subtitle}"
        : day.label;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.65),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(Icons.calendar_today_outlined,
              size: 12, color: TravelPalette.of(context).accent),
          const SizedBox(width: 5),
          Text(
            text,
            style: const TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w600,
                color: Colors.white),
          ),
        ],
      ),
    );
  }

  Widget _mapFabButton({
    required IconData icon,
    required String label,
    required VoidCallback onTap,
  }) {
    return Material(
      color: Colors.black.withValues(alpha: 0.65),
      borderRadius: BorderRadius.circular(999),
      child: InkWell(
        borderRadius: BorderRadius.circular(999),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(icon, size: 14, color: TravelPalette.of(context).accent),
              const SizedBox(width: 5),
              Text(label,
                  style: const TextStyle(
                      fontSize: 12, fontWeight: FontWeight.w600,
                      color: Colors.white)),
            ],
          ),
        ),
      ),
    );
  }

  /// 智能路线结果卡：总览 + 分段建议 + 警告 + 交通切换 + 叫车/租车/导航。
  Widget _buildRouteResultCard(ColorScheme cs) {
    final SmartRouteResult route = _route!;
    final Map<String, String> links = route.serviceLinks();
    return Material(
      color: Colors.black.withValues(alpha: 0.82),
      borderRadius: BorderRadius.circular(12),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxHeight: 230),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              // 总览行
              Row(
                children: <Widget>[
                  Icon(Icons.auto_awesome, size: 14, color: TravelPalette.of(context).accent),
                  SizedBox(width: 6),
                  Text(
                    "${route.totalDistanceText} · ${route.totalDurationText} · "
                    "人流${route.averageCrowdIndex}/10 · 优化分 ${route.optimizationScore}",
                    style: const TextStyle(
                        fontSize: 12, fontWeight: FontWeight.w600,
                        color: Colors.white),
                  ),
                  const Spacer(),
                  InkWell(
                    onTap: _clearRoute,
                    child: const Icon(Icons.close, size: 15, color: Colors.white70),
                  ),
                ],
              ),
              const SizedBox(height: 3),
              Text(route.assessment,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                      fontSize: 11,
                      color: TravelPalette.of(context).green.withValues(alpha: 0.9))),
              const Divider(height: 10, color: Colors.white24),
              // 分段建议（可滚动）
              Flexible(
                child: SingleChildScrollView(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      for (final SmartRouteSegment seg in route.segments)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 3),
                          child: Text(
                            "• ${seg.instruction}"
                            "（${(seg.distanceMeters / 1000).toStringAsFixed(1)}km · ${seg.durationMinutes}分钟）",
                            style: const TextStyle(
                                fontSize: 11, height: 1.4,
                                color: Colors.white70),
                          ),
                        ),
                      for (final SmartRouteWarning w in route.warnings)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 3),
                          child: Text(
                            "⚠ ${w.message}",
                            style: TextStyle(
                                fontSize: 11, height: 1.4,
                                color: w.severity == "high"
                                    ? const Color(0xFFF87171)
                                    : const Color(0xFFFBBF24)),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 6),
              // 交通方式切换（备选推荐）
              Wrap(
                spacing: 5,
                runSpacing: 5,
                children: <Widget>[
                  for (final TransportRecommendation alt
                      in route.segments.firstOrNull?.alternatives ??
                          const <TransportRecommendation>[])
                    InkWell(
                      borderRadius: BorderRadius.circular(999),
                      onTap: () => _switchTransportMode(alt.mode),
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 8, vertical: 3),
                        decoration: BoxDecoration(
                          color: Colors.white.withValues(alpha: 0.08),
                          borderRadius: BorderRadius.circular(999),
                          border: Border.all(color: Colors.white24),
                        ),
                        child: Text(
                          "${_modeName(alt.mode)} ${alt.reason}",
                          style: const TextStyle(
                              fontSize: 10, color: Colors.white70),
                        ),
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 6),
              // 叫车 / 租车 / 导航
              Row(
                children: <Widget>[
                  _routeActionBtn("一键叫车", Icons.local_taxi_outlined,
                      () => _openServiceDialog("选择叫车平台", <String, String>{
                            "滴滴出行": links["didi"]!,
                            "美团打车": links["meituan"]!,
                            "首汽约车": links["shouqi"]!,
                            "高德地图导航": links["gaode"]!,
                          })),
                  const SizedBox(width: 6),
                  _routeActionBtn("租车自驾", Icons.directions_car_outlined,
                      () => _launchExternal(links["ctripCar"]!)),
                  const Spacer(),
                  _routeActionBtn("导航前往", Icons.navigation_outlined,
                      () => _openServiceDialog("选择导航地图", <String, String>{
                            "高德地图": links["gaode"]!,
                            "百度地图": links["baidu"]!,
                          })),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  static String _modeName(String mode) {
    const Map<String, String> names = <String, String>{
      "driving": "驾车",
      "rental_car": "租车",
      "taxi": "网约车",
      "public_transit": "公交",
      "cycling": "骑行",
      "walking": "步行",
    };
    return names[mode] ?? mode;
  }

  Widget _routeActionBtn(String label, IconData icon, VoidCallback onTap) {
    return InkWell(
      borderRadius: BorderRadius.circular(8),
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
        decoration: BoxDecoration(
          color: TravelPalette.of(context).accent.withValues(alpha: 0.18),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(icon, size: 12, color: TravelPalette.of(context).accent),
            const SizedBox(width: 4),
            Text(label,
                style: const TextStyle(
                    fontSize: 11, fontWeight: FontWeight.w600,
                    color: Colors.white)),
          ],
        ),
      ),
    );
  }

  Future<void> _openServiceDialog(String title, Map<String, String> services) async {
    await showDialog<void>(
      context: context,
      builder: (BuildContext context) => SimpleDialog(
        title: Text(title, style: const TextStyle(fontSize: 15)),
        children: <Widget>[
          for (final MapEntry<String, String> s in services.entries)
            SimpleDialogOption(
              onPressed: () {
                Navigator.of(context).pop();
                _launchExternal(s.value);
              },
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Text(s.key, style: const TextStyle(fontSize: 13)),
              ),
            ),
        ],
      ),
    );
  }

  Future<void> _launchExternal(String url) async {
    final Uri? uri = Uri.tryParse(url);
    if (uri == null) return;
    try {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      _toast("无法打开外部链接", error: true);
    }
  }

  // ── 左栏：天数列表（可收起为窄边栏）────────────────────────────────
  Widget _buildDayList(ColorScheme cs) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(6, 6, 8, 0),
          child: Row(
            children: <Widget>[
              _dayListToggleBtn(cs, expand: false),
              const SizedBox(width: 4),
              Expanded(
                child: Text(
                  "行程天数（共 ${_plan.days.length} 天）",
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    color: cs.onSurfaceVariant,
                  ),
                ),
              ),
            ],
          ),
        ),
        Expanded(
          child: ListView.builder(
            padding: const EdgeInsets.symmetric(vertical: 10),
            itemCount: _plan.days.length + (_plan.footer.isEmpty ? 0 : 1),
            itemBuilder: (BuildContext context, int index) {
              if (index == _plan.days.length) return _buildFooterCard(cs);
              final TravelPlanDay day = _plan.days[index];
              final bool selected = index == _selectedDay;
              return _DayCard(
                day: day,
                selected: selected,
                onTap: () => _selectDay(index),
              );
            },
          ),
        ),
      ],
    );
  }

  /// 收起后的窄边栏：展开按钮 + 天数序号圆点（点击切换当天）。
  Widget _buildDayRail(ColorScheme cs) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: _dayListToggleBtn(cs, expand: true),
        ),
        Expanded(
          child: ListView.builder(
            padding: const EdgeInsets.symmetric(vertical: 8),
            itemCount: _plan.days.length,
            itemBuilder: (BuildContext context, int index) => _DayRailChip(
              index: index,
              label: _plan.days[index].label,
              selected: index == _selectedDay,
              onTap: () => _selectDay(index),
            ),
          ),
        ),
      ],
    );
  }

  /// 天数列表 收起/展开 切换按钮。
  Widget _dayListToggleBtn(ColorScheme cs, {required bool expand}) {
    return Tooltip(
      message: expand ? "展开天数列表" : "收起天数列表",
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: () => setState(() => _dayListCollapsed = !expand),
        child: Padding(
          padding: const EdgeInsets.all(5),
          child: Icon(
            expand ? Icons.chevron_right : Icons.chevron_left,
            size: 16,
            color: cs.onSurfaceVariant,
          ),
        ),
      ),
    );
  }

  Widget _buildFooterCard(ColorScheme cs) {
    if (_plan.footer.isEmpty) return const SizedBox.shrink();
    return Container(
      margin: const EdgeInsets.fromLTRB(10, 6, 10, 2),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHighest.withValues(alpha: 0.45),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        _plan.footer,
        style: TextStyle(
          fontSize: 11,
          height: 1.45,
          color: cs.onSurfaceVariant,
        ),
      ),
    );
  }
}

// ── 左栏天数卡片 ─────────────────────────────────────────────────
class _DayCard extends StatelessWidget {
  const _DayCard({
    required this.day,
    required this.selected,
    required this.onTap,
  });

  final TravelPlanDay day;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
      child: Material(
        color: selected
            ? TravelPalette.of(context).accent.withValues(alpha: 0.12)
            : Colors.transparent,
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: onTap,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(8),
              border: Border.all(
                color: selected
                    ? TravelPalette.of(context).accent.withValues(alpha: 0.4)
                    : Colors.transparent,
              ),
            ),
            child: Row(
              children: <Widget>[
                Icon(
                  Icons.place_outlined,
                  size: 14,
                  color: selected ? TravelPalette.of(context).accent : cs.onSurfaceVariant,
                ),
                SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        day.label,
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: selected
                              ? FontWeight.w700
                              : FontWeight.w500,
                          color: selected ? TravelPalette.of(context).accent : cs.onSurface,
                        ),
                      ),
                      Text(
                        "${day.entries.length} 项",
                        style: TextStyle(
                          fontSize: 10,
                          color: cs.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

// ── 收起态窄边栏的天数序号圆点 ───────────────────────────────────
class _DayRailChip extends StatelessWidget {
  const _DayRailChip({
    required this.index,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final int index;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Center(
        child: Tooltip(
          message: label,
          child: InkWell(
            borderRadius: BorderRadius.circular(999),
            onTap: onTap,
            child: Container(
              width: 28,
              height: 28,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: selected
                    ? TravelPalette.of(context).accent.withValues(alpha: 0.18)
                    : Colors.transparent,
                border: Border.all(
                  color: selected
                      ? TravelPalette.of(context).accent.withValues(alpha: 0.6)
                      : cs.outline.withValues(alpha: 0.25),
                ),
              ),
              child: Text(
                "${index + 1}",
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  color: selected ? TravelPalette.of(context).accent : cs.onSurfaceVariant,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 全屏行程规划页：独立路由，沉浸式浏览行程地图。
class TravelPlanFullscreenPage extends StatelessWidget {
  const TravelPlanFullscreenPage({super.key, required this.data});

  final AgentResultData data;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Scaffold(
      backgroundColor: cs.surface,
      appBar: AppBar(
        title: const Text("行程规划"),
        backgroundColor: cs.surfaceContainer,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          tooltip: "返回",
          onPressed: () => Navigator.of(context).pop(),
        ),
      ),
      body: TravelPlanPanel(data: data, fullscreen: true),
    );
  }
}
