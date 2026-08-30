import "package:flutter/foundation.dart";

/// 虚拟电话通话会话：`agent.phone.*` WS 事件 → 手机端全屏通话页的数据总线。
///
/// - main.dart 收到来电/接通/语音回应事件时更新本会话；
/// - `PhoneCallPage` 监听本对象，按 [phase] 渲染振铃接听 / 通话中 UI，
///   会话结束（[end]）时自动关闭页面；
/// - 桌面端仍走 Win32 原生悬浮窗，本会话在桌面端只承载 voice_reply 的
///   转写与播报状态，不驱动页面。
///
/// 页面动作（接听/挂断/回复）通过 [onAccept] 等钩子回到 main.dart 统一处理，
/// WS 发送经 [transport]（启动时绑定为 `WsChatService.sendEvent`）。
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
    notifyListeners();
  }

  // ---- 页面动作 → WS ----

  /// 通话中用户回复（phone.call_reply；进服务端通话回复总线）
  bool sendReply(String text) {
    final String t = text.trim();
    if (t.isEmpty || callId.isEmpty) return false;
    if (phase != PhoneCallPhase.inCall) return false;
    // sendEvent 离线时会入队补发，这里乐观写入转写区
    transcript.add(PhoneCallTranscriptEntry(fromUser: true, text: t));
    notifyListeners();
    return transport?.call("phone.call_reply", <String, dynamic>{
          "callId": callId,
          "text": t,
        }) ??
        false;
  }

  /// 用户挂断（phone.call_hangup；服务端推 ended 并清理会话）
  bool hangup() {
    if (callId.isEmpty) return false;
    return transport?.call("phone.call_hangup", <String, dynamic>{
          "callId": callId,
        }) ??
        false;
  }
}
