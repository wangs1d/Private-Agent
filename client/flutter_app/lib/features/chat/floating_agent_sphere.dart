import "package:flutter/foundation.dart" show kIsWeb;
import "package:flutter/material.dart";

import "agent_sphere_webview.dart";
import "shift_drag_overlay.dart";

/// 页面内自由拖动的 3D 球形 Agent（无侧栏、无边框，仅展示模型）。
class FloatingAgentSphere extends StatefulWidget {
  const FloatingAgentSphere({super.key});

  static const Size panelSize = Size(300, 340);

  @override
  State<FloatingAgentSphere> createState() => _FloatingAgentSphereState();
}

class _FloatingAgentSphereState extends State<FloatingAgentSphere> {
  Offset? _position;

  void _ensureInitialPosition(Size screen) {
    _position ??= Offset(
      screen.width - FloatingAgentSphere.panelSize.width - 20,
      screen.height - FloatingAgentSphere.panelSize.height - 88,
    );
  }

  void _applyDragDelta(Offset delta, Size screen) {
    final Offset base = _position ?? Offset.zero;
    final double maxX = (screen.width - FloatingAgentSphere.panelSize.width).clamp(0, double.infinity);
    final double maxY = (screen.height - FloatingAgentSphere.panelSize.height).clamp(0, double.infinity);
    setState(() {
      _position = Offset(
        (base.dx + delta.dx).clamp(0, maxX),
        (base.dy + delta.dy).clamp(0, maxY),
      );
    });
  }

  Widget? _desktopDragLayer(Size screen) {
    if (kIsWeb) return null;
    return Positioned.fill(
      child: ShiftDragOverlay(
        onDragDelta: (Offset d) => _applyDragDelta(d, screen),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final Size screen = MediaQuery.sizeOf(context);
    _ensureInitialPosition(screen);
    final Offset pos = _position!;

    return Positioned(
      left: pos.dx,
      top: pos.dy,
      width: FloatingAgentSphere.panelSize.width,
      height: FloatingAgentSphere.panelSize.height,
      child: Stack(
        clipBehavior: Clip.none,
        children: <Widget>[
          Positioned.fill(
            child: AgentSphereWebView(
              showOverlayButton: false,
              onDragDelta: kIsWeb ? (Offset d) => _applyDragDelta(d, screen) : null,
            ),
          ),
          if (_desktopDragLayer(screen) != null) _desktopDragLayer(screen)!,
        ],
      ),
    );
  }
}
