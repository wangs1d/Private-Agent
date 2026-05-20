import "dart:async";
import "dart:convert";

import "package:web_socket_channel/web_socket_channel.dart";
import "package:web_socket_channel/status.dart" as status;

class WsChatService {
  WsChatService({required this.url});

  final String url;
  WebSocketChannel? _channel;
  final StreamController<Map<String, dynamic>> _eventsController =
      StreamController<Map<String, dynamic>>.broadcast();
  Timer? _reconnectTimer;
  int _reconnectAttempts = 0;
  static const int _maxReconnectAttempts = 10; // 增加重连尝试次数
  static const Duration _reconnectDelay = Duration(seconds: 2); // 减少重连间隔
  bool _isConnecting = false;

  Stream<Map<String, dynamic>> get events => _eventsController.stream;

  void connect() {
    if (!_isConnecting) {
      _connectWithRetry();
    }
  }

  void _connectWithRetry() {
    if (_isConnecting) return;
    
    _isConnecting = true;
    try {
      print('Attempting to connect to WebSocket at: $url');
      _channel = WebSocketChannel.connect(Uri.parse(url));
      
      _channel!.stream.listen(
        (dynamic data) {
          final Map<String, dynamic> event =
              jsonDecode(data.toString()) as Map<String, dynamic>;
          _eventsController.add(event);
          // 成功接收数据时重置重连计数
          _reconnectAttempts = 0;
          _isConnecting = false;
        },
        onError: (error) {
          print('WebSocket error: $error');
          _isConnecting = false;
          _handleConnectionError();
        },
        onDone: () {
          print('WebSocket connection closed');
          _isConnecting = false;
          _handleConnectionError();
        },
        cancelOnError: false,
      );
    } catch (e) {
      print('Failed to connect to WebSocket: $e');
      _isConnecting = false;
      _handleConnectionError();
    }
  }

  void _handleConnectionError() {
    if (_reconnectAttempts < _maxReconnectAttempts && !_isConnecting) {
      _reconnectAttempts++;
      print('Attempting to reconnect (${_reconnectAttempts}/$_maxReconnectAttempts) in ${_reconnectDelay.inSeconds} seconds...');
      
      // 取消之前的定时器（如果存在）
      _reconnectTimer?.cancel();
      
      // 设置延迟后重连
      _reconnectTimer = Timer(_reconnectDelay, () {
        _connectWithRetry();
      });
    } else if (_reconnectAttempts >= _maxReconnectAttempts) {
      print('Max reconnection attempts reached. Please check your network connection and server status.');
      // 发送一个错误事件给监听器
      _eventsController.add({
        'type': 'connection_error',
        'payload': {
          'message': '无法连接到服务器，请检查网络连接和服务器状态',
          'attempts': _reconnectAttempts,
          'url': url,
        }
      });
    }
  }

  void sendEvent(String type, Map<String, dynamic> payload) {
    if (_channel != null && _channel!.closeCode == null) {
      try {
        _channel?.sink.add(jsonEncode(<String, dynamic>{
          "type": type,
          "payload": payload,
        }));
      } catch (e) {
        print('Error sending event: $e');
        // 尝试重新连接
        _connectWithRetry();
      }
    } else {
      print('Cannot send event: WebSocket is not connected');
      // 尝试重新连接
      _connectWithRetry();
    }
  }

  Future<void> close() async {
    _reconnectTimer?.cancel();
    _isConnecting = false;
    await _channel?.sink.close(status.goingAway);
    await _eventsController.close();
  }
}
