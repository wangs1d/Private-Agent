import "../core/presentation/voice_call_ui_labels.dart";

/// 通话/语音事件 payload → 领域值的解析收口。
///
/// 原 main.dart 在 agent.phone.ringing_start / call_connecting / incoming、
/// agent.proactive_voice / voice.speak / voice.alarm 各自内联同一段解析，
/// 这里去重为纯静态函数（无状态、无平台依赖，可单测）。
abstract final class PhoneCallController {
  /// 铃前摇默认时长（ms），服务端未带 ringDurationMs 时兜底。
  static const int defaultRingMs = 30000;

  /// direction/fromPhone → 来电方显示标签。
  /// [defaultDirection]：incoming 事件缺省为空串（由 ringStyle 分流判断），
  /// 其余事件缺省 agent_to_user。
  static String resolveCallerLabel(
    Map<String, dynamic> payload, {
    String defaultDirection = "agent_to_user",
  }) {
    return VoiceCallUiLabels.incomingCallerLabel(
      direction: payload["direction"]?.toString() ?? defaultDirection,
      fromPhone: payload["fromPhone"]?.toString(),
    );
  }

  /// 铃前摇时长（ms）。
  static int resolveRingMs(Map<String, dynamic> payload) =>
      (payload["ringDurationMs"] as num?)?.toInt() ?? defaultRingMs;

  /// 载荷里的 TTS 音频（mp3 base64）；缺格式/空载荷返回 null（走文本兜底）。
  static String? extractTtsBase64(Object? ttsRaw) {
    if (ttsRaw is Map) {
      final Object? fmt = ttsRaw["format"];
      final Object? b64 = ttsRaw["base64"];
      if (fmt?.toString() == "mp3" && b64 is String && b64.isNotEmpty) {
        return b64;
      }
    }
    return null;
  }
}
