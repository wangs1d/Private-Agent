import "dart:async";

import "package:flutter/material.dart";

import "../../core/config/api_config.dart";
import "../../core/services/notes_api_client.dart";
import "../../core/services/ws_chat_service.dart";
import "note_detail_page.dart";

/// 笔记对话页：
/// - 与主聊天共用同一 WebSocket 协议，但 sessionId/userId 带 `notes:` 前缀。
///   服务端据此把对话记忆写入 `context=notes` 独立桶。
/// - 左侧：笔记列表（来自 `GET /notes`），点击进入笔记详情或发送上下文消息。
/// - 右侧：与笔记 Agent 的实时对话。
class NotesChatPage extends StatefulWidget {
  NotesChatPage({
    super.key,
    this.api,
    WsChatService? ws,
  }) : _wsOverride = ws;

  final NotesApiClient? api;
  final WsChatService? _wsOverride;

  @override
  State<NotesChatPage> createState() => _NotesChatPageState();
}

class _NotesChatPageState extends State<NotesChatPage> {
  late final NotesApiClient _api = widget.api ?? NotesApiClient();
  late final WsChatService _ws =
      widget._wsOverride ?? WsChatService(url: ApiConfig.wsUrl);

  StreamSubscription<Map<String, dynamic>>? _eventSub;

  final List<_ChatMessage> _messages = <_ChatMessage>[];
  final List<Map<String, dynamic>> _notes = <Map<String, dynamic>>[];
  final TextEditingController _inputCtrl = TextEditingController();
  final ScrollController _scrollCtrl = ScrollController();

  String? _activeNoteId;
  bool _loadingNotes = false;
  String? _error;
  String _status = "初始化中…";
  bool _wsReady = false;
  String? _pendingAssistantMessageId;

  /// 与服务端约定：notes 命名空间下 sessionId/userId 都加 `notes:` 前缀。
  String get _notesSessionId => "notes:${ApiConfig.effectiveActorId}";

  @override
  void initState() {
    super.initState();
    _ws.onConnected = _onWsConnected;
    _eventSub = _ws.events.listen(_onWsEvent);
    _ws.connect();
    _reloadNotes();
  }

  @override
  void dispose() {
    _eventSub?.cancel();
    if (widget._wsOverride == null) {
      _ws.close();
    }
    _inputCtrl.dispose();
    _scrollCtrl.dispose();
    super.dispose();
  }

  void _onWsConnected() {
    if (!mounted) return;
    setState(() {
      _wsReady = true;
      _status = "已连接 · 上下文 = notes";
    });
    _ws.sendEvent("session.init", <String, dynamic>{
      "sessionId": _notesSessionId,
      "userId": _notesSessionId,
    });
  }

  void _onWsEvent(Map<String, dynamic> event) {
    if (!mounted) return;
    final String type = event["type"]?.toString() ?? "";
    final Map<String, dynamic> payload =
        (event["payload"] as Map?)?.cast<String, dynamic>() ?? <String, dynamic>{};

    switch (type) {
      case "ws_connected":
        return;
      case "ws_disconnected":
        setState(() => _status = "连接已断开，正在重连…");
        return;
      case "connection_error":
        setState(() => _status = "连接失败：${payload["message"] ?? ""}");
        return;
      case "chat.assistant_interim":
        // 「分阶段异步对话交互」阶段一：即时确认应答。real chunk 一到就让位。
        final String text = payload["text"]?.toString().trim() ?? "";
        if (text.isNotEmpty) {
          setState(() => _status = text);
        }
        return;
      case "chat.agent_status":
        setState(() => _status = payload["message"]?.toString() ?? "处理中…");
        return;
      case "tool.call":
        final String name = payload["name"]?.toString() ?? "";
        if (name.isNotEmpty) {
          setState(() => _status = "调用工具：$name");
        }
        return;
      case "chat.assistant_chunk":
        final String id = payload["messageId"]?.toString() ??
            payload["id"]?.toString() ??
            _pendingAssistantMessageId ??
            "";
        final String delta = payload["delta"]?.toString() ??
            payload["text"]?.toString() ??
            "";
        _appendOrUpdateAssistant(id, delta);
        // real chunk 抵达：状态行让位，让用户聚焦到真实回复上
        if (_status.isNotEmpty) {
          setState(() => _status = "");
        }
        return;
      case "chat.assistant_done":
        final String id = payload["messageId"]?.toString() ??
            payload["id"]?.toString() ??
            _pendingAssistantMessageId ??
            "";
        final String text = payload["text"]?.toString() ?? "";
        _finalizeAssistant(id, text);
        _pendingAssistantMessageId = null;
        // 笔记 Agent 创建/更新笔记后自动刷新列表
        _reloadNotes();
        setState(() => _status = "就绪");
        return;
      default:
        // 忽略未识别事件
        return;
    }
  }

  void _appendOrUpdateAssistant(String messageId, String delta) {
    if (delta.isEmpty) return;
    setState(() {
      final int idx = _messages.indexWhere((_ChatMessage m) => m.id == messageId);
      if (idx >= 0) {
        _messages[idx] = _ChatMessage(
          id: messageId,
          role: _messages[idx].role,
          text: _messages[idx].text + delta,
        );
      } else {
        _pendingAssistantMessageId = messageId;
        _messages.add(_ChatMessage(id: messageId, role: "assistant", text: delta));
      }
    });
    _scrollToBottom();
  }

  void _finalizeAssistant(String messageId, String text) {
    setState(() {
      final int idx = _messages.indexWhere((_ChatMessage m) => m.id == messageId);
      if (idx >= 0) {
        _messages[idx] = _ChatMessage(
          id: messageId,
          role: _messages[idx].role,
          text: text.isNotEmpty ? text : _messages[idx].text,
        );
      } else if (text.isNotEmpty) {
        _messages.add(_ChatMessage(id: messageId, role: "assistant", text: text));
      }
    });
    _scrollToBottom();
  }

  void _scrollToBottom() {
    if (!_scrollCtrl.hasClients) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollCtrl.hasClients) return;
      _scrollCtrl.animateTo(
        0,
        duration: const Duration(milliseconds: 200),
        curve: Curves.easeOut,
      );
    });
  }

  Future<void> _reloadNotes() async {
    setState(() {
      _loadingNotes = true;
      _error = null;
    });
    final NotesApiResult<List<Map<String, dynamic>>> r = await _api.listNotes(limit: 80);
    if (!mounted) return;
    setState(() {
      _loadingNotes = false;
      if (r.ok) {
        _notes
          ..clear()
          ..addAll(r.value ?? <Map<String, dynamic>>[]);
      } else {
        _error = r.error;
      }
    });
  }

  void _sendUserMessage(String text) {
    final String body = text.trim();
    if (body.isEmpty) return;
    if (!_wsReady) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("连接未就绪，请稍后重试")),
      );
      return;
    }
    final String messageId = "msg-${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}";
    setState(() {
      _messages.add(_ChatMessage(id: messageId, role: "user", text: body));
    });
    _inputCtrl.clear();
    _scrollToBottom();
    _ws.sendEvent("chat.user_message", <String, dynamic>{
      "sessionId": _notesSessionId,
      "userId": _notesSessionId,
      "messageId": messageId,
      "text": body,
    });
    setState(() => _status = "处理中…");
  }

  void _sendComposer() {
    _sendUserMessage(_inputCtrl.text);
  }

  Future<void> _openNoteDetail(Map<String, dynamic> note) async {
    final String? id = note["id"]?.toString();
    if (id == null) return;
    await Navigator.of(context).push<Map<String, dynamic>>(
      MaterialPageRoute<Map<String, dynamic>>(
        builder: (_) => NoteDetailPage(noteId: id, api: _api),
      ),
    );
    _reloadNotes();
  }

  void _selectNote(Map<String, dynamic> note) {
    final String? id = note["id"]?.toString();
    if (id == null) return;
    setState(() {
      _activeNoteId = id;
    });
    final String title = (note["title"] ?? "(无标题)").toString();
    _sendUserMessage("我们继续讨论这条笔记：$title（id=$id）。先回顾一下要点，再给我下一步建议。");
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text("学习笔记 · 对话"),
        actions: <Widget>[
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _reloadNotes,
            tooltip: "刷新笔记",
          ),
        ],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(28),
          child: Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            color: Theme.of(context).colorScheme.surfaceContainerHighest,
            child: Text(
              _status,
              style: Theme.of(context).textTheme.bodySmall,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ),
      ),
      body: Row(
        children: <Widget>[
          SizedBox(
            width: 220,
            child: _buildNoteSidebar(),
          ),
          const VerticalDivider(width: 1),
          Expanded(
            child: _buildChatPane(),
          ),
        ],
      ),
    );
  }

  Widget _buildNoteSidebar() {
    if (_loadingNotes && _notes.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null && _notes.isEmpty) {
      return Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            Text("加载失败：$_error", textAlign: TextAlign.center),
            const SizedBox(height: 8),
            FilledButton(onPressed: _reloadNotes, child: const Text("重试")),
          ],
        ),
      );
    }
    if (_notes.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(12),
          child: Text(
            "还没有笔记，在右侧和 Agent 聊一聊开始沉淀。",
            textAlign: TextAlign.center,
          ),
        ),
      );
    }
    return ListView.separated(
      itemCount: _notes.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (BuildContext ctx, int i) {
        final Map<String, dynamic> n = _notes[i];
        final String? id = n["id"]?.toString();
        final bool active = id != null && id == _activeNoteId;
        return ListTile(
          dense: true,
          selected: active,
          title: Text(
            n["title"]?.toString() ?? "(无标题)",
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          subtitle: Text(
            n["category"]?.toString() ?? "",
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(context).textTheme.bodySmall,
          ),
          onTap: () => _selectNote(n),
          onLongPress: () => _openNoteDetail(n),
        );
      },
    );
  }

  Widget _buildChatPane() {
    return Column(
      children: <Widget>[
        Expanded(
          child: ListView.builder(
            controller: _scrollCtrl,
            reverse: true,
            padding: const EdgeInsets.all(12),
            itemCount: _messages.length,
            itemBuilder: (BuildContext ctx, int i) {
              final _ChatMessage m = _messages[_messages.length - 1 - i];
              return _ChatBubble(
                role: m.role,
                text: m.text,
              );
            },
          ),
        ),
        SafeArea(
          top: false,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              border: Border(
                top: BorderSide(color: Theme.of(context).dividerColor),
              ),
            ),
            child: Row(
              children: <Widget>[
                Expanded(
                  child: TextField(
                    controller: _inputCtrl,
                    minLines: 1,
                    maxLines: 4,
                    textInputAction: TextInputAction.send,
                    onSubmitted: (_) => _sendComposer(),
                    decoration: const InputDecoration(
                      hintText: "和笔记 Agent 聊一聊…",
                      border: OutlineInputBorder(),
                      isDense: true,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: _wsReady ? _sendComposer : null,
                  child: const Text("发送"),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _ChatMessage {
  _ChatMessage({required this.id, required this.role, required this.text});
  final String id;
  final String role;
  final String text;
}

class _ChatBubble extends StatelessWidget {
  const _ChatBubble({required this.role, required this.text});
  final String role;
  final String text;

  @override
  Widget build(BuildContext context) {
    final bool isUser = role == "user";
    final ColorScheme cs = Theme.of(context).colorScheme;
    final Color bg = isUser ? cs.primary : cs.surfaceContainerHighest;
    final Color fg = isUser ? cs.onPrimary : cs.onSurface;
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.7,
        ),
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(10),
        ),
        child: Text(
          text.isEmpty ? "…" : text,
          style: TextStyle(color: fg, fontSize: 14),
        ),
      ),
    );
  }
}
