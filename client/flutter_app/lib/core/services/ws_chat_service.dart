import "dart:async";
import "dart:convert";

import "package:web_socket_channel/web_socket_channel.dart";
import "package:web_socket_channel/status.dart" as status;

class _PendingWsEvent {
  const _PendingWsEvent({required this.type, required this.payload});

  final String type;
  final Map<String, dynamic> payload;
}

class WsChatService {
  WsChatService({required this.url});

  final String url;
  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _subscription;
  final StreamController<Map<String, dynamic>> _eventsController =
      StreamController<Map<String, dynamic>>.broadcast();
  Timer? _reconnectTimer;
  Timer? _heartbeatTimer;
  int _reconnectAttempts = 0;
  static const int _maxReconnectAttempts = 10;
  static const Duration _initialReconnectDelay = Duration(seconds: 2);
  static const Duration _maxReconnectDelay = Duration(seconds: 30);
  static const Duration _heartbeatInterval = Duration(seconds: 20);
  static const Duration _heartbeatTimeout = Duration(seconds: 45);
  bool _isConnecting = false;
  bool _isConnected = false;
  final List<_PendingWsEvent> _pendingOutbound = <_PendingWsEvent>[];
  DateTime _lastInboundAt = DateTime.fromMillisecondsSinceEpoch(0);

  /// 连接就绪（含重连后）时回调；应在此时发送 `session.init`。
  void Function()? onConnected;

  Stream<Map<String, dynamic>> get events => _eventsController.stream;

  bool get isConnected => _isConnected;

  void connect() {
    if (!_isConnecting && !_isConnected) {
      _connectWithRetry();
    }
  }

  /// 放弃重连计数后再次尝试（例如用户从设置页手动重连）。
  void retryConnect() {
    _reconnectAttempts = 0;
    _reconnectTimer?.cancel();
    _stopHeartbeat();
    unawaited(_subscription?.cancel());
    _subscription = null;
    _isConnecting = false;
    _isConnected = false;
    try {
      _channel?.sink.close(1000); // 使用正常的关闭代码
    } catch (e) {
      // WebSocket close error - silently ignore
    }
    _channel = null;
    _connectWithRetry();
  }

  void _connectWithRetry() {
    if (_isConnecting) return;

    _isConnecting = true;
    try {
      final WebSocketChannel channel = WebSocketChannel.connect(Uri.parse(url));
      _channel = channel;

      _subscription = channel.stream.listen(
        (dynamic data) {
          if (!identical(_channel, channel)) return;
          _lastInboundAt = DateTime.now();
          final Map<String, dynamic> event =
              jsonDecode(data.toString()) as Map<String, dynamic>;
          _eventsController.add(event);
        },
        onError: (Object error) {
          _handleDisconnect(channel);
        },
        onDone: () {
          _handleDisconnect(channel);
        },
        cancelOnError: false,
      );

      unawaited(
        channel.ready.then((_) {
          if (!identical(_channel, channel)) return;
          _isConnected = true;
          _reconnectAttempts = 0;
          _isConnecting = false;
          _lastInboundAt = DateTime.now();
          _startHeartbeat(channel);
          _flushPendingOutbound();
          onConnected?.call();
        }).catchError((Object _) {
          if (!identical(_channel, channel)) return;
          _handleDisconnect(channel);
        }),
      );
    } catch (e) {
      _notifyDisconnected();
      _handleConnectionError();
    }
  }

  void _notifyDisconnected() {
    final bool wasConnected = _isConnected;
    _markDisconnected();
    if (wasConnected) {
      _eventsController.add(<String, dynamic>{
        "type": "ws_disconnected",
        "payload": <String, dynamic>{
          "message": "与服务器的连接已断开",
        },
      });
    }
  }

  void _markDisconnected() {
    _isConnected = false;
    _isConnecting = false;
  }

  void _handleDisconnect(WebSocketChannel channel) {
    if (!identical(_channel, channel)) return;
    _stopHeartbeat();
    unawaited(_subscription?.cancel());
    _subscription = null;
    _channel = null;
    _notifyDisconnected();
    _handleConnectionError();
  }

  void _startHeartbeat(WebSocketChannel channel) {
    _stopHeartbeat();
    _heartbeatTimer = Timer.periodic(_heartbeatInterval, (_) {
      if (!identical(_channel, channel)) {
        _stopHeartbeat();
        return;
      }
      if (!_isConnected) return;
      final Duration idle = DateTime.now().difference(_lastInboundAt);
      if (idle > _heartbeatTimeout) {
        _handleDisconnect(channel);
        return;
      }
      _sendNow(
        "ws.keepalive",
        <String, dynamic>{
          "clientTime": DateTime.now().toIso8601String(),
        },
      );
    });
  }

  void _stopHeartbeat() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
  }

  void _flushPendingOutbound() {
    if (!_isConnected || _channel == null) return;
    final List<_PendingWsEvent> batch =
        List<_PendingWsEvent>.from(_pendingOutbound);
    _pendingOutbound.clear();
    for (final _PendingWsEvent item in batch) {
      _sendNow(item.type, item.payload);
    }
  }

  void _handleConnectionError() {
    if (_reconnectAttempts < _maxReconnectAttempts && !_isConnecting) {
      _reconnectAttempts++;

      final Duration currentDelay = _calculateBackoffDelay();
      print(
        "Attempting to reconnect ($_reconnectAttempts/$_maxReconnectAttempts) "
        "in ${currentDelay.inSeconds} seconds...",
      );

      _reconnectTimer?.cancel();
      _reconnectTimer = Timer(currentDelay, () {
        _connectWithRetry();
      });
    } else if (_reconnectAttempts >= _maxReconnectAttempts) {
      print(
        "Max reconnection attempts reached. Please check your network "
        "connection and server status.",
      );
      _eventsController.add(<String, dynamic>{
        "type": "connection_error",
        "payload": <String, dynamic>{
          "message": "无法连接到服务器，请检查网络连接和服务器状态",
          "attempts": _reconnectAttempts,
          "url": url,
        },
      });
    }
  }

  Duration _calculateBackoffDelay() {
    final int exponent = _reconnectAttempts - 1;
    final int delayInSeconds = (_initialReconnectDelay.inSeconds * (1 << exponent)).clamp(
      _initialReconnectDelay.inSeconds,
      _maxReconnectDelay.inSeconds,
    );
    return Duration(seconds: delayInSeconds);
  }

  bool sendEvent(String type, Map<String, dynamic> payload) {
    if (_isConnected && _channel != null && _channel!.closeCode == null) {
      final result = _sendNow(type, payload);
      return result;
    }
    _pendingOutbound.add(_PendingWsEvent(type: type, payload: payload));
    if (!_isConnecting) {
      _connectWithRetry();
    }
    return false;
  }

  bool _sendNow(String type, Map<String, dynamic> payload) {
    if (_channel == null || _channel!.closeCode != null) {
      return false;
    }
    try {
      final message = jsonEncode(<String, dynamic>{
        "type": type,
        "payload": payload,
      });
      _channel!.sink.add(message);
      return true;
    } catch (e) {
      _markDisconnected();
      _pendingOutbound.add(_PendingWsEvent(type: type, payload: payload));
      _handleConnectionError();
      return false;
    }
  }

  Future<void> close() async {
    _reconnectTimer?.cancel();
    _stopHeartbeat();
    await _subscription?.cancel();
    _subscription = null;
    _isConnecting = false;
    _isConnected = false;
    _pendingOutbound.clear();
    await _channel?.sink.close(status.goingAway);
    await _eventsController.close();
  }
}
