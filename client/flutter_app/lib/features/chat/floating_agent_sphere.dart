import "dart:async";

import "package:flutter/foundation.dart"
    show defaultTargetPlatform, kIsWeb, TargetPlatform;
import "package:flutter/material.dart";

import "../../core/services/agent_sphere_mood_bridge.dart";
import "../../core/services/desk_pet_session.dart";
import "../../core/services/sphere_entity_controller.dart";
import "../../core/services/sphere_overlay_launcher.dart";
import "agent_sphere_webview.dart";
import "sphere_float_motion.dart";
import "web_sphere_drag_chrome.dart";

/// 球形 Agent 悬浮层。
///
/// - Web：iframe 内嵌
/// - Windows：默认独立桌宠窗口，主应用内不渲染
/// - 降级：Tauri 不可用时，才使用应用内 WebView
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
    with TickerProviderStateMixin {
  Offset? _position;
  late final SphereFloatMotion _floatMotion = SphereFloatMotion(vsync: this);

  bool get _overlayActive =>
      FloatingAgentSphere.useWindowsDesktop &&
      SphereOverlayLauncher.overlayActive.value;

  bool get _embeddedFallback =>
      FloatingAgentSphere.useWindowsDesktop &&
      SphereOverlayLauncher.useEmbeddedFallback.value;

  @override
  void initState() {
    super.initState();
    AgentSphereMoodBridge.instance.addMessageListener(_onEmbodimentCommand);
    DeskPetSession.instance.addListener(_onDeskPetSessionChanged);
    SphereOverlayLauncher.overlayActive.addListener(_onOverlayState);
    SphereOverlayLauncher.useEmbeddedFallback.addListener(_onOverlayState);
  }

  @override
  void dispose() {
    AgentSphereMoodBridge.instance.removeMessageListener(_onEmbodimentCommand);
    DeskPetSession.instance.removeListener(_onDeskPetSessionChanged);
    SphereOverlayLauncher.overlayActive.removeListener(_onOverlayState);
    SphereOverlayLauncher.useEmbeddedFallback.removeListener(_onOverlayState);
    _floatMotion.dispose();
    super.dispose();
  }

  void _onDeskPetSessionChanged() {
    if (mounted) setState(() {});
  }

  void _onOverlayState() {
    if (mounted) setState(() {});
  }

  void _onEmbodimentCommand(Map<String, dynamic> message) {
    final String? type = message["type"]?.toString();
    if (type != "agent-sphere:command") return;
    if (!mounted || _overlayActive) return;

    final Size screen = MediaQuery.sizeOf(context);
    _ensureInitialPosition(screen);

    if (_embeddedFallback) {
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
      ));
    }
  }

  void _ensureInitialPosition(Size screen) {
    _position ??= Offset(
      screen.width - FloatingAgentSphere.panelSize.width - 20,
      screen.height - FloatingAgentSphere.panelSize.height - 88,
    );
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

  @override
  Widget build(BuildContext context) {
    if (!DeskPetSession.instance.isSummoned) {
      return const SizedBox.shrink();
    }

    final Size screen = MediaQuery.sizeOf(context);

    if (FloatingAgentSphere.useWindowsDesktop) {
      if (_overlayActive || !_embeddedFallback) {
        return const SizedBox.shrink();
      }

      _ensureInitialPosition(screen);
      return Positioned(
        left: _position!.dx,
        top: _position!.dy,
        width: FloatingAgentSphere.panelSize.width,
        height: FloatingAgentSphere.panelSize.height,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(24),
          child: const ColoredBox(
            color: Colors.transparent,
            child: AgentSphereWebView(showOverlayButton: false),
          ),
        ),
      );
    }

    if (kIsWeb) {
      return const AgentSphereWebView(
        showOverlayButton: false,
        visible: true,
      );
    }

    return const SizedBox.shrink();
  }
}
