import "dart:async" show Timer;
import "dart:convert" show jsonDecode, JsonEncoder;
import "dart:io" show Directory, File, Platform;
import "dart:math" as math;
import "dart:ui" show Offset, Rect, Size;

import "package:flutter/foundation.dart" show debugPrint;
import "package:path_provider/path_provider.dart";
import "package:screen_retriever/screen_retriever.dart";
import "package:window_manager/window_manager.dart";

/// 主窗口的矩形（逻辑像素）+ 最大化状态。
class WindowBounds {
  const WindowBounds({
    required this.x,
    required this.y,
    required this.width,
    required this.height,
    this.maximized = false,
  });

  final double x;
  final double y;
  final double width;
  final double height;

  /// 落盘时窗口是否处于最大化（x/y/w/h 保存的是最大化之前的还原态矩形）。
  final bool maximized;

  Rect get rect => Rect.fromLTWH(x, y, width, height);

  Map<String, dynamic> toJson() => <String, dynamic>{
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "maximized": maximized,
        "updatedAt": DateTime.now().toIso8601String(),
      };

  /// 文件损坏 / 字段非法时返回 null（视为没有历史，走默认尺寸）。
  static WindowBounds? fromJson(Map<String, dynamic> json) {
    final double? x = _asDouble(json["x"]);
    final double? y = _asDouble(json["y"]);
    final double? width = _asDouble(json["width"]);
    final double? height = _asDouble(json["height"]);
    if (x == null || y == null || width == null || height == null) return null;
    // 非法/异常值兜底：尺寸过小无法使用，过大视为脏数据。
    if (width < 160 || height < 160 || width > 10000 || height > 10000) {
      return null;
    }
    return WindowBounds(
      x: x,
      y: y,
      width: width,
      height: height,
      maximized: json["maximized"] == true,
    );
  }

  static double? _asDouble(Object? value) {
    if (value is num) return value.toDouble();
    if (value is String) return double.tryParse(value);
    return null;
  }
}

/// 主窗口大小/位置持久化：applicationSupport 目录下的 JSON 文件
/// （与 [RightPanelToolPreference] 同目录、同读写模式，进程内带缓存）。
///
/// 首次启动（无文件）返回 null，主入口走默认 1280x800 居中；之后每次
/// 调整窗口都会落盘，下次启动按上次的大小/位置还原，实现「固定打开时
/// 的大小」。
class WindowBoundsPreference {
  WindowBoundsPreference._();

  static const String _fileName = "window_bounds.json";
  static WindowBounds? _cached;

  static Future<WindowBounds?> load() async {
    if (_cached != null) return _cached;
    try {
      final File prefFile = await _getPrefFile();
      if (!await prefFile.exists()) return null;
      final String raw = await prefFile.readAsString();
      final Object? decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) return null;
      return _cached = WindowBounds.fromJson(decoded);
    } catch (e) {
      debugPrint("[WindowBounds] read failed: $e");
      return null;
    }
  }

  static Future<void> save(WindowBounds bounds) async {
    _cached = bounds;
    try {
      final File prefFile = await _getPrefFile();
      await prefFile.parent.create(recursive: true);
      await prefFile.writeAsString(
        const JsonEncoder.withIndent("  ").convert(bounds.toJson()),
        flush: true,
      );
    } catch (e) {
      debugPrint("[WindowBounds] save failed: $e");
    }
  }

  static Future<File> _getPrefFile() async {
    final Directory appDir = await getApplicationSupportDirectory();
    return File("${appDir.path}${Platform.pathSeparator}$_fileName");
  }
}

/// 首次启动（无任何历史）的默认窗口大小：在默认 1280x800 基础上向外
/// 扩展 0.1 倍（×1.1 → 1408x880），并钳制到主显示器工作区内——
/// 屏幕放不下时自动收缩，保证窗口完整可见。
Future<Size> firstLaunchWindowSize() async {
  const double baseWidth = 1280;
  const double baseHeight = 800;
  double width = baseWidth * 1.1;
  double height = baseHeight * 1.1;
  try {
    final Display primary = await screenRetriever.getPrimaryDisplay();
    final Offset? visiblePos = primary.visiblePosition;
    final Size? visibleSize = primary.visibleSize;
    if (visiblePos != null && visibleSize != null) {
      width = math.min(width, math.max(480, visibleSize.width - 16));
      height = math.min(height, math.max(360, visibleSize.height - 16));
    }
  } catch (e) {
    debugPrint("[WindowBounds] primary display query failed: $e");
  }
  return Size(width, height);
}

/// 读取「可用于还原」的窗口矩形：加载落盘值后，按当前显示器布局做
/// 可见性校验与钳制。显示器拔掉/分辨率变小后，保证窗口不会整个跑到
/// 屏幕外，也不会比当前屏幕大得离谱。
///
/// 无历史、数据损坏或完全落在所有屏幕之外时返回 null（走默认居中）。
Future<WindowBounds?> loadRestorableWindowBounds() async {
  final WindowBounds? saved = await WindowBoundsPreference.load();
  if (saved == null) return null;
  try {
    final List<Display> displays = await screenRetriever.getAllDisplays();
    for (final Display display in displays) {
      final Offset? visiblePos = display.visiblePosition;
      final Size? visibleSize = display.visibleSize;
      if (visiblePos == null || visibleSize == null) continue;
      final Rect area = Rect.fromLTWH(
        visiblePos.dx,
        visiblePos.dy,
        visibleSize.width,
        visibleSize.height,
      );
      if (!area.overlaps(saved.rect)) continue;
      return _clampInto(area, saved);
    }
  } catch (e) {
    debugPrint("[WindowBounds] display query failed: $e");
    return saved;
  }
  return null;
}

/// 把矩形钳进单个显示器工作区：左右各保留 120px、顶部保留标题栏可点、
/// 底部留 80px；尺寸不大于该工作区（保留最小可用尺寸下限）。
WindowBounds _clampInto(Rect area, WindowBounds bounds) {
  const double minW = 480;
  const double minH = 360;
  final double width =
      bounds.width.clamp(minW, math.max(minW, area.width - 16));
  final double height =
      bounds.height.clamp(minH, math.max(minH, area.height - 16));

  final double xMin = area.left - width + 120;
  final double xMax = area.right - 120;
  final double yMin = area.top - 8;
  final double yMax = area.bottom - 80;
  final double x = xMax >= xMin ? bounds.x.clamp(xMin, xMax) : area.left;
  final double y = yMax >= yMin ? bounds.y.clamp(yMin, yMax) : area.top;

  return WindowBounds(
    x: x,
    y: y,
    width: width,
    height: height,
    maximized: bounds.maximized,
  );
}

/// 监听主窗口的移动/缩放/最大化事件，防抖落盘（拖拽过程事件高频触发，
/// 停止操作 800ms 后才写文件）。最大化时 GetWindowRect 拿到的是最大化
/// 矩形，因此只更新 maximized 标记，保留上次的还原态矩形。
class WindowBoundsSaver with WindowListener {
  WindowBoundsSaver._();

  static final WindowBoundsSaver instance = WindowBoundsSaver._();

  Timer? _debounce;

  @override
  void onWindowMove() => _scheduleSave();

  @override
  void onWindowMoved() => _scheduleSave();

  @override
  void onWindowResize() => _scheduleSave();

  @override
  void onWindowResized() => _scheduleSave();

  @override
  void onWindowMaximize() => _saveNow(keepRect: true);

  @override
  void onWindowUnmaximize() => _saveNow();

  void _scheduleSave() {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 800), _saveNow);
  }

  Future<void> _saveNow({bool keepRect = false}) async {
    _debounce?.cancel();
    _debounce = null;
    try {
      final bool maximized = await windowManager.isMaximized();
      final WindowBounds? previous = await WindowBoundsPreference.load();
      if (keepRect || maximized) {
        if (previous == null) return; // 没有还原态矩形可保留，跳过本次
        await WindowBoundsPreference.save(WindowBounds(
          x: previous.x,
          y: previous.y,
          width: previous.width,
          height: previous.height,
          maximized: maximized,
        ));
        return;
      }
      final Rect bounds = await windowManager.getBounds();
      await WindowBoundsPreference.save(WindowBounds(
        x: bounds.left,
        y: bounds.top,
        width: bounds.width,
        height: bounds.height,
      ));
    } catch (e) {
      debugPrint("[WindowBounds] save failed: $e");
    }
  }
}
