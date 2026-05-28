import "dart:async";

import "package:flutter/foundation.dart" show ValueNotifier, VoidCallback, debugPrint;

import "../config/api_config.dart";
import "agent_sphere_mood_bridge.dart";
import "multimodal_recognition_service.dart";
import "voice_command_processor.dart";
import "voice_wake_service.dart";
import "voiceprint_service.dart";

/// 3D Agent 语音交互状态（唤醒 + 声纹 ASR）
class AgentSphereVoiceState {
  const AgentSphereVoiceState({
    this.wakeEnabled = true,
    this.isWaitingWake = false,
    this.isSpeaking = false,
    this.statusText = "正在启动…",
    this.verificationStatus = "",
    this.wakeHint = "",
    this.confidence = 0.0,
    this.isVoiceprintRegistered = false,
  });

  final bool wakeEnabled;
  final bool isWaitingWake;
  final bool isSpeaking;
  final String statusText;
  final String verificationStatus;
  final String wakeHint;
  final double confidence;
  final bool isVoiceprintRegistered;

  AgentSphereVoiceState copyWith({
    bool? wakeEnabled,
    bool? isWaitingWake,
    bool? isSpeaking,
    String? statusText,
    String? verificationStatus,
    String? wakeHint,
    double? confidence,
    bool? isVoiceprintRegistered,
  }) {
    return AgentSphereVoiceState(
      wakeEnabled: wakeEnabled ?? this.wakeEnabled,
      isWaitingWake: isWaitingWake ?? this.isWaitingWake,
      isSpeaking: isSpeaking ?? this.isSpeaking,
      statusText: statusText ?? this.statusText,
      verificationStatus: verificationStatus ?? this.verificationStatus,
      wakeHint: wakeHint ?? this.wakeHint,
      confidence: confidence ?? this.confidence,
      isVoiceprintRegistered: isVoiceprintRegistered ?? this.isVoiceprintRegistered,
    );
  }
}

/// 全屏 3D Agent 语音能力 — 替代原「语音模式」页
class AgentSphereVoiceController {
  AgentSphereVoiceController._();

  static final AgentSphereVoiceController instance = AgentSphereVoiceController._();

  final ValueNotifier<AgentSphereVoiceState> state =
      ValueNotifier<AgentSphereVoiceState>(const AgentSphereVoiceState());

  final MultimodalRecognitionService _recognitionService = MultimodalRecognitionService();
  final VoiceCommandProcessor _commandProcessor = VoiceCommandProcessor();
  final VoiceWakeService _wakeService = VoiceWakeService.instance;

  StreamSubscription<VoiceprintEvent>? _voiceprintSubscription;
  bool _bootstrapped = false;

  /// 识别到文本后回调（由 main 注入：填入输入框并发送）
  void Function(String text)? onRecognizedText;

  /// 需要打开声纹注册页
  VoidCallback? onRequestVoiceprintRegistration;

  AgentSphereVoiceState get _s => state.value;

  void _emit(AgentSphereVoiceState next) => state.value = next;

  Future<void> bootstrap() async {
    if (_bootstrapped) return;
    _bootstrapped = true;
    _commandProcessor.initializeDefaultCommands();
    AgentSphereMoodBridge.instance.idle();

    try {
      await _recognitionService.initialize(userId: ApiConfig.effectiveActorId);
    } catch (e) {
      debugPrint("[AgentSphereVoice] init failed: $e");
    }

    if (_s.wakeEnabled) {
      await startWakeListening();
    } else {
      _emit(_s.copyWith(statusText: "点击 Agent 开始说话"));
    }
  }

  Future<void> dispose() async {
    await _wakeService.stop();
    _stopVoiceprintListening(resumeWake: false);
    _bootstrapped = false;
  }

  /// 离开聊天页时暂停监听
  Future<void> pauseForBackground() async {
    await _stopWakeListening();
    _stopVoiceprintListening(resumeWake: false);
  }

  /// 回到聊天页时恢复唤醒
  Future<void> resumeForForeground() async {
    if (!_bootstrapped) {
      await bootstrap();
      return;
    }
    if (_s.wakeEnabled && !_s.isSpeaking) {
      await startWakeListening();
    }
  }

  Future<void> toggleWakeEnabled() async {
    if (_s.wakeEnabled) {
      await _wakeService.stop();
      _emit(_s.copyWith(
        wakeEnabled: false,
        isWaitingWake: false,
        wakeHint: "",
        statusText: _s.isSpeaking ? _s.statusText : "点击 Agent 开始说话",
        verificationStatus: _s.isSpeaking ? _s.verificationStatus : "语音唤醒已关闭",
      ));
    } else {
      _emit(_s.copyWith(wakeEnabled: true, verificationStatus: ""));
      if (!_s.isSpeaking) await startWakeListening();
    }
  }

  Future<void> startWakeListening() async {
    if (_s.isSpeaking || !_s.wakeEnabled) return;

    final bool ok = await _wakeService.start(
      onWake: _onWakeDetected,
      onPartial: (String partial) {
        if (!_s.isWaitingWake) return;
        _emit(_s.copyWith(wakeHint: partial));
      },
    );

    _emit(_s.copyWith(
      isWaitingWake: ok,
      statusText: ok ? "等待唤醒" : "语音唤醒不可用",
      verificationStatus: ok
          ? "说「${VoiceWakeService.displayWakePhrase}」开始对话"
          : "请检查麦克风权限，或点击 Agent 说话",
      wakeHint: "",
    ));
    if (ok) AgentSphereMoodBridge.instance.idle();
  }

  Future<void> _stopWakeListening() async {
    await _wakeService.stop();
    _emit(_s.copyWith(isWaitingWake: false, wakeHint: ""));
  }

  void _onWakeDetected() {
    _emit(_s.copyWith(
      isWaitingWake: false,
      wakeHint: "",
      statusText: "已唤醒",
      verificationStatus: "",
    ));
    AgentSphereMoodBridge.instance.listening(caption: "唤醒成功");
    startVoiceSession(fromWake: true);
  }

  void toggleVoiceSession() {
    if (_s.isSpeaking) {
      _stopVoiceprintListening();
    } else {
      unawaited(_stopWakeListening());
      startVoiceSession();
    }
  }

  void startVoiceSession({bool fromWake = false}) {
    if (!_recognitionService.isInitialized) {
      _emit(_s.copyWith(statusText: "服务未初始化"));
      if (_s.wakeEnabled) unawaited(startWakeListening());
      return;
    }

    if (!_s.isVoiceprintRegistered) {
      _emit(_s.copyWith(
        statusText: fromWake ? "已唤醒 · 请先注册声纹" : "请先注册声纹",
        verificationStatus: "点击右上角注册声纹",
      ));
      onRequestVoiceprintRegistration?.call();
      if (_s.wakeEnabled) unawaited(startWakeListening());
      return;
    }

    unawaited(_stopWakeListening());

    try {
      final Stream<VoiceprintEvent>? stream = _recognitionService.startVoiceprintListening(
        onResult: (String text) {
          onRecognizedText?.call(text);
          _commandProcessor.processCommand(text);
        },
      );

      if (stream == null) return;

      _voiceprintSubscription = stream.listen((VoiceprintEvent event) {
        switch (event.type) {
          case VoiceprintEventType.listening:
            _emit(_s.copyWith(
              statusText: "正在聆听…",
              verificationStatus: "",
            ));
            AgentSphereMoodBridge.instance.listening();
            break;
          case VoiceprintEventType.verified:
            _emit(_s.copyWith(
              statusText: "验证通过",
              verificationStatus: "✓ 声纹匹配",
              confidence: event.verificationResult?.confidence ?? 0.0,
            ));
            break;
          case VoiceprintEventType.rejected:
            _emit(_s.copyWith(
              statusText: "验证失败",
              verificationStatus: "✗ 非授权用户",
              confidence: event.verificationResult?.confidence ?? 0.0,
            ));
            AgentSphereMoodBridge.instance.alert(caption: "声纹未通过");
            break;
          case VoiceprintEventType.error:
            _emit(_s.copyWith(
              statusText: "识别错误",
              verificationStatus: event.error ?? "未知错误",
            ));
            AgentSphereMoodBridge.instance.alert(caption: event.error ?? "识别错误");
            break;
          default:
            break;
        }
      });

      _emit(_s.copyWith(
        isSpeaking: true,
        statusText: fromWake ? "唤醒聆听中…" : "正在聆听…",
      ));
      AgentSphereMoodBridge.instance.listening();
    } catch (e) {
      _emit(_s.copyWith(statusText: "启动失败", verificationStatus: e.toString()));
      if (_s.wakeEnabled) unawaited(startWakeListening());
    }
  }

  void _stopVoiceprintListening({bool resumeWake = true}) {
    _voiceprintSubscription?.cancel();
    _voiceprintSubscription = null;
    _recognitionService.stopVoiceprintListening();

    _emit(_s.copyWith(
      isSpeaking: false,
      confidence: 0.0,
      statusText: _s.wakeEnabled && resumeWake ? "等待唤醒" : "点击 Agent 开始说话",
      verificationStatus: _s.wakeEnabled && resumeWake
          ? "说「${VoiceWakeService.displayWakePhrase}」开始对话"
          : (_s.wakeEnabled ? "" : "语音唤醒已关闭"),
    ));
    AgentSphereMoodBridge.instance.idle();

    if (_s.wakeEnabled && resumeWake) {
      unawaited(startWakeListening());
    }
  }

  void markVoiceprintRegistered() {
    _emit(_s.copyWith(
      isVoiceprintRegistered: true,
      statusText: _s.wakeEnabled ? "等待唤醒" : "点击 Agent 开始说话",
      verificationStatus: _s.wakeEnabled
          ? "说「${VoiceWakeService.displayWakePhrase}」开始对话"
          : "",
    ));
    if (_s.wakeEnabled && !_s.isSpeaking) {
      unawaited(startWakeListening());
    }
  }
}
