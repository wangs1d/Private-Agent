import "dart:async";
import "dart:io";

import "package:flutter/foundation.dart" show kIsWeb;
import "package:flutter/material.dart";
import "package:flutter/scheduler.dart";

import "../../core/services/sphere_entity_controller.dart";
import "agent_sphere_webview.dart";
import "shift_drag_overlay.dart";

/// 球形 Agent 悬浮层。
///
/// Windows 桌面：单一原生 overlay 实体，Flutter 槽位为透明锚点（可溢出到桌面漫游）。
/// Web / 其它平台：iframe / WebView 内嵌 embed。
class FloatingAgentSphere extends StatefulWidget {
  const FloatingAgentSphere({super.key});

  static const Size panelSize = SphereEntityController.entitySize;

  /// Win32 独立透明悬浮窗（桌面漫游）。默认关闭：启动时会触发 WebView2 原生崩溃。
  /// 启用：`flutter run -d windows --dart-define=NATIVE_SPHERE_OVERLAY=true`
  static const bool _enableNativeOverlay = bool.fromEnvironment(
    "NATIVE_SPHERE_OVERLAY",
    defaultValue: false,
  );

  /// Windows 桌面使用 Flutter 侧透明槽位（可拖动）；与 [_enableNativeOverlay] 独立。
  static bool get useWindowsDockSlot => !kIsWeb && Platform.isWindows;

  /// 是否挂载 Win32 原生 WebView2 悬浮实体。
  static bool get useNativeEntity =>
      useWindowsDockSlot && _enableNativeOverlay;

  @override
  State<FloatingAgentSphere> createState() => _FloatingAgentSphereState();
}

class _FloatingAgentSphereState extends State<FloatingAgentSphere>
    with WidgetsBindingObserver {
  final SphereEntityController _entity = SphereEntityController.instance;
  final GlobalKey _slotKey = GlobalKey();

  Offset? _position;
  bool _bootstrapping = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    if (FloatingAgentSphere.useNativeEntity) {
      _entity.onRequestSnapToDock = _snapBackToDock;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        Future<void>.delayed(const Duration(seconds: 2), () {
          if (mounted) unawaited(_bootstrapNativeEntity());
        });
      });
    }
  }

  @override
  void dispose() {
    if (FloatingAgentSphere.useNativeEntity &&
        identical(_entity.onRequestSnapToDock, _snapBackToDock)) {
      _entity.onRequestSnapToDock = null;
    }
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  void _snapBackToDock() {
    if (!mounted) return;
    final Rect? slot = _slotGlobalRect();
    if (slot == null) return;
    final double dpr = MediaQuery.devicePixelRatioOf(context);
    unawaited(_entity.snapToDock(slot, dpr));
  }

  @override
  void didChangeMetrics() {
    if (FloatingAgentSphere.useNativeEntity) {
      SchedulerBinding.instance.addPostFrameCallback((_) => _syncDockIfNeeded());
    }
  }

  Future<void> _bootstrapNativeEntity() async {
    if (_bootstrapping) return;
    _bootstrapping = true;
    await _entity.ensureOverlay();
    if (mounted) {
      SchedulerBinding.instance.addPostFrameCallback((_) => _syncDockIfNeeded());
    }
    _bootstrapping = false;
  }

  void _ensureInitialPosition(Size screen) {
    _position ??= Offset(
      screen.width - FloatingAgentSphere.panelSize.width - 20,
      screen.height - FloatingAgentSphere.panelSize.height - 88,
    );
  }

  Rect? _slotGlobalRect() {
    final RenderObject? ro = _slotKey.currentContext?.findRenderObject();
    if (ro is! RenderBox || !ro.hasSize) return null;
    final Offset topLeft = ro.localToGlobal(Offset.zero);
    return topLeft & ro.size;
  }

  Future<void> _syncDockIfNeeded() async {
    if (!mounted || !_entity.overlayReady) return;
    if (_entity.mode != SphereEntityMode.docked) return;

    final Rect? slot = _slotGlobalRect();
    if (slot == null) return;

    final double dpr = MediaQuery.devicePixelRatioOf(context);
    await _entity.syncDockSlot(slot, dpr);
  }

  void _applyDragDelta(Offset delta, Size screen, BuildContext context) {
    final double dpr = MediaQuery.devicePixelRatioOf(context);

    if (FloatingAgentSphere.useNativeEntity && _entity.overlayReady) {
      unawaited(_entity.moveOverlayByPhysical(Offset(
        delta.dx * dpr,
        delta.dy * dpr,
      )));
      return;
    }

    final Offset base = _position ?? Offset.zero;
    final double maxX =
        (screen.width - FloatingAgentSphere.panelSize.width).clamp(0, double.infinity);
    final double maxY =
        (screen.height - FloatingAgentSphere.panelSize.height).clamp(0, double.infinity);
    setState(() {
      _position = Offset(
        (base.dx + delta.dx).clamp(0, maxX),
        (base.dy + delta.dy).clamp(0, maxY),
      );
    });
  }

  Future<void> _onDragEnd(BuildContext context) async {
    if (!FloatingAgentSphere.useNativeEntity || !_entity.overlayReady) return;

    final double dpr = MediaQuery.devicePixelRatioOf(context);
    await _entity.refreshOverflowState(dpr);

    if (_entity.mode == SphereEntityMode.docked) {
      final Rect? slot = _slotGlobalRect();
      if (slot != null) {
        await _entity.syncDockSlot(slot, dpr);
      }
    }
  }

  Widget _nativeDockSlot(BuildContext context, Size screen) {
    return GestureDetector(
      behavior: HitTestBehavior.translucent,
      onPanUpdate: (DragUpdateDetails details) =>
          _applyDragDelta(details.delta, screen, context),
      onPanEnd: (_) => unawaited(_onDragEnd(context)),
      child: Container(
        key: _slotKey,
        color: Colors.transparent,
        child: _entity.mode == SphereEntityMode.overflow
            ? Align(
                alignment: Alignment.bottomCenter,
                child: Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: Colors.black.withValues(alpha: 0.35),
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: const Padding(
                      padding: EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      child: Text(
                        "桌面漫游中",
                        style: TextStyle(color: Colors.white70, fontSize: 10),
                      ),
                    ),
                  ),
                ),
              )
            : (!FloatingAgentSphere.useNativeEntity
                ? Center(
                    child: Icon(
                      Icons.smart_toy_outlined,
                      size: 56,
                      color: Colors.white.withValues(alpha: 0.18),
                    ),
                  )
                : null),
      ),
    );
  }

  Widget? _desktopDragLayer(Size screen, BuildContext context) {
    if (kIsWeb || FloatingAgentSphere.useNativeEntity) return null;
    return Positioned.fill(
      child: ShiftDragOverlay(
        onDragDelta: (Offset d) => _applyDragDelta(d, screen, context),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final Size screen = MediaQuery.sizeOf(context);
    _ensureInitialPosition(screen);
    final Offset pos = _position!;

    SchedulerBinding.instance.addPostFrameCallback((_) {
      if (FloatingAgentSphere.useNativeEntity) {
        _syncDockIfNeeded();
      }
    });

    return Positioned(
      left: pos.dx,
      top: pos.dy,
      width: FloatingAgentSphere.panelSize.width,
      height: FloatingAgentSphere.panelSize.height,
      child: Stack(
        clipBehavior: Clip.none,
        children: <Widget>[
          Positioned.fill(
            child: FloatingAgentSphere.useWindowsDockSlot
                ? _nativeDockSlot(context, screen)
                : AgentSphereWebView(
                    showOverlayButton: false,
                    onDragDelta:
                        kIsWeb ? (Offset d) => _applyDragDelta(d, screen, context) : null,
                  ),
          ),
          if (_desktopDragLayer(screen, context) != null)
            _desktopDragLayer(screen, context)!,
        ],
      ),
    );
  }
}
