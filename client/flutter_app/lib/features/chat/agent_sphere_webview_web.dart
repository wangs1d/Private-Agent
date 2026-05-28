// ignore: avoid_web_libraries_in_flutter
import "dart:convert";
import "dart:html" as html;
import "dart:ui_web" as ui_web;

import "package:flutter/material.dart";

import "../../core/config/api_config.dart";
import "../../core/services/agent_sphere_mood_bridge.dart";

/// Web 平台 — iframe 嵌入 3D Agent
class AgentSphereWebView extends StatefulWidget {
  const AgentSphereWebView({
    super.key,
    this.showOverlayButton = true,
  });

  final bool showOverlayButton;

  @override
  State<AgentSphereWebView> createState() => _AgentSphereWebViewState();
}

class _AgentSphereWebViewState extends State<AgentSphereWebView> {
  static int _viewSeq = 0;
  late final String _viewType;
  html.IFrameElement? _frame;
  bool _ready = false;

  @override
  void initState() {
    super.initState();
    _viewType = "agent-sphere-iframe-${_viewSeq++}";
    final String src =
        "${ApiConfig.httpBase}/chat/assets/avatar/embed.html?wsOff=1&sessionId=${Uri.encodeComponent(ApiConfig.effectiveActorId)}";

    ui_web.platformViewRegistry.registerViewFactory(_viewType, (int _) {
      _frame = html.IFrameElement()
        ..src = src
        ..style.border = "0"
        ..style.width = "100%"
        ..style.height = "100%"
        ..style.display = "block"
        ..allow = "autoplay";
      final html.DivElement host = html.DivElement()
        ..style.width = "100%"
        ..style.height = "100%"
        ..style.overflow = "hidden"
        ..style.position = "relative"
        ..style.pointerEvents = "auto";
      host.append(_frame!);
      return host;
    });

    AgentSphereMoodBridge.instance.addListener(_onPatch);
    html.window.onMessage.listen((html.MessageEvent event) {
      if (event.data is Map && event.data["type"] == "agent-sphere:ready") {
        setState(() => _ready = true);
        AgentSphereMoodBridge.instance.idle();
      }
    });
  }

  @override
  void dispose() {
    AgentSphereMoodBridge.instance.removeListener(_onPatch);
    super.dispose();
  }

  void _onPatch(AgentSpherePatch patch) {
    _frame?.contentWindow?.postMessage(patch.toJson(), "*");
  }

  @override
  Widget build(BuildContext context) {
    return ClipRect(
      child: Stack(
        fit: StackFit.expand,
        clipBehavior: Clip.hardEdge,
        children: <Widget>[
          HtmlElementView(viewType: _viewType),
        if (!_ready)
          const Center(
            child: SizedBox(
              width: 24,
              height: 24,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          ),
        ],
      ),
    );
  }
}
