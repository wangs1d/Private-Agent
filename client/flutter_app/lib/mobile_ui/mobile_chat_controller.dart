import "dart:async";
import "dart:convert";

import "package:flutter/foundation.dart";
import "package:http/http.dart" as http;

import "../core/config/api_config.dart";
import "../core/models/chat_models.dart";
import "../core/services/ws_chat_service.dart";
import "../core/vision/vision_wire_frame.dart";

// ===== 真·分绿泡（2026-09-28）：气泡拆分消息 id 工具（与桌面端 main.dart 同构）=====
final RegExp _bubbleIdPattern = RegExp(r"^assistant-(.+)-b(\d+)$");

/// 是否为分泡消息 id（assistant-<traceId>-bN，服务端 BubbleTracker 分配）。
bool _isBubbleId(String messageId) => _bubbleIdPattern.hasMatch(messageId);

/// 从分泡消息 id 提取轮次 traceId；非分泡 id 返回 null。
String? _bubbleTraceOf(String messageId) =>
    _bubbleIdPattern.firstMatch(messageId)?.group(1);

/// 手机端对话控制器：复用 [WsChatService] 连接与桌面端同一后端，数据/会话自动同步。
///
/// 协议(与桌面端一致)：
/// - 连接成功 → `session.init`(携带 userId/sessionId,后端按 userId 绑定 actor,两端同步)
/// - 发送 → `chat.user_message`(messageId/text/timestamp/userId/agentAccessMode)
/// - 接收 → `chat.turn_started/interim`(思考态)、`chat.assistant_chunk`(流式正文)、
///   `chat.media_ready`(边说边出图临时照片)、`chat.assistant_done`(收尾最终文本,
///   含结构化 mediaCards/renderBlocks 字段,与桌面端一致)
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

  /// 连接状态通知器(「我的」页账号卡监听展示在线/离线)。
  final ValueNotifier<bool> connection = ValueNotifier<bool>(false);

  /// 底层 WS 服务(邮箱页等同源复用,避免双连接)。
  WsChatService get service => _service;

  /// 错误提示(轻提示用)。
  String? errorMessage;

  /// 当前流式助手消息 id。
  String? _streamingMessageId;

  /// 当前正在调用的工具名（`tool.call` 置位、`tool.result`/收尾清空）。
  /// 输入框左上角据此展示「球形图标 + 正在调用:xxx」。
  String? currentToolName;

  /// 打开一个新会话：仅清空本地内存，仍连接同一后端。
  void reset() {
    messages.clear();
    _streamingMessageId = null;
    currentToolName = null;
    isProcessing = false;
    notifyListeners();
  }

  /// 删除全部聊天记录：调服务端清空接口(聊天线程+Agent 记忆)，并通知服务端、
  /// 清空本地内存。返回是否成功(接口可达且返回 200)。
  Future<bool> clearAllChat() async {
    bool ok = false;
    try {
      final Uri uri = Uri.parse("${ApiConfig.httpBase}/api/chat-data/clear-all");
      final http.Response res = await http
          .post(
            uri,
            headers: const <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, dynamic>{
              "sessionId": ApiConfig.effectiveActorId,
            }),
          )
          .timeout(const Duration(seconds: 15));
      ok = res.statusCode == 200;
    } catch (_) {
      ok = false;
    }
    // 通知服务端同步清除 ChatThreadStore 内存上下文
    _service.sendEvent("chat.clear_history", <String, dynamic>{
      "sessionId": ApiConfig.sessionId,
    });
    messages.clear();
    _streamingMessageId = null;
    currentToolName = null;
    isProcessing = false;
    errorMessage = ok ? null : "服务端清理失败,已清空本地";
    notifyListeners();
    return ok;
  }

  void _sendSessionInit() {
    final Map<String, dynamic> init = <String, dynamic>{
      "sessionId": ApiConfig.sessionId,
      "deviceId": "mobile-${defaultTargetPlatform.name}",
      "userAlias": "owner",
      // 登录邮箱覆盖（未登录回落 USER_ID/sessionId），服务端按 userId 绑定 actor
      "userId": ApiConfig.effectiveActorId,
    };
    _service.sendEvent("session.init", init);
  }

  /// 发送一条用户消息(空文本+无图忽略)。携带 [visionFrames] 时与桌面端
  /// 同协议走 `chat.user_message.visionFrames`(base64,服务端视觉管线)。
  /// 返回落库的用户消息 id(未发送返回 null),供调用方挂气泡缩略图。
  Future<String?> send(String raw, {List<VisionWireFrame>? visionFrames}) async {
    final String text = raw.trim();
    final bool hasFrames = visionFrames != null && visionFrames.isNotEmpty;
    if (text.isEmpty && !hasFrames) return null;
    if (!_service.isConnected) {
      _service.retryConnect();
      errorMessage = "正在连接服务器,请稍后再发";
      notifyListeners();
      return null;
    }
    final ChatMessage userMsg = ChatMessage(
      messageId: "msg-${DateTime.now().microsecondsSinceEpoch}",
      sessionId: ApiConfig.effectiveActorId,
      role: "user",
      // 纯图无文字时气泡显示「（见图）」,与桌面端一致
      text: text.isEmpty && hasFrames ? "（见图）" : text,
      timestamp: DateTime.now(),
      attachmentImageCount: hasFrames ? visionFrames.length : 0,
    );
    messages.add(userMsg);
    isProcessing = true;
    errorMessage = null;
    notifyListeners();

    final Map<String, dynamic> payload = <String, dynamic>{
      "sessionId": ApiConfig.sessionId,
      "messageId": userMsg.messageId,
      // 纯图轮 text 置空(服务端按 visionFrames 走视觉分档),与桌面端一致
      "text": text,
      "timestamp": DateTime.now().toIso8601String(),
      "agentAccessMode": "full",
      // 与 session.init 同源：登录邮箱优先，保证消息落在本账号车道
      "userId": ApiConfig.effectiveActorId,
    };
    if (hasFrames) {
      payload["visionFrames"] =
          visionFrames.map((VisionWireFrame f) => f.toJson()).toList();
    }
    _service.sendEvent("chat.user_message", payload);
    return userMsg.messageId;
  }

  /// 测试入口：直接驱动 WS 事件（生产路径走 [_subscription] → 本方法）。
  @visibleForTesting
  void debugHandleWsEvent(Map<String, dynamic> event) => _onWsEvent(event);

  void _onWsEvent(Map<String, dynamic> event) {
    final String type = event["type"]?.toString() ?? "";
    final Map<String, dynamic> payload =
        event["payload"] is Map ? event["payload"] as Map<String, dynamic> : const {};
    switch (type) {
      case "ws_connected":
        isConnected = true;
        connection.value = true;
        notifyListeners();
      case "ws_disconnected":
      case "connection_error":
        isConnected = false;
        connection.value = false;
        notifyListeners();
      case "chat.turn_started":
      case "chat.assistant_interim":
        _openStreamingMessage(payload);
        isProcessing = true;
        notifyListeners();
      case "chat.assistant_chunk":
        _appendChunk(payload);
      case "chat.media_ready":
        _handleMediaReady(payload);
      case "tool.call":
        currentToolName = payload["toolName"]?.toString().trim() ?? "";
        isProcessing = true;
        notifyListeners();
      case "tool.result":
        // 当前这把工具结束，让位给下一把（若链式调用，紧随的 tool.call 会重新置位）
        currentToolName = null;
        notifyListeners();
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
    final String chunk = payload["chunk"]?.toString() ?? "";
    final String? traceId = payload["traceId"]?.toString();
    final String id = payload["messageId"]?.toString() ??
        (traceId != null && traceId.isNotEmpty
            ? "assistant-$traceId"
            : "assistant-streaming");
    // 真·分绿泡：chunk 自带独立泡 id（assistant-<trace>-bN）→ 走分泡追加
    if (_isBubbleId(id)) {
      _appendBubbleChunk(id, traceId, chunk);
      return;
    }
    _openStreamingMessage(payload);
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
      // 保留已挂上的「边说边出图」临时照片，避免后续 chunk 覆盖丢失。
      pendingMediaCards: prev.pendingMediaCards,
    );
    isProcessing = true;
    notifyListeners();
  }

  /// 真·分绿泡：分泡 chunk 追加。新泡开=旧泡完；turn_started 建的空占位
  /// （assistant-$traceId，非泡 id 且无正文）让位给第一个真泡。
  void _appendBubbleChunk(String id, String? traceId, String chunk) {
    if (_streamingMessageId != null &&
        _streamingMessageId != id &&
        !_isBubbleId(_streamingMessageId!)) {
      final int phIdx = messages.indexWhere(
        (m) => m.messageId == _streamingMessageId,
      );
      if (phIdx >= 0 && messages[phIdx].text.trim().isEmpty) {
        messages.removeAt(phIdx);
      }
    }
    if (chunk.isNotEmpty) {
      // 同 trace 的其他流式泡定稿（打字机收尾），新泡从头逐字
      for (int i = 0; i < messages.length; i++) {
        final ChatMessage m = messages[i];
        if (!m.streaming || m.messageId == id) continue;
        if (!_isBubbleId(m.messageId)) continue;
        if (traceId != null && traceId.isNotEmpty && _bubbleTraceOf(m.messageId) != traceId) {
          continue;
        }
        messages[i] = ChatMessage(
          messageId: m.messageId,
          sessionId: m.sessionId,
          role: m.role,
          text: m.text,
          timestamp: m.timestamp,
          pendingMediaCards: m.pendingMediaCards,
          // streaming 不带 → false：定稿
        );
      }
      final int idx = messages.indexWhere((m) => m.messageId == id);
      if (idx < 0) {
        messages.add(ChatMessage(
          messageId: id,
          sessionId: ApiConfig.effectiveActorId,
          role: "assistant",
          text: chunk,
          timestamp: DateTime.now(),
          streaming: true,
        ));
      } else {
        final ChatMessage prev = messages[idx];
        messages[idx] = ChatMessage(
          messageId: prev.messageId,
          sessionId: prev.sessionId,
          role: prev.role,
          text: prev.text + chunk,
          timestamp: prev.timestamp,
          streaming: true,
          pendingMediaCards: prev.pendingMediaCards,
        );
      }
      _streamingMessageId = id;
    }
    isProcessing = true;
    notifyListeners();
  }

  /// 边说边出图：`chat.media_ready` 到达时把已搜到的照片先挂到当前流式消息上，
  /// 前端插到正在打字的正文下方实时展示；`chat.assistant_done` 后以
  /// renderBlocks 的最终顺序渲染（pendingMediaCards 被清空由最终消息接管）。
  void _handleMediaReady(Map<String, dynamic> payload) {
    final List<dynamic>? rawCards = payload["cards"] as List<dynamic>?;
    if (rawCards == null || rawCards.isEmpty) return;
    final List<Map<String, dynamic>> cards = rawCards
        .whereType<Map<String, dynamic>>()
        .toList(growable: false);
    if (cards.isEmpty) return;
    // 真·分绿泡：分泡轮次媒体照片挂到当前流式泡上（media_ready 的 messageId
    // 恒为 assistant-$traceId 基础 id，不能据此开占位消息，防幻影空泡）
    if (_streamingMessageId != null && _isBubbleId(_streamingMessageId!)) {
      final int bIdx = messages.indexWhere(
        (m) => m.messageId == _streamingMessageId,
      );
      if (bIdx >= 0) {
        final ChatMessage prev = messages[bIdx];
        messages[bIdx] = ChatMessage(
          messageId: prev.messageId,
          sessionId: prev.sessionId,
          role: prev.role,
          text: prev.text,
          timestamp: prev.timestamp,
          streaming: prev.streaming,
          pendingMediaCards: cards,
        );
        notifyListeners();
        return;
      }
    }
    _openStreamingMessage(payload);
    final int idx = messages.indexWhere(
      (m) => m.messageId == _streamingMessageId,
    );
    if (idx < 0) return;
    final ChatMessage prev = messages[idx];
    messages[idx] = ChatMessage(
      messageId: prev.messageId,
      sessionId: prev.sessionId,
      role: prev.role,
      text: prev.text,
      timestamp: prev.timestamp,
      streaming: true,
      pendingMediaCards: cards,
    );
    notifyListeners();
  }

  /// 从 `chat.assistant_done` 载荷解析结构化媒体卡片/交错渲染块。
  /// 与桌面端一致：无字段时返回 null（前端回退纯文本渲染）。
  List<Map<String, dynamic>>? _parseStructuredList(
    Map<String, dynamic> payload,
    String key,
  ) {
    final List<dynamic>? raw = payload[key] as List<dynamic>?;
    if (raw == null || raw.isEmpty) return null;
    final List<Map<String, dynamic>> out =
        raw.whereType<Map<String, dynamic>>().toList(growable: false);
    return out.isEmpty ? null : out;
  }

  void _finalizeReply(Map<String, dynamic> payload) {
    // 真·分绿泡：带 bubbles 对账数组的轮次按泡收口（不走单泡 finalText 替换）
    final List<Map<String, dynamic>>? bubbles =
        _parseStructuredList(payload, "bubbles");
    if (bubbles != null && bubbles.isNotEmpty) {
      _finalizeBubbles(payload, bubbles);
      return;
    }
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
    // 结构化媒体卡片 / 交错渲染块 / 回复信封块：与桌面端一致，前端据此渲染
    // 卡片与图文交错，不再把 `[AGENT_RESULT_CARD_START]` 等标记当纯文本展示。
    final List<Map<String, dynamic>>? mediaCards =
        _parseStructuredList(payload, "mediaCards");
    final List<Map<String, dynamic>>? renderBlocks =
        _parseStructuredList(payload, "renderBlocks");
    final List<Map<String, dynamic>>? replyBlocks =
        _parseStructuredList(payload, "blocks");
    if (idx < 0) {
      // 没有流式占位:直接落一条最终消息
      messages.add(ChatMessage(
        messageId: messageId ?? "assistant-final",
        sessionId: ApiConfig.effectiveActorId,
        role: "assistant",
        text: finalText,
        timestamp: DateTime.now(),
        mediaCards: mediaCards,
        renderBlocks: renderBlocks,
        replyBlocks: replyBlocks,
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
        mediaCards: mediaCards ?? prev.mediaCards,
        renderBlocks: renderBlocks ?? prev.renderBlocks,
        replyBlocks: replyBlocks ?? prev.replyBlocks,
      );
    }
    _streamingMessageId = null;
    currentToolName = null;
    isProcessing = false;
    notifyListeners();
  }

  /// 真·分绿泡 done 收口：逐泡以服务端对账数组定稿；
  /// finalTextReplacesStream=true 时整轮塌缩成单泡（删除全部分泡）。
  void _finalizeBubbles(
    Map<String, dynamic> payload,
    List<Map<String, dynamic>> bubbles,
  ) {
    final String? traceId = payload["traceId"]?.toString();
    final String finalText = payload["finalText"]?.toString() ?? "";
    final List<Map<String, dynamic>>? mediaCards =
        _parseStructuredList(payload, "mediaCards");
    final List<Map<String, dynamic>>? renderBlocks =
        _parseStructuredList(payload, "renderBlocks");
    final List<Map<String, dynamic>>? replyBlocks =
        _parseStructuredList(payload, "blocks");
    if (payload["finalTextReplacesStream"] == true) {
      // 塌缩：删除本轮所有分泡（含 id 对账与同 trace 兜底），落单泡 finalText
      messages.removeWhere((m) {
        final bool hit = bubbles.any((b) => b["id"]?.toString() == m.messageId) ||
            (traceId != null &&
                traceId.isNotEmpty &&
                _bubbleTraceOf(m.messageId) == traceId);
        return hit;
      });
      messages.add(ChatMessage(
        messageId: traceId != null && traceId.isNotEmpty
            ? "assistant-$traceId"
            : "assistant-final",
        sessionId: ApiConfig.effectiveActorId,
        role: "assistant",
        text: finalText,
        timestamp: DateTime.now(),
        mediaCards: mediaCards,
        renderBlocks: renderBlocks,
        replyBlocks: replyBlocks,
      ));
      _streamingMessageId = null;
      currentToolName = null;
      isProcessing = false;
      notifyListeners();
      return;
    }
    // 正常收口：空占位让位，逐泡定稿（服务端文本为准），卡片挂末泡。
    // 多泡时块序列只留非 text 块（text 块按全文切分，挂末泡会整段复读）。
    messages.removeWhere((m) =>
        m.streaming && m.text.trim().isEmpty && !_isBubbleId(m.messageId));
    List<Map<String, dynamic>>? replyBlocksForLast = replyBlocks;
    List<Map<String, dynamic>>? renderBlocksForLast = renderBlocks;
    if (bubbles.length > 1) {
      if (replyBlocks != null) {
        final List<Map<String, dynamic>> cardOnly = replyBlocks
            .where((b) => b["type"]?.toString() != "text")
            .toList(growable: false);
        replyBlocksForLast = cardOnly.isEmpty ? null : cardOnly;
      }
      if (renderBlocks != null) {
        final List<Map<String, dynamic>> mediaOnly = renderBlocks
            .where((b) => b["type"]?.toString() != "text")
            .toList(growable: false);
        renderBlocksForLast = mediaOnly.isEmpty ? null : mediaOnly;
      }
    }
    for (int i = 0; i < bubbles.length; i++) {
      final Map<String, dynamic> b = bubbles[i];
      final String id = b["id"]?.toString() ?? "";
      if (id.isEmpty) continue;
      final bool isLast = i == bubbles.length - 1;
      final String text = b["text"]?.toString() ?? "";
      final int idx = messages.indexWhere((m) => m.messageId == id);
      if (idx < 0) {
        // 客户端漏收该泡 chunk：按对账补建
        messages.add(ChatMessage(
          messageId: id,
          sessionId: ApiConfig.effectiveActorId,
          role: "assistant",
          text: text,
          timestamp: DateTime.now(),
          mediaCards: isLast ? mediaCards : null,
          renderBlocks: isLast ? renderBlocksForLast : null,
          replyBlocks: isLast ? replyBlocksForLast : null,
        ));
      } else {
        final ChatMessage prev = messages[idx];
        messages[idx] = ChatMessage(
          messageId: prev.messageId,
          sessionId: prev.sessionId,
          role: prev.role,
          text: text.isNotEmpty ? text : prev.text,
          timestamp: prev.timestamp,
          mediaCards: isLast ? (mediaCards ?? prev.mediaCards) : prev.mediaCards,
          renderBlocks:
              isLast ? (renderBlocksForLast ?? prev.renderBlocks) : prev.renderBlocks,
          replyBlocks:
              isLast ? (replyBlocksForLast ?? prev.replyBlocks) : prev.replyBlocks,
          pendingMediaCards: isLast ? null : prev.pendingMediaCards,
          // streaming 不带 → false：定稿
        );
      }
    }
    _streamingMessageId = null;
    currentToolName = null;
    isProcessing = false;
    notifyListeners();
  }

  @override
  void dispose() {
    unawaited(_subscription?.cancel());
    _service.close();
    connection.dispose();
    super.dispose();
  }
}