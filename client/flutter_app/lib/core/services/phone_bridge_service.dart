import "dart:async";
import "dart:convert";
import "dart:io" show Platform;

import "package:flutter/foundation.dart";
import "package:web_socket_channel/web_socket_channel.dart";
import "package:web_socket_channel/status.dart" as ws_status;

import "../config/api_config.dart";
import "phone_dial_invoker.dart";

/// 手机桥接连接状态（供设置页开关旁的状态展示）。
enum PhoneBridgeStatus { disabled, connecting, online, offline }

/// 手机桥接客户端服务（运行在用户手机 App 内）。
///
/// 与网关建立一条**独立**于聊天会话的 WebSocket 连接：`session.init` 携带
/// `phoneBridge: true` + `userId`，把本机绑定为该用户的「手机执行器」，
/// 随后接收 `phone.bridge.invoke` 并以 `phone.bridge.result` 回执：
///  - `dial`：经 [PhoneDialInvoker] 拉起原生确认窗 → 用户确认后拨号；
///  - 其余 action：回执 `action_not_supported` 快速失败，
///    避免服务端invoke 等满 30s 超时（battery/ring 等能力后续按需补齐）。
///
/// 服务端协议（ws/connection.ts + phone-bridge-coordinator.ts）：
///  - 无口令模式（未配置 PHONE_BRIDGE_TOKEN）：session.init 即自动绑定；
///  - 口令模式：需再发 `phone.bridge.register` 携带 token。本服务两种都发，
///    重复 register 在无口令模式下只是幂等重复绑定，服务端行为安全。
class PhoneBridgeService {
  PhoneBridgeService._();

  static final PhoneBridgeService instance = PhoneBridgeService._();

  /// 本地偏好 key（是否启用手机桥接；默认开启，仅 Android 生效）
  static const String _prefKeyEnabled = "phone_bridge.enabled";

  static const String _bridgeTokenFromEnv = String.fromEnvironment(
    "PHONE_BRIDGE_TOKEN",
  );

  Future<dynamic> Function(String key)? _readPref;
  Future<void> Function(String key, dynamic value)? _writePref;

  final ValueNotifier<PhoneBridgeStatus> status =
      ValueNotifier<PhoneBridgeStatus>(PhoneBridgeStatus.offline);

  bool _enabled = false;
  bool get isEnabled => _enabled;

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _subscription;
  Timer? _reconnectTimer;
  Timer? _keepaliveTimer;
  int _reconnectAttempts = 0;
  bool _manualStopped = false;

  static const Duration _initialReconnectDelay = Duration(seconds: 2);
  static const Duration _maxReconnectDelay = Duration(seconds: 30);
  static const Duration _keepaliveInterval = Duration(seconds: 20);

  /// 注入本地偏好存取（与 ClientLocationService.bindPreferences 同模式，
  /// 由宿主在存储初始化后调用）。
  void bindPreferences({
    required Future<dynamic> Function(String key) read,
    required Future<void> Function(String key, dynamic value) write,
  }) {
    _readPref = read;
    _writePref = write;
  }

  /// 启动时恢复开关状态：默认启用（Android）。读偏好失败按启用处理。
  Future<void> restoreAndStart() async {
    bool enabled = true;
    final reader = _readPref;
    if (reader != null) {
      try {
        final dynamic saved = await reader(_prefKeyEnabled);
        if (saved is bool) enabled = saved;
      } catch (_) {
        // 读不到偏好按默认开启处理
      }
    }
    _enabled = enabled;
    if (_enabled) {
      start();
    } else {
      status.value = PhoneBridgeStatus.disabled;
    }
  }

  /// 用户在设置页开启：持久化 + 立即连接。
  Future<void> enable() async {
    _enabled = true;
    final writer = _writePref;
    if (writer != null) {
      try {
        await writer(_prefKeyEnabled, true);
      } catch (_) {
        // 持久化失败不影响本次会话内生效
      }
    }
    start();
  }

  /// 用户在设置页关闭：持久化 + 断开并停止重连。
  Future<void> disable() async {
    _enabled = false;
    final writer = _writePref;
    if (writer != null) {
      try {
        await writer(_prefKeyEnabled, false);
      } catch (_) {
        // 同上
      }
    }
    stop();
    status.value = PhoneBridgeStatus.disabled;
  }

  /// 建立桥接连接（幂等：已连接/连接中时跳过）。
  void start() {
    _manualStopped = false;
    if (_channel != null || _reconnectTimer != null) return;
    status.value = PhoneBridgeStatus.connecting;
    _connect();
  }

  /// 断开并停止重连（设置页关闭开关时调用）。
  void stop() {
    _manualStopped = true;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _keepaliveTimer?.cancel();
    _keepaliveTimer = null;
    _teardownChannel();
  }

  void _connect() {
    if (_manualStopped || !_enabled) return;
    final WebSocketChannel channel = WebSocketChannel.connect(
      Uri.parse(ApiConfig.wsUrl),
    );
    _channel = channel;

    _subscription = channel.stream.listen(
      (dynamic data) {
        if (!identical(_channel, channel)) return;
        _handleServerMessage(data.toString());
      },
      onError: (Object _) => _handleDisconnect(channel),
      onDone: () => _handleDisconnect(channel),
      cancelOnError: false,
    );

    unawaited(
      channel.ready.then((_) {
        if (!identical(_channel, channel)) return;
        _reconnectAttempts = 0;
        status.value = PhoneBridgeStatus.offline; // 绑定成功后才算 online
        _send("session.init", _sessionInitPayload());
        _send("phone.bridge.register", _registerPayload());
        _startKeepalive(channel);
      }).catchError((Object _) {
        if (!identical(_channel, channel)) return;
        _handleDisconnect(channel);
      }),
    );
  }

  Map<String, dynamic> _deviceInfoPayload() {
    return <String, dynamic>{
      "model": "flutter-app",
      "manufacturer": Platform.operatingSystem,
      "brand": Platform.operatingSystem,
      "systemVersion": Platform.operatingSystemVersion,
    };
  }

  /// 手机桥接通道必须提供 userId（服务端拒绝仅 sessionId 的桥接绑定），
  /// 统一用 effectiveActorId，与聊天会话的 actorId 保持一致。
  Map<String, dynamic> _sessionInitPayload() {
    return <String, dynamic>{
      "sessionId": "phone-bridge-${ApiConfig.sessionId}",
      "userId": ApiConfig.effectiveActorId,
      "phoneBridge": true,
      "deviceId": "phone-bridge",
      ..._deviceInfoPayload(),
    };
  }

  Map<String, dynamic> _registerPayload() {
    return <String, dynamic>{
      "token": _bridgeTokenFromEnv,
      ..._deviceInfoPayload(),
    };
  }

  void _handleServerMessage(String raw) {
    Map<String, dynamic> event;
    try {
      final dynamic decoded = jsonDecode(raw);
      if (decoded is! Map) return;
      event = decoded.cast<String, dynamic>();
    } catch (_) {
      return;
    }
    final String type = event["type"]?.toString() ?? "";
    final Map<String, dynamic> payload =
        ((event["payload"] ?? const <String, dynamic>{}) as Map)
            .cast<String, dynamic>();

    switch (type) {
      case "phone.bridge.invoke":
        unawaited(_handleInvoke(payload));
        break;
      case "phone.bridge.register_ack":
        final bool ok = payload["ok"] == true;
        status.value = ok ? PhoneBridgeStatus.online : PhoneBridgeStatus.offline;
        debugPrint("[PhoneBridge] register_ack mode=${payload["mode"]} ok=$ok");
        break;
      case "phone.bridge.sync":
        // 其他设备的绑定变化同步；本机在线性以自身 socket 为准，这里仅留日志。
        debugPrint(
          "[PhoneBridge] sync online=${payload["phoneBridgeOnline"]} at=${payload["updatedAt"]}",
        );
        break;
      case "error":
        debugPrint(
          "[PhoneBridge] server error code=${payload["code"]} msg=${payload["message"]}",
        );
        break;
      default:
        break;
    }
  }

  /// 服务端下发指令：目前只实现 dial，其余 action 快速失败。
  Future<void> _handleInvoke(Map<String, dynamic> payload) async {
    final String jobId = payload["jobId"]?.toString().trim() ?? "";
    if (jobId.isEmpty) return;
    final String action = payload["action"]?.toString() ?? "";

    Map<String, dynamic> result;
    if (action == "dial") {
      result = await _invokeDial(
        (payload["params"] ?? const <String, dynamic>{}) as Map,
      );
    } else {
      result = <String, dynamic>{"ok": false, "error": "action_not_supported:$action"};
    }

    _send("phone.bridge.result", <String, dynamic>{"jobId": jobId, ...result});
  }

  /// 拨号：native 侧自带 confirmTimeoutSec 兜底，这里再加 25s 硬超时，
  /// 保证永远赶在服务端 30s invoke 超时之前回执。
  Future<Map<String, dynamic>> _invokeDial(Map params) async {
    final p = params.cast<String, dynamic>();
    try {
      return await PhoneDialInvoker.dial(
        number: p["number"]?.toString() ?? "",
        contactName: p["contactName"]?.toString() ?? "",
        reason: p["reason"]?.toString() ?? "",
        mode: p["mode"]?.toString() ?? "direct",
        confirmTimeoutSec: 20,
      ).timeout(
        const Duration(seconds: 25),
        onTimeout: () =>
            <String, dynamic>{"ok": false, "error": "dial_timeout", "state": "cancelled"},
      );
    } catch (e) {
      return <String, dynamic>{"ok": false, "error": "dial_exception:$e"};
    }
  }

  void _startKeepalive(WebSocketChannel channel) {
    _keepaliveTimer?.cancel();
    _keepaliveTimer = Timer.periodic(_keepaliveInterval, (_) {
      if (!identical(_channel, channel)) {
        _keepaliveTimer?.cancel();
        _keepaliveTimer = null;
        return;
      }
      _sendNow("ws.keepalive", <String, dynamic>{
        "clientTime": DateTime.now().toIso8601String(),
        "reason": "phone_bridge",
      });
    });
  }

  void _handleDisconnect(WebSocketChannel channel) {
    if (!identical(_channel, channel)) return;
    _keepaliveTimer?.cancel();
    _keepaliveTimer = null;
    _teardownChannel();
    if (_manualStopped || !_enabled) return;
    status.value = PhoneBridgeStatus.offline;
    _scheduleReconnect();
  }

  void _teardownChannel() {
    unawaited(_subscription?.cancel());
    _subscription = null;
    try {
      _channel?.sink.close(ws_status.goingAway);
    } catch (_) {
      // 已断开时 close 可能抛错，忽略
    }
    _channel = null;
  }

  void _scheduleReconnect() {
    if (_reconnectTimer != null) return;
    final int exponent = _reconnectAttempts.clamp(0, 8);
    final int delaySec = (_initialReconnectDelay.inSeconds * (1 << exponent)).clamp(
      _initialReconnectDelay.inSeconds,
      _maxReconnectDelay.inSeconds,
    );
    _reconnectAttempts += 1;
    status.value = PhoneBridgeStatus.connecting;
    _reconnectTimer = Timer(Duration(seconds: delaySec), () {
      _reconnectTimer = null;
      _connect();
    });
  }

  bool _send(String type, Map<String, dynamic> payload) {
    return _sendNow(type, payload);
  }

  bool _sendNow(String type, Map<String, dynamic> payload) {
    final channel = _channel;
    if (channel == null || channel.closeCode != null) return false;
    try {
      channel.sink.add(jsonEncode(<String, dynamic>{
        "type": type,
        "payload": payload,
      }));
      return true;
    } catch (_) {
      return false;
    }
  }
}
