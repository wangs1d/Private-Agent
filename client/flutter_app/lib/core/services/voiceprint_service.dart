import "dart:async";

/// 声纹识别服务接口 - 抽象层
abstract class VoiceprintService {
  /// 初始化声纹识别服务
  Future<bool> initialize();

  /// 注册声纹（录入用户声音样本）
  Future<bool> registerVoiceprint({
    required String userId,
    required List<List<double>> audioSamples,
  });

  /// 验证声纹（识别当前说话人是否为注册用户）
  Future<VoiceprintVerificationResult> verifyVoiceprint({
    required String userId,
    required List<List<double>> audioSamples,
  });

  /// 开始监听并实时验证声纹
  Stream<VoiceprintEvent> startListeningWithVerification({
    required String userId,
    required Function(String recognizedText) onResult,
  });

  /// 停止监听
  void stopListening();

  /// 释放资源
  void dispose();
}

/// 声纹验证结果
class VoiceprintVerificationResult {
  VoiceprintVerificationResult({
    required this.isMatch,
    required this.confidence,
    required this.userId,
  });

  final bool isMatch;
  final double confidence;
  final String userId;
}

/// 声纹事件
class VoiceprintEvent {
  VoiceprintEvent({
    required this.type,
    this.text,
    this.verificationResult,
    this.error,
  });

  final VoiceprintEventType type;
  final String? text;
  final VoiceprintVerificationResult? verificationResult;
  final String? error;
}

enum VoiceprintEventType {
  listening,
  recognized,
  verified,
  rejected,
  error,
}
