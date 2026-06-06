import "package:flutter/material.dart";
import "dart:async";

import "../../core/services/multimodal_recognition_service.dart";

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
  final MultimodalRecognitionService _recognitionService = MultimodalRecognitionService();
  
  bool _isRecording = false;
  int _recordingCount = 0;
  final List<List<List<double>>> _audioSamples = []; // List<样本<List<帧<List<double>>>>>
  bool _isRegistering = false;
  String _statusText = '准备录制';
  double _progress = 0.0;

  @override
  void initState() {
    super.initState();
    _initializeService();
  }

  Future<void> _initializeService() async {
    await _recognitionService.initialize(userId: widget.userId);
  }

  Future<void> _startRecording() async {
    setState(() {
      _isRecording = true;
      _statusText = '正在录制...请说话';
    });

    // 模拟录音3秒
    await Future.delayed(const Duration(seconds: 3));

    // 模拟生成音频样本数据（实际应用中需要从麦克风获取真实音频数据）
    final sample = _generateMockAudioSample();
    
    setState(() {
      _isRecording = false;
      _recordingCount++;
      _audioSamples.add(sample);
      _progress = _recordingCount / 3.0; // 需要录制3次
      _statusText = '录制完成 $_recordingCount/3';
    });

    if (_recordingCount >= 3) {
      _registerVoiceprint();
    }
  }

  List<List<double>> _generateMockAudioSample() {
    // 模拟音频特征数据（实际应用中需要使用真实的音频处理库提取MFCC等特征）
    final sample = <List<double>>[];
    for (int i = 0; i < 13; i++) {
      final frame = <double>[];
      for (int j = 0; j < 20; j++) {
        frame.add((i * 20 + j).toDouble() * 0.1);
      }
      sample.add(frame);
    }
    return sample;
  }

  Future<void> _registerVoiceprint() async {
    setState(() {
      _isRegistering = true;
      _statusText = '正在注册声纹...';
    });

    try {
      // 将所有样本的第一个帧合并（简化处理）
      final mergedSamples = <List<double>>[];
      for (final sample in _audioSamples) {
        if (sample.isNotEmpty) {
          mergedSamples.addAll(sample);
        }
      }
      
      final success = await _recognitionService.registerVoiceprint(
        userId: widget.userId,
        audioSamples: mergedSamples,
      );

      setState(() {
        _isRegistering = false;
        if (success) {
          _statusText = '声纹注册成功！';
          Future.delayed(const Duration(seconds: 1), () {
            widget.onRegistrationComplete();
          });
        } else {
          _statusText = '声纹注册失败，请重试';
          _recordingCount = 0;
          _audioSamples.clear();
          _progress = 0.0;
        }
      });
    } catch (e) {
      setState(() {
        _isRegistering = false;
        _statusText = '注册出错: $e';
      });
    }
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
        title: const Text(
          '声纹注册',
          style: TextStyle(color: Colors.white),
        ),
      ),
      body: Padding(
        padding: const EdgeInsets.all(24.0),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            // 进度指示器
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: Colors.white.withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(16),
              ),
              child: Column(
                children: [
                  Text(
                    '$_recordingCount/3',
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 48,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const SizedBox(height: 16),
                  LinearProgressIndicator(
                    value: _progress,
                    backgroundColor: Colors.white.withValues(alpha: 0.2),
                    valueColor: AlwaysStoppedAnimation<Color>(cs.primary),
                    minHeight: 8,
                  ),
                  const SizedBox(height: 16),
                  Text(
                    _statusText,
                    style: TextStyle(
                      color: Colors.white.withValues(alpha: 0.8),
                      fontSize: 16,
                    ),
                    textAlign: TextAlign.center,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 40),

            // 录制按钮
            GestureDetector(
              onTap: _isRecording || _isRegistering ? null : _startRecording,
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 200),
                width: _isRecording ? 100 : 80,
                height: _isRecording ? 100 : 80,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: _isRecording
                      ? Colors.red.withValues(alpha: 0.8)
                      : _isRegistering
                          ? Colors.grey.withValues(alpha: 0.5)
                          : cs.primary.withValues(alpha: 0.8),
                  boxShadow: [
                    BoxShadow(
                      color: _isRecording
                          ? Colors.red.withValues(alpha: 0.4)
                          : cs.primary.withValues(alpha: 0.3),
                      blurRadius: _isRecording ? 30 : 20,
                      spreadRadius: _isRecording ? 5 : 2,
                    ),
                  ],
                ),
                child: Icon(
                  _isRecording ? Icons.mic : Icons.mic_none,
                  color: Colors.white,
                  size: 40,
                ),
              ),
            ),
            const SizedBox(height: 24),

            // 说明文字
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: Colors.white.withValues(alpha: 0.05),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(
                  color: Colors.white.withValues(alpha: 0.1),
                ),
              ),
              child: Column(
                children: [
                  const Text(
                    '注册说明',
                    style: TextStyle(
                      color: Colors.white,
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    '1. 点击麦克风按钮开始录制\n'
                    '2. 每次录制约3秒，请清晰说话\n'
                    '3. 需要完成3次录制\n'
                    '4. 建议使用不同的语句进行录制',
                    style: TextStyle(
                      color: Colors.white.withValues(alpha: 0.7),
                      fontSize: 14,
                      height: 1.6,
                    ),
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
