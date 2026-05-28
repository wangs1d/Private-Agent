import "dart:async";
import "dart:io";

import "package:flutter/foundation.dart";

import "sphere_overlay_launcher.dart";

/// Agent 3D 形象状态 — 与 embed.html / overlay 的 mood 对齐
class AgentSpherePatch {
  const AgentSpherePatch({
    this.mood,
    this.energy,
    this.caption,
    this.clearCaption = false,
  });

  final String? mood;
  final double? energy;
  final String? caption;
  final bool clearCaption;

  Map<String, dynamic> toJson() => <String, dynamic>{
        if (mood != null) "mood": mood,
        if (energy != null) "energy": energy,
        if (clearCaption) "caption": null else if (caption != null) "caption": caption,
        "type": "agent-sphere:patch",
      };
}

typedef AgentSpherePatchListener = void Function(AgentSpherePatch patch);

/// 统一驱动聊天页 WebView 与桌面悬浮 Agent 的表情状态
class AgentSphereMoodBridge {
  AgentSphereMoodBridge._();

  static final AgentSphereMoodBridge instance = AgentSphereMoodBridge._();

  final List<AgentSpherePatchListener> _listeners = <AgentSpherePatchListener>[];
  double _speakingEnergy = 0.45;

  void addListener(AgentSpherePatchListener listener) {
    if (!_listeners.contains(listener)) _listeners.add(listener);
  }

  void removeListener(AgentSpherePatchListener listener) {
    _listeners.remove(listener);
  }

  void patch(AgentSpherePatch patch) {
    for (final AgentSpherePatchListener listener in List<AgentSpherePatchListener>.from(_listeners)) {
      listener(patch);
    }
    if (!kIsWeb && Platform.isWindows) {
      unawaited(SphereOverlayLauncher.patchMood(patch));
    }
  }

  void listening({String caption = "正在聆听…"}) {
    _speakingEnergy = 0.45;
    patch(AgentSpherePatch(mood: "listening", energy: 0.65, caption: caption));
  }

  void thinking({String? caption}) {
    patch(AgentSpherePatch(mood: "thinking", energy: 0.72, caption: caption));
  }

  void speaking({String? caption}) {
    _speakingEnergy = (_speakingEnergy + 0.025).clamp(0.45, 1.0);
    patch(AgentSpherePatch(mood: "speaking", energy: _speakingEnergy, caption: caption));
  }

  void idle() {
    _speakingEnergy = 0.45;
    patch(AgentSpherePatch(mood: "idle", energy: 0.5, clearCaption: true));
  }

  void happy() {
    patch(AgentSpherePatch(mood: "happy", energy: 0.55, clearCaption: true));
    Future<void>.delayed(const Duration(milliseconds: 1800), idle);
  }

  void alert({required String caption}) {
    patch(AgentSpherePatch(mood: "alert", energy: 0.85, caption: caption));
  }
}
