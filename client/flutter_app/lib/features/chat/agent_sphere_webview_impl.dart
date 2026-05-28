import "package:flutter/material.dart";

import "../../core/services/agent_sphere_mood_bridge.dart";

/// 非 Web / 非 Windows 平台占位
class AgentSphereWebView extends StatelessWidget {
  const AgentSphereWebView({
    super.key,
    this.showOverlayButton = true,
    this.onDragDelta,
    this.onDragStart,
    this.onDragEnd,
  });

  final bool showOverlayButton;
  final ValueChanged<Offset>? onDragDelta;
  final VoidCallback? onDragStart;
  final VoidCallback? onDragEnd;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.transparent,
      alignment: Alignment.center,
      child: Text(
        "3D Agent 需 Web 或 Windows 客户端",
        style: TextStyle(color: Colors.white.withOpacity(0.6), fontSize: 12),
        textAlign: TextAlign.center,
      ),
    );
  }
}
