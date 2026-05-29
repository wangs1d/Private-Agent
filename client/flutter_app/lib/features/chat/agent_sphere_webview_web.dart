// ignore: avoid_web_libraries_in_flutter
import "dart:html" as html;
import "dart:ui_web" as ui_web;

import "package:flutter/material.dart";

import "../../core/config/api_config.dart";
import "../../core/services/agent_sphere_interact_bridge.dart";
import "../../core/services/agent_sphere_mood_bridge.dart";

/// Web 平台 — iframe 嵌入 3D Agent
class AgentSphereWebView extends StatefulWidget {
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
  State<AgentSphereWebView> createState() => _AgentSphereWebViewState();
}

class _AgentSphereWebViewState extends State<AgentSphereWebView> {
  static int _viewSeq = 0;
  late final String _viewType;
  html.IFrameElement? _frame;
  bool _ready = false;
  bool _dragging = false;
  double _lastClientX = 0;
  double _lastClientY = 0;

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
        ..style.backgroundColor = "transparent"
        ..allow = "autoplay; microphone";
      final html.DivElement host = html.DivElement()
        ..style.width = "100%"
        ..style.height = "100%"
        ..style.overflow = "hidden"
        ..style.position = "relative"
        ..style.pointerEvents = "auto"
        ..style.backgroundColor = "transparent";
      host.append(_frame!);
      _bindDrag(host, _frame!);
      return host;
    });

    AgentSphereMoodBridge.instance.addListener(_onPatch);
    AgentSphereMoodBridge.instance.addMessageListener(_onSphereMessage);
    html.window.onMessage.listen((html.MessageEvent event) {
      if (event.data is! Map) return;
      final Map data = event.data as Map;
      if (data["type"] == "agent-sphere:ready") {
        setState(() => _ready = true);
        AgentSphereMoodBridge.instance.idle();
        return;
      }
      if (data["type"] == "agent-sphere:interact" && data["action"] == "focus") {
        AgentSphereMoodBridge.instance.requestChatFocus();
        return;
      }
      if (data["type"] == "agent-sphere:send") {
        AgentSphereInteractBridge.instance.send(
          data["action"]?.toString() ?? "",
          text: data["text"]?.toString(),
        );
      }
    });
  }

  @override
  void dispose() {
    AgentSphereMoodBridge.instance.removeListener(_onPatch);
    AgentSphereMoodBridge.instance.removeMessageListener(_onSphereMessage);
    super.dispose();
  }

  void _onPatch(AgentSpherePatch patch) {
    _frame?.contentWindow?.postMessage(patch.toJson(), "*");
  }

  void _onSphereMessage(Map<String, dynamic> message) {
    _frame?.contentWindow?.postMessage(message, "*");
  }

  void _bindDrag(html.DivElement host, html.IFrameElement frame) {
    if (widget.onDragDelta == null) return;

    void onMouseDown(html.MouseEvent ev) {
      // 左键拖动旋转视角；Shift/Alt + 拖动移动悬浮位置
      if (ev.button != 0 || widget.onDragDelta == null) return;
      if (!ev.shiftKey && !ev.altKey) return;
      _dragging = true;
      _lastClientX = ev.client.x.toDouble();
      _lastClientY = ev.client.y.toDouble();
      frame.style.pointerEvents = "none";
      host.style.cursor = "grabbing";
      widget.onDragStart?.call();
      ev.preventDefault();
    }

    void onMouseMove(html.MouseEvent ev) {
      if (!_dragging || widget.onDragDelta == null) return;
      final double x = ev.client.x.toDouble();
      final double y = ev.client.y.toDouble();
      widget.onDragDelta!(Offset(x - _lastClientX, y - _lastClientY));
      _lastClientX = x;
      _lastClientY = y;
    }

    void onMouseEnd(html.MouseEvent ev) {
      if (!_dragging) return;
      _dragging = false;
      frame.style.pointerEvents = "auto";
      host.style.cursor = "grab";
      widget.onDragEnd?.call();
    }

    host.style.cursor = "grab";
    host.onMouseDown.listen(onMouseDown);
    frame.onMouseDown.listen(onMouseDown);
    html.document.onMouseMove.listen(onMouseMove);
    html.document.onMouseUp.listen(onMouseEnd);
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      fit: StackFit.expand,
      clipBehavior: Clip.none,
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
    );
  }
}
