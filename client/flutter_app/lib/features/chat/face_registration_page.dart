import "package:flutter/material.dart";
import "dart:async";

import "../../core/services/multimodal_recognition_service.dart";

class FaceRegistrationPage extends StatefulWidget {
  const FaceRegistrationPage({
    super.key,
    required this.userId,
    required this.onRegistrationComplete,
  });

  final String userId;
  final VoidCallback onRegistrationComplete;

  @override
  State<FaceRegistrationPage> createState() => _FaceRegistrationPageState();
}

class _FaceRegistrationPageState extends State<FaceRegistrationPage> {
  final MultimodalRecognitionService _recognitionService = MultimodalRecognitionService();
  
  bool _isCapturing = false;
  int _captureCount = 0;
  final List<List<List<double>>> _faceSamples = [];
  bool _isRegistering = false;
  String _statusText = '准备采集';
  double _progress = 0.0;

  @override
  void initState() {
    super.initState();
    _initializeService();
  }

  Future<void> _initializeService() async {
    await _recognitionService.initialize(userId: widget.userId);
  }

  Future<void> _startCapture() async {
    setState(() {
      _isCapturing = true;
      _statusText = '正在采集...请正视摄像头';
    });

    // 模拟摄像头采集2秒
    await Future.delayed(const Duration(seconds: 2));

    // 模拟生成面部特征数据（实际应用中需要从摄像头获取真实图像并提取特征）
    final sample = _generateMockFaceFeatures();
    
    setState(() {
      _isCapturing = false;
      _captureCount++;
      _faceSamples.add(sample);
      _progress = _captureCount / 5.0; // 需要采集5次
      _statusText = '采集完成 $_captureCount/5';
    });

    if (_captureCount >= 5) {
      _registerFace();
    }
  }

  List<List<double>> _generateMockFaceFeatures() {
    // 模拟面部特征数据（实际应用中需要使用OpenCV或ML Kit提取128维特征向量）
    final features = <List<double>>[];
    for (int i = 0; i < 10; i++) {
      final landmark = <double>[];
      for (int j = 0; j < 128; j++) {
        landmark.add((i * 128 + j).toDouble() * 0.01);
      }
      features.add(landmark);
    }
    return features;
  }

  Future<void> _registerFace() async {
    setState(() {
      _isRegistering = true;
      _statusText = '正在注册面部特征...';
    });

    try {
      // 将所有样本合并
      final mergedFeatures = <List<double>>[];
      for (final sample in _faceSamples) {
        if (sample.isNotEmpty) {
          mergedFeatures.addAll(sample);
        }
      }
      
      final success = await _recognitionService.registerFace(
        userId: widget.userId,
        faceFeatures: mergedFeatures,
      );

      setState(() {
        _isRegistering = false;
        if (success) {
          _statusText = '面部注册成功！';
          Future.delayed(const Duration(seconds: 1), () {
            widget.onRegistrationComplete();
          });
        } else {
          _statusText = '面部注册失败，请重试';
          _captureCount = 0;
          _faceSamples.clear();
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
          '面部注册',
          style: TextStyle(color: Colors.white),
        ),
      ),
      body: Padding(
        padding: const EdgeInsets.all(24.0),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            // 摄像头预览框（模拟）
            Container(
              width: 200,
              height: 200,
              decoration: BoxDecoration(
                color: Colors.black.withValues(alpha: 0.3),
                borderRadius: BorderRadius.circular(16),
                border: Border.all(
                  color: cs.primary.withValues(alpha: 0.5),
                  width: 2,
                ),
              ),
              child: Center(
                child: Icon(
                  Icons.face,
                  size: 80,
                  color: Colors.white.withValues(alpha: 0.5),
                ),
              ),
            ),
            const SizedBox(height: 24),

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
                    '$_captureCount/5',
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

            // 采集按钮
            GestureDetector(
              onTap: _isCapturing || _isRegistering ? null : _startCapture,
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 200),
                width: _isCapturing ? 100 : 80,
                height: _isCapturing ? 100 : 80,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: _isCapturing
                      ? Colors.grey.withValues(alpha: 0.8)
                      : _isRegistering
                          ? Colors.grey.withValues(alpha: 0.5)
                          : cs.primary.withValues(alpha: 0.8),
                  boxShadow: [
                    BoxShadow(
                      color: _isCapturing
                          ? Colors.grey.withValues(alpha: 0.4)
                          : cs.primary.withValues(alpha: 0.3),
                      blurRadius: _isCapturing ? 30 : 20,
                      spreadRadius: _isCapturing ? 5 : 2,
                    ),
                  ],
                ),
                child: Icon(
                  _isCapturing ? Icons.camera : Icons.camera_alt,
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
                    '1. 点击相机按钮开始采集\n'
                    '2. 每次采集约2秒，请正视摄像头\n'
                    '3. 需要完成5次采集\n'
                    '4. 建议在不同角度和光线下采集',
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
