import "dart:async";
import "dart:math" as math;

import "package:flutter/material.dart";

import "../../core/services/sphere_embodiment_motion_bridge.dart";
import "../../core/services/sphere_overlay_launcher.dart";

/// 将主 Agent 具身指令映射为悬浮层屏幕坐标移动（Web / Flutter 槽位 / Win32 overlay）。
class SphereFloatMotion {
  SphereFloatMotion({required TickerProvider vsync}) : _vsync = vsync;

  final TickerProvider _vsync;
  final math.Random _rng = math.Random();

  AnimationController? _anim;

  static const double _sceneBound = 2.4;

  void dispose() {
    _anim?.dispose();
    _anim = null;
  }

  bool get acceptsAgentMotion =>
      SphereEmbodimentMotionBridge.instance.mainAgentLinked;

  /// 处理 `agent-sphere:command` / `agent.embodiment.command` 载荷。
  Future<void> handleCommand({
    required Map<String, dynamic> payload,
    required Size viewport,
    required Size panelSize,
    required Offset current,
    required Offset Function(Offset) clampPosition,
    required void Function(Offset position) applyPosition,
    required bool useNativeOverlay,
    double devicePixelRatio = 1,
  }) async {
    if (!acceptsAgentMotion) return;

    final String? action = payload["action"]?.toString();
    if (action == null || action.isEmpty) return;

    switch (action) {
      case "window_place":
      case "window_move":
        if (useNativeOverlay) {
          await _nativeWindowPlace(payload, devicePixelRatio);
          return;
        }
        final double? screenX = _readNum(payload["screenX"]);
        final double? screenY = _readNum(payload["screenY"]);
        if (screenX == null || screenY == null) return;
        final Offset target = _normalizedToScreen(
          nx: screenX.clamp(0.0, 1.0),
          nz: screenY.clamp(0.0, 1.0),
          viewport: viewport,
          panelSize: panelSize,
        );
        _animateTo(
          from: current,
          to: clampPosition(target),
          durationMs: 1000,
          applyPosition: applyPosition,
        );
        return;
      case "window_roam":
      case "roam":
        if (useNativeOverlay) {
          await SphereOverlayLauncher.roam();
          return;
        }
        final double strength = _readStrength(payload["strength"]);
        final Offset target = _randomTarget(
          viewport,
          panelSize,
        );
        _animateTo(
          from: current,
          to: clampPosition(target),
          durationMs: (900 + (1.2 - strength) * 400).round(),
          applyPosition: applyPosition,
        );
        return;
      case "move":
        if (useNativeOverlay) {
          await _nativeMoveTo(payload, devicePixelRatio);
          return;
        }
        final double? x = _readNum(payload["x"]);
        final double? z = _readNum(payload["z"]);
        if (x == null || z == null) return;
        final Offset target = _mapSceneToScreen(
          x: x,
          z: z,
          viewport: viewport,
          panelSize: panelSize,
        );
        _animateTo(
          from: current,
          to: clampPosition(target),
          durationMs: 1100,
          applyPosition: applyPosition,
        );
        return;
      case "stop":
        _anim?.stop();
        return;
      default:
        return;
    }
  }

  Future<void> _nativeWindowPlace(
    Map<String, dynamic> payload,
    double dpr,
  ) async {
    final Map<String, int>? area = await SphereOverlayLauncher.getWorkArea();
    if (area == null) {
      await SphereOverlayLauncher.roam();
      return;
    }

    final double? screenX = _readNum(payload["screenX"]);
    final double? screenY = _readNum(payload["screenY"]);
    if (screenX == null || screenY == null) {
      await SphereOverlayLauncher.roam();
      return;
    }

    const int panelW = 450;
    const int panelH = 570;
    final int margin = 12;
    final int aw = area["width"] ?? 1920;
    final int ah = area["height"] ?? 1080;
    final int ax = area["x"] ?? 0;
    final int ay = area["y"] ?? 0;

    final Offset logical = _normalizedToScreen(
      nx: screenX.clamp(0.0, 1.0),
      nz: screenY.clamp(0.0, 1.0),
      viewport: Size(aw / dpr, ah / dpr),
      panelSize: const Size(450, 570),
    );

    final int maxX = math.max(margin, aw - panelW - margin);
    final int maxY = math.max(margin, ah - panelH - margin);
    final int px = (ax + logical.dx * dpr).round().clamp(ax + margin, ax + maxX);
    final int py = (ay + logical.dy * dpr).round().clamp(ay + margin, ay + maxY);

    await SphereOverlayLauncher.moveTo(px, py, durationMs: 1100);
  }

  Offset _normalizedToScreen({
    required double nx,
    required double nz,
    required Size viewport,
    required Size panelSize,
  }) {
    const double margin = 20;
    final double maxX =
        (viewport.width - panelSize.width - margin).clamp(margin, double.infinity);
    final double maxY =
        (viewport.height - panelSize.height - margin).clamp(margin, double.infinity);
    return Offset(
      margin + nx * math.max(1, maxX - margin),
      margin + nz * math.max(1, maxY - margin),
    );
  }

  Future<void> _nativeMoveTo(Map<String, dynamic> payload, double dpr) async {
    final Map<String, int>? area = await SphereOverlayLauncher.getWorkArea();
    if (area == null) return;

    final double? x = _readNum(payload["x"]);
    final double? z = _readNum(payload["z"]);
    if (x == null || z == null) {
      await SphereOverlayLauncher.roam();
      return;
    }

    const int panelW = 450;
    const int panelH = 570;
    final int margin = 12;
    final int aw = area["width"] ?? 1920;
    final int ah = area["height"] ?? 1080;
    final int ax = area["x"] ?? 0;
    final int ay = area["y"] ?? 0;

    final double nx = ((x + _sceneBound) / (_sceneBound * 2)).clamp(0.0, 1.0);
    final double nz = ((z + _sceneBound) / (_sceneBound * 2)).clamp(0.0, 1.0);
    final int maxX = math.max(margin, aw - panelW - margin);
    final int maxY = math.max(margin, ah - panelH - margin);
    final int px = ax + margin + (nx * (maxX - margin)).round();
    final int py = ay + margin + (nz * (maxY - margin)).round();

    await SphereOverlayLauncher.moveTo(px, py, durationMs: 1200);
  }

  Offset _randomTarget(Size viewport, Size panel) {
    const double margin = 16;
    final double maxX =
        (viewport.width - panel.width - margin).clamp(margin, double.infinity);
    final double maxY =
        (viewport.height - panel.height - margin).clamp(margin, double.infinity);
    return Offset(
      margin + _rng.nextDouble() * math.max(1, maxX - margin),
      margin + _rng.nextDouble() * math.max(1, maxY - margin),
    );
  }

  Offset _mapSceneToScreen({
    required double x,
    required double z,
    required Size viewport,
    required Size panelSize,
  }) {
    final double nx = ((x + _sceneBound) / (_sceneBound * 2)).clamp(0.0, 1.0);
    final double nz = ((z + _sceneBound) / (_sceneBound * 2)).clamp(0.0, 1.0);
    const double margin = 20;

    final double maxX =
        (viewport.width - panelSize.width - margin).clamp(margin, double.infinity);
    final double maxY =
        (viewport.height - panelSize.height - margin).clamp(margin, double.infinity);
    return Offset(
      margin + nx * math.max(1, maxX - margin),
      margin + nz * math.max(1, maxY - margin),
    );
  }

  void _animateTo({
    required Offset from,
    required Offset to,
    required int durationMs,
    required void Function(Offset position) applyPosition,
  }) {
    final AnimationController? prev = _anim;
    if (prev != null) {
      prev.stop();
      _anim = null;
      prev.dispose();
    }
    if ((from - to).distance < 2) {
      applyPosition(to);
      return;
    }

    _anim = AnimationController(
      vsync: _vsync,
      duration: Duration(milliseconds: durationMs.clamp(200, 2400)),
    );
    final Animation<Offset> tween = Tween<Offset>(begin: from, end: to).animate(
      CurvedAnimation(parent: _anim!, curve: Curves.easeInOutCubic),
    );
    void tick() {
      if (_anim == null) return;
      applyPosition(tween.value);
    }

    _anim!.addListener(tick);
    _anim!.addStatusListener((AnimationStatus status) {
      if (status != AnimationStatus.completed &&
          status != AnimationStatus.dismissed) {
        return;
      }
      final AnimationController? current = _anim;
      if (current == null) return;
      current.removeListener(tick);
      applyPosition(to);
    });
    unawaited(_anim!.forward());
  }

  double _readStrength(dynamic raw) {
    if (raw is num && raw.isFinite) {
      return raw.toDouble().clamp(0.2, 2.0);
    }
    return 1.0;
  }

  double? _readNum(dynamic raw) {
    if (raw is num && raw.isFinite) return raw.toDouble();
    return null;
  }
}
