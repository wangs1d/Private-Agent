import "dart:async";
import "dart:typed_data";

import "package:flutter/material.dart";
import "package:permission_handler/permission_handler.dart";
import "package:record/record.dart";

import "../../core/config/api_config.dart";
import "../../core/services/tts_player.dart";
import "../../core/services/voice_duplex_service.dart";

/// App 内「实时语音」会话页（全双工 duplex）。
///
/// 打通此前只存在于协议层的 [VoiceDuplexService]：
///  - 麦克风：record 包采集 16kHz/16bit/单声道 PCM（开回声消除 + 降噪），
///    约 100ms 一块经 `audio.chunk` 上行
///  - 回复：服务端 ASR → LLM → TTS，`tts.chunk`（mp3 base64）经 TtsPlayer 顺序播放
///  - 打断：speaking 态下用户再开口（服务端 VAD）或点「打断」时，
///    立即清空待播队列并停掉当前播放
///
/// 前置条件：服务端 voice-duplex 已装配（默认已接入 bootstrap）且
/// ASR/TTS 服务可用；不可用时 `error` 事件会展示在页内。
///
/// 注意：播放复用全局 [TtsPlayer] 单例 —— 与虚拟通话同时使用时会互相打断，
/// 属已知限制。
class VoiceDuplexSheet extends StatefulWidget {
  const VoiceDuplexSheet({super.key});

  /// 便捷入口：全屏打开会话页。
  static Future<void> show(BuildContext context) {
    return showDialog<void>(
      context: context,
      useRootNavigator: true,
      barrierDismissible: false,
      builder: (BuildContext ctx) => const Dialog.fullscreen(
        child: VoiceDuplexSheet(),
      ),
    );
  }

  @override
  State<VoiceDuplexSheet> createState() => _VoiceDuplexSheetState();
}

class _VoiceDuplexSheetState extends State<VoiceDuplexSheet> {
  VoiceDuplexService? _voice;
  AudioRecorder? _recorder;
  StreamSubscription<Uint8List>? _micSub;

  _SessionPhase _phase = _SessionPhase.connecting;
  String? _error;

  /// 转录完成的轮次（用户 / 助手交替）。
  final List<_VoiceTurn> _turns = <_VoiceTurn>[];
  String _userPartial = "";
  String _assistantPartial = "";
  final ScrollController _scrollController = ScrollController();

  /// tts.chunk 播放队列：串行消费，保证 mp3 分片按序播放。
  final List<String> _ttsQueue = <String>[];
  bool _playingTts = false;
  bool _closing = false;

  @override
  void initState() {
    super.initState();
    // 首帧 build 后再启动会话，避免初始化报错无处展示。
    WidgetsBinding.instance.addPostFrameCallback((_) => _startSession());
  }

  @override
  void dispose() {
    _closing = true;
    _micSub?.cancel();
    unawaited(_recorder?.stop());
    unawaited(_recorder?.dispose());
    unawaited(_voice?.stop());
    TtsPlayer.instance.stop();
    _scrollController.dispose();
    super.dispose();
  }

  // ------------------------------------------------------------------ //
  // 会话生命周期
  // ------------------------------------------------------------------ //

  /// duplex 专用 WS 地址：复用主 WS 的 host/port，路径替换为 /ws/voice-duplex。
  String get _duplexUrl {
    final Uri uri = Uri.parse(ApiConfig.wsUrl);
    return uri.replace(path: "/ws/voice-duplex").toString();
  }

  Future<void> _startSession() async {
    // 麦克风权限（桌面端通常直接放行，移动端走系统弹窗）。
    final PermissionStatus status = await Permission.microphone.request();
    if (status != PermissionStatus.granted) {
      if (mounted) {
        setState(() {
          _phase = _SessionPhase.error;
          _error = "未获得麦克风权限，无法进行语音对话";
        });
      }
      return;
    }

    final VoiceDuplexService voice = VoiceDuplexService(url: _duplexUrl);
    _voice = voice;
    voice.onEvent = _handleVoiceEvent;

    try {
      await voice.start(
        sampleRate: 16000,
        language: "zh",
        sessionId: ApiConfig.effectiveActorId,
      );
    } catch (e) {
      if (mounted) {
        setState(() {
          _phase = _SessionPhase.error;
          _error = "无法连接语音服务：$e";
        });
      }
      return;
    }

    await _startMic();
  }

  Future<void> _startMic() async {
    final AudioRecorder recorder = AudioRecorder();
    _recorder = recorder;
    try {
      // echoCancel/noiseSuppress：防止扬声器 TTS 被麦克风当成人声触发打断。
      final Stream<Uint8List> stream = await recorder.startStream(
        const RecordConfig(
          encoder: AudioEncoder.pcm16bits,
          sampleRate: 16000,
          numChannels: 1,
          echoCancel: true,
          noiseSuppress: true,
        ),
      );
      _micSub = stream.listen(
        (Uint8List chunk) => _voice?.sendAudioChunk(chunk),
        onError: (Object e) {
          if (mounted) {
            setState(() {
              _phase = _SessionPhase.error;
              _error = "麦克风采集异常：$e";
            });
          }
        },
      );
    } catch (e) {
      if (mounted) {
        setState(() {
          _phase = _SessionPhase.error;
          _error = "无法启动麦克风：$e";
        });
      }
    }
  }

  Future<void> _close() async {
    if (_closing) return;
    _closing = true;
    _ttsQueue.clear();
    await _micSub?.cancel();
    _micSub = null;
    unawaited(_recorder?.stop());
    unawaited(_recorder?.dispose());
    _recorder = null;
    TtsPlayer.instance.stop();
    await _voice?.stop();
    _voice = null;
    if (mounted && Navigator.of(context).canPop()) {
      Navigator.of(context).pop();
    }
  }

  void _interrupt() {
    _ttsQueue.clear();
    TtsPlayer.instance.stop();
    _voice?.interrupt();
  }

  /// 手动宣告一句话结束（服务端 VAD 漏判时的兜底）。
  void _manualEndUtterance() {
    unawaited(_voice?.endAudio());
  }

  // ------------------------------------------------------------------ //
  // 服务端事件
  // ------------------------------------------------------------------ //

  void _handleVoiceEvent(Map<String, dynamic> event) {
    if (_closing) return;
    switch (event["type"]) {
      case "session.ready":
        if (mounted) setState(() => _phase = _SessionPhase.listening);
        break;
      case "state":
        final DuplexVoiceState s = DuplexVoiceState.values.firstWhere(
          (DuplexVoiceState e) => e.wireName == event["state"],
          orElse: () => DuplexVoiceState.idle,
        );
        if (!mounted) return;
        setState(() {
          switch (s) {
            case DuplexVoiceState.listening:
              _phase = _SessionPhase.listening;
            case DuplexVoiceState.thinking:
              _phase = _SessionPhase.thinking;
            case DuplexVoiceState.speaking:
              _phase = _SessionPhase.speaking;
            case DuplexVoiceState.idle:
              break;
          }
        });
        // speaking → listening：说明发生了打断/新轮次，清空待播分片。
        if (s == DuplexVoiceState.listening && _ttsQueue.isNotEmpty) {
          _ttsQueue.clear();
          TtsPlayer.instance.stop();
        }
        break;
      case "asr.partial":
        if (!mounted) return;
        setState(() => _userPartial = event["text"]?.toString() ?? "");
        break;
      case "asr.final":
        final String text = event["text"]?.toString() ?? "";
        if (!mounted) return;
        setState(() {
          if (text.isNotEmpty) {
            _turns.add(_VoiceTurn(role: "user", text: text));
          }
          _userPartial = "";
          _assistantPartial = "";
        });
        _scrollToBottom();
        break;
      case "assistant.delta":
        if (!mounted) return;
        setState(() => _assistantPartial += event["text"]?.toString() ?? "");
        break;
      case "tts.chunk":
        final String audio = event["audio"]?.toString() ??
            event["mp3"]?.toString() ??
            event["data"]?.toString() ??
            "";
        if (audio.isNotEmpty) {
          _ttsQueue.add(audio);
          _drainTtsQueue();
        }
        break;
      case "turn.completed":
      case "tts.end":
        if (_assistantPartial.isNotEmpty && mounted) {
          setState(() {
            _turns.add(_VoiceTurn(role: "assistant", text: _assistantPartial));
            _assistantPartial = "";
          });
          _scrollToBottom();
        }
        break;
      case "error":
        if (!mounted) return;
        setState(() {
          _error = event["message"]?.toString() ?? "语音服务错误";
          _phase = _SessionPhase.error;
        });
        break;
      case "session.ended":
        if (mounted) _close();
        break;
      default:
        break;
    }
  }

  /// 串行播放 TTS 分片：同一时间只 await 一个 playFromBase64。
  Future<void> _drainTtsQueue() async {
    if (_playingTts) return;
    _playingTts = true;
    try {
      while (_ttsQueue.isNotEmpty && !_closing) {
        final String chunk = _ttsQueue.removeAt(0);
        await TtsPlayer.instance.playFromBase64(chunk);
      }
    } finally {
      _playingTts = false;
    }
  }

  void _scrollToBottom() {
    if (!_scrollController.hasClients) return;
    unawaited(Future<void>.delayed(const Duration(milliseconds: 50), () {
      if (_scrollController.hasClients) {
        _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
      }
    }));
  }

  // ------------------------------------------------------------------ //
  // UI
  // ------------------------------------------------------------------ //

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Scaffold(
      backgroundColor: cs.surface,
      body: SafeArea(
        child: Column(
          children: <Widget>[
            // 顶栏：标题 + 关闭
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 4, 8, 0),
              child: Row(
                children: <Widget>[
                  IconButton(
                    icon: const Icon(Icons.close),
                    tooltip: "结束语音会话",
                    onPressed: _close,
                  ),
                  const SizedBox(width: 4),
                  Text("实时语音", style: Theme.of(context).textTheme.titleMedium),
                  const Spacer(),
                  if (_phase == _SessionPhase.speaking)
                    TextButton.icon(
                      onPressed: _interrupt,
                      icon: const Icon(Icons.front_hand, size: 16),
                      label: const Text("打断"),
                    ),
                ],
              ),
            ),
            // 转录流
            Expanded(
              child: _turns.isEmpty &&
                      _userPartial.isEmpty &&
                      _assistantPartial.isEmpty
                  ? _buildHint(cs)
                  : ListView.builder(
                      controller: _scrollController,
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      itemCount: _turns.length + 2,
                      itemBuilder: (BuildContext context, int index) {
                        if (index < _turns.length) {
                          return _TurnBubble(turn: _turns[index]);
                        }
                        if (index == _turns.length &&
                            _userPartial.isNotEmpty) {
                          return _TurnBubble(
                            turn: _VoiceTurn(role: "user", text: _userPartial),
                            pending: true,
                          );
                        }
                        if (_assistantPartial.isNotEmpty) {
                          return _TurnBubble(
                            turn: _VoiceTurn(
                              role: "assistant",
                              text: _assistantPartial,
                            ),
                            pending: true,
                          );
                        }
                        return const SizedBox.shrink();
                      },
                    ),
            ),
            // 底部：状态灯 + 大按钮
            _buildBottomBar(cs),
          ],
        ),
      ),
    );
  }

  Widget _buildHint(ColorScheme cs) {
    final String hint = switch (_phase) {
      _SessionPhase.connecting => "正在连接语音服务…",
      _SessionPhase.listening => "我在听，请说 —",
      _SessionPhase.thinking => "让我想一想…",
      _SessionPhase.speaking => "我在说，随时可以打断",
      _SessionPhase.error => _error ?? "语音服务不可用",
    };
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(
            Icons.graphic_eq,
            size: 40,
            color: cs.primary.withValues(alpha: 0.6),
          ),
          const SizedBox(height: 12),
          Text(hint, style: TextStyle(color: cs.onSurfaceVariant)),
          if (_phase == _SessionPhase.error) ...<Widget>[
            const SizedBox(height: 8),
            Text(
              "检查服务端 voice-duplex 与 ASR/TTS 配置",
              style: TextStyle(
                  color: cs.onSurfaceVariant.withValues(alpha: 0.7),
                  fontSize: 12),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildBottomBar(ColorScheme cs) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(0, 8, 0, 24),
      child: Column(
        children: <Widget>[
          _VoiceOrb(phase: _phase),
          const SizedBox(height: 12),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              if (_phase == _SessionPhase.listening)
                OutlinedButton.icon(
                  onPressed: _manualEndUtterance,
                  icon: const Icon(Icons.check, size: 16),
                  label: const Text("说完了"),
                )
              else
                Text(
                  _phaseLabel,
                  style: TextStyle(color: cs.onSurfaceVariant, fontSize: 13),
                ),
            ],
          ),
        ],
      ),
    );
  }

  String get _phaseLabel => switch (_phase) {
        _SessionPhase.connecting => "连接中",
        _SessionPhase.listening => "聆听中",
        _SessionPhase.thinking => "思考中",
        _SessionPhase.speaking => "播报中",
        _SessionPhase.error => "已中断",
      };
}

/// 会话阶段（UI 状态机，与服务端 DuplexVoiceState 对齐后映射到这里）。
enum _SessionPhase { connecting, listening, thinking, speaking, error }

class _VoiceTurn {
  const _VoiceTurn({required this.role, required this.text});

  final String role;
  final String text;
}

/// 转录气泡：用户右对齐主色底，助手左对齐 surface 底。
class _TurnBubble extends StatelessWidget {
  const _TurnBubble({required this.turn, this.pending = false});

  final _VoiceTurn turn;
  final bool pending;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final bool isUser = turn.role == "user";
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * 0.72,
        ),
        decoration: BoxDecoration(
          color: isUser ? cs.primaryContainer : cs.surfaceContainerHigh,
          borderRadius: BorderRadius.circular(14),
        ),
        child: Text(
          turn.text,
          style: TextStyle(
            color: isUser ? cs.onPrimaryContainer : cs.onSurface,
            fontSize: 14.5,
            height: 1.4,
            fontStyle: pending ? FontStyle.italic : FontStyle.normal,
          ),
        ),
      ),
    );
  }
}

/// 中央状态球：聆听呼吸动画 / 思考收缩 / 播报扩散。
class _VoiceOrb extends StatefulWidget {
  const _VoiceOrb({required this.phase});

  final _SessionPhase phase;

  @override
  State<_VoiceOrb> createState() => _VoiceOrbState();
}

class _VoiceOrbState extends State<_VoiceOrb>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final Color color = switch (widget.phase) {
      _SessionPhase.listening => cs.primary,
      _SessionPhase.thinking => cs.tertiary,
      _SessionPhase.speaking => cs.secondary,
      _SessionPhase.error => cs.error,
      _ => cs.outline,
    };
    final bool animate = widget.phase != _SessionPhase.error &&
        widget.phase != _SessionPhase.connecting;

    return ScaleTransition(
      scale: animate
          ? Tween<double>(begin: 0.92, end: 1.08).animate(
              CurvedAnimation(parent: _controller, curve: Curves.easeInOut),
            )
          : const AlwaysStoppedAnimation<double>(0.92),
      child: Container(
        width: 84,
        height: 84,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: color.withValues(alpha: 0.16),
          border: Border.all(color: color, width: 2),
        ),
        child: Icon(
          switch (widget.phase) {
            _SessionPhase.listening => Icons.mic,
            _SessionPhase.thinking => Icons.psychology,
            _SessionPhase.speaking => Icons.volume_up,
            _SessionPhase.error => Icons.mic_off,
            _ => Icons.hourglass_top,
          },
          size: 34,
          color: color,
        ),
      ),
    );
  }
}
