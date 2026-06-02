import "dart:async";
import "dart:io";
import "dart:ui";

import "package:flutter/foundation.dart";

import "sphere_overlay_launcher.dart";

/// 球形 Agent 呈现模式：停靠在应用槽位 / 溢出桌面漫游。
enum SphereEntityMode {
  docked,
  overflow,
}

/// Windows 桌面统一实体控制器 — 单一原生 overlay 窗口，Flutter 槽位仅作坐标锚点。
class SphereEntityController extends ChangeNotifier {
  SphereEntityController._();

  static final SphereEntityController instance = SphereEntityController._();

  SphereEntityMode mode = SphereEntityMode.docked;
  bool overlayReady = false;
  DateTime? _dockSyncHoldUntil;

  /// Agent 通过具身工具移动后，短暂禁止自动对齐侧栏槽位（避免「说动了但仍停在左边」）。
  bool get shouldSuppressDockSync =>
      _dockSyncHoldUntil != null && DateTime.now().isBefore(_dockSyncHoldUntil!);

  void beginAgentPositionHold({Duration duration = const Duration(seconds: 45)}) {
    _dockSyncHoldUntil = DateTime.now().add(duration);
    if (mode == SphereEntityMode.docked) {
      mode = SphereEntityMode.overflow;
      notifyListeners();
    }
  }

  /// 由 [FloatingAgentSphere] 注册：AppBar「召回」时对齐槽位。
  VoidCallback? onRequestSnapToDock;

  /// 与原生 overlay 对齐的尺寸（逻辑像素，调用方乘 DPR 后下发）。
  static const Size entitySize = Size(300, 380);

  void reset() {
    overlayReady = false;
    mode = SphereEntityMode.docked;
    _dockSyncHoldUntil = null;
    notifyListeners();
  }

  void markElectronReady() {
    overlayReady = true;
    notifyListeners();
  }

  Future<bool> ensureOverlay() async {
    if (kIsWeb || !Platform.isWindows) return false;
    if (overlayReady && SphereOverlayLauncher.isCreated) {
      return true;
    }
    final bool ok = await SphereOverlayLauncher.launch();
    if (!ok) return false;
    if (SphereOverlayLauncher.electronActive.value ||
        SphereOverlayLauncher.useEmbeddedFallback.value) {
      overlayReady = true;
      notifyListeners();
      return true;
    }
    overlayReady = await SphereOverlayLauncher.isWebViewReady();
    if (overlayReady) notifyListeners();
    return overlayReady;
  }

  /// 将原生悬浮窗对齐到 Flutter 槽位的屏幕物理坐标。
  Future<void> syncDockSlot(Rect globalLogicalRect, double devicePixelRatio) async {
    if (!overlayReady || mode != SphereEntityMode.docked || shouldSuppressDockSync) {
      return;
    }
    if (!await SphereOverlayLauncher.isWebViewReady()) return;

    final int x = (globalLogicalRect.left * devicePixelRatio).round();
    final int y = (globalLogicalRect.top * devicePixelRatio).round();
    final int w = (globalLogicalRect.width * devicePixelRatio).round();
    final int h = (globalLogicalRect.height * devicePixelRatio).round();

    await SphereOverlayLauncher.setBounds(
      x,
      y,
      w,
      h,
      durationMs: 0,
    );
  }

  /// 拖动溢出：按屏幕物理像素移动原生窗。
  Future<void> moveOverlayByPhysical(Offset deltaPhysical) async {
    if (!overlayReady) return;

    if (mode == SphereEntityMode.docked) {
      mode = SphereEntityMode.overflow;
      notifyListeners();
    }

    await SphereOverlayLauncher.moveBy(
      deltaPhysical.dx.round(),
      deltaPhysical.dy.round(),
    );
  }

  /// 检测原生窗中心是否仍在应用窗口内。
  Future<void> refreshOverflowState(double devicePixelRatio) async {
    if (!overlayReady) return;

    final Map<String, int>? app = await SphereOverlayLauncher.getAppBounds();
    final Map<String, int>? bounds = await SphereOverlayLauncher.getBounds();
    if (app == null || bounds == null) return;

    final double dpr = devicePixelRatio;
    final Rect appLogical = Rect.fromLTWH(
      app["x"]! / dpr,
      app["y"]! / dpr,
      app["width"]! / dpr,
      app["height"]! / dpr,
    );
    final Rect overlayLogical = Rect.fromLTWH(
      bounds["x"]! / dpr,
      bounds["y"]! / dpr,
      bounds["width"]! / dpr,
      bounds["height"]! / dpr,
    );

    final bool inside = appLogical.contains(overlayLogical.center);
    final SphereEntityMode next =
        inside ? SphereEntityMode.docked : SphereEntityMode.overflow;
    if (next != mode) {
      mode = next;
      notifyListeners();
    }
  }

  Future<void> snapToDock(Rect globalLogicalRect, double devicePixelRatio) async {
    mode = SphereEntityMode.docked;
    notifyListeners();
    await syncDockSlot(globalLogicalRect, devicePixelRatio);
  }

  Future<void> roam() => SphereOverlayLauncher.roam();

  /// 回报球形窗口位置，供服务端 `embodiment.observe` 闭环。
  Future<Map<String, dynamic>?> collectStateReport(double devicePixelRatio) async {
    final Map<String, int>? work = await SphereOverlayLauncher.getWorkArea();
    final Map<String, int>? bounds = await SphereOverlayLauncher.getBounds();
    if (work == null || bounds == null) return null;

    final double dpr = devicePixelRatio;
    final int aw = work["width"] ?? 1;
    final int ah = work["height"] ?? 1;
    final int ax = work["x"] ?? 0;
    final int ay = work["y"] ?? 0;

    final double cx = bounds["x"]! + bounds["width"]! / 2;
    final double cy = bounds["y"]! + bounds["height"]! / 2;
    final double centerScreenX = aw > 0 ? ((cx - ax) / aw).clamp(0.0, 1.0) : 0.5;
    final double centerScreenY = ah > 0 ? ((cy - ay) / ah).clamp(0.0, 1.0) : 0.5;

    return <String, dynamic>{
      "x": bounds["x"],
      "y": bounds["y"],
      "width": bounds["width"],
      "height": bounds["height"],
      "centerScreenX": centerScreenX,
      "centerScreenY": centerScreenY,
      "workAreaWidth": aw,
      "workAreaHeight": ah,
      "mode": mode.name,
      "overlayReady": overlayReady,
    };
  }
}
