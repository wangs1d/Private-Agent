import "package:flutter/material.dart";
import "dart:async";

import "../../core/services/multimodal_recognition_service.dart";
import "../../core/services/voiceprint_service.dart";
import "../../core/services/voice_command_processor.dart";
import "../../core/config/api_config.dart";
import "voiceprint_registration_page.dart";

class VoiceModePage extends StatefulWidget {
  const VoiceModePage({
    super.key,
    required this.onExit,
  });

  final VoidCallback onExit;

  @override
  State<VoiceModePage> createState() => _VoiceModePageState();
}

class _VoiceModePageState extends State<VoiceModePage> with SingleTickerProviderStateMixin {
  late AnimationController _animationController;
  late Animation<double> _scaleAnimation;
  late Animation<double> _opacityAnimation;
  bool _isSpeaking = false;
  
  final MultimodalRecognitionService _recognitionService = MultimodalRecognitionService();
  final VoiceCommandProcessor _commandProcessor = VoiceCommandProcessor();
  StreamSubscription<VoiceprintEvent>? _voiceprintSubscription;
  String _statusText = '点击球体开始说话';
  String _verificationStatus = '';
  double _confidence = 0.0;
  bool _isVoiceprintRegistered = false;

  @override
  void initState() {
    super.initState();
    
    // 初始化多模态识别服务
    _initializeRecognitionService();
    
    // 初始化语音命令处理器
    _commandProcessor.initializeDefaultCommands();
    
    // 创建呼吸动画控制器
    _animationController = AnimationController(
      duration: const Duration(seconds: 2),
      vsync: this,
    )..repeat(reverse: true);

    // 缩放动画 - 球体大小变化
    _scaleAnimation = Tween<double>(
      begin: 0.8,
      end: 1.2,
    ).animate(CurvedAnimation(
      parent: _animationController,
      curve: Curves.easeInOut,
    ));

    // 透明度动画 - 发光效果
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
      print("语音模式页面：多模态识别服务初始化成功");
    } catch (e) {
      print("语音模式页面：多模态识别服务初始化失败: $e");
    }
  }

  @override
  void dispose() {
    _stopVoiceprintListening();
    _animationController.dispose();
    super.dispose();
  }

  void _startVoiceprintListening() {
    if (!_recognitionService.isInitialized) {
      setState(() {
        _statusText = '服务未初始化';
      });
      return;
    }

    // 检查是否已注册声纹
    if (!_isVoiceprintRegistered) {
      setState(() {
        _statusText = '请先注册声纹';
        _verificationStatus = '点击右上角注册';
      });
      // 显示确认弹窗
      showDialog(
        context: context,
        builder: (BuildContext dialogContext) {
          return AlertDialog(
            title: const Text('需要注册声纹'),
            content: const Text('您需要先注册声纹才能使用语音模式功能。是否现在前往注册？'),
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
                  // 跳转到声纹注册页面
                  Navigator.of(context).push(
                    MaterialPageRoute(
                      builder: (context) => VoiceprintRegistrationPage(
                        userId: ApiConfig.effectiveActorId,
                        onRegistrationComplete: () {
                          Navigator.of(context).pop();
                          setState(() {
                            _isVoiceprintRegistered = true;
                            _statusText = '点击球体开始说话';
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
      final stream = _recognitionService.startVoiceprintListening(
        onResult: (String recognizedText) {
          print("识别到命令: $recognizedText");
          // 处理语音命令
          _commandProcessor.processCommand(recognizedText);
        },
      );

      if (stream != null) {
        _voiceprintSubscription = stream.listen((VoiceprintEvent event) {
          setState(() {
            switch (event.type) {
              case VoiceprintEventType.listening:
                _statusText = '正在聆听...';
                _verificationStatus = '';
                break;
              case VoiceprintEventType.verified:
                _statusText = '验证通过';
                _verificationStatus = '✓ 声纹匹配';
                _confidence = event.verificationResult?.confidence ?? 0.0;
                break;
              case VoiceprintEventType.rejected:
                _statusText = '验证失败';
                _verificationStatus = '✗ 非授权用户';
                _confidence = event.verificationResult?.confidence ?? 0.0;
                break;
              case VoiceprintEventType.error:
                _statusText = '识别错误';
                _verificationStatus = event.error ?? '未知错误';
                break;
              default:
                break;
            }
          });
        });

        setState(() {
          _isSpeaking = true;
          _statusText = '正在聆听...';
        });
      }
    } catch (e) {
      setState(() {
        _statusText = '启动失败';
        _verificationStatus = e.toString();
      });
    }
  }

  void _stopVoiceprintListening() {
    _voiceprintSubscription?.cancel();
    _voiceprintSubscription = null;
    _recognitionService.stopVoiceprintListening();
    
    setState(() {
      _isSpeaking = false;
      _statusText = '点击球体开始说话';
      _verificationStatus = '';
      _confidence = 0.0;
    });
  }

  void _toggleSpeaking() {
    if (_isSpeaking) {
      _stopVoiceprintListening();
    } else {
      _startVoiceprintListening();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF2A2A2A), // 灰色背景
      body: Stack(
        children: [
          // 返回按钮
          Positioned(
            top: 40,
            left: 20,
            child: IconButton(
              icon: Icon(Icons.arrow_back, color: Colors.white.withValues(alpha: 0.7)),
              onPressed: widget.onExit,
              tooltip: '退出语音模式',
            ),
          ),

          // 中心的呼吸灯球形
          Center(
            child: GestureDetector(
              onTap: _toggleSpeaking,
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
                          _isSpeaking 
                            ? Colors.white.withValues(alpha: _opacityAnimation.value)
                            : Colors.black.withValues(alpha: _opacityAnimation.value),
                          _isSpeaking
                            ? const Color(0xFFE8EBF0).withValues(alpha: _opacityAnimation.value * 0.8)
                            : const Color(0xFF1A1A1A).withValues(alpha: _opacityAnimation.value * 0.8),
                          _isSpeaking
                            ? const Color(0xFFD9DEE7).withValues(alpha: _opacityAnimation.value * 0.6)
                            : const Color(0xFF0D0D0D).withValues(alpha: _opacityAnimation.value * 0.6),
                        ],
                        stops: const [0.0, 0.5, 1.0],
                      ),
                      boxShadow: [
                        // 内部阴影 - 创建立体感
                        BoxShadow(
                          color: Colors.black.withValues(alpha: 0.8),
                          blurRadius: 20,
                          offset: const Offset(0, 10),
                        ),
                        // 外部光晕 - 呼吸效果
                        BoxShadow(
                          color: (_isSpeaking ? Colors.white : Colors.white)
                              .withValues(alpha: _opacityAnimation.value * 0.1),
                          blurRadius: 30,
                          spreadRadius: 5,
                        ),
                        // 底部高光 - 增强立体感
                        BoxShadow(
                          color: (_isSpeaking ? Colors.white : Colors.white)
                              .withValues(alpha: _opacityAnimation.value * 0.05),
                          blurRadius: 15,
                          offset: const Offset(0, -5),
                        ),
                      ],
                    ),
                    child: Center(
                      child: Container(
                        width: 60,
                        height: 60,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          gradient: RadialGradient(
                            colors: [
                              (_isSpeaking ? Colors.white : Colors.white)
                                  .withValues(alpha: _opacityAnimation.value * 0.3),
                              Colors.transparent,
                            ],
                            stops: const [0.0, 1.0],
                          ),
                        ),
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
                    color: Colors.white.withValues(alpha: 0.8),
                    fontSize: 18,
                    fontWeight: FontWeight.w500,
                  ),
                ),
                if (_verificationStatus.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  Text(
                    _verificationStatus,
                    style: TextStyle(
                      color: _verificationStatus.contains('✓') 
                          ? Colors.green.withValues(alpha: 0.8)
                          : Colors.red.withValues(alpha: 0.8),
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
                      color: Colors.white.withValues(alpha: 0.6),
                      fontSize: 14,
                    ),
                  ),
                ],
                const SizedBox(height: 8),
                Text(
                  _isSpeaking ? '点击球体停止录音' : '点击球体开始说话',
                  style: TextStyle(
                    color: Colors.white.withValues(alpha: 0.5),
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
