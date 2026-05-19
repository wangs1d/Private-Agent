import "dart:async";
import "dart:convert";

import "package:web_socket_channel/web_socket_channel.dart";

class WsChatService {
  WsChatService({required this.url});

  final String url;
  WebSocketChannel? _channel;
  final StreamController<Map<String, dynamic>> _eventsController =
      StreamController<Map<String, dynamic>>.broadcast();

  Stream<Map<String, dynamic>> get events => _eventsController.stream;

  void connect() {
    _channel = WebSocketChannel.connect(Uri.parse(url));
    _channel!.stream.listen((dynamic data) {
      final Map<String, dynamic> event =
          jsonDecode(data.toString()) as Map<String, dynamic>;
      _eventsController.add(event);
    });
  }

  void sendEvent(String type, Map<String, dynamic> payload) {
    _channel?.sink.add(jsonEncode(<String, dynamic>{
      "type": type,
      "payload": payload,
    }));
  }

  Future<void> close() async {
    await _channel?.sink.close();
    await _eventsController.close();
  }
}
