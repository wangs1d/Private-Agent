import "dart:async";
import "dart:math" as math;

import "voiceprint_service.dart";

/// 声纹识别服务模拟实现 - 用于开发和测试
class MockVoiceprintService implements VoiceprintService {
  bool _isInitialized = false;
  bool _isListening = false;
  StreamController<VoiceprintEvent>? _eventController;
  Timer? _simulationTimer;
  
  // 模拟已注册的声纹数据
  final Map<String, List<List<double>>> _registeredVoiceprints = {};

  @override
  Future<bool> initialize() async {
    try {
      _isInitialized = true;
      print("声纹识别服务初始化成功");
      return true;
    } catch (e) {
      print("声纹识别服务初始化失败: $e");
      return false;
    }
  }

  @override
  Future<bool> registerVoiceprint({
    required String userId,
    required List<List<double>> audioSamples,
  }) async {
    if (!_isInitialized) {
      throw Exception("声纹识别服务未初始化");
    }

    try {
      _registeredVoiceprints[userId] = audioSamples;
      print("用户 $userId 的声纹注册成功");
      return true;
    } catch (e) {
      print("声纹注册失败: $e");
      return false;
    }
  }

  @override
  Future<VoiceprintVerificationResult> verifyVoiceprint({
    required String userId,
    required List<List<double>> audioSamples,
  }) async {
    if (!_isInitialized) {
      throw Exception("声纹识别服务未初始化");
    }

    final registeredSamples = _registeredVoiceprints[userId];
    if (registeredSamples == null || registeredSamples.isEmpty) {
      return VoiceprintVerificationResult(
        isMatch: false,
        confidence: 0.0,
        userId: userId,
      );
    }

    // 模拟声纹匹配算法
    final confidence = _calculateSimilarity(audioSamples, registeredSamples);
    final isMatch = confidence > 0.8; // 阈值设为80%

    return VoiceprintVerificationResult(
      isMatch: isMatch,
      confidence: confidence,
      userId: userId,
    );
  }

  @override
  Stream<VoiceprintEvent> startListeningWithVerification({
    required String userId,
    required Function(String recognizedText) onResult,
  }) {
    if (!_isInitialized) {
      throw Exception("声纹识别服务未初始化");
    }

    if (_isListening) {
      throw Exception("已经在监听中");
    }

    _isListening = true;
    _eventController = StreamController<VoiceprintEvent>.broadcast();

    // 发送开始监听事件
    _eventController!.add(VoiceprintEvent(
      type: VoiceprintEventType.listening,
    ));

    // 模拟实时语音识别和声纹验证
    _startSimulation(userId, onResult);

    return _eventController!.stream;
  }

  void _startSimulation(String userId, Function(String recognizedText) onResult) {
    final random = math.Random();
    
    _simulationTimer = Timer.periodic(const Duration(seconds: 2), (timer) {
      if (!_isListening || _eventController == null || _eventController!.isClosed) {
        timer.cancel();
        return;
      }

      // 模拟语音识别结果
      final mockTexts = [
        "打开天气应用",
        "设置明天早上八点的闹钟",
        "给张三发消息",
        "播放音乐",
        "查询今天的日程",
      ];
      
      final recognizedText = mockTexts[random.nextInt(mockTexts.length)];
      
      // 模拟声纹验证（70%概率匹配成功）
      final isVerified = random.nextDouble() > 0.3;
      
      if (isVerified) {
        // 声纹验证通过，处理命令
        _eventController!.add(VoiceprintEvent(
          type: VoiceprintEventType.verified,
          text: recognizedText,
          verificationResult: VoiceprintVerificationResult(
            isMatch: true,
            confidence: 0.85 + random.nextDouble() * 0.15,
            userId: userId,
          ),
        ));
        
        onResult(recognizedText);
      } else {
        // 声纹验证失败，拒绝命令
        _eventController!.add(VoiceprintEvent(
          type: VoiceprintEventType.rejected,
          text: recognizedText,
          verificationResult: VoiceprintVerificationResult(
            isMatch: false,
            confidence: random.nextDouble() * 0.5,
            userId: userId,
          ),
        ));
      }
    });
  }

  double _calculateSimilarity(
    List<List<double>> samples1,
    List<List<double>> samples2,
  ) {
    if (samples1.isEmpty || samples2.isEmpty) {
      return 0.0;
    }

    // 简化的相似度计算（实际应用中需要使用专业的声纹匹配算法）
    final random = math.Random();
    return 0.7 + random.nextDouble() * 0.3; // 返回70%-100%的相似度
  }

  @override
  void stopListening() {
    _isListening = false;
    _simulationTimer?.cancel();
    _simulationTimer = null;
    
    if (_eventController != null && !_eventController!.isClosed) {
      _eventController!.close();
      _eventController = null;
    }
    
    print("声纹识别监听已停止");
  }

  @override
  void dispose() {
    stopListening();
    _registeredVoiceprints.clear();
    _isInitialized = false;
  }
}
