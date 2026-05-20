class ChatSession {
  ChatSession({
    required this.sessionId,
    required this.title,
    required this.createdAt,
  });

  final String sessionId;
  final String title;
  final DateTime createdAt;
}

class ChatMessage {
  ChatMessage({
    required this.messageId,
    required this.sessionId,
    required this.role,
    required this.text,
    required this.timestamp,
    this.attachmentImageCount = 0,
    this.playUrl,
  });

  final String messageId;
  final String sessionId;
  final String role;
  final String text;
  final DateTime timestamp;
  /// 随本条用户消息发往服务端的配图张数（仅本地展示，不参与 WS 回包）。
  final int attachmentImageCount;
  /// 五子棋等对局入口（来自 tool.result 或回复文本解析）。
  final String? playUrl;
}
