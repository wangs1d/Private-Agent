/// 消息附件类型。
enum MessageAttachmentType {
  audio,
  image,
  video,
}

/// 消息附件（语音 / 图片 / 视频）。
class MessageAttachment {
  MessageAttachment({
    required this.type,
    required this.url,
    this.durationMs,
    this.waveform,
    this.transcript,
    this.mimeType,
  });

  /// 附件类型。
  final MessageAttachmentType type;

  /// 可访问的 URL，如 `/agent/voice/messages/{actorId}/{msgId}.mp3`。
  final String url;

  /// 音频时长（毫秒），仅 type=audio 有效。
  final int? durationMs;

  /// 波形数据（0.0-1.0），仅 type=audio 有效；为 null 时用静默 placeholder 渲染。
  final List<double>? waveform;

  /// 文本备份（语音消息的转录文本），无障碍 / 不可播放时降级展示。
  final String? transcript;

  /// MIME 类型（如 `audio/mpeg`）。
  final String? mimeType;

  /// 从原始 JSON 构造（兼容服务端字段）。
  factory MessageAttachment.fromJson(Map<String, dynamic> json) {
    final typeStr = (json["type"] ?? "").toString().toLowerCase();
    MessageAttachmentType type;
    switch (typeStr) {
      case "audio":
        type = MessageAttachmentType.audio;
        break;
      case "image":
        type = MessageAttachmentType.image;
        break;
      case "video":
        type = MessageAttachmentType.video;
        break;
      default:
        // 默认按音频处理（语音消息主用场景）
        type = MessageAttachmentType.audio;
    }
    return MessageAttachment(
      type: type,
      url: (json["url"] ?? json["mediaUrl"] ?? "").toString(),
      durationMs: json["durationMs"] is int
          ? json["durationMs"] as int
          : (json["durationMs"] is num
              ? (json["durationMs"] as num).toInt()
              : null),
      waveform: json["waveform"] is List
          ? (json["waveform"] as List)
              .map((e) => (e as num).toDouble())
              .toList()
          : null,
      transcript: json["transcript"]?.toString(),
      mimeType: json["mimeType"]?.toString(),
    );
  }

  Map<String, dynamic> toJson() => {
        "type": type.name,
        "url": url,
        if (durationMs != null) "durationMs": durationMs,
        if (waveform != null) "waveform": waveform,
        if (transcript != null) "transcript": transcript,
        if (mimeType != null) "mimeType": mimeType,
      };
}

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
    this.attachments = const [],
    this.contentType = "text",
    this.durationMs,
    this.waveform,
  });

  final String messageId;
  final String sessionId;
  final String role;
  final String text;
  final DateTime timestamp;
  /// 随本条用户消息发往服务端的配图张数（仅本地展示，不参与 WS 回包）。
  final int attachmentImageCount;
  /// 对局入口（来自 tool.result 或回复文本解析）。
  final String? playUrl;

  /// 消息附件列表（语音 / 图片 / 视频）。
  /// agent 发的语音消息、用户上传的语音消息都会落到这里。
  final List<MessageAttachment> attachments;

  /// 消息内容类型：`text` / `audio`。
  /// 用于区分纯文本消息和语音消息（用户端录音上传时使用）。
  final String contentType;

  /// 当 contentType=audio 时的音频时长（毫秒）。
  final int? durationMs;

  /// 当 contentType=audio 时的波形数据（0.0-1.0）。
  final List<double>? waveform;
}
