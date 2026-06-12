import "dart:async";
import "dart:io";

import "package:flutter/foundation.dart";

import "sphere_overlay_launcher.dart";

/// Windows 桌面统一实体控制器 — 管理原生 overlay 窗口生命周期与位置。
class SphereEntityController extends ChangeNotifier {
  SphereEntityController._();

  static final SphereEntityController instance = SphereEntityController._();

  bool overlayReady = false;

  /// 与原生 overlay 对齐的尺寸（逻辑像素，调用方乘 DPR 后下发）。
  static const Size entitySize = Size(450, 570);

  void reset() {
    overlayReady = false;
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

  /// 拖动：按屏幕物理像素移动原生窗。
  Future<void> moveOverlayByPhysical(Offset deltaPhysical) async {
    if (!overlayReady) return;

    await SphereOverlayLauncher.moveBy(
      deltaPhysical.dx.round(),
      deltaPhysical.dy.round(),
    );
  }

  Future<void> roam() => SphereOverlayLauncher.roam();

  /// 回报球形窗口位置，供服务端 `embodiment.observe` 闭环。
  Future<Map<String, dynamic>?> collectStateReport(double devicePixelRatio) async {
    final Map<String, int>? work = await SphereOverlayLauncher.getWorkArea();
    final Map<String, int>? bounds = await SphereOverlayLauncher.getBounds();
    if (work == null || bounds == null) return null;

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
      "overlayReady": overlayReady,
    };
  }
}
