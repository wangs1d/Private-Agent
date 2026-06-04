import "dart:async";

import "package:flutter/foundation.dart"
    show defaultTargetPlatform, kIsWeb, TargetPlatform;
import "package:flutter/material.dart";
import "package:flutter/scheduler.dart";

import "../../core/services/agent_sphere_mood_bridge.dart";
import "../../core/services/desk_pet_session.dart";
import "../../core/services/sphere_entity_controller.dart";
import "../../core/services/sphere_overlay_launcher.dart";
import "agent_sphere_webview.dart";
import "sphere_float_motion.dart";
import "web_sphere_drag_chrome.dart";

/// 球形 Agent 悬浮层。
///
/// - **Web**：iframe 嵌入
/// - **Windows 桌面**：Win32 原生透明桌宠窗 + Flutter 透明槽位锚点（无内嵌 WebView）
class FloatingAgentSphere extends StatefulWidget {
  const FloatingAgentSphere({super.key});

  static const Size panelSize = SphereEntityController.entitySize;

  static const double webDragChromeHeight = WebSphereDragChrome.height;

  static bool get useWindowsDesktop =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.windows;

  @override
  State<FloatingAgentSphere> createState() => _FloatingAgentSphereState();
}

class _FloatingAgentSphereState extends State<FloatingAgentSphere>
    with WidgetsBindingObserver, TickerProviderStateMixin {
  final SphereEntityController _entity = SphereEntityController.instance;
  final GlobalKey _slotKey = GlobalKey();

  Offset? _position;
  bool _bootstrapping = false;
  String? _bootError;
  late final SphereFloatMotion _floatMotion = SphereFloatMotion(vsync: this);

  bool get _electronActive =>
      FloatingAgentSphere.useWindowsDesktop &&
      SphereOverlayLauncher.electronActive.value;

  bool get _embeddedFallback =>
      FloatingAgentSphere.useWindowsDesktop &&
      SphereOverlayLauncher.useEmbeddedFallback.value;

  bool get _nativeReady =>
      _entity.overlayReady && !_embeddedFallback;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    AgentSphereMoodBridge.instance.addMessageListener(_onEmbodimentCommand);
    DeskPetSession.instance.addListener(_onDeskPetSessionChanged);

    if (FloatingAgentSphere.useWindowsDesktop) {
      _entity.onRequestSnapToDock = _snapBackToDock;
      _entity.addListener(_onEntityChanged);
      SphereOverlayLauncher.electronActive.addListener(_onOverlayState);
      SphereOverlayLauncher.useEmbeddedFallback.addListener(_onOverlayState);
    }
  }

  @override
  void dispose() {
    AgentSphereMoodBridge.instance.removeMessageListener(_onEmbodimentCommand);
    DeskPetSession.instance.removeListener(_onDeskPetSessionChanged);
    _entity.removeListener(_onEntityChanged);
    SphereOverlayLauncher.electronActive.removeListener(_onOverlayState);
    SphereOverlayLauncher.useEmbeddedFallback.removeListener(_onOverlayState);
    if (identical(_entity.onRequestSnapToDock, _snapBackToDock)) {
      _entity.onRequestSnapToDock = null;
    }
    _floatMotion.dispose();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  void _onDeskPetSessionChanged() {
    if (mounted) setState(() {});
  }

  void _onEntityChanged() {
    if (mounted) setState(() {});
  }

  void _onOverlayState() {
    if (mounted) setState(() {});
  }

  Future<void> _bootstrapNativeDeskPet() async {
    if (!DeskPetSession.instance.isSummoned) return;
    if (_bootstrapping ||
        _nativeReady ||
        _electronActive ||
        _embeddedFallback) {
      return;
    }
    _bootstrapping = true;
    _bootError = DeskPetSession.instance.error;
    if (mounted) setState(() {});

    if (_bootError == null) {
      final bool ok = await _entity.ensureOverlay();
      if (!ok && mounted) {
        _bootError = DeskPetSession.instance.error ??
            "桌宠窗口启动失败\n请确认后端已运行且 avatar 已构建";
      }
    }

    _bootstrapping = false;
    if (mounted) {
      SchedulerBinding.instance.addPostFrameCallback((_) => _syncDockIfNeeded());
      setState(() {});
    }
  }

  void _onEmbodimentCommand(Map<String, dynamic> message) {
    final String? type = message["type"]?.toString();
    if (type != "agent-sphere:command") return;
    if (!mounted || _electronActive) return;

    final Size screen = MediaQuery.sizeOf(context);
    _ensureInitialPosition(screen);
    final double dpr = MediaQuery.devicePixelRatioOf(context);

    if (_embeddedFallback) {
      _entity.beginAgentPositionHold();
      unawaited(_floatMotion.handleCommand(
        payload: message,
        viewport: screen,
        panelSize: FloatingAgentSphere.panelSize,
        current: _position!,
        clampPosition: (Offset p) => _clampToViewport(p, screen),
        applyPosition: (Offset p) {
          if (!mounted) return;
          setState(() => _position = p);
        },
        useNativeOverlay: false,
        devicePixelRatio: dpr,
      ));
      return;
    }

    if (!_nativeReady) return;

    _entity.beginAgentPositionHold();

    unawaited(_floatMotion.handleCommand(
      payload: message,
      viewport: screen,
      panelSize: FloatingAgentSphere.panelSize,
      current: _position!,
      clampPosition: (Offset p) => _clampToViewport(p, screen),
      applyPosition: (Offset p) {
        if (!mounted) return;
        setState(() => _position = p);
      },
      useNativeOverlay: true,
      devicePixelRatio: dpr,
    ));
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
    if (_nativeReady) {
      SchedulerBinding.instance.addPostFrameCallback((_) => _syncDockIfNeeded());
    }
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
    if (!mounted || !_nativeReady) return;
    if (_entity.mode != SphereEntityMode.docked || _entity.shouldSuppressDockSync) {
      return;
    }

    final Rect? slot = _slotGlobalRect();
    if (slot == null) return;

    final double dpr = MediaQuery.devicePixelRatioOf(context);
    await _entity.syncDockSlot(slot, dpr);
  }

  void _applyDragDelta(Offset delta, Size screen, BuildContext context) {
    if (!_nativeReady) return;
    final double dpr = MediaQuery.devicePixelRatioOf(context);
    unawaited(_entity.moveOverlayByPhysical(Offset(
      delta.dx * dpr,
      delta.dy * dpr,
    )));
  }

  Offset _clampToViewport(Offset pos, Size screen) {
    final Size size = FloatingAgentSphere.panelSize;
    final double maxX = (screen.width - size.width).clamp(0, double.infinity);
    final double maxY = (screen.height - size.height).clamp(0, double.infinity);
    return Offset(
      pos.dx.clamp(0, maxX),
      pos.dy.clamp(0, maxY),
    );
  }

  Future<void> _onDragEnd(BuildContext context) async {
    if (!_nativeReady) return;

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
            : _bootstrapping
                ? Center(
                    child: SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Colors.white.withValues(alpha: 0.25),
                      ),
                    ),
                  )
                : _bootError != null
                    ? Center(
                        child: Padding(
                          padding: const EdgeInsets.all(8),
                          child: Text(
                            _bootError!,
                            style: TextStyle(
                              color: Colors.white.withValues(alpha: 0.45),
                              fontSize: 10,
                            ),
                            textAlign: TextAlign.center,
                          ),
                        ),
                      )
                    : null,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (!DeskPetSession.instance.isSummoned) {
      return const SizedBox.shrink();
    }

    final Size screen = MediaQuery.sizeOf(context);

    if (FloatingAgentSphere.useWindowsDesktop) {
      // Windows 桌宠仅由 Electron 独立窗呈现，主应用内不保留占位框。
      return const SizedBox.shrink();
    }

    if (kIsWeb) {
      return AgentSphereWebView(
        showOverlayButton: false,
        visible: true,
      );
    }

    if (_electronActive) {
      return const SizedBox.shrink();
    }

    if (_embeddedFallback) {
      _ensureInitialPosition(screen);
      return Positioned(
        left: _position!.dx,
        top: _position!.dy,
        width: FloatingAgentSphere.panelSize.width,
        height: FloatingAgentSphere.panelSize.height,
        child: AgentSphereWebView(showOverlayButton: false),
      );
    }

    SchedulerBinding.instance.addPostFrameCallback((_) {
      if (_nativeReady) {
        _syncDockIfNeeded();
      } else if (!_bootstrapping && !_electronActive && !_embeddedFallback) {
        unawaited(_bootstrapNativeDeskPet());
      }
    });

    _ensureInitialPosition(screen);
    return Positioned(
      left: _position!.dx,
      top: _position!.dy,
      width: FloatingAgentSphere.panelSize.width,
      height: FloatingAgentSphere.panelSize.height,
      child: _nativeDockSlot(context, screen),
    );
  }
}
