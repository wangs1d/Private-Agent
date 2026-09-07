import "dart:async";
import "dart:convert";
import "dart:typed_data";

import "package:web_socket_channel/web_socket_channel.dart";
import "package:web_socket_channel/status.dart" as status;

/// 全双工实时语音客户端（协议层）。
///
/// 与服务端 `services/voice-duplex/protocol.ts` 对齐：单条 WebSocket，
/// 全部 JSON 文本帧；上行音频为 base64 的 16-bit 单声道小端 PCM。
///
/// 职责边界：本类只做「协议 + 会话状态」，不负责录音与播放 ——
/// 麦克风采到 PCM 块后调 [sendAudioChunk]，收到 `tts.chunk`（mp3 base64）
/// 后由上层交给播放器；`state` 事件驱动 UI（listening/thinking/speaking）。
///
/// 使用示例：
/// ```dart
/// final voice = VoiceDuplexService(url: "ws://127.0.0.1:3000/ws/voice-duplex");
/// voice.onEvent = (event) { ... };
/// await voice.start(sampleRate: 16000, language: "zh");
/// // 麦克风回调里（100ms 一块）：
/// voice.sendAudioChunk(pcmBytes);
/// // 一句话说完（或静音检测）：
/// await voice.endAudio();
/// // 打断（插话时）：
/// voice.interrupt();
/// await voice.stop();
/// ```
///
/// 注意：设备端采集需开启回声消除（AEC），否则扬声器播放的 TTS 会被
/// 麦克风当成用户插话触发打断。
class VoiceDuplexService {
  VoiceDuplexService({required this.url});

  final String url;

  WebSocketChannel? _channel;
  bool _manualClose = false;
  DuplexVoiceState _state = DuplexVoiceState.idle;
  String? _lastError;

  /// 服务端事件（state / asr.partial / asr.final / assistant.delta /
  /// tts.chunk / tts.end / turn.completed / error / session.ended）。
  void Function(Map<String, dynamic> event)? onEvent;

  DuplexVoiceState get state => _state;
  String? get lastError => _lastError;

  Future<void> start({
    int sampleRate = 16000,
    String language = "zh",
    String? voiceId,
    String? sessionId,
    String? systemPrompt,
  }) async {
    _manualClose = false;
    _lastError = null;
    await _closeChannel();
    final channel = WebSocketChannel.connect(Uri.parse(url));
    _channel = channel;
    channel.stream.listen(
      (data) {
        if (data is String) _handleServerFrame(data);
      },
      onError: (Object err) {
        _lastError = err.toString();
        _setState(DuplexVoiceState.idle);
      },
      onDone: () {
        _setState(DuplexVoiceState.idle);
      },
      cancelOnError: true,
    );
    await channel.ready;
    _send({
      "type": "session.start",
      "sampleRate": sampleRate,
      "language": language,
      if (voiceId != null) "voiceId": voiceId,
      if (sessionId != null) "sessionId": sessionId,
      if (systemPrompt != null) "systemPrompt": systemPrompt,
    });
  }

  /// 上行一块音频（16-bit LE mono PCM，建议 100ms 一块）。
  void sendAudioChunk(Uint8List pcmBytes) {
    _send({"type": "audio.chunk", "pcm": base64Encode(pcmBytes)});
  }

  /// 通知服务端一句话结束（服务端会触发 ASR final → 回复生成）。
  Future<void> endAudio() async {
    _send({"type": "audio.end"});
  }

  /// 打断（speaking/thinking 态下用户插话时调用；说话态收到音频块
  /// 服务端也会自动打断）。
  void interrupt() {
    _send({"type": "interrupt"});
  }

  Future<void> stop() async {
    _send({"type": "session.stop"});
    _manualClose = true;
    await _closeChannel();
    _setState(DuplexVoiceState.idle);
  }

  // ------------------------------------------------------------------ //

  void _handleServerFrame(String raw) {
    Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } catch (_) {
      return;
    }
    if (decoded is! Map<String, dynamic>) return;
    final event = decoded;
    switch (event["type"]) {
      case "session.ready":
        _setState(DuplexVoiceState.listening);
        break;
      case "state":
        final value = event["state"];
        _setState(DuplexVoiceState.values.firstWhere(
          (s) => s.wireName == value,
          orElse: () => DuplexVoiceState.idle,
        ));
        break;
      case "error":
        _lastError = event["message"]?.toString();
        break;
      case "session.ended":
        _setState(DuplexVoiceState.idle);
        break;
      default:
        break;
    }
    onEvent?.call(event);
  }

  void _setState(DuplexVoiceState next) {
    if (_state == next) return;
    _state = next;
  }

  void _send(Map<String, dynamic> message) {
    final channel = _channel;
    if (channel == null || _manualClose) return;
    try {
      channel.sink.add(jsonEncode(message));
    } catch (_) {
      // 连接中断：由上层状态恢复
    }
  }

  Future<void> _closeChannel() async {
    final channel = _channel;
    _channel = null;
    if (channel == null) return;
    try {
      await channel.sink.close(status.normalClosure);
    } catch (_) {
      // ignore
    }
  }
}

/// 会话状态（与服务端 DuplexSessionState 对齐）。
enum DuplexVoiceState {
  idle("idle"),
  listening("listening"),
  thinking("thinking"),
  speaking("speaking");

  const DuplexVoiceState(this.wireName);

  final String wireName;
}
