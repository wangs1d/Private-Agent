import "dart:async";

import "package:flutter/foundation.dart";

import "../core/config/api_config.dart";
import "../core/services/ws_chat_service.dart";
import "../core/models/chat_models.dart";

/// 手机端对话控制器：复用 [WsChatService] 连接与桌面端同一后端，数据/会话自动同步。
///
/// 协议(与桌面端一致)：
/// - 连接成功 → `session.init`(携带 userId/sessionId,后端按 userId 绑定 actor,两端同步)
/// - 发送 → `chat.user_message`(messageId/text/timestamp/userId/agentAccessMode)
/// - 接收 → `chat.turn_started/interim`(思考态)、`chat.assistant_chunk`(流式正文)、
///   `chat.assistant_done`(收尾最终文本)
class MobileChatController extends ChangeNotifier {
  MobileChatController({String? wsBaseUrl}) {
    _service = WsChatService(url: wsBaseUrl ?? ApiConfig.wsUrl);
    _service.onConnected = _sendSessionInit;
    _subscription = _service.events.listen(_onWsEvent);
    _service.connect();
  }

  late final WsChatService _service;
  StreamSubscription? _subscription;

  /// 对话历史(含正在流式生成的助手消息)。
  final List<ChatMessage> messages = <ChatMessage>[];

  /// Agent 是否正在思考 / 生成中。
  bool isProcessing = false;

  /// 连接状态文案(用于顶栏状态点)。
  bool isConnected = false;

  /// 错误提示(轻提示用)。
  String? errorMessage;

  /// 当前流式助手消息 id。
  String? _streamingMessageId;

  /// 打开一个新会话：仅清空本地内存，仍连接同一后端。
  void reset() {
    messages.clear();
    _streamingMessageId = null;
    isProcessing = false;
    notifyListeners();
  }

  void _sendSessionInit() {
    final Map<String, dynamic> init = <String, dynamic>{
      "sessionId": ApiConfig.sessionId,
      "deviceId": "mobile-${defaultTargetPlatform.name}",
      "userAlias": "owner",
    };
    final String uid = ApiConfig.userId.trim();
    if (uid.isNotEmpty) init["userId"] = uid;
    _service.sendEvent("session.init", init);
  }

  /// 发送一条用户消息(空/纯空白忽略)。
  Future<void> send(String raw) async {
    final String text = raw.trim();
    if (text.isEmpty) return;
    if (!_service.isConnected) {
      _service.retryConnect();
      errorMessage = "正在连接服务器,请稍后再发";
      notifyListeners();
      return;
    }
    final ChatMessage userMsg = ChatMessage(
      messageId: "msg-${DateTime.now().microsecondsSinceEpoch}",
      sessionId: ApiConfig.effectiveActorId,
      role: "user",
      text: text,
      timestamp: DateTime.now(),
    );
    messages.add(userMsg);
    isProcessing = true;
    errorMessage = null;
    notifyListeners();

    final Map<String, dynamic> payload = <String, dynamic>{
      "sessionId": ApiConfig.sessionId,
      "messageId": userMsg.messageId,
      "text": text,
      "timestamp": DateTime.now().toIso8601String(),
      "agentAccessMode": "full",
    };
    final String uid = ApiConfig.userId.trim();
    if (uid.isNotEmpty) payload["userId"] = uid;
    _service.sendEvent("chat.user_message", payload);
  }

  void _onWsEvent(Map<String, dynamic> event) {
    final String type = event["type"]?.toString() ?? "";
    final Map<String, dynamic> payload =
        event["payload"] is Map ? event["payload"] as Map<String, dynamic> : const {};
    switch (type) {
      case "ws_connected":
        isConnected = true;
        notifyListeners();
      case "ws_disconnected":
      case "connection_error":
        isConnected = false;
        notifyListeners();
      case "chat.turn_started":
      case "chat.assistant_interim":
        _openStreamingMessage(payload);
        isProcessing = true;
        notifyListeners();
      case "chat.assistant_chunk":
        _appendChunk(payload);
      case "chat.assistant_done":
        _finalizeReply(payload);
      case "chat.error":
        isProcessing = false;
        errorMessage = payload["message"]?.toString() ?? "出错了,请重试";
        notifyListeners();
    }
  }

  /// 思考态或流式开始时,确保有一条等待中的助手消息。
  void _openStreamingMessage(Map<String, dynamic> payload) {
    if (_streamingMessageId != null) return;
    final String? traceId = payload["traceId"]?.toString();
    final String id =
        payload["messageId"]?.toString() ??
        (traceId != null && traceId.isNotEmpty ? "assistant-$traceId" : "assistant-streaming");
    messages.add(ChatMessage(
      messageId: id,
      sessionId: ApiConfig.effectiveActorId,
      role: "assistant",
      text: "",
      timestamp: DateTime.now(),
      streaming: true,
    ));
    _streamingMessageId = id;
  }

  void _appendChunk(Map<String, dynamic> payload) {
    _openStreamingMessage(payload);
    final String chunk = payload["chunk"]?.toString() ?? "";
    if (chunk.isEmpty) return;
    final int idx = messages.indexWhere(
      (m) => m.messageId == _streamingMessageId,
    );
    if (idx < 0) return;
    final ChatMessage prev = messages[idx];
    messages[idx] = ChatMessage(
      messageId: prev.messageId,
      sessionId: prev.sessionId,
      role: prev.role,
      text: prev.text + chunk,
      timestamp: prev.timestamp,
      streaming: true,
    );
    isProcessing = true;
    notifyListeners();
  }

  void _finalizeReply(Map<String, dynamic> payload) {
    final String? traceId = payload["traceId"]?.toString();
    final String? messageId = payload["messageId"]?.toString();
    // 优先用已经打开的流式消息;否则尝试按 trace 对齐
    int idx;
    if (_streamingMessageId != null) {
      idx = messages.indexWhere((m) => m.messageId == _streamingMessageId);
    } else {
      final String traceKey =
          traceId != null && traceId.isNotEmpty ? "assistant-$traceId" : "assistant-final";
      idx = messages.indexWhere(
        (m) => m.messageId == traceKey || (messageId != null && m.messageId == messageId),
      );
    }
    final String finalText = payload["finalText"]?.toString() ?? "";
    if (idx < 0) {
      // 没有流式占位:直接落一条最终消息
      messages.add(ChatMessage(
        messageId: messageId ?? "assistant-final",
        sessionId: ApiConfig.effectiveActorId,
        role: "assistant",
        text: finalText,
        timestamp: DateTime.now(),
      ));
    } else {
      final ChatMessage prev = messages[idx];
      messages[idx] = ChatMessage(
        messageId: messageId ?? prev.messageId,
        sessionId: prev.sessionId,
        role: prev.role,
        text: finalText.isNotEmpty ? finalText : prev.text,
        timestamp: prev.timestamp,
        streaming: false,
      );
    }
    _streamingMessageId = null;
    isProcessing = false;
    notifyListeners();
  }

  @override
  void dispose() {
    unawaited(_subscription?.cancel());
    _service.close();
    super.dispose();
  }
}