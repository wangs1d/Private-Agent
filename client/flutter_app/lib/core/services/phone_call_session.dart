import "dart:async";

import "package:flutter/foundation.dart";

import "voice_duplex_service.dart";

/// 虚拟电话通话会话：`agent.phone.*` WS 事件 → 手机端全屏通话页的数据总线。
///
/// - main.dart 收到来电/接通/语音回应事件时更新本会话；
/// - `PhoneCallPage` 监听本对象，按 [phase] 渲染振铃接听 / 通话中 UI，
///   会话结束（[end]）时自动关闭页面；
/// - 桌面端仍走 Win32 原生悬浮窗，本会话在桌面端只承载 voice_reply 的
///   转写与播报状态，不驱动页面。
///
/// 页面动作（接听/挂断）通过 [onAccept] 等钩子回到 main.dart 统一处理，
/// WS 发送经 [transport]（启动时绑定为 `WsChatService.sendEvent`）。
///
/// 通话对话（2026-09-28 起）：MiniMax realtime 端到端语音——接通即经
/// /ws/voice-duplex（sessionId=callId 注入通话上下文）开麦克风上行，
/// 服务端 VAD 断句 + realtime 应答，回复语音整轮回流；打字回复已删除。
enum PhoneCallPhase { idle, incoming, inCall }

class PhoneCallTranscriptEntry {
  const PhoneCallTranscriptEntry({required this.fromUser, required this.text});

  final bool fromUser;
  final String text;
}

class PhoneCallSession extends ChangeNotifier {
  PhoneCallSession._();

  static final PhoneCallSession instance = PhoneCallSession._();

  PhoneCallPhase phase = PhoneCallPhase.idle;
  String callId = "";
  String callerLabel = "";
  String callerInitial = "A";
  String subtitle = "";
  /// 服务端在通话中推给用户的语音稿（call_connecting / voice_reply）
  final List<PhoneCallTranscriptEntry> transcript = <PhoneCallTranscriptEntry>[];
  /// Agent 正在播报 TTS（头像呼吸动画）
  bool agentTalking = false;
  DateTime? connectedAt;
  /// 振铃自动挂断时限（incoming 阶段倒计时用）
  DateTime? ringDeadline;

  /// realtime 语音通路状态（供通话 UI 显示：聆听中/思考中/播报中）
  String voiceState = "";
  /// realtime 语音通路是否就绪（false = 回落提示，服务端无 minimax 等）
  bool voiceReady = false;
  bool _voiceStarting = false;

  /// 当前语音通路服务的通话 ID：用于识别上一通电话残留的状态，
  /// 见 [_startRealtimeVoice] 的重建判断。
  String _voiceCallId = "";

  /// 麦克风电平（0-1，每 2s 随诊断窗口刷新）；通话 UI 据此提示「没听到你说话」
  double micLevel = 0;

  /// 麦克风是否采集到足以触发服务端 VAD 的声音（false 时说话不会被识别）
  bool get micHasSignal => VoiceDuplexService.instance.micHasSignal;

  /// WS 发送通道（main.dart initState 绑定）
  bool Function(String type, Map<String, dynamic> payload)? transport;

  /// 页面动作钩子（main.dart initState 绑定，语义与桌面原生悬浮窗回调一致）
  VoidCallback? onAccept;
  VoidCallback? onDecline;
  VoidCallback? onHangup;
  VoidCallback? onTimeout;

  bool get isActive => phase != PhoneCallPhase.idle;

  /// 取首字符（处理中英文，回退 fallback；用 runes 兼容 emoji/中文）
  static String _firstChar(String s, {required String fallback}) {
    if (s.isEmpty) return fallback;
    return String.fromCharCode(s.runes.first).toUpperCase();
  }

  void showIncoming({
    required String callId,
    required String callerLabel,
    String subtitle = "来电",
    String? initial,
    int ringTimeoutMs = 30000,
  }) {
    this.callId = callId;
    this.callerLabel = callerLabel;
    this.subtitle = subtitle;
    final String seed = (initial ?? callerLabel).trim();
    callerInitial = _firstChar(seed, fallback: "A");
    ringDeadline = DateTime.now().add(Duration(milliseconds: ringTimeoutMs));
    phase = PhoneCallPhase.incoming;
    connectedAt = null;
    agentTalking = false;
    transcript.clear();
    notifyListeners();
  }

  /// 接通（前摇结束 call_connecting，或用户呼出 call_status connected）。
  /// 会话处于 idle（页面未开）时也会进入 inCall，由页面打开方判断是否弹页。
  void markInCall({String? callId, String? transcriptText}) {
    if (callId != null && callId.isNotEmpty) this.callId = callId;
    if (transcriptText != null && transcriptText.isNotEmpty) {
      transcript.add(PhoneCallTranscriptEntry(fromUser: false, text: transcriptText));
    }
    connectedAt ??= DateTime.now();
    agentTalking = false;
    ringDeadline = null;
    final bool wasIdle = phase == PhoneCallPhase.idle;
    phase = PhoneCallPhase.inCall;
    notifyListeners();
    if (wasIdle) {
      // 首次进入通话（如用户呼出场景），由页面打开方据此弹页
      _openedFromIdle = true;
    }
    // 接通即起 realtime 语音（幂等）：麦克风上行 + 语音回流，通话上下文经 callId 注入
    unawaited(_startRealtimeVoice());
  }

  /// 标记「本次 markInCall 是从 idle 直接进入」，供 main.dart 决定是否开页。
  bool consumeOpenedFromIdle() {
    final bool v = _openedFromIdle;
    _openedFromIdle = false;
    return v;
  }

  bool _openedFromIdle = false;

  /// 通话中 Agent 的后续语音回应（agent.phone.voice_reply）
  void appendAgentVoice({String? transcriptText}) {
    if (phase == PhoneCallPhase.idle) return;
    if (transcriptText != null && transcriptText.isNotEmpty) {
      transcript.add(PhoneCallTranscriptEntry(fromUser: false, text: transcriptText));
    }
    agentTalking = true;
    notifyListeners();
  }

  void setTalking(bool talking) {
    if (agentTalking == talking) return;
    agentTalking = talking;
    notifyListeners();
  }

  void end() {
    if (phase == PhoneCallPhase.idle) return;
    phase = PhoneCallPhase.idle;
    callId = "";
    agentTalking = false;
    connectedAt = null;
    ringDeadline = null;
    _openedFromIdle = false;
    _stopRealtimeVoice();
    notifyListeners();
  }

  // ---- realtime 语音通路（MiniMax 端到端通话） ----

  Future<void> _startRealtimeVoice() async {
    if (phase != PhoneCallPhase.inCall || callId.isEmpty) return;
    // 幂等收窄到「确属本次通话且连接确实还活着」。
    //
    // 此前只看 voiceReady：上一通电话若没走到 end()（用户直接关掉通话窗、
    // 服务端没推 ended、App 被重启打断），voiceReady 会残留 true，新通话进来
    // 时这里直接 return，不再建 duplex 连接——表现就是「接通了但永远没声音」。
    // 补上 callId 归属校验 + 实际连接存活校验后，残留状态会被自动重建。
    if (voiceReady &&
        _voiceCallId == callId &&
        VoiceDuplexService.instance.isReady) {
      return;
    }
    if (_voiceStarting) return;
    _voiceStarting = true;
    voiceState = "连接实时语音…";
    notifyListeners();

    final VoiceDuplexService duplex = VoiceDuplexService.instance;
    duplex
      ..onStateChanged = _onVoiceStateChanged
      ..onTurnCompleted = _onVoiceTurnCompleted
      ..onMicProbe = () {
        if (!isActive) return;
        micLevel = duplex.micLevel.value;
        notifyListeners();
      }
      ..onError = (String message, bool recoverable) {
        if (!isActive) return;
        voiceState = recoverable ? "请再说一遍" : "语音链路异常";
        notifyListeners();
      }
      ..onConnectionLost = () {
        if (!isActive) return;
        voiceReady = false;
        _voiceCallId = "";
        voiceState = "语音已断开";
        notifyListeners();
      };

    try {
      final bool ok = await duplex.start(sessionId: callId);
      if (!ok || !isActive) {
        voiceReady = false;
        _voiceCallId = "";
        if (isActive) voiceState = "实时语音不可用";
        notifyListeners();
        return;
      }
      voiceReady = true;
      _voiceCallId = callId;
      voiceState = "聆听中，请直接说话";
      notifyListeners();
      final bool micOk = await duplex.startMic();
      if (!micOk && isActive) {
        voiceState = "麦克风不可用";
        notifyListeners();
      }
    } catch (e) {
      // 兜底：确保 _voiceStarting 一定复位，否则本会话再也无法重试建连
      debugPrint("[PhoneCallSession] realtime voice failed: $e");
      voiceReady = false;
      _voiceCallId = "";
      if (isActive) {
        voiceState = "实时语音异常";
        notifyListeners();
      }
    } finally {
      _voiceStarting = false;
    }
  }

  void _stopRealtimeVoice() {
    _voiceStarting = false;
    voiceReady = false;
    _voiceCallId = "";
    micLevel = 0;
    voiceState = "";
    final VoiceDuplexService duplex = VoiceDuplexService.instance;
    duplex.onStateChanged = null;
    duplex.onTurnCompleted = null;
    duplex.onMicProbe = null;
    duplex.onError = null;
    duplex.onConnectionLost = null;
    unawaited(duplex.stop());
  }

  void _onVoiceStateChanged(String state) {
    if (!isActive) return;
    voiceState = switch (state) {
      "listening" => "聆听中，请直接说话",
      "thinking" => "思考中…",
      "speaking" => "正在播报…",
      _ => voiceState,
    };
    if (state == "speaking") {
      agentTalking = true;
    } else if (state == "listening") {
      agentTalking = false;
    }
    notifyListeners();
  }

  void _onVoiceTurnCompleted(String userText, String assistantText) {
    if (!isActive) return;
    agentTalking = false;
    if (userText.trim().isNotEmpty) {
      transcript.add(PhoneCallTranscriptEntry(fromUser: true, text: userText.trim()));
    }
    if (assistantText.trim().isNotEmpty) {
      transcript.add(PhoneCallTranscriptEntry(fromUser: false, text: assistantText.trim()));
    }
    voiceState = "聆听中，请直接说话";
    notifyListeners();
  }

  // ---- 页面动作 → WS ----

  /// 用户挂断（phone.call_hangup；服务端推 ended 并清理会话）
  bool hangup() {
    if (callId.isEmpty) return false;
    return transport?.call("phone.call_hangup", <String, dynamic>{
          "callId": callId,
        }) ??
        false;
  }
}
