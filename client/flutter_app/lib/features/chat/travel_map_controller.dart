import "dart:async";
import "dart:convert";

/// 旅游行程地图控制器 —— 通过 WebView 承载 MapLibre GL JS 页面
/// （assets/travel_map/map.html，能力一比一移植自 3D-Travel 项目 Map3DController）。
///
/// 桥协议：
/// - Dart → JS：`window.__travelMap.xxx(...)` 经 executeScript 调用；
/// - JS → Dart：`window.chrome.webview.postMessage(JSON)` 经 webMessage 流回传，
///   由 [handleWebMessage] 分发为回调。
///
/// 非 Windows / WebView 初始化失败场景下，本控制器所有方法静默 no-op，
/// 不会抛异常导致宿主面板崩溃。
class TravelMapController {
  /// POI 点击回调（弹窗联动等，由视图层设置）。
  void Function(String name)? onPoiTap;

  /// 沉浸式 3D 实景打开回调（url 已在 JS 侧拼接 httpBase）。
  void Function(String url)? onSplatOpen;

  /// 底图样式切换回调（0 街道 1 卫星 2 暗色）。
  void Function(int index)? onStyleChanged;

  /// JS 页面就绪回调（供视图移除加载占位）。
  void Function()? onReady;

  Future<void> Function(String script)? _executeScript;
  bool _ready = false;
  final List<String> _pendingScripts = <String>[];

  /// WebView 是否已就绪（收到 JS 的 ready 事件）。
  bool get isReady => _ready;

  /// 由视图在 WebView 加载完成后调用：注入脚本执行器并发送宿主配置。
  ///
  /// [httpBase] 用于 JS 侧拼接相对路径的 splatUrl（与 resolveMediaUrl 约定一致）；
  /// [maptilerKey] 可选，有则 JS 侧追加 MapTiler 源（启用 3D 地形 + 建筑）。
  Future<void> attach(
    Future<void> Function(String script) executeScript, {
    String httpBase = "",
    String maptilerKey = "",
  }) async {
    _executeScript = executeScript;
    _ready = false;
    await _runNow(
      "window.__travelMap && window.__travelMap.setHttpBase("
      "${jsonEncode(httpBase)}, ${jsonEncode(maptilerKey)});",
    );
  }

  /// 视图 dispose 时调用：释放引用，方法回归静默 no-op。
  void detach() {
    _executeScript = null;
    _ready = false;
    _pendingScripts.clear();
  }

  /// JS → Dart 事件入口：由视图把 webMessage 原样转发进来。
  void handleWebMessage(Object? message) {
    Map<String, dynamic>? data;
    if (message is Map) {
      data = <String, dynamic>{
        for (final MapEntry<Object?, Object?> e in message.entries)
          e.key.toString(): e.value,
      };
    } else if (message is String) {
      try {
        final Object? decoded = jsonDecode(message);
        if (decoded is Map) {
          data = <String, dynamic>{
            for (final MapEntry<Object?, Object?> e in decoded.entries)
              e.key.toString(): e.value,
          };
        }
      } catch (_) {
        return;
      }
    }
    if (data == null) return;
    switch (data["event"]) {
      case "ready":
        _ready = true;
        _flushPending();
        onReady?.call();
        break;
      case "poiTap":
        onPoiTap?.call(data["name"]?.toString() ?? "");
        break;
      case "splat":
        onSplatOpen?.call(data["url"]?.toString() ?? "");
        break;
      case "styleChanged":
        onStyleChanged?.call(int.tryParse("${data["index"]}") ?? 0);
        break;
      default:
        break;
    }
  }

  // ── 对 JS 的能力调用（未 attach / 未就绪时入队或 no-op）──────────────

  /// 设置 POI 标记（整体替换）。type: hotel/attraction/restaurant/transport。
  void setPois(List<TravelMapPoi> pois) {
    _send(
      "setPois",
      <Map<String, dynamic>>[for (final TravelMapPoi p in pois) p.toJson()],
    );
  }

  /// 按天过滤 POI 显隐并 fitBounds 到当天范围；[dayIndex] 为 null 显示全部。
  void showDay(int? dayIndex) {
    _send("showDay", dayIndex);
  }

  /// 飞行定位到某点。
  void flyTo(double lat, double lng, {double zoom = 16}) {
    // 三个位置参数，不走 jsonEncode 数组形式
    _sendRaw(
      "window.__travelMap && window.__travelMap.flyTo($lat,$lng,$zoom);",
    );
  }

  /// 绘制行程路线（分段按交通方式配色 + 流光动画 + 途经点徽标）。
  void drawRoute(List<TravelRouteSegment> segments) {
    _send(
      "drawRoute",
      <Map<String, dynamic>>[
        for (final TravelRouteSegment s in segments) s.toJson(),
      ],
    );
  }

  /// 清除路线与途经点徽标。
  void clearRoute() {
    _send("clearRoute");
  }

  /// 一键切换 3D 视角（地形 exaggeration 1.2 / pitch 55 / bearing -15 ⇄ 平面）。
  void toggle3D() {
    _send("toggle3D");
  }

  /// 切换底图样式：0 街道 1 卫星（ESRI 影像 hybrid）2 暗色。
  void setStyle(int index) {
    _send("setStyle", index);
  }

  /// 复位视角（fitBounds 到当前可见 POI，或回到默认中心）。
  void resetView() {
    _send("resetView");
  }

  // ── 内部：脚本派发 ────────────────────────────────────────────────

  void _send(String method, [Object? args]) {
    final String argList = args == null ? "" : jsonEncode(args);
    _sendRaw("window.__travelMap && window.__travelMap.$method($argList);");
  }

  void _sendRaw(String script) {
    if (_executeScript == null) return; // 未 attach / 已 detach，静默 no-op
    if (!_ready) {
      _pendingScripts.add(script);
      return;
    }
    _runNow(script);
  }

  void _flushPending() {
    final List<String> scripts = List<String>.of(_pendingScripts);
    _pendingScripts.clear();
    for (final String script in scripts) {
      _runNow(script);
    }
  }

  Future<void> _runNow(String script) async {
    final Future<void> Function(String)? exec = _executeScript;
    if (exec == null) return;
    try {
      await exec(script);
    } catch (_) {
      // executeScript 失败（页面未就绪/已销毁等）静默吞掉，不传染面板
    }
  }
}

/// 地图上的一个点（经纬度）。
class TravelMapPoint {
  const TravelMapPoint({required this.latitude, required this.longitude});

  final double latitude;
  final double longitude;

  Map<String, double> toJson() => <String, double>{
        "latitude": latitude,
        "longitude": longitude,
      };
}

/// 地图 POI（旅游行程中的地点标记）。
class TravelMapPoi {
  const TravelMapPoi({
    required this.name,
    required this.type,
    required this.latitude,
    required this.longitude,
    this.splatUrl = "",
    this.dayIndex,
    this.address = "",
  });

  /// 地点名称（弹窗标题 / poiTap 事件回传）。
  final String name;

  /// 类型：hotel / attraction / restaurant / transport（决定标记四色）。
  final String type;

  final double latitude;
  final double longitude;

  /// 3DGS 高斯溅射实景地址（相对路径时 JS 侧拼 httpBase 前缀）；空则不显示实景按钮。
  final String splatUrl;

  /// 所属天（0 基），null 表示不限天（始终显示）。
  final int? dayIndex;

  final String address;

  Map<String, dynamic> toJson() => <String, dynamic>{
        "name": name,
        "type": type,
        "latitude": latitude,
        "longitude": longitude,
        "splatUrl": splatUrl,
        "dayIndex": dayIndex,
        "address": address,
      };
}

/// 一段行程路线（按交通方式配色）。
class TravelRouteSegment {
  const TravelRouteSegment({
    required this.mode,
    required this.points,
    this.fromName = "",
    this.toName = "",
  });

  /// 交通方式：driving / taxi / transit / walking / cycling（决定配色）。
  final String mode;

  /// 路径折线点（至少两个有效点才会绘制）。
  final List<TravelMapPoint> points;

  final String fromName;
  final String toName;

  Map<String, dynamic> toJson() => <String, dynamic>{
        "mode": mode,
        "points": <Map<String, double>>[
          for (final TravelMapPoint p in points) p.toJson(),
        ],
        "fromName": fromName,
        "toName": toName,
      };
}
