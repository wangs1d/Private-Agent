import "package:flutter/material.dart";
import "dart:async";

import "../../core/services/multimodal_recognition_service.dart";
import "../../core/services/visual_recognition_service.dart";
import "../../core/config/api_config.dart";
import "face_registration_page.dart";

class FaceRecognitionModePage extends StatefulWidget {
  const FaceRecognitionModePage({
    super.key,
    required this.onExit,
  });

  final VoidCallback onExit;

  @override
  State<FaceRecognitionModePage> createState() => _FaceRecognitionModePageState();
}

class _FaceRecognitionModePageState extends State<FaceRecognitionModePage> with SingleTickerProviderStateMixin {
  late AnimationController _animationController;
  late Animation<double> _scaleAnimation;
  late Animation<double> _opacityAnimation;
  
  final MultimodalRecognitionService _recognitionService = MultimodalRecognitionService();
  StreamSubscription<VisualEvent>? _visualSubscription;
  bool _isRecognizing = false;
  String _statusText = '点击开始面部识别';
  String _verificationStatus = '';
  double _confidence = 0.0;
  String _lastDetectedAction = '';
  bool _isFaceRegistered = false;

  @override
  void initState() {
    super.initState();
    
    // 初始化多模态识别服务
    _initializeRecognitionService();
    
    // 创建呼吸动画控制器
    _animationController = AnimationController(
      duration: const Duration(seconds: 2),
      vsync: this,
    )..repeat(reverse: true);

    // 缩放动画
    _scaleAnimation = Tween<double>(
      begin: 0.8,
      end: 1.2,
    ).animate(CurvedAnimation(
      parent: _animationController,
      curve: Curves.easeInOut,
    ));

    // 透明度动画
    _opacityAnimation = Tween<double>(
      begin: 0.3,
      end: 0.8,
    ).animate(CurvedAnimation(
      parent: _animationController,
      curve: Curves.easeInOut,
    ));
  }

  Future<void> _initializeRecognitionService() async {
    try {
      await _recognitionService.initialize(userId: "user_001");
      print("面部识别页面：多模态识别服务初始化成功");
    } catch (e) {
      print("面部识别页面：多模态识别服务初始化失败: $e");
    }
  }

  @override
  void dispose() {
    _stopFaceRecognition();
    _animationController.dispose();
    super.dispose();
  }

  void _startFaceRecognition() {
    if (!_recognitionService.isInitialized) {
      setState(() {
        _statusText = '服务未初始化';
      });
      return;
    }

    // 检查是否已注册面部
    if (!_isFaceRegistered) {
      setState(() {
        _statusText = '请先注册面部';
        _verificationStatus = '点击右上角注册';
      });
      // 显示确认弹窗
      showDialog(
        context: context,
        builder: (BuildContext dialogContext) {
          return AlertDialog(
            title: const Text('需要注册面部'),
            content: const Text('您需要先注册面部才能使用面部识别功能。是否现在前往注册？'),
            actions: [
              TextButton(
                onPressed: () {
                  Navigator.of(dialogContext).pop(); // 关闭弹窗
                },
                child: const Text('取消'),
              ),
              TextButton(
                onPressed: () {
                  Navigator.of(dialogContext).pop(); // 关闭弹窗
                  // 跳转到面部注册页面
                  Navigator.of(context).push(
                    MaterialPageRoute(
                      builder: (context) => FaceRegistrationPage(
                        userId: ApiConfig.effectiveActorId,
                        onRegistrationComplete: () {
                          Navigator.of(context).pop();
                          setState(() {
                            _isFaceRegistered = true;
                            _statusText = '点击开始面部识别';
                            _verificationStatus = '';
                          });
                        },
                      ),
                    ),
                  );
                },
                child: const Text('去注册'),
              ),
            ],
          );
        },
      );
      return;
    }

    try {
      final stream = _recognitionService.startFaceRecognition(
        onDetected: (String detectedAction) {
          print("检测到动作: $detectedAction");
          setState(() {
            _lastDetectedAction = detectedAction;
          });
        },
      );

      if (stream != null) {
        _visualSubscription = stream.listen((VisualEvent event) {
          setState(() {
            switch (event.type) {
              case VisualEventType.detecting:
                _statusText = '正在检测...';
                _verificationStatus = '';
                break;
              case VisualEventType.verified:
                _statusText = '验证通过';
                _verificationStatus = '✓ 面部匹配';
                _confidence = event.verificationResult?.confidence ?? 0.0;
                break;
              case VisualEventType.rejected:
                _statusText = '验证失败';
                _verificationStatus = '✗ 非授权用户';
                _confidence = event.verificationResult?.confidence ?? 0.0;
                break;
              case VisualEventType.error:
                _statusText = '识别错误';
                _verificationStatus = event.error ?? '未知错误';
                break;
              default:
                break;
            }
          });
        });

        setState(() {
          _isRecognizing = true;
          _statusText = '正在检测...';
        });
      }
    } catch (e) {
      setState(() {
        _statusText = '启动失败';
        _verificationStatus = e.toString();
      });
    }
  }

  void _stopFaceRecognition() {
    _visualSubscription?.cancel();
    _visualSubscription = null;
    _recognitionService.stopFaceRecognition();
    
    setState(() {
      _isRecognizing = false;
      _statusText = '点击开始面部识别';
      _verificationStatus = '';
      _confidence = 0.0;
      _lastDetectedAction = '';
    });
  }

  void _toggleRecognition() {
    if (_isRecognizing) {
      _stopFaceRecognition();
    } else {
      _startFaceRecognition();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF2A2A2A),
      body: Stack(
        children: [
          // 返回按钮
          Positioned(
            top: 40,
            left: 20,
            child: IconButton(
              icon: Icon(Icons.arrow_back, color: Colors.white.withOpacity(0.7)),
              onPressed: widget.onExit,
              tooltip: '退出面部识别',
            ),
          ),

          // 中心的面部识别图标
          Center(
            child: GestureDetector(
              onTap: _toggleRecognition,
              child: AnimatedBuilder(
                animation: _animationController,
                builder: (context, child) {
                  return Container(
                    width: 200 * _scaleAnimation.value,
                    height: 200 * _scaleAnimation.value,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      gradient: RadialGradient(
                        colors: [
                          _isRecognizing
                            ? Colors.grey.withOpacity(_opacityAnimation.value)
                            : Colors.black.withOpacity(_opacityAnimation.value),
                          _isRecognizing
                            ? const Color(0xFF616161).withOpacity(_opacityAnimation.value * 0.8)
                            : const Color(0xFF1A1A1A).withOpacity(_opacityAnimation.value * 0.8),
                          _isRecognizing
                            ? const Color(0xFF757575).withOpacity(_opacityAnimation.value * 0.6)
                            : const Color(0xFF0D0D0D).withOpacity(_opacityAnimation.value * 0.6),
                        ],
                        stops: const [0.0, 0.5, 1.0],
                      ),
                      boxShadow: [
                        BoxShadow(
                          color: Colors.black.withOpacity(0.8),
                          blurRadius: 20,
                          offset: const Offset(0, 10),
                        ),
                        BoxShadow(
                          color: (_isRecognizing ? Colors.grey : Colors.white)
                              .withOpacity(_opacityAnimation.value * 0.1),
                          blurRadius: 30,
                          spreadRadius: 5,
                        ),
                        BoxShadow(
                          color: (_isRecognizing ? Colors.grey : Colors.white)
                              .withOpacity(_opacityAnimation.value * 0.05),
                          blurRadius: 15,
                          offset: const Offset(0, -5),
                        ),
                      ],
                    ),
                    child: Center(
                      child: Icon(
                        Icons.face,
                        size: 80,
                        color: (_isRecognizing ? Colors.grey : Colors.white)
                            .withOpacity(_opacityAnimation.value * 0.5),
                      ),
                    ),
                  );
                },
              ),
            ),
          ),

          // 底部的提示文字
          Positioned(
            bottom: 80,
            left: 0,
            right: 0,
            child: Column(
              children: [
                Text(
                  _statusText,
                  style: TextStyle(
                    color: Colors.white.withOpacity(0.8),
                    fontSize: 18,
                    fontWeight: FontWeight.w500,
                  ),
                ),
                if (_lastDetectedAction.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  Text(
                    '检测到: $_lastDetectedAction',
                    style: TextStyle(
                      color: Colors.grey.withOpacity(0.8),
                      fontSize: 16,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ],
                if (_verificationStatus.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  Text(
                    _verificationStatus,
                    style: TextStyle(
                      color: _verificationStatus.contains('✓') 
                          ? Colors.green.withOpacity(0.8)
                          : Colors.red.withOpacity(0.8),
                      fontSize: 16,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ],
                if (_confidence > 0) ...[
                  const SizedBox(height: 4),
                  Text(
                    '置信度: ${(_confidence * 100).toStringAsFixed(1)}%',
                    style: TextStyle(
                      color: Colors.white.withOpacity(0.6),
                      fontSize: 14,
                    ),
                  ),
                ],
                const SizedBox(height: 8),
                Text(
                  _isRecognizing ? '点击停止识别' : '点击开始面部识别',
                  style: TextStyle(
                    color: Colors.white.withOpacity(0.5),
                    fontSize: 14,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
