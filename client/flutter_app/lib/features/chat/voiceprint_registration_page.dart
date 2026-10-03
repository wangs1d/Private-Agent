import "dart:async";
import "dart:typed_data";

import "package:flutter/material.dart";

import "../../core/services/mic_clip_recorder.dart";
import "../../core/services/model_api_tester.dart";

/// 声纹注册页（真实录音版）：3 次 × 4s PCM16 16k 采集 →
/// 服务端本地 ONNX 说话人引擎注册。语音对话/控制只响应录入声纹的人。
class VoiceprintRegistrationPage extends StatefulWidget {
  const VoiceprintRegistrationPage({
    super.key,
    required this.userId,
    required this.onRegistrationComplete,
  });

  final String userId;
  final VoidCallback onRegistrationComplete;

  @override
  State<VoiceprintRegistrationPage> createState() => _VoiceprintRegistrationPageState();
}

class _VoiceprintRegistrationPageState extends State<VoiceprintRegistrationPage> {
  final MicClipRecorder _recorder = MicClipRecorder();
  final List<Uint8List> _clips = <Uint8List>[];

  bool _isRecording = false;
  bool _isRegistering = false;
  double _progress = 0.0;
  String _statusText = "点击麦克风开始";
  double _recordElapsed = 0;
  Timer? _recordTimer;
  static const Duration _clipDuration = Duration(seconds: 5);

  /// 固定照读句：文本无关引擎不挑内容，固定文本只为采集一致——
  /// 音素覆盖广（平翘舌/前后鼻音/语气词）、每句约 18 字 ≈ 5 秒、口语自然。
  static const List<String> _prompts = <String>[
    "今天天气真好，我们一起去公园散步吧。",
    "明天早上七点叫我起床，我八点要赶高铁。",
    "晚上记得给妈妈打个电话，周末回家吃饭。",
  ];

  @override
  void dispose() {
    _recordTimer?.cancel();
    _recorder.dispose();
    super.dispose();
  }

  Future<void> _startRecording() async {
    if (_isRecording || _isRegistering) return;
    final bool ok = await _recorder.start();
    if (!ok) {
      setState(() => _statusText = "无法访问麦克风，请检查系统权限");
      return;
    }
    setState(() {
      _isRecording = true;
      _recordElapsed = 0;
      _statusText = "请照着读下面的句子";
    });
    const Duration tickDur = Duration(milliseconds: 100);
    _recordTimer?.cancel();
    _recordTimer = Timer.periodic(tickDur, (Timer t) {
      _recordElapsed += tickDur.inMilliseconds / 1000;
      if (_recordElapsed >= _clipDuration.inMilliseconds / 1000) {
        unawaited(_finishRecording());
      } else if (mounted) {
        setState(() {});
      }
    });
  }

  Future<void> _finishRecording() async {
    _recordTimer?.cancel();
    _recordTimer = null;
    final Uint8List clip = await _recorder.stop();
    if (!mounted) return;
    if (clip.length < 16000) {
      setState(() {
        _isRecording = false;
        _statusText = "录音太短，请重新点击并说满一句话";
      });
      return;
    }
    setState(() {
      _isRecording = false;
      _clips.add(clip);
      _progress = _clips.length / 3.0;
      _statusText = "录制完成 ${_clips.length}/3";
    });
    if (_clips.length >= 3) {
      unawaited(_registerVoiceprint());
    }
  }

  Future<void> _registerVoiceprint() async {
    setState(() {
      _isRegistering = true;
      _statusText = "正在注册声纹…";
    });
    try {
      final Map<String, dynamic> res = await VoiceprintApi.register(_clips);
      if (!mounted) return;
      setState(() => _isRegistering = false);
      if (res["ok"] == true) {
        setState(() => _statusText = "声纹注册成功");
        Future<void>.delayed(const Duration(milliseconds: 900), () {
          if (mounted) widget.onRegistrationComplete();
        });
      } else {
        setState(() {
          _statusText = res["error"]?.toString() ?? "注册失败，请重试";
          _clips.clear();
          _progress = 0;
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _isRegistering = false;
        _statusText = "声纹服务不可达：$e";
      });
    }
  }

  void _reset() {
    if (_isRecording || _isRegistering) return;
    setState(() {
      _clips.clear();
      _progress = 0;
      _statusText = "已重置，点击麦克风开始";
    });
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;

    return Scaffold(
      backgroundColor: const Color(0xFF0F0F0F),
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: Colors.white),
          onPressed: () => Navigator.of(context).pop(),
        ),
        title: const Text("声纹注册", style: TextStyle(color: Colors.white)),
        actions: <Widget>[
          if (_clips.isNotEmpty && !_isRecording && !_isRegistering)
            TextButton(
              onPressed: _reset,
              child: const Text("重录", style: TextStyle(color: Colors.white54, fontSize: 13)),
            ),
        ],
      ),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: Colors.white.withValues(alpha: 0.06),
                borderRadius: BorderRadius.circular(16),
              ),
              child: Column(
                children: <Widget>[
                  Text(
                    "${_clips.length}/3",
                    style: const TextStyle(color: Colors.white, fontSize: 44, fontWeight: FontWeight.bold),
                  ),
                  const SizedBox(height: 14),
                  Text(
                    "第 ${(_clips.length + 1).clamp(1, 3)} 句 · 请照着读",
                    style: TextStyle(color: Colors.white.withValues(alpha: 0.55), fontSize: 12.5),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    _prompts[_clips.length.clamp(0, 2)],
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 19,
                      height: 1.5,
                      fontWeight: FontWeight.w600,
                    ),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 14),
                  LinearProgressIndicator(
                    value: _progress,
                    backgroundColor: Colors.white.withValues(alpha: 0.15),
                    valueColor: const AlwaysStoppedAnimation<Color>(Colors.white),
                    minHeight: 3,
                  ),
                  const SizedBox(height: 14),
                  Text(
                    _isRecording
                        ? "正在聆听… ${(_clipDuration.inMilliseconds / 1000 - _recordElapsed).ceil()}s"
                        : _statusText,
                    style: TextStyle(color: Colors.white.withValues(alpha: 0.85), fontSize: 15, height: 1.5),
                    textAlign: TextAlign.center,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 40),
            ValueListenableBuilder<double>(
              valueListenable: _recorder.level,
              builder: (BuildContext context, double level, _) {
                final double pulse = _isRecording ? 1.0 + level * 0.2 : 1.0;
                return GestureDetector(
                  onTap: _isRecording ? _finishRecording : (_isRegistering ? null : _startRecording),
                  child: AnimatedScale(
                    scale: pulse,
                    duration: const Duration(milliseconds: 120),
                    child: Container(
                      width: 88,
                      height: 88,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: _isRecording
                            ? Colors.white
                            : _isRegistering
                                ? Colors.white.withValues(alpha: 0.2)
                                : cs.primary.withValues(alpha: 0.85),
                        boxShadow: <BoxShadow>[
                          BoxShadow(
                            color: Colors.white.withValues(alpha: _isRecording ? 0.35 : 0.12),
                            blurRadius: _isRecording ? 28 : 16,
                          ),
                        ],
                      ),
                      child: Icon(
                        _isRecording ? Icons.stop_rounded : Icons.mic_none,
                        color: _isRecording ? Colors.black : Colors.white,
                        size: 36,
                      ),
                    ),
                  ),
                );
              },
            ),
            const SizedBox(height: 24),
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: Colors.white.withValues(alpha: 0.04),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: Colors.white.withValues(alpha: 0.08)),
              ),
              child: Column(
                children: <Widget>[
                  const Text("注册说明", style: TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 10),
                  Text(
                    "1. 点击麦克风，照着屏幕上的句子朗读\n"
                    "2. 每句约 5 秒，用平时说话的音量和语速\n"
                    "3. 完成 3 句后自动注册\n"
                    "4. 验证时不用背这些句子，正常说话即可",
                    style: TextStyle(color: Colors.white.withValues(alpha: 0.65), fontSize: 13.5, height: 1.7),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
