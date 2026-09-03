import "package:flutter/material.dart";
import "package:flutter/services.dart" show Clipboard, ClipboardData;
import "package:qr_flutter/qr_flutter.dart";
import "package:url_launcher/url_launcher.dart";

import "../../core/config/api_config.dart";
import "../../core/services/image_preview_launcher.dart";
import "../../core/utils/agent_result_parser.dart";
import "intelligent_route_planner.dart";
import "media_thumbnail.dart";
import "travel_booking_sheet.dart";
import "travel_detail_sheet.dart";
import "travel_export_util.dart";
import "travel_item_editor.dart";
import "travel_map_controller.dart";
import "travel_map_view.dart";
import "travel_plan_api.dart";
import "travel_plan_models.dart";

// ═══════════════════════════════════════════════════════════════════
// 双面板行程规划界面（能力一比一移植自 3D-Travel 主界面：
// 地图 3D / 智能路线 / 行程编辑 / 预订清单 / 详情面板 / 导出分享）
// ═══════════════════════════════════════════════════════════════════

const Color _kAccentBlue = Color(0xFF18D6F3);
const Color _kAccentGreen = Color(0xFF1ED7A6);
const Color _kAccentOrange = Color(0xFFD7B85A);
const Color _kAccentPurple = Color(0xFF8B5CF6);

/// 双面板行程规划界面（左栏天数 + 中部地图 + 右栏当日行程）。
///
/// 既可用于右侧分栏面板（聊天 + 规划界面双面板并行），
/// 也可经全屏入口在独立页面中以更大尺寸呈现。
class TravelPlanPanel extends StatefulWidget {
  const TravelPlanPanel({
    super.key,
    required this.data,
    this.fullscreen = false,
    this.onClose,
  });

  final AgentResultData data;

  /// 是否为全屏模式（全屏页时隐藏内部关闭按钮、强制深色渲染）。
  final bool fullscreen;

  /// 关闭回调（右侧面板模式传 [RightSidePanel] 的关闭，全屏页自身有返回键）。
  final VoidCallback? onClose;

  @override
  State<TravelPlanPanel> createState() => _TravelPlanPanelState();
}

class _TravelPlanPanelState extends State<TravelPlanPanel> {
  late TravelPlanData _plan = TravelPlanData.from(widget.data);
  int _selectedDay = 0;

  // 地图（WebView + MapLibre，能力移植自 3D-Travel Map3DController）
  final TravelMapController _mapController = TravelMapController();
  bool _mapOn = true;

  // 智能路线规划（移植自 IntelligentRoutePlanner）
  final IntelligentRoutePlanner _planner = IntelligentRoutePlanner();
  TravelPreferences _prefs = const TravelPreferences();
  SmartRouteResult? _route;
  List<RouteWaypoint> _lastWaypoints = const <RouteWaypoint>[];

  // 价格设置（预订清单用，面板级留存）
  String _memberTier = "normal";
  List<BoundPlatform> _platforms = const <BoundPlatform>[];

  bool _busy = false; // 编辑类操作进行中

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
    _mapController.setPois(_collectPois());
    _mapController.showDay(_plan.days.length > 1 ? _selectedDay : null);
  }

  void _onPoiTap(String name) {
    // 3D-Travel 中点击标记即弹出地图 Popup（地图内实现）；这里补一次飞行定位
    for (final TravelMapPoi poi in _collectPois()) {
      if (poi.name == name) {
        _mapController.flyTo(poi.latitude, poi.longitude, zoom: 16.5);
        return;
      }
    }
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
  // 行程编辑（替换 / 提意见重推荐 / 移除 → 服务端持久化）
  // ═════════════════════════════════════════════════════════════════

  Future<void> _openItemEditor(int dayIndex, int itemIndex) async {
    final TravelDayEntry entry = _plan.days[dayIndex].entries[itemIndex];
    if (!_plan.hasPlanId) {
      _toast("当前行程为文本解析结果，不支持在线编辑", error: true);
      return;
    }
    final TravelItemEditorResult? result = await TravelItemEditor.show(
      context,
      entry: entry,
      destination: _plan.destination,
    );
    if (result == null || !mounted) return;
    setState(() => _busy = true);
    try {
      final TravelPlanApi api = TravelPlanApi();
      final Map<String, dynamic> updated;
      if (result.item != null) {
        final Map<String, dynamic> item = Map<String, dynamic>.of(result.item!);
        item["startTime"] = entry.time; // 替换保留原时间段
        if ((item["type"]?.toString() ?? "").isEmpty) {
          item["type"] = entry.type;
        }
        updated = await api.replaceItem(_plan.planId, dayIndex, itemIndex, item);
        _toast("已替换：${item["name"] ?? ""}");
      } else {
        updated = await api.commentItem(
            _plan.planId, dayIndex, itemIndex, result.comment ?? "");
        _toast("已按你的意见重新推荐");
      }
      _applyUpdatedPlan(updated);
    } catch (e) {
      _toast("操作失败：$e", error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _removeItem(int dayIndex, int itemIndex) async {
    if (!_plan.hasPlanId) {
      _toast("当前行程为文本解析结果，不支持在线编辑", error: true);
      return;
    }
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext context) => AlertDialog(
        title: const Text("移除该行程项", style: TextStyle(fontSize: 15)),
        content: Text(
          "确定移除「${_plan.days[dayIndex].entries[itemIndex].title}」吗？",
          style: const TextStyle(fontSize: 13),
        ),
        actions: <Widget>[
          TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: const Text("取消")),
          FilledButton(
              onPressed: () => Navigator.of(context).pop(true),
              child: const Text("移除")),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _busy = true);
    try {
      final Map<String, dynamic> updated =
          await TravelPlanApi().removeItem(_plan.planId, dayIndex, itemIndex);
      _applyUpdatedPlan(updated);
      _toast("已移除");
    } catch (e) {
      _toast("移除失败：$e", error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// 服务端返回的更新后行程 → 刷新面板 + 地图（路线已失效则清除）。
  void _applyUpdatedPlan(Map<String, dynamic> updated) {
    setState(() {
      _plan = TravelPlanData.fromPlanJson(updated);
      if (_selectedDay >= _plan.days.length) _selectedDay = 0;
      if (_route != null) {
        _route = null;
        _lastWaypoints = const <RouteWaypoint>[];
        _mapController.clearRoute();
      }
    });
    _syncMap();
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
  // 预订 / 偏好 / 分享 / 导出
  // ═════════════════════════════════════════════════════════════════

  Future<void> _openBooking() async {
    if (!_plan.hasPlanId) {
      _toast("当前行程为文本解析结果，暂不支持预订计价", error: true);
      return;
    }
    final (String, List<BoundPlatform>)? applied = await TravelBookingSheet.show(
      context,
      planId: _plan.planId,
      initialTier: _memberTier,
      initialPlatforms: _platforms,
    );
    if (applied != null) {
      setState(() {
        _memberTier = applied.$1;
        _platforms = applied.$2;
      });
    }
  }

  /// 偏好设置弹窗（移植自 _openPreferencesPanel），保存后自动重新规划路线。
  Future<void> _openPreferences() async {
    String scenery = _prefs.sceneryPreference;
    String transportMode = _prefs.transportMode;
    final TextEditingController timeCtrl =
        TextEditingController(text: _prefs.departureTime);
    String budget = _prefs.budgetLevel;
    String effort = _prefs.physicalEffort;
    bool avoidCrowds = _prefs.avoidCrowds;
    bool prioritizeSpeed = _prefs.prioritizeSpeed;

    final bool? saved = await showDialog<bool>(
      context: context,
      builder: (BuildContext context) => StatefulBuilder(
        builder: (BuildContext context, void Function(void Function()) setDialog) {
          final ColorScheme cs = Theme.of(context).colorScheme;
          Widget chips<T extends Object>({
            required String label,
            required T value,
            required Map<T, String> options,
            required void Function(T) onSelect,
          }) {
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(label,
                    style: const TextStyle(
                        fontSize: 12, fontWeight: FontWeight.w600)),
                const SizedBox(height: 6),
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: <Widget>[
                    for (final MapEntry<T, String> o in options.entries)
                      ChoiceChip(
                        label: Text(o.value, style: const TextStyle(fontSize: 11)),
                        selected: value == o.key,
                        onSelected: (_) => setDialog(() => onSelect(o.key)),
                      ),
                  ],
                ),
              ],
            );
          }

          return Dialog(
            backgroundColor: cs.surfaceContainer,
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440, maxHeight: 600),
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    const Text("智能规划偏好设置",
                        style: TextStyle(
                            fontSize: 15, fontWeight: FontWeight.w700)),
                    const SizedBox(height: 12),
                    Expanded(
                      child: SingleChildScrollView(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            chips<String>(
                              label: "景色偏好",
                              value: scenery,
                              options: const <String, String>{
                                "natural": "自然风光",
                                "cultural": "人文历史",
                                "balanced": "平衡兼顾",
                              },
                              onSelect: (String v) => scenery = v,
                            ),
                            const SizedBox(height: 12),
                            chips<String>(
                              label: "首选交通方式",
                              value: transportMode,
                              options: const <String, String>{
                                "auto": "自动推荐",
                                "driving": "驾车",
                                "public_transit": "公共交通",
                                "cycling": "骑行",
                                "walking": "步行",
                                "taxi": "网约车",
                                "rental_car": "租车自驾",
                              },
                              onSelect: (String v) => transportMode = v,
                            ),
                            const SizedBox(height: 12),
                            Text("出发时间",
                                style: const TextStyle(
                                    fontSize: 12,
                                    fontWeight: FontWeight.w600)),
                            const SizedBox(height: 6),
                            TextField(
                              controller: timeCtrl,
                              style: const TextStyle(fontSize: 13),
                              decoration: InputDecoration(
                                isDense: true,
                                hintText: "09:00",
                                border: OutlineInputBorder(
                                    borderRadius: BorderRadius.circular(10)),
                              ),
                            ),
                            const SizedBox(height: 12),
                            chips<String>(
                              label: "预算水平",
                              value: budget,
                              options: const <String, String>{
                                "low": "经济实惠",
                                "medium": "中等预算",
                                "high": "不差钱",
                              },
                              onSelect: (String v) => budget = v,
                            ),
                            const SizedBox(height: 12),
                            chips<String>(
                              label: "体力要求",
                              value: effort,
                              options: const <String, String>{
                                "easy": "轻松休闲",
                                "moderate": "适中活动",
                                "challenging": "挑战自我",
                              },
                              onSelect: (String v) => effort = v,
                            ),
                            const SizedBox(height: 12),
                            SwitchListTile(
                              contentPadding: EdgeInsets.zero,
                              dense: true,
                              title: const Text("避开人流高峰",
                                  style: TextStyle(fontSize: 12)),
                              value: avoidCrowds,
                              onChanged: (bool v) =>
                                  setDialog(() => avoidCrowds = v),
                            ),
                            SwitchListTile(
                              contentPadding: EdgeInsets.zero,
                              dense: true,
                              title: const Text("优先速度（vs 景色）",
                                  style: TextStyle(fontSize: 12)),
                              value: prioritizeSpeed,
                              onChanged: (bool v) =>
                                  setDialog(() => prioritizeSpeed = v),
                            ),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 10),
                    Row(
                      children: <Widget>[
                        Expanded(
                          child: OutlinedButton(
                            onPressed: () => Navigator.of(context).pop(false),
                            child: const Text("取消"),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: FilledButton(
                            onPressed: () => Navigator.of(context).pop(true),
                            child: const Text("保存并重新规划"),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
    timeCtrl.dispose();
    if (saved == true) {
      setState(() {
        _prefs = TravelPreferences(
          sceneryPreference: scenery,
          transportMode: transportMode,
          departureTime: timeCtrl.text.trim().isNotEmpty
              ? timeCtrl.text.trim()
              : "09:00",
          budgetLevel: budget,
          physicalEffort: effort,
          avoidCrowds: avoidCrowds,
          prioritizeSpeed: prioritizeSpeed,
        );
      });
      _toast("偏好已保存，正在重新规划路线…");
      _planRoute();
    }
  }

  /// 更多菜单（导出 / 分享 / 发送到手机）。
  Future<void> _openMoreMenu() async {
    final String? action = await showMenu<String>(
      context: context,
      position: const RelativeRect.fromLTRB(double.maxFinite, 60, 12, double.maxFinite),
      items: const <PopupMenuEntry<String>>[
        PopupMenuItem<String>(value: "export-json", child: Text("导出 JSON", style: TextStyle(fontSize: 13))),
        PopupMenuItem<String>(value: "export-text", child: Text("导出文本", style: TextStyle(fontSize: 13))),
        PopupMenuItem<String>(value: "export-calendar", child: Text("导出日历 (ICS)", style: TextStyle(fontSize: 13))),
        PopupMenuDivider(),
        PopupMenuItem<String>(value: "share", child: Text("生成分享码", style: TextStyle(fontSize: 13))),
        PopupMenuItem<String>(value: "mobile", child: Text("发送到手机", style: TextStyle(fontSize: 13))),
      ],
    );
    if (action == null || !mounted) return;
    switch (action) {
      case "export-json":
      case "export-text":
      case "export-calendar":
        final String? msg = await TravelExportUtil.exportItinerary(
            _plan, action.substring("export-".length));
        if (msg != null) _toast(msg);
        break;
      case "share":
      case "mobile":
        await _sharePlan(toMobile: action == "mobile");
        break;
    }
  }

  Future<void> _sharePlan({required bool toMobile}) async {
    if (!_plan.hasPlanId) {
      _toast("当前行程为文本解析结果，暂不支持分享", error: true);
      return;
    }
    setState(() => _busy = true);
    try {
      final String code = await TravelPlanApi().createShareCode(_plan.planId);
      if (!mounted) return;
      if (toMobile) {
        final String url = "${ApiConfig.httpBase}/travel/share/$code";
        await showDialog<void>(
          context: context,
          builder: (BuildContext context) => AlertDialog(
            title: const Text("发送到手机", style: TextStyle(fontSize: 15)),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: QrImageView(
                    data: url,
                    size: 180,
                    backgroundColor: Colors.white,
                  ),
                ),
                const SizedBox(height: 10),
                Text("手机扫码查看「${_plan.destination}」行程",
                    style: const TextStyle(fontSize: 12)),
                const SizedBox(height: 4),
                SelectableText(url,
                    style: const TextStyle(fontSize: 10, color: Colors.grey)),
              ],
            ),
            actions: <Widget>[
              TextButton(
                  onPressed: () => Navigator.of(context).pop(),
                  child: const Text("关闭")),
            ],
          ),
        );
      } else {
        await showDialog<void>(
          context: context,
          builder: (BuildContext context) => AlertDialog(
            title: const Text("行程分享码", style: TextStyle(fontSize: 15)),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                SelectableText(code,
                    style: const TextStyle(
                        fontSize: 24,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 4)),
                const SizedBox(height: 8),
                const Text("对方在行程面板输入分享码即可查看完整行程",
                    style: TextStyle(fontSize: 12)),
              ],
            ),
            actions: <Widget>[
              TextButton(
                onPressed: () {
                  Clipboard.setData(ClipboardData(text: code));
                  Navigator.of(context).pop();
                  _toast("分享码已复制");
                },
                child: const Text("复制"),
              ),
            ],
          ),
        );
      }
    } catch (e) {
      _toast("分享失败：$e", error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
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
            child: Stack(
              children: <Widget>[
                Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    if (_plan.days.length > 1) ...<Widget>[
                      SizedBox(width: leftWidth, child: _buildDayList(cs)),
                      VerticalDivider(width: 1, color: cs.outline.withValues(alpha: 0.18)),
                    ],
                    Expanded(child: _buildMainArea(cs, full)),
                  ],
                ),
                if (_busy)
                  Positioned.fill(
                    child: IgnorePointer(
                      child: Center(
                        child: Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 16, vertical: 10),
                          decoration: BoxDecoration(
                            color: cs.surface.withValues(alpha: 0.9),
                            borderRadius: BorderRadius.circular(10),
                          ),
                          child: const Row(
                            mainAxisSize: MainAxisSize.min,
                            children: <Widget>[
                              SizedBox(
                                  width: 16,
                                  height: 16,
                                  child: CircularProgressIndicator(strokeWidth: 2)),
                              SizedBox(width: 10),
                              Text("处理中…", style: TextStyle(fontSize: 12)),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  // ── 顶栏：目的地 + 标题 + 工具组 ──────────────────────────────────
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
              color: _kAccentBlue.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(999),
              border: Border.all(
                  color: _kAccentBlue.withValues(alpha: 0.35)),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                const Icon(Icons.flag_outlined, size: 13, color: _kAccentBlue),
                const SizedBox(width: 4),
                Text(
                  dest,
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: _kAccentBlue,
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
          _headerIconBtn(cs, icon: Icons.route_outlined, tooltip: "规划当日路线",
              onTap: _planRoute),
          _headerIconBtn(cs,
              icon: _mapOn ? Icons.map_rounded : Icons.map_outlined,
              tooltip: _mapOn ? "收起地图" : "展开地图",
              color: _mapOn ? _kAccentBlue : null,
              onTap: () => setState(() => _mapOn = !_mapOn)),
          _headerIconBtn(cs,
              icon: Icons.receipt_long_outlined,
              tooltip: "预订清单",
              onTap: _openBooking),
          _headerIconBtn(cs,
              icon: Icons.tune_outlined, tooltip: "偏好设置", onTap: _openPreferences),
          _headerIconBtn(cs,
              icon: Icons.more_horiz, tooltip: "导出 / 分享", onTap: _openMoreMenu),
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

  // ── 主区：地图 + 当日时间线 ──────────────────────────────────────
  Widget _buildMainArea(ColorScheme cs, bool full) {
    final Widget timeline = _buildDayDetail(cs, full);
    if (!_mapOn) return timeline;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Expanded(
          flex: 5,
          child: Stack(
            fit: StackFit.expand,
            children: <Widget>[
              TravelMapView(controller: _mapController),
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
          ),
        ),
        VerticalDivider(width: 1, color: cs.outline.withValues(alpha: 0.18)),
        Expanded(flex: 6, child: timeline),
      ],
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
              Icon(icon, size: 14, color: _kAccentBlue),
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
                  const Icon(Icons.auto_awesome, size: 14, color: _kAccentBlue),
                  const SizedBox(width: 6),
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
                      color: _kAccentGreen.withValues(alpha: 0.9))),
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
          color: _kAccentBlue.withValues(alpha: 0.18),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(icon, size: 12, color: _kAccentBlue),
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

  // ── 左栏：天数列表 ──────────────────────────────────────────────
  Widget _buildDayList(ColorScheme cs) {
    return ListView.builder(
      padding: const EdgeInsets.symmetric(vertical: 10),
      itemCount: _plan.days.length + (_plan.footer.isEmpty ? 0 : 1),
      itemBuilder: (BuildContext context, int index) {
        if (index == _plan.days.length) return _buildFooterCard(cs);
        final TravelPlanDay day = _plan.days[index];
        final bool selected = index == _selectedDay;
        return _DayCard(
          day: day,
          selected: selected,
          onTap: () {
            setState(() => _selectedDay = index);
            _mapController.showDay(_plan.days.length > 1 ? index : null);
            if (_route != null) _clearRoute();
          },
        );
      },
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

  // ── 右栏：当日行程时间线（点击开详情，悬停出编辑操作）──────────────
  Widget _buildDayDetail(ColorScheme cs, bool full) {
    final TravelPlanDay day =
        _plan.days[_selectedDay.clamp(0, _plan.days.length - 1)];
    final List<TravelDayEntry> entries = day.entries;

    return CustomScrollView(
      slivers: <Widget>[
        SliverToBoxAdapter(
          child: Padding(
            padding: EdgeInsets.fromLTRB(full ? 22 : 14, 14, full ? 22 : 14, 6),
            child: Row(
              children: <Widget>[
                Icon(Icons.calendar_today_outlined,
                    size: 14, color: _kAccentBlue),
                const SizedBox(width: 6),
                Text(
                  day.label,
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: cs.onSurface,
                  ),
                ),
                if (day.subtitle.isNotEmpty) ...<Widget>[
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      day.subtitle,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 11,
                        color: cs.onSurfaceVariant,
                      ),
                    ),
                  ),
                ],
                const Spacer(),
                Text(
                  "${entries.length} 项安排",
                  style: TextStyle(
                    fontSize: 11,
                    color: cs.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ),
        if (entries.isEmpty)
          SliverFillRemaining(
            hasScrollBody: false,
            child: Center(
              child: Text(
                "这一天的行程还在安排中",
                style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
              ),
            ),
          )
        else
          SliverList(
            delegate: SliverChildBuilderDelegate(
              (BuildContext context, int i) => _EntryTile(
                entry: entries[i],
                dayIndex: _selectedDay,
                itemIndex: i,
                dayLabel: day.label,
                last: i == entries.length - 1,
                editable: _plan.hasPlanId,
                onOpenDetail: () => TravelDetailSheet.show(
                  context,
                  entry: entries[i],
                  dayLabel: day.label,
                ),
                onEdit: () => _openItemEditor(_selectedDay, i),
                onRemove: () => _removeItem(_selectedDay, i),
              ),
              childCount: entries.length,
            ),
          ),
        if (_plan.footer.isNotEmpty && _mapOn)
          const SliverToBoxAdapter(child: SizedBox.shrink())
        else if (_plan.footer.isNotEmpty)
          SliverToBoxAdapter(
            child: Padding(
              padding: EdgeInsets.fromLTRB(full ? 22 : 14, 12, full ? 22 : 14, 20),
              child: _buildInfoPanel(cs),
            ),
          ),
      ],
    );
  }

  /// 底部信息区：价格/实用信息提示（footer）。
  Widget _buildInfoPanel(ColorScheme cs) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHigh.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: cs.outline.withValues(alpha: 0.15)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Icon(Icons.lightbulb_outline, size: 14, color: _kAccentOrange),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              _plan.footer,
              style: TextStyle(
                fontSize: 12,
                height: 1.5,
                color: cs.onSurfaceVariant,
              ),
            ),
          ),
        ],
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
            ? _kAccentBlue.withValues(alpha: 0.12)
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
                    ? _kAccentBlue.withValues(alpha: 0.4)
                    : Colors.transparent,
              ),
            ),
            child: Row(
              children: <Widget>[
                Icon(
                  Icons.place_outlined,
                  size: 14,
                  color: selected ? _kAccentBlue : cs.onSurfaceVariant,
                ),
                const SizedBox(width: 8),
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
                          color: selected ? _kAccentBlue : cs.onSurface,
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

// ── 右栏时间线条目（悬停操作：编辑/提意见/移除；点击开详情）──────────
class _EntryTile extends StatefulWidget {
  const _EntryTile({
    required this.entry,
    required this.dayIndex,
    required this.itemIndex,
    required this.dayLabel,
    required this.last,
    required this.editable,
    required this.onOpenDetail,
    required this.onEdit,
    required this.onRemove,
  });

  final TravelDayEntry entry;
  final int dayIndex;
  final int itemIndex;
  final String dayLabel;
  final bool last;
  final bool editable;
  final VoidCallback onOpenDetail;
  final VoidCallback onEdit;
  final VoidCallback onRemove;

  @override
  State<_EntryTile> createState() => _EntryTileState();
}

class _EntryTileState extends State<_EntryTile> {
  bool _hover = false;

  Color get _kindColor {
    switch (widget.entry.kind) {
      case TravelEntryKind.restaurant:
        return _kAccentOrange;
      case TravelEntryKind.hotel:
        return _kAccentGreen;
      case TravelEntryKind.transport:
        return _kAccentPurple;
      case TravelEntryKind.attraction:
        return _kAccentBlue;
      case TravelEntryKind.other:
        return const Color(0xFF9AA0A6);
    }
  }

  IconData get _kindIcon {
    switch (widget.entry.kind) {
      case TravelEntryKind.restaurant:
        return Icons.restaurant_outlined;
      case TravelEntryKind.hotel:
        return Icons.hotel_outlined;
      case TravelEntryKind.transport:
        return Icons.directions_transit_outlined;
      case TravelEntryKind.attraction:
        return Icons.attractions_outlined;
      case TravelEntryKind.other:
        return Icons.place_outlined;
    }
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final TravelDayEntry entry = widget.entry;
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 4, 14, 2),
      child: IntrinsicHeight(
        child: MouseRegion(
          onEnter: (_) => setState(() => _hover = true),
          onExit: (_) => setState(() => _hover = false),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              // 时间列
              SizedBox(
                width: 44,
                child: Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    entry.time,
                    textAlign: TextAlign.right,
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                      color: cs.onSurfaceVariant,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              // 时间轴
              Column(
                children: <Widget>[
                  Container(
                    width: 22,
                    height: 22,
                    margin: const EdgeInsets.only(top: 3),
                    decoration: BoxDecoration(
                      color: _kindColor.withValues(alpha: 0.12),
                      shape: BoxShape.circle,
                      border: Border.all(
                          color: _kindColor.withValues(alpha: 0.45)),
                    ),
                    child: Icon(_kindIcon, size: 12, color: _kindColor),
                  ),
                  if (!widget.last)
                    Expanded(
                      child: Container(
                        width: 1.5,
                        color: _kindColor.withValues(alpha: 0.15),
                      ),
                    ),
                ],
              ),
              const SizedBox(width: 10),
              // 内容卡
              Expanded(
                child: GestureDetector(
                  onTap: widget.onOpenDetail,
                  child: Container(
                    margin: const EdgeInsets.only(bottom: 12),
                    padding: const EdgeInsets.symmetric(
                        horizontal: 12, vertical: 8),
                    decoration: BoxDecoration(
                      color: cs.surfaceContainerHigh,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(
                          color: _hover
                              ? _kindColor.withValues(alpha: 0.4)
                              : cs.outline.withValues(alpha: 0.12)),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Row(
                          children: <Widget>[
                            Expanded(
                              child: Text(
                                entry.title,
                                style: TextStyle(
                                  fontSize: 13,
                                  fontWeight: FontWeight.w600,
                                  color: cs.onSurface,
                                ),
                              ),
                            ),
                            // 悬停操作：编辑（替换/提意见）+ 移除
                            AnimatedOpacity(
                              opacity: _hover ? 1 : 0,
                              duration: const Duration(milliseconds: 120),
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: <Widget>[
                                  if (widget.editable) ...<Widget>[
                                    _tileAction(
                                      icon: Icons.swap_horiz,
                                      tooltip: "替换 / 提意见",
                                      color: _kAccentBlue,
                                      onTap: widget.onEdit,
                                    ),
                                    const SizedBox(width: 2),
                                  ],
                                  if (widget.editable)
                                    _tileAction(
                                      icon: Icons.delete_outline,
                                      tooltip: "移除",
                                      color: cs.error,
                                      onTap: widget.onRemove,
                                    ),
                                ],
                              ),
                            ),
                          ],
                        ),
                        if (entry.priceInfo.isNotEmpty)
                          _metaText(cs, entry.priceInfo,
                              color: _kAccentOrange),
                        if (entry.description.isNotEmpty)
                          _metaText(cs, entry.description),
                        if (entry.tips.isNotEmpty)
                          _metaText(cs, entry.tips.join("；")),
                        if (entry.address.isNotEmpty)
                          _metaText(cs, "📍 ${entry.address}"),
                        if (entry.images.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(top: 8),
                            child: _buildImageStrip(context, cs),
                          ),
                        if (entry.reviews.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(top: 7),
                            child: _buildReviewLines(cs),
                          ),
                        if (entry.videos.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(top: 7),
                            child: _buildVideoChips(context, cs),
                          ),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _tileAction({
    required IconData icon,
    required String tooltip,
    required Color color,
    required VoidCallback onTap,
  }) {
    return Tooltip(
      message: tooltip,
      child: InkWell(
        borderRadius: BorderRadius.circular(6),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(3),
          child: Icon(icon, size: 14, color: color),
        ),
      ),
    );
  }

  Widget _metaText(ColorScheme cs, String text, {Color? color}) {
    return Padding(
      padding: const EdgeInsets.only(top: 3),
      child: Text(
        text,
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          fontSize: 11,
          height: 1.45,
          color: color ?? cs.onSurfaceVariant,
        ),
      ),
    );
  }

  // ── 媒体区：实拍图条（点击开大图预览）──────────────────────────
  Widget _buildImageStrip(BuildContext context, ColorScheme cs) {
    return SizedBox(
      height: 64,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: widget.entry.images.length,
        separatorBuilder: (_, __) => const SizedBox(width: 6),
        itemBuilder: (BuildContext context, int i) {
          return GestureDetector(
            onTap: () {
              // 大图预览（面板顶部的右侧图片预览面板）
              _openPreview(context, i);
            },
            child: MediaThumbnail(
              url: widget.entry.images[i],
              cs: cs,
              width: 84,
              height: 64,
              borderRadius: 6,
            ),
          );
        },
      ),
    );
  }

  void _openPreview(BuildContext context, int index) {
    ImagePreviewLauncher.open(
      url: widget.entry.images[index],
      title: widget.entry.title,
      gallery: widget.entry.images,
      index: index,
    );
  }

  // ── 媒体区：本地评论（内联 2 条）────────────────────────────────
  Widget _buildReviewLines(ColorScheme cs) {
    final int total = widget.entry.reviews.length;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        for (final TravelEntryReview review in widget.entry.reviews)
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Row(
              children: <Widget>[
                const Icon(Icons.star_rounded,
                    size: 13, color: Color(0xFFF5B942)),
                const SizedBox(width: 4),
                Expanded(
                  child: Text(
                    "${review.rating.toStringAsFixed(1)} · "
                    "${review.author.isEmpty ? "旅友" : review.author}：${review.text}",
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 11,
                      color: cs.onSurfaceVariant,
                    ),
                  ),
                ),
              ],
            ),
          ),
        if (total >= 2)
          Padding(
            padding: const EdgeInsets.only(top: 3, left: 17),
            child: Text(
              "共 $total 条评论",
              style: TextStyle(
                fontSize: 10,
                color: cs.onSurfaceVariant.withValues(alpha: 0.75),
              ),
            ),
          ),
      ],
    );
  }

  // ── 媒体区：视频入口（元数据 chip，点击跳原平台播放页）──────────
  Widget _buildVideoChips(BuildContext context, ColorScheme cs) {
    return Wrap(
      spacing: 6,
      runSpacing: 6,
      children: <Widget>[
        for (final TravelEntryVideo video in widget.entry.videos)
          if (video.playPageUrl.isNotEmpty)
            InkWell(
              borderRadius: BorderRadius.circular(999),
              onTap: () {
                final Uri? uri = Uri.tryParse(video.playPageUrl);
                if (uri != null) {
                  launchUrl(uri, mode: LaunchMode.externalApplication);
                }
              },
              child: Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                decoration: BoxDecoration(
                  color: _kAccentBlue.withValues(alpha: 0.08),
                  borderRadius: BorderRadius.circular(999),
                  border: Border.all(
                      color: _kAccentBlue.withValues(alpha: 0.3)),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    const Icon(Icons.play_circle_outline,
                        size: 13, color: _kAccentBlue),
                    const SizedBox(width: 4),
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 150),
                      child: Text(
                        video.title.isEmpty
                            ? (video.platform.isEmpty ? "相关视频" : video.platform)
                            : "${video.platform.isEmpty ? "" : "${video.platform} · "}${video.title}",
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 11,
                          color: _kAccentBlue,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
      ],
    );
  }
}

/// 全屏行程规划页：独立路由，沉浸式浏览双面板行程。
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
