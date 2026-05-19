import "dart:async";

/// 视觉识别服务接口 - 抽象层（为后续摄像头识别预留）
abstract class VisualRecognitionService {
  /// 初始化视觉识别服务
  Future<bool> initialize();

  /// 注册面部特征（录入用户面部样本）
  Future<bool> registerFace({
    required String userId,
    required List<List<double>> faceFeatures,
  });

  /// 验证面部（识别当前画面中的人是否为注册用户）
  Future<VisualVerificationResult> verifyFace({
    required String userId,
    required List<List<double>> faceFeatures,
  });

  /// 开始实时面部识别
  Stream<VisualEvent> startRealTimeRecognition({
    required String userId,
    required Function(String detectedAction) onDetected,
  });

  /// 停止识别
  void stopRecognition();

  /// 释放资源
  void dispose();
}

/// 视觉验证结果
class VisualVerificationResult {
  VisualVerificationResult({
    required this.isMatch,
    required this.confidence,
    required this.userId,
  });

  final bool isMatch;
  final double confidence;
  final String userId;
}

/// 视觉事件
class VisualEvent {
  VisualEvent({
    required this.type,
    this.action,
    this.verificationResult,
    this.error,
  });

  final VisualEventType type;
  final String? action;
  final VisualVerificationResult? verificationResult;
  final String? error;
}

enum VisualEventType {
  detecting,
  recognized,
  verified,
  rejected,
  error,
}
