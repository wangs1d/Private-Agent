// 纯语音对话模式 —— 悬浮球
//
// 设计目标：
//   - 屏幕一角悬浮一个圆球（最小化态，约 48px）
//   - 点击球体 → 展开为长胶囊条（280×56），左侧球体 + 中间字幕 + 右侧声波
//   - 球体与声波随 5 状态机（idle / listening / recognizing / thinking / speaking）变色
//   - 单工模式：点球体开始录音，再点结束触发一轮对话
//   - 声纹默认关闭，可点击右上角菜单切换
//
// 依赖：
//   - POST /brain/sensory/listen   音频 → 文本（ASR）
//   - POST /brain/sensory/speak    文本 → 音频（TTS）
//   - WS  chat.user_message / chat.assistant_chunk / chat.assistant_done
//
// 集成方式：作为 widget 直接放在主区 Stack 中（与 FloatingAgentSphere 同层）。

import "dart:async";
import "dart:convert";
import "dart:io";
import "dart:typed_data";
import "dart:math" as math;

import "package:flutter/material.dart";
import "package:http/http.dart" as http;
import "package:permission_handler/permission_handler.dart";
import "package:record/record.dart";

import "../../core/config/api_config.dart";
import "../../core/services/tts_player.dart";
import "../../core/services/ws_chat_service.dart";
import "../../core/utils/agent_result_parser.dart";
import "../../core/utils/assistant_text_sanitizer.dart";

/// 语音对话状态机
enum VoiceOrbPhase {
  idle,
  listening,
  recognizing,
  thinking,
  speaking,
}

/// 一条对话历史（最近 N 轮滚动显示）
class _OrbTurn {
  _OrbTurn({required this.isUser, required this.text});
  final bool isUser;
  final String text;
}

class VoiceOrb extends StatefulWidget {
  const VoiceOrb({
    super.key,
    required this.ws,
    this.size = 48.0,
    this.expandedWidth = 280.0,
    this.expandedHeight = 56.0,
    this.initialPosition,
  });

  /// WebSocket 服务（与主聊天页共享）
  final WsChatService ws;

  /// 最小化态直径
  final double size;

  /// 展开态宽
  final double expandedWidth;

  /// 展开态高
  final double expandedHeight;

  /// 初始位置（null = 屏幕右下默认）
  final Offset? initialPosition;

  @override
  State<VoiceOrb> createState() => VoiceOrbState();
}

/// 对外暴露的 State 类型，外部通过 `GlobalKey<VoiceOrbState>` 调用入口方法。
class VoiceOrbState extends State<VoiceOrb>
    with TickerProviderStateMixin {
  // ---- 动画 ----
  late final AnimationController _breathController;
  late final Animation<double> _pulseAnim;
  late final AnimationController _waveController;

  // ---- 录音 ----
  final AudioRecorder _recorder = AudioRecorder();
  bool _recording = false;
  String? _recordingPath;

  // ---- 状态 ----
  bool _expanded = false;
  VoiceOrbPhase _phase = VoiceOrbPhase.idle;
  String _subtitle = ""; // 字幕文本
  final List<_OrbTurn> _turns = <_OrbTurn>[];

  // ---- 位置（最小化态时）----
  Offset? _position;
  static const Duration _expandAnimDuration = Duration(milliseconds: 220);

  // ---- WS 监听 ----
  StreamSubscription<Map<String, dynamic>>? _wsSub;
  String? _activeTraceId;
  final StringBuffer _assistantBuffer = StringBuffer();
  final AssistantTextSanitizer _assistantTextSanitizer =
      AssistantTextSanitizer();

  // ---- 设置 ----
  bool _voiceprintRequired = false;

  // ---- 一次性提示动画：让用户首次见到悬浮球时能注意到 ----
  bool _introPlayed = false;
  late final AnimationController _introController;

  @override
  void initState() {
    super.initState();

    _breathController = AnimationController(
      duration: const Duration(milliseconds: 2200),
      vsync: this,
    )..repeat(reverse: true);
    _pulseAnim = Tween<double>(begin: 0.85, end: 1.15).animate(
      CurvedAnimation(parent: _breathController, curve: Curves.easeInOut),
    );
    _waveController = AnimationController(
      duration: const Duration(milliseconds: 900),
      vsync: this,
    );
    _introController = AnimationController(
      duration: const Duration(milliseconds: 1400),
      vsync: this,
    );

    _wsSub = widget.ws.events.listen(_onWsEvent);
    TtsPlayer.instance.addOnCompleted(_onTtsCompleted);

    // 首次挂载：先 ping 一下提示用户悬浮球在这里，1.2s 后自行结束
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted || _introPlayed) return;
      _introPlayed = true;
      _introController.forward(from: 0).whenComplete(() {
        if (mounted) _introController.stop();
      });
    });
  }

  @override
  void dispose() {
    _wsSub?.cancel();
    TtsPlayer.instance.removeOnCompleted(_onTtsCompleted);
    _breathController.dispose();
    _waveController.dispose();
    _introController.dispose();
    if (_recording) {
      _recorder.stop().catchError((_) => null);
    }
    _recorder.dispose().catchError((_) {});
    super.dispose();
  }

  /// 外部入口：召唤悬浮球并立即开始录音
  ///
  /// - 若已展开且正在 listening/recognizing/thinking/speaking：忽略
  /// - 若已展开但 idle：直接开始录音
  /// - 若处于最小化态：先展开，再开始录音
  /// - 若连接/权限/启动失败：保留展开态，由字幕显示具体原因
  Future<void> wakeUpAndListen() async {
    if (!mounted) return;
    if (_phase != VoiceOrbPhase.idle) return;
    if (!_expanded) {
      setState(() => _expanded = true);
      // 等展开动画落地，避免动画期间调用 start 抖动
      await Future<void>.delayed(_expandAnimDuration);
      if (!mounted) return;
    }
    await _startRecording();
  }

  // ============================================================
  // WS 事件
  // ============================================================

  void _onWsEvent(Map<String, dynamic> event) {
    final String type = event["type"]?.toString() ?? "";
    final Map<String, dynamic> payload =
        (event["payload"] as Map<String, dynamic>?) ?? <String, dynamic>{};
    switch (type) {
      case "chat.turn_started":
        _onTurnStarted(payload);
        break;
      case "chat.assistant_chunk":
        _onAssistantChunk(payload);
        break;
      case "chat.assistant_done":
        _onAssistantDone(payload);
        break;
    }
  }

  void _onTurnStarted(Map<String, dynamic> payload) {
    final String? traceId = payload["traceId"]?.toString();
    if (traceId == null ||
        traceId.isEmpty ||
        _activeTraceId == null ||
        traceId != _activeTraceId) {
      return;
    }
    if (!mounted) return;
    setState(() {
      _phase = VoiceOrbPhase.thinking;
      _subtitle = "正在思考…";
    });
  }

  void _onAssistantChunk(Map<String, dynamic> payload) {
    if (_activeTraceId == null) return;
    final String? traceId = payload["traceId"]?.toString();
    final String? msgId = payload["messageId"]?.toString();
    final bool traceMatch = traceId != null &&
        traceId.isNotEmpty &&
        traceId == _activeTraceId;
    final bool msgMatch = msgId != null &&
        msgId.isNotEmpty &&
        msgId.endsWith(_activeTraceId!);
    if (!traceMatch && !msgMatch) return;
    if (payload["phase"]?.toString() == "interim") return;

    final String rawChunk = payload["chunk"]?.toString() ?? "";
    if (rawChunk.isEmpty) return;
    final String chunk = _assistantTextSanitizer.ingest(rawChunk);
    if (chunk.isEmpty) return;
    _assistantBuffer.write(chunk);
    if (!mounted) return;
    setState(() {
      _subtitle = _assistantBuffer.toString();
      if (_phase != VoiceOrbPhase.thinking) {
        _phase = VoiceOrbPhase.thinking;
      }
    });
  }

  Future<void> _onAssistantDone(Map<String, dynamic> payload) async {
    if (_activeTraceId == null) return;
    final String? doneTraceId = payload["traceId"]?.toString();
    if (doneTraceId != null &&
        doneTraceId.isNotEmpty &&
        doneTraceId != _activeTraceId) {
      return;
    }
    String text =
        stripAssistantTimestampFrames(payload["finalText"]?.toString() ?? "");
    if (text.isEmpty) {
      final String buffered = _assistantBuffer.toString().trim();
      final String pending = _assistantTextSanitizer.drainPending().trim();
      text = pending.isEmpty ? buffered : "$buffered$pending";
    }
    _assistantBuffer.clear();
    _assistantTextSanitizer.reset();
    _activeTraceId = null;
    if (text.isEmpty) {
      if (!mounted) return;
      _resetToIdle("暂无回复");
      return;
    }
    // 语音播报取舍：卡片块的 speak=high 时优先朗读「结论」(title+footer)，
    // 否则剥离卡片块只读正文，避免把卡片 JSON 原文读出来。
    final String speakText = _resolveSpeakText(text);
    if (speakText.isEmpty) {
      if (!mounted) return;
      _resetToIdle("暂无回复");
      return;
    }
    if (!mounted) return;
    setState(() {
      _turns.add(_OrbTurn(isUser: false, text: speakText));
      _subtitle = speakText;
      _phase = VoiceOrbPhase.speaking;
    });
    await _synthesizeAndPlay(speakText);
  }

  /// 根据卡片 speak 优先级决定朗读文本与字幕文本。
  ///
  /// - 含结果卡片：剥离 `AGENT_RESULT_CARD_*` 标记，绝不朗读原始 JSON；
  ///   - `speak=high` → 优先朗读「结论」= title + footer（追问/结论句）；
  ///   - 其余 → 朗读剥离卡片后的正文字。
  /// - 无卡片：原样返回清洗后的文本。
  String _resolveSpeakText(String raw) {
    final String stripped = stripAssistantTimestampFrames(raw).trim();
    if (stripped.isEmpty) return "";
    final AgentResultParseResult parsed = AgentResultParser.parse(stripped);
    final AgentResultData? data = parsed.data;
    if (data == null) return stripped;

    final String body = parsed.cleanedText.trim();
    final String conclusion = <String>[
      if (data.title.trim().isNotEmpty) data.title.trim(),
      if (data.footer.trim().isNotEmpty) data.footer.trim(),
    ].join("。");
    if (data.speak == "high" && conclusion.isNotEmpty) {
      return conclusion;
    }
    return body.isEmpty ? conclusion : body;
  }

  // ============================================================
  // TTS
  // ============================================================

  Future<void> _synthesizeAndPlay(String text) async {
    try {
      final http.Response r = await http.post(
        Uri.parse("${ApiConfig.httpBase}/brain/sensory/speak"),
        headers: <String, String>{"Content-Type": "application/json"},
        body: jsonEncode(<String, dynamic>{
          "text": text,
          "channel": "ws",
        }),
      );
      if (r.statusCode != 200 || !mounted) {
        if (!mounted) return;
        _resetToIdle("合成失败");
        return;
      }
      final Map<String, dynamic> body =
          jsonDecode(r.body) as Map<String, dynamic>;
      if (body["ok"] != true) {
        if (!mounted) return;
        _resetToIdle("合成失败");
        return;
      }
      final Map<String, dynamic> result =
          (body["result"] as Map<String, dynamic>?) ?? <String, dynamic>{};
      final Map<String, dynamic>? audio =
          result["audio"] as Map<String, dynamic>?;
      final String? base64 = _extractBase64FromAudioData(audio?["data"]);
      if (base64 == null || base64.isEmpty) {
        if (!mounted) return;
        _resetToIdle("无语音数据");
        return;
      }
      final bool ok = await TtsPlayer.instance.playFromBase64(base64);
      if (!ok && mounted) _resetToIdle("播放失败");
    } catch (_) {
      if (!mounted) return;
      _resetToIdle("合成异常");
    }
  }

  String? _extractBase64FromAudioData(dynamic data) {
    if (data == null) return null;
    if (data is String) return data;
    if (data is Map) {
      final List? arr = data["data"] as List?;
      if (arr != null) {
        return base64Encode(Uint8List.fromList(
            arr.map((e) => (e as num).toInt()).toList()));
      }
    }
    if (data is List) {
      return base64Encode(Uint8List.fromList(
          data.map((e) => (e as num).toInt()).toList()));
    }
    return null;
  }

  void _onTtsCompleted() {
    if (!mounted) return;
    _resetToIdle("");
  }

  // ============================================================
  // 录音 + ASR + 发送
  // ============================================================

  Future<void> _startRecording() async {
    if (!widget.ws.isConnected) {
      widget.ws.retryConnect();
      if (!mounted) return;
      setState(() => _subtitle = "正在连接服务器…");
      return;
    }
    final PermissionStatus status = await Permission.microphone.request();
    if (!status.isGranted) {
      if (!mounted) return;
      setState(() => _subtitle = "需要麦克风权限");
      return;
    }
    if (!await _recorder.hasPermission()) {
      if (!mounted) return;
      setState(() => _subtitle = "录音权限被拒绝");
      return;
    }
    final Directory tempDir = await Directory.systemTemp.createTemp("voice_orb");
    _recordingPath =
        "${tempDir.path}/voice_${DateTime.now().microsecondsSinceEpoch}.wav";
    try {
      await _recorder.start(
        const RecordConfig(
          encoder: AudioEncoder.wav,
          sampleRate: 16000,
          numChannels: 1,
          autoGain: true,
          echoCancel: true,
          noiseSuppress: true,
        ),
        path: _recordingPath!,
      );
      _recording = true;
      if (!mounted) return;
      setState(() {
        _phase = VoiceOrbPhase.listening;
        _subtitle = "正在聆听…点球结束";
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _subtitle = "录音启动失败");
    }
  }

  Future<void> _stopRecordingAndRecognize() async {
    if (!_recording) return;
    String? path;
    try {
      path = await _recorder.stop();
    } catch (_) {
      path = _recordingPath;
    }
    _recording = false;
    path ??= _recordingPath;
    if (path == null || path.isEmpty) {
      if (!mounted) return;
      _resetToIdle("录音失败");
      return;
    }
    if (!mounted) return;
    setState(() {
      _phase = VoiceOrbPhase.recognizing;
      _subtitle = "正在识别…";
    });
    try {
      final File audioFile = File(path);
      final Uint8List bytes = await audioFile.readAsBytes();
      final String b64 = base64Encode(bytes);
      final http.Response r = await http.post(
        Uri.parse("${ApiConfig.httpBase}/brain/sensory/listen"),
        headers: <String, String>{"Content-Type": "application/json"},
        body: jsonEncode(<String, dynamic>{
          "audio": <String, dynamic>{
            "data": b64,
            "format": "wav",
            "sampleRate": 16000,
            "channels": 1,
          },
          "language": "zh",
        }),
      );
      try {
        await audioFile.delete();
      } catch (_) {}
      if (r.statusCode != 200) {
        if (!mounted) return;
        _resetToIdle("识别服务异常");
        return;
      }
      final Map<String, dynamic> body =
          jsonDecode(r.body) as Map<String, dynamic>;
      if (body["ok"] != true) {
        if (!mounted) return;
        _resetToIdle("识别失败");
        return;
      }
      final String text = ((body["result"] as Map<String, dynamic>?)?["text"]
                  ?.toString() ??
              "")
          .trim();
      if (text.isEmpty) {
        if (!mounted) return;
        _resetToIdle("没听清，请再说一次");
        return;
      }
      if (!mounted) return;
      setState(() {
        _turns.add(_OrbTurn(isUser: true, text: text));
        _subtitle = text;
        _phase = VoiceOrbPhase.thinking;
      });
      _sendUserMessage(text);
    } catch (_) {
      if (!mounted) return;
      _resetToIdle("识别异常");
    }
  }

  void _sendUserMessage(String text) {
    if (!widget.ws.isConnected) {
      widget.ws.retryConnect();
      if (!mounted) return;
      _resetToIdle("连接断开");
      return;
    }
    final String messageId = "voice-${DateTime.now().microsecondsSinceEpoch}";
    _activeTraceId = messageId;
    _assistantBuffer.clear();
    _assistantTextSanitizer.reset();
    final Map<String, dynamic> userMsg = <String, dynamic>{
      "sessionId": ApiConfig.sessionId,
      "messageId": messageId,
      "text": text,
      "timestamp": DateTime.now().toIso8601String(),
    };
    if (ApiConfig.userId.trim().isNotEmpty) {
      userMsg["userId"] = ApiConfig.userId.trim();
    }
    userMsg["agentAccessMode"] = "full";
    final bool sent = widget.ws.sendEvent("chat.user_message", userMsg);
    if (!sent) {
      _activeTraceId = null;
      if (!mounted) return;
      _resetToIdle("未发送");
    }
  }

  // ============================================================
  // 状态重置
  // ============================================================

  void _resetToIdle(String lastStatus) {
    if (!mounted) return;
    setState(() {
      _phase = VoiceOrbPhase.idle;
      _subtitle = lastStatus;
    });
    Future<void>.delayed(const Duration(milliseconds: 1800), () {
      if (!mounted || _phase != VoiceOrbPhase.idle) return;
      setState(() => _subtitle = "");
    });
  }

  // ============================================================
  // 颜色 / 状态
  // ============================================================

  Color _phaseColor() {
    switch (_phase) {
      case VoiceOrbPhase.idle:
        return const Color(0xFF3B82F6); // 蓝
      case VoiceOrbPhase.listening:
        return const Color(0xFF60A5FA); // 亮蓝
      case VoiceOrbPhase.recognizing:
        return const Color(0xFF22D3EE); // 青
      case VoiceOrbPhase.thinking:
        return const Color(0xFFA78BFA); // 紫
      case VoiceOrbPhase.speaking:
        return const Color(0xFF34D399); // 绿
    }
  }

  bool get _waveActive =>
      _phase == VoiceOrbPhase.speaking ||
      _phase == VoiceOrbPhase.listening;

  // ============================================================
  // 位置
  // ============================================================

  void _ensureInitialPosition(Size screen) {
    _position ??= widget.initialPosition ??
        Offset(
          screen.width - widget.size - 24,
          screen.height - widget.size - 32,
        );
  }

  // ============================================================
  // Build
  // ============================================================

  @override
  Widget build(BuildContext context) {
    final Size screen = MediaQuery.sizeOf(context);
    _ensureInitialPosition(screen);

    return Positioned(
      left: _position!.dx,
      top: _position!.dy,
      child: GestureDetector(
        onTap: _onOrbTap,
        onPanUpdate: !_expanded ? _onDrag : null,
        child: AnimatedContainer(
          duration: _expandAnimDuration,
          curve: Curves.easeOutCubic,
          width: _expanded ? widget.expandedWidth : widget.size,
          height: _expanded ? widget.expandedHeight : widget.size,
          decoration: BoxDecoration(
            color: const Color(0xFF1F2937),
            borderRadius: BorderRadius.circular(
              _expanded ? widget.expandedHeight / 2 : widget.size / 2,
            ),
            boxShadow: <BoxShadow>[
              BoxShadow(
                color: Colors.black.withValues(alpha: 0.5),
                blurRadius: 20,
                offset: const Offset(0, 8),
              ),
              BoxShadow(
                color: _phaseColor().withValues(alpha: 0.35),
                blurRadius: 24,
                spreadRadius: 1,
              ),
            ],
            border: Border.all(
              color: _phaseColor().withValues(alpha: 0.45),
              width: 1,
            ),
          ),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(
              _expanded ? widget.expandedHeight / 2 : widget.size / 2,
            ),
            child: _expanded ? _buildExpanded() : _buildMinimized(),
          ),
        ),
      ),
    );
  }

  void _onOrbTap() {
    if (_expanded) {
      // 展开态：单工模式，点球体开始/结束录音
      if (_phase == VoiceOrbPhase.idle) {
        _startRecording();
      } else if (_phase == VoiceOrbPhase.listening) {
        _stopRecordingAndRecognize();
      }
      // 其他阶段（recognizing / thinking / speaking）忽略
    } else {
      // 最小化态：点击展开
      setState(() => _expanded = true);
      if (_phase == VoiceOrbPhase.speaking) {
        _waveController.repeat();
      }
    }
  }

  void _onDrag(DragUpdateDetails details) {
    if (_expanded) return;
    final Size screen = MediaQuery.sizeOf(context);
    final double maxX = screen.width - widget.size;
    final double maxY = screen.height - widget.size;
    setState(() {
      _position = Offset(
        (_position!.dx + details.delta.dx).clamp(0, maxX),
        (_position!.dy + details.delta.dy).clamp(0, maxY),
      );
    });
  }

  // ---- 最小化态 ----
  Widget _buildMinimized() {
    final Color c = _phaseColor();
    return Stack(
      alignment: Alignment.center,
      children: <Widget>[
        // 一次性提示：外扩涟漪 ring —— 让用户首次见到悬浮球时能注意到
        IgnorePointer(
          child: AnimatedBuilder(
            animation: _introController,
            builder: (BuildContext context, Widget? child) {
              final double t = _introController.value;
              if (t == 0) return const SizedBox.shrink();
              final double size = widget.size + t * widget.size * 2.4;
              return Container(
                width: size,
                height: size,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(
                    color: c.withValues(alpha: (1 - t) * 0.9),
                    width: 2.4 * (1 - t) + 0.6,
                  ),
                ),
              );
            },
          ),
        ),
        // 外圈光晕（呼吸）
        AnimatedBuilder(
          animation: _breathController,
          builder: (BuildContext context, Widget? child) {
            final double scale = _phase == VoiceOrbPhase.idle
                ? 1.0
                : _pulseAnim.value;
            final double opacity = _phase == VoiceOrbPhase.idle ? 0.0 : 0.6;
            return Container(
              width: widget.size * scale,
              height: widget.size * scale,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: RadialGradient(
                  colors: <Color>[
                    c.withValues(alpha: opacity),
                    c.withValues(alpha: 0.0),
                  ],
                ),
              ),
            );
          },
        ),
        // 主体圆
        Container(
          width: widget.size * 0.78,
          height: widget.size * 0.78,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            gradient: RadialGradient(
              colors: <Color>[
                c,
                c.withValues(alpha: 0.7),
              ],
            ),
            boxShadow: <BoxShadow>[
              BoxShadow(
                color: c.withValues(alpha: 0.6),
                blurRadius: 12,
                spreadRadius: 1,
              ),
            ],
          ),
        ),
        // 中心点（雷达纹样）
        Container(
          width: 6,
          height: 6,
          decoration: const BoxDecoration(
            shape: BoxShape.circle,
            color: Colors.white,
          ),
        ),
        Container(
          width: 18,
          height: 18,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(
              color: Colors.white.withValues(alpha: 0.7),
              width: 1.2,
            ),
          ),
        ),
      ],
    );
  }

  // ---- 展开态 ----
  Widget _buildExpanded() {
    final Color c = _phaseColor();
    return Row(
      children: <Widget>[
        // 左侧小圆球
        SizedBox(
          width: widget.size,
          height: widget.expandedHeight,
          child: _buildMinimized(),
        ),
        const SizedBox(width: 8),
        // 中间字幕
        Expanded(
          child: _buildSubtitle(),
        ),
        const SizedBox(width: 8),
        // 右侧声波 + 菜单
        SizedBox(
          width: 56,
          height: widget.expandedHeight,
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              _buildWaveBars(c),
              const SizedBox(width: 6),
              _buildMenuButton(),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildSubtitle() {
    final String display = _subtitle.isEmpty
        ? (_phase == VoiceOrbPhase.idle ? "点击球体开始对话" : "…")
        : _subtitle;
    return Center(
      child: Text(
        display,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        textAlign: TextAlign.left,
        style: TextStyle(
          color: Colors.white.withValues(alpha: 0.92),
          fontSize: 14,
          fontWeight: FontWeight.w500,
          height: 1.2,
        ),
      ),
    );
  }

  Widget _buildWaveBars(Color c) {
    return AnimatedBuilder(
      animation: _waveController,
      builder: (BuildContext context, Widget? child) {
        if (_waveActive && !_waveController.isAnimating) {
          _waveController.repeat();
        } else if (!_waveActive && _waveController.isAnimating) {
          _waveController.stop();
        }
        return Row(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: <Widget>[
            _bar(0, c),
            _bar(1, c),
            _bar(2, c),
            _bar(3, c),
          ],
        );
      },
    );
  }

  Widget _bar(int i, Color c) {
    final double t = (_waveController.value + i * 0.13) % 1.0;
    final double h = _waveActive
        ? 6 + 10 * (0.5 + 0.5 * math.sin(t * math.pi * 2))
        : 10.0;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 1.5),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 80),
        width: 2.5,
        height: h,
        decoration: BoxDecoration(
          color: c.withValues(alpha: _waveActive ? 0.95 : 0.45),
          borderRadius: BorderRadius.circular(1.5),
        ),
      ),
    );
  }

  Widget _buildMenuButton() {
    return PopupMenuButton<String>(
      icon: Icon(Icons.more_horiz,
          color: Colors.white.withValues(alpha: 0.7), size: 18),
      padding: EdgeInsets.zero,
      tooltip: "语音模式设置",
      onSelected: (String value) {
        if (value == "voiceprint") {
          setState(() => _voiceprintRequired = !_voiceprintRequired);
        } else if (value == "collapse") {
          setState(() => _expanded = false);
        }
      },
      itemBuilder: (BuildContext context) => <PopupMenuEntry<String>>[
        PopupMenuItem<String>(
          value: "voiceprint",
          child: Row(
            children: <Widget>[
              Icon(
                _voiceprintRequired
                    ? Icons.check_box
                    : Icons.check_box_outline_blank,
                size: 18,
              ),
              const SizedBox(width: 8),
              const Text("声纹验证"),
            ],
          ),
        ),
        const PopupMenuItem<String>(
          value: "collapse",
          child: Row(
            children: <Widget>[
              Icon(Icons.unfold_less, size: 18),
              SizedBox(width: 8),
              Text("收起为小球"),
            ],
          ),
        ),
      ],
    );
  }
}
