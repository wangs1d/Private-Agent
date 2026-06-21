import "dart:async";
import "dart:convert";
import "dart:io";

import "package:flutter/foundation.dart";
import "package:flutter/services.dart";
import "package:web_socket_channel/web_socket_channel.dart";

import "../config/api_config.dart";

/// 手机桥接服务：在 Android 设备上运行，连接服务端 WebSocket，
/// 接收 `phone.bridge.invoke` 指令并通过 MethodChannel 调用原生能力。
///
/// 兼容华为/荣耀/HarmonyOS：不依赖 GMS，定位使用原生 LocationManager；
/// 通过前台服务 + 电池优化白名单 + 自启动权限对抗华为杀后台。
class PhoneBridgeService {
  PhoneBridgeService._();

  static final PhoneBridgeService instance = PhoneBridgeService._();

  static const Duration _reconnectDelay = Duration(seconds: 4);
  static const Duration _heartbeatInterval = Duration(seconds: 20);
  static const Duration _heartbeatTimeout = Duration(seconds: 45);

  static const MethodChannel _channel = MethodChannel("pai/phone_bridge");

  WebSocketChannel? _ws;
  StreamSubscription<dynamic>? _subscription;
  Timer? _reconnectTimer;
  Timer? _heartbeatTimer;
  bool _connecting = false;
  bool _connected = false;
  DateTime _lastInboundAt = DateTime.fromMillisecondsSinceEpoch(0);

  final ValueNotifier<bool> bridgeConnected = ValueNotifier<bool>(false);

  bool get isActive => _connected;

  void start() {
    if (kIsWeb || !Platform.isAndroid) return;
    if (_connecting || _connected) return;
    _connect();
  }

  void stop() {
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _stopHeartbeat();
    unawaited(_subscription?.cancel());
    _subscription = null;
    try {
      _ws?.sink.close(1000);
    } catch (_) {}
    _ws = null;
    _connecting = false;
    _connected = false;
    bridgeConnected.value = false;
  }

  void _connect() {
    _connecting = true;
    try {
      final WebSocketChannel ch = WebSocketChannel.connect(Uri.parse(ApiConfig.wsUrl));
      _ws = ch;
      _subscription = ch.stream.listen(
        (dynamic data) {
          if (!identical(_ws, ch)) return;
          _lastInboundAt = DateTime.now();
          _onMessage(data);
        },
        onError: (_) => _handleDisconnect(ch),
        onDone: () => _handleDisconnect(ch),
        cancelOnError: false,
      );
      unawaited(
        ch.ready.then((_) {
          if (!identical(_ws, ch)) return;
          _connected = true;
          _connecting = false;
          _lastInboundAt = DateTime.now();
          bridgeConnected.value = true;
          _startHeartbeat(ch);
          _sendSessionInit();
        }).catchError((_) {
          if (!identical(_ws, ch)) return;
          _handleDisconnect(ch);
        }),
      );
    } catch (_) {
      _handleDisconnect(_ws);
    }
  }

  void _handleDisconnect(WebSocketChannel? channel) {
    if (channel != null && !identical(_ws, channel)) return;
    final bool shouldReconnect = _ws != null || _connected || _connecting;
    _stopHeartbeat();
    unawaited(_subscription?.cancel());
    _subscription = null;
    try {
      _ws?.sink.close(1000);
    } catch (_) {}
    _ws = null;
    _connecting = false;
    _connected = false;
    bridgeConnected.value = false;
    if (!shouldReconnect) return;
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (kIsWeb || !Platform.isAndroid) return;
    if (_reconnectTimer != null) return;
    _reconnectTimer = Timer(_reconnectDelay, () {
      _reconnectTimer = null;
      if (!_connected && !_connecting) {
        start();
      }
    });
  }

  void _startHeartbeat(WebSocketChannel channel) {
    _stopHeartbeat();
    _heartbeatTimer = Timer.periodic(_heartbeatInterval, (_) {
      if (!identical(_ws, channel)) return;
      final DateTime now = DateTime.now();
      if (now.difference(_lastInboundAt) > _heartbeatTimeout) {
        _handleDisconnect(channel);
        return;
      }
      _sendEvent("ping", <String, dynamic>{});
    });
  }

  void _stopHeartbeat() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
  }

  void _sendSessionInit() {
    _sendEvent("session.init", <String, dynamic>{
      "userId": ApiConfig.effectiveActorId,
      "sessionId": ApiConfig.effectiveActorId,
      "phoneBridge": true,
      if (ApiConfig.phoneBridgeToken.isNotEmpty) "token": ApiConfig.phoneBridgeToken,
    });
  }

  void _sendEvent(String type, Map<String, dynamic> payload) {
    try {
      _ws?.sink.add(jsonEncode(<String, dynamic>{"type": type, "payload": payload}));
    } catch (_) {}
  }

  void _sendResult(String jobId, Map<String, dynamic> result) {
    _sendEvent("phone.bridge.result", <String, dynamic>{"jobId": jobId, ...result});
  }

  Future<void> _onMessage(dynamic data) async {
    final String text = data is String ? data : "";
    if (text.isEmpty) return;
    try {
      final Map<String, dynamic> envelope = jsonDecode(text) as Map<String, dynamic>;
      final String type = envelope["type"] as String? ?? "";
      final Map<String, dynamic> payload =
          (envelope["payload"] as Map?)?.cast<String, dynamic>() ?? <String, dynamic>{};

      if (type == "phone.bridge.invoke") {
        final String jobId = payload["jobId"] as String? ?? "";
        final String action = payload["action"] as String? ?? "";
        final Map<String, dynamic> params =
            (payload["params"] as Map?)?.cast<String, dynamic>() ?? <String, dynamic>{};
        await _handleAction(jobId, action, params);
      }
    } catch (_) {}
  }

  Future<void> _handleAction(String jobId, String action, Map<String, dynamic> params) async {
    try {
      switch (action) {
        case "battery":
          await _handleBattery(jobId);
        case "notifications":
          await _handleNotifications(jobId, params);
        case "camera_capture":
          await _handleCameraCapture(jobId, params);
        case "screen_record":
          await _handleScreenRecord(jobId, params);
        case "locate":
          await _handleLocate(jobId);
        case "ring":
          await _handleRing(jobId, params);
        case "sms_list":
          await _handleSmsList(jobId, params);
        case "call_log":
          await _handleCallLog(jobId, params);
        default:
          _sendResult(jobId, <String, dynamic>{"ok": false, "error": "unknown action: $action"});
      }
    } catch (e) {
      _sendResult(jobId, <String, dynamic>{"ok": false, "error": e.toString()});
    }
  }

  Future<void> _handleBattery(String jobId) async {
    final result = await _channel.invokeMethod<Map>("battery", <String, dynamic>{});
    _sendResult(jobId, _mapResult(result));
  }

  Future<void> _handleNotifications(String jobId, Map<String, dynamic> params) async {
    final result = await _channel.invokeMethod<Map>(
      "notifications",
      <String, dynamic>{"limit": params["limit"] ?? 20},
    );
    _sendResult(jobId, _mapResult(result));
  }

  Future<void> _handleCameraCapture(String jobId, Map<String, dynamic> params) async {
    final result = await _channel.invokeMethod<Map>(
      "camera_capture",
      <String, dynamic>{"camera": params["camera"] ?? "back"},
    );
    _sendResult(jobId, _mapResult(result));
  }

  Future<void> _handleScreenRecord(String jobId, Map<String, dynamic> params) async {
    final result = await _channel.invokeMethod<Map>(
      "screen_record",
      <String, dynamic>{"durationSec": params["durationSec"] ?? 15},
    );
    _sendResult(jobId, _mapResult(result));
  }

  Future<void> _handleLocate(String jobId) async {
    final result = await _channel.invokeMethod<Map>("locate", <String, dynamic>{});
    _sendResult(jobId, _mapResult(result));
  }

  Future<void> _handleRing(String jobId, Map<String, dynamic> params) async {
    final result = await _channel.invokeMethod<Map>(
      "ring",
      <String, dynamic>{
        "reason": params["reason"] ?? "",
        "durationSec": params["durationSec"] ?? 15,
        "volume": params["volume"] ?? 100,
        "vibrate": params["vibrate"] ?? true,
      },
    );
    _sendResult(jobId, _mapResult(result));
  }

  Future<void> _handleSmsList(String jobId, Map<String, dynamic> params) async {
    final result = await _channel.invokeMethod<Map>(
      "sms_list",
      <String, dynamic>{"limit": params["limit"] ?? 20},
    );
    _sendResult(jobId, _mapResult(result));
  }

  Future<void> _handleCallLog(String jobId, Map<String, dynamic> params) async {
    final result = await _channel.invokeMethod<Map>(
      "call_log",
      <String, dynamic>{"limit": params["limit"] ?? 20},
    );
    _sendResult(jobId, _mapResult(result));
  }

  Map<String, dynamic> _mapResult(Map? result) {
    return result?.cast<String, dynamic>() ?? <String, dynamic>{"ok": false, "error": "no result"};
  }

  /// 供 UI 调用：获取华为/荣耀兼容状态。
  Future<Map<String, dynamic>> getCompatStatus() async {
    final result = await _channel.invokeMethod<Map>("getCompatStatus", <String, dynamic>{});
    return result?.cast<String, dynamic>() ?? <String, dynamic>{"ok": false};
  }

  /// 供 UI 调用：跳转指定系统设置页。
  Future<void> openSettingsByKey(String key) async {
    await _channel.invokeMethod<void>("openSettingsByKey", <String, dynamic>{"key": key});
  }

  /// 启动前台保活服务（应在授权完成后调用）。
  Future<void> startForegroundService() async {
    await _channel.invokeMethod<void>("startForegroundService", <String, dynamic>{});
  }

  /// 停止前台保活服务。
  Future<void> stopForegroundService() async {
    await _channel.invokeMethod<void>("stopForegroundService", <String, dynamic>{});
  }

  /// 本地直接调用原生能力（供 UI 测试/手动触发）。
  Future<Map<String, dynamic>> invokeLocal(String action, Map<String, dynamic> params) async {
    final result = await _channel.invokeMethod<Map>(action, params);
    return result?.cast<String, dynamic>() ?? <String, dynamic>{"ok": false, "error": "no result"};
  }
}
