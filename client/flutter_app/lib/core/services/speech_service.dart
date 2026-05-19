import "package:speech_to_text/speech_to_text.dart" as stt;
import "package:permission_handler/permission_handler.dart";

/// 语音识别服务
class SpeechService {
  static final SpeechService _instance = SpeechService._internal();
  factory SpeechService() => _instance;
  SpeechService._internal();

  final stt.SpeechToText _speech = stt.SpeechToText();
  bool _isListening = false;
  bool _isAvailable = false;

  /// 是否正在监听
  bool get isListening => _isListening;

  /// 语音识别是否可用
  bool get isAvailable => _isAvailable;

  /// 初始化语音识别
  Future<bool> initialize() async {
    try {
      // 请求麦克风权限
      final status = await Permission.microphone.request();
      if (status != PermissionStatus.granted) {
        print("麦克风权限被拒绝");
        return false;
      }

      // 初始化语音识别
      _isAvailable = await _speech.initialize(
        onStatus: (status) {
          print("语音识别状态: $status");
          if (status == "done" || status == "notListening") {
            _isListening = false;
          }
        },
        onError: (error) {
          print("语音识别错误: ${error.errorMsg}");
          _isListening = false;
        },
      );

      print("语音识别初始化: $_isAvailable");
      return _isAvailable;
    } catch (e) {
      print("初始化语音识别失败: $e");
      return false;
    }
  }

  /// 开始监听语音
  /// [onResult] 回调函数，接收识别到的文本
  Future<void> startListening({
    required Function(String text) onResult,
    Function()? onDone,
  }) async {
    if (!_isAvailable) {
      final initialized = await initialize();
      if (!initialized) {
        print("语音识别不可用");
        return;
      }
    }

    _isListening = true;
    _speech.listen(
      onResult: (result) {
        final text = result.recognizedWords;
        if (text.isNotEmpty) {
          onResult(text);
        }
      },
      listenFor: const Duration(seconds: 30),
      pauseFor: const Duration(seconds: 3),
      partialResults: false,
      localeId: "zh_CN", // 设置为中文
      onSoundLevelChange: (level) {},
      cancelOnError: true,
      listenMode: stt.ListenMode.dictation,
    );
  }

  /// 停止监听
  Future<void> stopListening() async {
    if (_isListening) {
      await _speech.stop();
      _isListening = false;
    }
  }

  /// 取消监听
  Future<void> cancel() async {
    if (_isListening) {
      await _speech.cancel();
      _isListening = false;
    }
  }

  /// 销毁服务
  void dispose() {
    _speech.cancel();
  }
}
