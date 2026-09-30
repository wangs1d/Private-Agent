import "dart:async";
import "dart:convert";

import "package:flutter/foundation.dart";
import "package:record/record.dart";
import "package:web_socket_channel/web_socket_channel.dart";

import "../config/api_config.dart";
import "tts_player.dart";

/// 全双工语音 WS 客户端（/ws/voice-duplex）。
///
/// 两种上行：
///   - `text.turn`：纯语音模式用——本地识别文本进，整轮语音回流；
///   - `audio.chunk`：电话通话用——麦克风 16kHz PCM16 流式上行，
///     服务端能量 VAD 断句后交给 MiniMax realtime 端到端应答。
/// 下行统一是 `tts.chunk`（24kHz wav base64），经 [TtsPlayer] 直接播。
///
/// 半双工门控（回声防护）：任何 TTS 播报期间（含通话接通问候语）麦克风
/// 上行自动暂停，播完自动恢复；服务端在 thinking/speaking 态还会二次丢弃
/// 上行音频，双层防扬声器回流污染对话上下文。
///
/// 服务端无 minimax 时 session.ready 会回 pipeline 引擎，本客户端
/// 不认 pipeline（start 返回 false，调用方回落）。
class VoiceDuplexService {
  VoiceDuplexService._();

  static final VoiceDuplexService instance = VoiceDuplexService._();

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _sub;
  Completer<bool>? _readyCompleter;
  Completer<void>? _playbackCompleter;
  bool _turnInFlight = false;

  final AudioRecorder _recorder = AudioRecorder();
  StreamSubscription<Uint8List>? _micSub;
  bool _micGated = false;
  VoidCallback? _gatingCompletionListener;

  String? engine;
  String? lastState;

  bool get isReady =>
      _channel != null &&
      (_readyCompleter?.isCompleted ?? false) &&
      engine == "minimax-realtime";

  bool get micActive => _micSub != null;

  /// 会话状态机（listening/thinking/speaking）变化
  void Function(String state)? onStateChanged;

  /// 一轮对话完成（assistantText 为语音转录；audio 上行时 userText 可能为空）
  void Function(String userText, String assistantText)? onTurnCompleted;

  /// 服务端错误。recoverable=false 或连接断开时调用方应回落。
  void Function(String message, bool recoverable)? onError;

  /// 连接断开（服务端重启/网络断）。
  void Function()? onConnectionLost;

  /// 建立会话并等待握手。
  ///
  /// [sessionId] 传通话 callId 时，服务端把该通电话的场景上下文并进
  /// realtime 人设（来电汇报内容/来电留言）。返回是否为可用的
  /// minimax-realtime 引擎。
  Future<bool> start({
    String? sessionId,
    String? actorId,
    Duration timeout = const Duration(seconds: 6),
  }) async {
    await stop();
    try {
      final Uri uri = Uri.parse("${ApiConfig.wsUrl}/voice-duplex");
      final WebSocketChannel channel = WebSocketChannel.connect(uri);
      _channel = channel;
      _readyCompleter = Completer<bool>();
      _sub = channel.stream.listen(
        _onMessage,
        onDone: _onDisconnected,
        onError: (Object _) => _onDisconnected(),
      );
      channel.sink.add(jsonEncode(<String, dynamic>{
        "type": "session.start",
        if (sessionId != null && sessionId.isNotEmpty) "sessionId": sessionId,
        // 声纹闸：声明身份；该身份已注册声纹时服务端要求 speaker.verify 后才受理对话
        if (actorId != null && actorId.isNotEmpty) "actorId": actorId,
      }));
      final bool ok = await _readyCompleter!.future.timeout(
        timeout,
        onTimeout: () => false,
      );
      if (!ok) {
        await stop();
      }
      return ok;
    } catch (e) {
      debugPrint("[VoiceDuplex] start failed: $e");
      await stop();
      return false;
    }
  }

  /// 声纹验证通过后上报一次性说话人令牌（服务端放行本连接的对话帧）。
  void sendSpeakerVerify(String token) {
    final WebSocketChannel? channel = _channel;
    if (channel == null) return;
    channel.sink.add(jsonEncode(<String, dynamic>{
      "type": "speaker.verify",
      "token": token,
    }));
  }

  /// 发送一轮文本对话（纯语音模式：本地识别文本 → 语音回流）。
  /// 返回 false = 连接不可用/上一轮未完成，调用方应回落。
  Future<bool> sendTextTurn(String text) async {
    final WebSocketChannel? channel = _channel;
    if (channel == null || !isReady || _turnInFlight) return false;
    _turnInFlight = true;
    _playbackCompleter = null;
    channel.sink.add(jsonEncode(<String, dynamic>{
      "type": "text.turn",
      "text": text,
    }));
    return true;
  }

  /// 开启麦克风上行（16kHz PCM16 单声道流式 → audio.chunk）。
  /// 仅电话通话用；纯语音模式的麦克风归本地唤醒/声纹/识别，勿开。
  Future<bool> startMic() async {
    final WebSocketChannel? channel = _channel;
    if (channel == null || !isReady) return false;
    if (_micSub != null) return true;
    try {
      if (!await _recorder.hasPermission()) {
        debugPrint("[VoiceDuplex] mic permission denied");
        return false;
      }
      final Stream<Uint8List> stream = await _recorder.startStream(
        const RecordConfig(
          encoder: AudioEncoder.pcm16bits,
          sampleRate: 16000,
          numChannels: 1,
        ),
      );
      _micSub = stream.listen((Uint8List data) {
        // 门控：播报期间 / 上一轮未收尾时不送（回声防护第一层）
        if (_micGated || TtsPlayer.instance.isPlaying) return;
        final WebSocketChannel? ch = _channel;
        if (ch == null || !isReady) return;
        ch.sink.add(jsonEncode(<String, dynamic>{
          "type": "audio.chunk",
          "pcm": base64Encode(data),
        }));
      });
      // 若此刻恰有 TTS 在播（通话接通问候语等），门控到播完
      if (TtsPlayer.instance.isPlaying) {
        _setMicGated(true);
      }
      return true;
    } catch (e) {
      debugPrint("[VoiceDuplex] startMic failed: $e");
      return false;
    }
  }

  /// 停麦克风上行。
  Future<void> stopMic() async {
    await _micSub?.cancel();
    _micSub = null;
    _setMicGated(false);
    try {
      if (await _recorder.isRecording()) await _recorder.stop();
    } catch (_) {}
  }

  /// 等本轮回复音频播放完（tts.chunk 已播完；无音频轮立即返回）。
  Future<void> waitPlayback({Duration timeout = const Duration(seconds: 90)}) async {
    final Completer<void>? c = _playbackCompleter;
    if (c == null) return;
    await c.future.timeout(timeout, onTimeout: () {});
  }

  /// 收会话（服务端销毁 realtime 连接）并关闭 WS。
  Future<void> stop() async {
    final WebSocketChannel? channel = _channel;
    _channel = null;
    await stopMic();
    await _sub?.cancel();
    _sub = null;
    _readyCompleter = null;
    _playbackCompleter = null;
    _turnInFlight = false;
    if (channel != null) {
      try {
        channel.sink.add(jsonEncode(<String, dynamic>{"type": "session.stop"}));
      } catch (_) {}
      try {
        await channel.sink.close(1000);
      } catch (_) {}
    }
  }

  // ── 内部 ──

  void _setMicGated(bool gated) {
    if (_micGated == gated) return;
    _micGated = gated;
    if (gated) {
      // 播完自动解除门控（一次性）
      void onDone() {
        _setMicGated(false);
        TtsPlayer.instance.removeOnCompleted(onDone);
        _gatingCompletionListener = null;
      }

      _gatingCompletionListener = onDone;
      TtsPlayer.instance.addOnCompleted(onDone);
    } else {
      final VoidCallback? l = _gatingCompletionListener;
      if (l != null) {
        TtsPlayer.instance.removeOnCompleted(l);
        _gatingCompletionListener = null;
      }
    }
  }

  void _onMessage(dynamic data) {
    final Map<String, dynamic> evt;
    try {
      evt = jsonDecode(data.toString()) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    switch (evt["type"]?.toString()) {
      case "session.ready":
        engine = evt["engine"]?.toString();
        final bool ok = engine == "minimax-realtime";
        if (_readyCompleter?.isCompleted != true) {
          _readyCompleter?.complete(ok);
        }
      case "state":
        lastState = evt["state"]?.toString();
        onStateChanged?.call(lastState ?? "");
      case "tts.chunk":
        final String audio = evt["audio"]?.toString() ?? "";
        if (audio.isEmpty) break;
        final String format = evt["format"]?.toString() ?? "wav";
        // 半双工：播报即门控麦克风，播完恢复
        _setMicGated(true);
        final Completer<void> completer = Completer<void>();
        _playbackCompleter = completer;
        void onPlaybackDone() {
          if (!completer.isCompleted) completer.complete();
          TtsPlayer.instance.removeOnCompleted(onPlaybackDone);
          _setMicGated(false);
        }

        TtsPlayer.instance.addOnCompleted(onPlaybackDone);
        unawaited(
          TtsPlayer.instance.playFromBase64(audio, format: format).then((
            bool played,
          ) {
            if (!played) {
              // 播放失败也要解除门控，否则麦克风被永久关死
              onPlaybackDone();
            }
          }),
        );
      case "turn.completed":
        _turnInFlight = false;
        final String user = evt["userText"]?.toString() ?? "";
        final String assistant = evt["assistantText"]?.toString() ?? "";
        onTurnCompleted?.call(user, assistant);
      case "error":
        _turnInFlight = false;
        onError?.call(
          evt["message"]?.toString() ?? "语音链路未知错误",
          evt["recoverable"] == true,
        );
      case "session.ended":
        _onDisconnected();
      default:
        break;
    }
  }

  void _onDisconnected() {
    if (_channel == null) return; // 已主动 stop，忽略
    _channel = null;
    _readyCompleter?.complete(false);
    _readyCompleter = null;
    if (!(_playbackCompleter?.isCompleted ?? true)) {
      _playbackCompleter?.complete();
    }
    _playbackCompleter = null;
    _turnInFlight = false;
    onConnectionLost?.call();
  }
}
