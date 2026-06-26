import "dart:async";

import "user_preferences_api.dart";
import "ws_chat_service.dart";

/// 早安简报事件控制器。
///
/// 职责：
///   1. 监听 WS 推送的 `morning.briefing` 服务端事件；
///   2. 将载荷广播给 UI，UI 自行决定渲染位置（弹窗 / 卡片）；
///   3. 语音模式 / 卡片扬声器按钮触发 TTS 朗读（占位实现）。
class BriefingController {
  BriefingController({
    required this.sessionId,
    required this.preferencesApi,
    required this.ws,
  });

  final String sessionId;
  final UserPreferencesApi preferencesApi;
  final WsChatService ws;

  final StreamController<Map<String, dynamic>> _briefingsController =
      StreamController<Map<String, dynamic>>.broadcast();

  /// 早安简报事件流，UI 监听此流来弹卡片。
  Stream<Map<String, dynamic>> get briefings => _briefingsController.stream;

  StreamSubscription<Map<String, dynamic>>? _wsSub;
  bool _started = false;

  /// 开始监听 WS 事件，重复调用会忽略后续请求。
  void start() {
    if (_started) return;
    _started = true;
    _wsSub = ws.events.listen((Map<String, dynamic> event) {
      if (event["type"] != "morning.briefing") return;
      final Object? rawPayload = event["payload"];
      if (rawPayload is! Map) return;
      final Map<String, dynamic> payload = rawPayload.cast<String, dynamic>();
      _handleBriefing(payload);
    });
  }

  void _handleBriefing(Map<String, dynamic> payload) {
    _briefingsController.add(payload);
    final String mode = payload["mode"]?.toString() ?? "card";
    if (mode == "voice") {
      final String text = payload["narrationText"]?.toString() ?? "";
      if (text.isNotEmpty) {
        unawaited(speakNarration(text));
      }
    }
  }

  /// 手动触发语音播报（用户在卡片上点击 🔊 按钮时调用）。
  ///
  /// 占位：TTS 集成
  /// 桌面端用系统 TTS, Web 用 speechSynthesis, 移动端调原生 TTS
  /// 这里只做接口预留，不实际调用
  Future<void> speakNarration(String text) async {
    if (text.isEmpty) return;
    // 实际 TTS 集成留待后续接入（flutter_tts / 平台通道 / Web Speech API）。
  }

  /// 停止监听并释放资源。调用后控制器不可再用。
  Future<void> stop() async {
    await _wsSub?.cancel();
    _wsSub = null;
    _started = false;
    if (!_briefingsController.isClosed) {
      await _briefingsController.close();
    }
  }
}
