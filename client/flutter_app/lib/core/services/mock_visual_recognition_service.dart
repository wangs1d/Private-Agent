import "dart:async";
import "dart:math" as math;

import "visual_recognition_service.dart";

/// 面部识别服务模拟实现 - 用于开发和测试
class MockVisualRecognitionService implements VisualRecognitionService {
  bool _isInitialized = false;
  bool _isRecognizing = false;
  StreamController<VisualEvent>? _eventController;
  Timer? _simulationTimer;
  
  // 模拟已注册的面部特征数据
  final Map<String, List<List<double>>> _registeredFaces = {};

  @override
  Future<bool> initialize() async {
    try {
      _isInitialized = true;
      print("面部识别服务初始化成功");
      return true;
    } catch (e) {
      print("面部识别服务初始化失败: $e");
      return false;
    }
  }

  @override
  Future<bool> registerFace({
    required String userId,
    required List<List<double>> faceFeatures,
  }) async {
    if (!_isInitialized) {
      throw Exception("面部识别服务未初始化");
    }

    try {
      _registeredFaces[userId] = faceFeatures;
      print("用户 $userId 的面部特征注册成功");
      return true;
    } catch (e) {
      print("面部注册失败: $e");
      return false;
    }
  }

  @override
  Future<VisualVerificationResult> verifyFace({
    required String userId,
    required List<List<double>> faceFeatures,
  }) async {
    if (!_isInitialized) {
      throw Exception("面部识别服务未初始化");
    }

    final registeredFeatures = _registeredFaces[userId];
    if (registeredFeatures == null || registeredFeatures.isEmpty) {
      return VisualVerificationResult(
        isMatch: false,
        confidence: 0.0,
        userId: userId,
      );
    }

    // 模拟面部匹配算法
    final confidence = _calculateSimilarity(faceFeatures, registeredFeatures);
    final isMatch = confidence > 0.85; // 阈值设为85%

    return VisualVerificationResult(
      isMatch: isMatch,
      confidence: confidence,
      userId: userId,
    );
  }

  @override
  Stream<VisualEvent> startRealTimeRecognition({
    required String userId,
    required Function(String detectedAction) onDetected,
  }) {
    if (!_isInitialized) {
      throw Exception("面部识别服务未初始化");
    }

    if (_isRecognizing) {
      throw Exception("已经在识别中");
    }

    _isRecognizing = true;
    _eventController = StreamController<VisualEvent>.broadcast();

    // 发送开始检测事件
    _eventController!.add(VisualEvent(
      type: VisualEventType.detecting,
    ));

    // 模拟实时面部识别
    _startSimulation(userId, onDetected);

    return _eventController!.stream;
  }

  void _startSimulation(String userId, Function(String detectedAction) onDetected) {
    final random = math.Random();
    
    _simulationTimer = Timer.periodic(const Duration(seconds: 3), (timer) {
      if (!_isRecognizing || _eventController == null || _eventController!.isClosed) {
        timer.cancel();
        return;
      }

      // 模拟检测到的动作/手势
      final mockActions = [
        "点头确认",
        "摇头拒绝",
        "微笑",
        "眨眼",
        "举手示意",
      ];
      
      final detectedAction = mockActions[random.nextInt(mockActions.length)];
      
      // 模拟面部验证（75%概率匹配成功）
      final isVerified = random.nextDouble() > 0.25;
      
      if (isVerified) {
        // 面部验证通过，处理动作
        _eventController!.add(VisualEvent(
          type: VisualEventType.verified,
          action: detectedAction,
          verificationResult: VisualVerificationResult(
            isMatch: true,
            confidence: 0.85 + random.nextDouble() * 0.15,
            userId: userId,
          ),
        ));
        
        onDetected(detectedAction);
      } else {
        // 面部验证失败
        _eventController!.add(VisualEvent(
          type: VisualEventType.rejected,
          action: detectedAction,
          verificationResult: VisualVerificationResult(
            isMatch: false,
            confidence: random.nextDouble() * 0.5,
            userId: userId,
          ),
        ));
      }
    });
  }

  double _calculateSimilarity(
    List<List<double>> features1,
    List<List<double>> features2,
  ) {
    if (features1.isEmpty || features2.isEmpty) {
      return 0.0;
    }

    // 简化的相似度计算（实际应用中需要使用专业的面部匹配算法）
    final random = math.Random();
    return 0.75 + random.nextDouble() * 0.25; // 返回75%-100%的相似度
  }

  @override
  void stopRecognition() {
    _isRecognizing = false;
    _simulationTimer?.cancel();
    _simulationTimer = null;
    
    if (_eventController != null && !_eventController!.isClosed) {
      _eventController!.close();
      _eventController = null;
    }
    
    print("面部识别已停止");
  }

  @override
  void dispose() {
    stopRecognition();
    _registeredFaces.clear();
    _isInitialized = false;
  }
}
