import "dart:async";
import "dart:html" as html;
import "dart:js" as js;

import "package:flutter/material.dart";

import "../../core/config/api_config.dart";
import "../../core/services/agent_sphere_interact_bridge.dart";
import "../../core/services/agent_sphere_mood_bridge.dart";

const String _lockKey = "__paiSphereLocked";

class AgentSphereWebView extends StatefulWidget {
  const AgentSphereWebView({
    super.key,
    this.showOverlayButton = true,
    this.onDragDelta,
    this.onDragStart,
    this.onDragEnd,
    this.visible = true,
  });

  final bool showOverlayButton;
  final ValueChanged<Offset>? onDragDelta;
  final VoidCallback? onDragStart;
  final VoidCallback? onDragEnd;
  final bool visible;

  @override
  State<AgentSphereWebView> createState() => _AgentSphereWebViewState();
}

class _AgentSphereWebViewState extends State<AgentSphereWebView> {
  html.DivElement? _host;
  html.IFrameElement? _frame;
  StreamSubscription<html.MessageEvent>? _msgSub;
  bool _iAmOwner = false;

  @override
  void initState() {
    super.initState();
    if (widget.visible) {
      _ensureInjected();
    }
  }

  @override
  void didUpdateWidget(covariant AgentSphereWebView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.visible && !oldWidget.visible) {
      _ensureInjected();
    } else if (!widget.visible && oldWidget.visible) {
      _teardown();
    }
    if (_iAmOwner) _applyVisibility();
  }

  void _ensureInjected() {
    if (_host != null) return;
    if (!_acquire()) return;
    _iAmOwner = true;
    _nukeAll();
    _inject();
    AgentSphereMoodBridge.instance.addListener(_onPatch);
    AgentSphereMoodBridge.instance.addMessageListener(_onSphereMessage);
    _msgSub ??= html.window.onMessage.listen(_onWindowMessage);
  }

  void _teardown() {
    if (!_iAmOwner) return;
    AgentSphereMoodBridge.instance.removeListener(_onPatch);
    AgentSphereMoodBridge.instance.removeMessageListener(_onSphereMessage);
    _msgSub?.cancel();
    _msgSub = null;
    _remove();
    _release();
    _iAmOwner = false;
  }

  @override
  void dispose() {
    _teardown();
    super.dispose();
  }

  static bool _acquire() {
    final locked = js.context[_lockKey];
    if (locked == true) return false;
    js.context[_lockKey] = true;
    return true;
  }

  static void _release() {
    js.context[_lockKey] = false;
  }

  void _nukeAll() {
    html.document.querySelectorAll("[data-pai-sphere]").forEach((el) => el.remove());
  }

  void _inject() {
    final String src =
        "${ApiConfig.httpBase}/chat/assets/avatar/free.html?wsOff=1&sessionId=${Uri.encodeComponent(ApiConfig.effectiveActorId)}";

    _host = html.DivElement()
      ..setAttribute("data-pai-sphere", "host")
      ..style.position = "fixed"
      ..style.left = "0"
      ..style.top = "0"
      ..style.width = "100vw"
      ..style.height = "100vh"
      ..style.pointerEvents = "none"
      ..style.zIndex = "9999"
      ..style.overflow = "visible"
      ..style.backgroundColor = "transparent";

    _frame = html.IFrameElement()
      ..setAttribute("data-pai-sphere", "frame")
      ..src = src
      ..style.border = "none"
      ..style.width = "100%"
      ..style.height = "100%"
      ..style.display = "block"
      ..style.backgroundColor = "transparent"
      ..style.pointerEvents = "none"
      ..style.overflow = "visible"
      ..allow = "autoplay; microphone";

    _host!.append(_frame!);
    html.document.body?.append(_host!);
    _applyVisibility();
  }

  void _remove() {
    _frame?.remove();
    _host?.remove();
    _frame = null;
    _host = null;
  }

  void _applyVisibility() {
    if (_host == null) return;
    _host!.style.display = widget.visible ? "" : "none";
  }

  void _onPatch(AgentSpherePatch patch) {
    _frame?.contentWindow?.postMessage(patch.toJson(), "*");
  }

  void _onSphereMessage(Map<String, dynamic> message) {
    _frame?.contentWindow?.postMessage(message, "*");
  }

  void _onWindowMessage(html.MessageEvent event) {
    if (event.data is! Map) return;
    final Map data = event.data as Map;
    final String? type = data["type"]?.toString();

    if (type == "agent-sphere:ready") {
      AgentSphereMoodBridge.instance.idle();
      return;
    }
    if (type == "agent-sphere:interact" && data["action"] == "focus") {
      AgentSphereMoodBridge.instance.requestChatFocus();
      return;
    }
    if (type == "agent-sphere:send") {
      AgentSphereInteractBridge.instance.send(
        data["action"]?.toString() ?? "",
        text: data["text"]?.toString(),
      );
      return;
    }
  }

  @override
  Widget build(BuildContext context) => const SizedBox.shrink();
}
