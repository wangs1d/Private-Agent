import "dart:async";
import "../../../core/services/ws_chat_service.dart";
import "game_chat_widget.dart";

class GameChatService {
  final WsChatService? ws;
  final String? sessionId;
  final String? tableId;
  final void Function(GameChatMessage message)? onNewMessage;

  StreamSubscription<Map<String, dynamic>>? _wsSub;
  final List<GameChatMessage> _messages = <GameChatMessage>[];

  List<GameChatMessage> get messages => List.unmodifiable(_messages);

  GameChatService({
    this.ws,
    this.sessionId,
    this.tableId,
    this.onNewMessage,
  });

  void init() {
    if (ws == null) return;
    _wsSub = ws!.events.listen(_handleWsEvent);
  }

  void dispose() {
    _wsSub?.cancel();
  }

  void _handleWsEvent(Map<String, dynamic> event) {
    final String type = event["type"]?.toString() ?? "";
    
    if (type == "world.gomoku.chat.message" || type == "world.chat.message") {
      final Object? payload = event["payload"];
      if (payload is! Map) return;
      final Map<String, dynamic> p = payload.cast<String, dynamic>();
      final String message = p["message"]?.toString() ?? "";
      final String sender = p["sender"]?.toString() ?? "";
      
      if (message.isNotEmpty && sender == "agent") {
        addAgentMessage(message);
      }
    }
  }

  void addAgentMessage(String text) {
    final msg = GameChatMessage(
      id: DateTime.now().millisecondsSinceEpoch.toString(),
      text: text,
      isUser: false,
      timestamp: DateTime.now(),
    );
    _messages.add(msg);
    onNewMessage?.call(msg);
  }

  void sendMessage(String text) {
    if (text.trim().isEmpty) return;
    
    final userMsg = GameChatMessage(
      id: DateTime.now().millisecondsSinceEpoch.toString(),
      text: text,
      isUser: true,
      timestamp: DateTime.now(),
    );
    _messages.add(userMsg);
    onNewMessage?.call(userMsg);
    
    if (tableId != null) {
      ws?.sendEvent("world.gomoku.chat", <String, dynamic>{
        "tableId": tableId,
        "message": text,
      });
    } else if (sessionId != null) {
      ws?.sendEvent("world.chat.send", <String, dynamic>{
        "message": text,
        "sessionId": sessionId,
      });
    }
  }

  void clearMessages() {
    _messages.clear();
  }
}
