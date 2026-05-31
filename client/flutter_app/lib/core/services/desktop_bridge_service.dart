import "dart:async";
import "dart:convert";
import "dart:io";

import "package:flutter/foundation.dart";
import "package:web_socket_channel/web_socket_channel.dart";

import "../config/api_config.dart";
import "desktop_screen_capture.dart";

/// Flutter Windows 作为 [desktopBridge] 执行器：与主聊天 WS 并行连接，响应截图任务。
class DesktopBridgeService {
  DesktopBridgeService._();

  static final DesktopBridgeService instance = DesktopBridgeService._();

  static const String _bridgeSessionSuffix = "-flutter-bridge";

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _subscription;
  bool _connecting = false;
  bool _connected = false;

  final ValueNotifier<bool> bridgeConnected = ValueNotifier<bool>(false);

  bool get isActive => _connected;

  /// 主聊天 WS 就绪后调用；与手机会话同 userId，独立 sessionId 绑定执行器。
  void start() {
    if (!DesktopScreenCapture.isSupported) return;
    if (_connecting || _connected) return;
    _connect();
  }

  void stop() {
    _subscription?.cancel();
    _subscription = null;
    try {
      _channel?.sink.close();
    } catch (_) {}
    _channel = null;
    _connecting = false;
    _connected = false;
    bridgeConnected.value = false;
  }

  void _connect() {
    _connecting = true;
    try {
      final WebSocketChannel ch = WebSocketChannel.connect(Uri.parse(ApiConfig.wsUrl));
      _channel = ch;
      _subscription = ch.stream.listen(
        _onMessage,
        onError: (_) => _handleDisconnect(),
        onDone: () => _handleDisconnect(),
        cancelOnError: false,
      );
      unawaited(
        ch.ready.then((_) {
          if (!identical(_channel, ch)) return;
          _connected = true;
          _connecting = false;
          bridgeConnected.value = true;
          _sendSessionInit();
        }).catchError((_) {
          if (!identical(_channel, ch)) return;
          _handleDisconnect();
        }),
      );
    } catch (_) {
      _handleDisconnect();
    }
  }

  void _handleDisconnect() {
    final bool was = _connected;
    stop();
    if (was) {
      Future<void>.delayed(const Duration(seconds: 4), () {
        if (!_connected && !_connecting) start();
      });
    }
  }

  void _sendSessionInit() {
    final String actor = ApiConfig.effectiveActorId;
    final Map<String, dynamic> payload = <String, dynamic>{
      "sessionId": "$actor$_bridgeSessionSuffix",
      "deviceId": "flutter-desktop-bridge",
      "userAlias": "flutter_bridge",
      "desktopBridge": true,
      "userId": actor,
    };
    _send("session.init", payload);
  }

  void _onMessage(dynamic data) {
    final Map<String, dynamic> event =
        jsonDecode(data.toString()) as Map<String, dynamic>;
    final String type = event["type"]?.toString() ?? "";
    final Map<String, dynamic> payload =
        (event["payload"] as Map?)?.cast<String, dynamic>() ?? <String, dynamic>{};

    if (type == "desktop.bridge.invoke") {
      unawaited(_handleInvoke(payload));
      return;
    }
    if (type == "error.event") {
      debugPrint("[DesktopBridge] error: ${payload["message"]}");
    }
  }

  Future<void> _handleInvoke(Map<String, dynamic> payload) async {
    final String jobId = payload["jobId"]?.toString() ?? "";
    if (jobId.isEmpty) return;

    final String action = payload["action"]?.toString() ?? "run_task";
    Map<String, dynamic> result;

    if (action == "screenshot") {
      result = await _runScreenshot(payload);
    } else {
      result = <String, dynamic>{
        "ok": false,
        "error":
            "Flutter 桌面桥接当前仅支持 screenshot；视觉 run_task 请使用 Python desktop-visual 桥接",
      };
    }

    _send("desktop.bridge.result", <String, dynamic>{"jobId": jobId, ...result});
  }

  Future<Map<String, dynamic>> _runScreenshot(Map<String, dynamic> payload) async {
    List<int>? region;
    final dynamic rawRegion = payload["region"];
    if (rawRegion is List && rawRegion.length == 4) {
      region = rawRegion
          .map((dynamic e) => e is num ? e.round() : 0)
          .toList(growable: false);
    }

    final Map<String, dynamic> cap = await DesktopScreenCapture.capture(region: region);
    if (cap["ok"] != true) {
      return <String, dynamic>{
        "ok": false,
        "error": cap["error"]?.toString() ?? "截图失败",
      };
    }

    return <String, dynamic>{
      "ok": true,
      "imageBase64": cap["imageBase64"],
      "mimeType": cap["mimeType"] ?? "image/png",
      "width": cap["width"],
      "height": cap["height"],
      "capturedAt": DateTime.now().toUtc().toIso8601String(),
    };
  }

  void _send(String type, Map<String, dynamic> payload) {
    final WebSocketChannel? ch = _channel;
    if (ch == null) return;
    try {
      ch.sink.add(jsonEncode(<String, dynamic>{"type": type, "payload": payload}));
    } catch (e) {
      debugPrint("[DesktopBridge] send failed: $e");
    }
  }
}
