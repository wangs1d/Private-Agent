import "dart:async";

import "voiceprint_service.dart";
import "visual_recognition_service.dart";
import "mock_voiceprint_service.dart";
import "mock_visual_recognition_service.dart";
import "security_service.dart";

/// 多模态识别服务管理器
class MultimodalRecognitionService {
  static final MultimodalRecognitionService _instance = MultimodalRecognitionService._internal();
  
  factory MultimodalRecognitionService() {
    return _instance;
  }
  
  MultimodalRecognitionService._internal();

  VoiceprintService? _voiceprintService;
  VisualRecognitionService? _visualService;
  final SecurityService _securityService = SecurityService();
  
  bool _isInitialized = false;
  String? _currentUserId;

  /// 获取单例实例
  static MultimodalRecognitionService get instance => _instance;

  /// 初始化多模态识别服务
  Future<bool> initialize({String? userId}) async {
    if (_isInitialized) {
      return true;
    }

    try {
      // 初始化声纹识别服务（使用模拟实现）
      _voiceprintService = MockVoiceprintService();
      await _voiceprintService!.initialize();

      // 初始化面部识别服务（使用模拟实现）
      _visualService = MockVisualRecognitionService();
      await _visualService!.initialize();

      _currentUserId = userId;
      
      // 生成会话令牌
      if (userId != null) {
        _securityService.generateSessionToken(userId);
      }
      
      _isInitialized = true;
      
      print("多模态识别服务初始化成功（声纹+面部）");
      return true;
    } catch (e) {
      print("多模态识别服务初始化失败: $e");
      return false;
    }
  }

  /// 设置当前用户ID
  void setCurrentUser(String userId) {
    _currentUserId = userId;
  }

  /// 注册声纹
  Future<bool> registerVoiceprint({
    required String userId,
    required List<List<double>> audioSamples,
  }) async {
    if (!_isInitialized || _voiceprintService == null) {
      throw Exception("多模态识别服务未初始化");
    }

    return await _voiceprintService!.registerVoiceprint(
      userId: userId,
      audioSamples: audioSamples,
    );
  }

  /// 开始声纹识别监听
  Stream<VoiceprintEvent>? startVoiceprintListening({
    required Function(String recognizedText) onResult,
  }) {
    if (!_isInitialized || _voiceprintService == null) {
      throw Exception("多模态识别服务未初始化");
    }

    if (_currentUserId == null) {
      throw Exception("未设置当前用户ID");
    }

    // 安全检查：账户是否被锁定
    if (_securityService.isAccountLocked(_currentUserId!)) {
      final remainingTime = _securityService.getRemainingLockoutTime(_currentUserId!);
      throw Exception("账户已锁定，请 $remainingTime 秒后重试");
    }

    return _voiceprintService!.startListeningWithVerification(
      userId: _currentUserId!,
      onResult: (String recognizedText) {
        // 验证通过后，重置失败尝试计数
        _securityService.resetFailedAttempts(_currentUserId!);
        onResult(recognizedText);
      },
    );
  }

  /// 停止声纹识别监听
  void stopVoiceprintListening() {
    _voiceprintService?.stopListening();
  }

  /// 注册面部特征（预留接口）
  Future<bool> registerFace({
    required String userId,
    required List<List<double>> faceFeatures,
  }) async {
    if (!_isInitialized || _visualService == null) {
      throw Exception("视觉识别服务未初始化");
    }

    return await _visualService!.registerFace(
      userId: userId,
      faceFeatures: faceFeatures,
    );
  }

  /// 开始面部识别（预留接口）
  Stream<VisualEvent>? startFaceRecognition({
    required Function(String detectedAction) onDetected,
  }) {
    if (!_isInitialized || _visualService == null) {
      throw Exception("视觉识别服务未初始化");
    }

    if (_currentUserId == null) {
      throw Exception("未设置当前用户ID");
    }

    return _visualService!.startRealTimeRecognition(
      userId: _currentUserId!,
      onDetected: onDetected,
    );
  }

  /// 停止面部识别（预留接口）
  void stopFaceRecognition() {
    _visualService?.stopRecognition();
  }

  /// 释放资源
  void dispose() {
    stopVoiceprintListening();
    stopFaceRecognition();
    
    _voiceprintService?.dispose();
    _visualService?.dispose();
    _securityService.clearSession();
    
    _voiceprintService = null;
    _visualService = null;
    _isInitialized = false;
    _currentUserId = null;
  }

  /// 检查是否已初始化
  bool get isInitialized => _isInitialized;

  /// 获取当前用户ID
  String? get currentUserId => _currentUserId;
}
