import "package:flutter/material.dart";

import "../../core/services/world_api_client.dart";

class MessageHubPage extends StatefulWidget {
  const MessageHubPage({super.key, required this.api});

  final WorldApiClient api;

  @override
  State<MessageHubPage> createState() => _MessageHubPageState();
}

class _MessageHubPageState extends State<MessageHubPage> {
  bool _loading = false;
  bool _serverOffline = false;
  List<Map<String, dynamic>> _conversations = [];

  @override
  void initState() {
    super.initState();
    _loadConversations();
  }

  Future<void> _loadConversations() async {
    setState(() => _loading = true);
    try {
      final result = await widget.api.getMessageConversations(limit: 100);
      if (!mounted) return;
      if (result["ok"] == true) {
        setState(() {
          _conversations = List<Map<String, dynamic>>.from(result["conversations"] ?? []);
          _serverOffline = false;
        });
      }
    } catch (e) {
      if (!mounted) return;
      if (_isNetworkError(e)) {
        setState(() => _serverOffline = true);
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  bool _isNetworkError(Object error) {
    final String msg = error.toString();
    return msg.contains("Failed to fetch") ||
        msg.contains("ClientException") ||
        msg.contains("SocketException") ||
        msg.contains("Connection refused");
  }

  String _platformGlyph(String platform) {
    switch (platform) {
      case "wechat":
        return "微";
      case "qq":
        return "Q";
      case "feishu":
        return "飞";
      default:
        return "信";
    }
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);

    if (_loading && _conversations.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_serverOffline) {
      return _buildOfflineHint(theme);
    }

    if (_conversations.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.mark_chat_unread_outlined,
              size: 64,
              color: theme.colorScheme.onSurfaceVariant,
            ),
            const SizedBox(height: 16),
            Text(
              "暂无聚合消息",
              style: theme.textTheme.titleMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              "接入微信、QQ、飞书后会统一显示在这里",
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _loadConversations,
      child: ListView.builder(
        itemCount: _conversations.length,
        itemBuilder: (context, index) {
          final Map<String, dynamic> item = _conversations[index];
          final String title =
              (item["title"] as String?)?.trim().isNotEmpty == true
              ? item["title"] as String
              : ((item["participantName"] as String?)?.trim().isNotEmpty == true
                    ? item["participantName"] as String
                    : (item["channelId"] as String? ?? "未命名会话"));
          final String preview = item["lastMessagePreview"] as String? ?? "";
          final int unread = item["unreadCount"] as int? ?? 0;
          final String platform = item["platform"] as String? ?? "generic";
          final String conversationId = item["conversationId"] as String? ?? "";

          return ListTile(
            leading: CircleAvatar(
              backgroundColor: unread > 0
                  ? theme.colorScheme.primaryContainer
                  : theme.colorScheme.surfaceContainerHighest,
              child: Text(_platformGlyph(platform)),
            ),
            title: Text(
              title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            subtitle: Text(
              preview,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
            trailing: unread > 0
                ? CircleAvatar(
                    radius: 11,
                    backgroundColor: theme.colorScheme.primary,
                    child: Text(
                      unread > 99 ? "99+" : unread.toString(),
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: theme.colorScheme.onPrimary,
                        fontSize: 10,
                      ),
                    ),
                  )
                : const Icon(Icons.chevron_right),
            onTap: conversationId.isEmpty
                ? null
                : () async {
                    await Navigator.push(
                      context,
                      MaterialPageRoute(
                        builder: (context) => _ConversationDetailPage(
                          api: widget.api,
                          conversationId: conversationId,
                          title: title,
                        ),
                      ),
                    );
                    if (mounted) {
                      await _loadConversations();
                    }
                  },
          );
        },
      ),
    );
  }

  Widget _buildOfflineHint(ThemeData theme) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.cloud_off, size: 64, color: theme.colorScheme.error),
          const SizedBox(height: 16),
          Text(
            "无法连接服务器",
            style: theme.textTheme.titleMedium?.copyWith(
              color: theme.colorScheme.error,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            "请先启动 server：npm run dev:server",
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 16),
          FilledButton.tonal(
            onPressed: _loadConversations,
            child: const Text("重试"),
          ),
        ],
      ),
    );
  }
}

class _ConversationDetailPage extends StatefulWidget {
  const _ConversationDetailPage({
    required this.api,
    required this.conversationId,
    required this.title,
  });

  final WorldApiClient api;
  final String conversationId;
  final String title;

  @override
  State<_ConversationDetailPage> createState() => _ConversationDetailPageState();
}

class _ConversationDetailPageState extends State<_ConversationDetailPage> {
  final TextEditingController _controller = TextEditingController();
  bool _loading = true;
  bool _sending = false;
  bool _suggesting = false;
  Map<String, dynamic>? _conversation;
  List<Map<String, dynamic>> _messages = <Map<String, dynamic>>[];

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final result = await widget.api.getConversationDetail(
        widget.conversationId,
        limit: 200,
      );
      if (!mounted) return;
      if (result["ok"] == true) {
        setState(() {
          _conversation = (result["conversation"] as Map?)?.cast<String, dynamic>();
          _messages = List<Map<String, dynamic>>.from(result["messages"] ?? []);
        });
        await widget.api.markConversationRead(widget.conversationId);
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _send() async {
    final String text = _controller.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    try {
      final result = await widget.api.sendConversationMessage(
        widget.conversationId,
        text,
      );
      if (!mounted) return;
      if (result["ok"] == true) {
        _controller.clear();
        await _load();
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              result["message"]?.toString() ??
                  result["error"]?.toString() ??
                  "发送失败",
            ),
          ),
        );
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("发送失败: $e")),
      );
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _suggestReply() async {
    if (_suggesting) return;
    setState(() => _suggesting = true);
    try {
      final result = await widget.api.suggestConversationReply(
        widget.conversationId,
        limit: 20,
      );
      if (!mounted) return;
      if (result["ok"] == true) {
        _controller.text = result["suggestedReply"]?.toString() ?? "";
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              result["message"]?.toString() ??
                  result["error"]?.toString() ??
                  "生成建议失败",
            ),
          ),
        );
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("生成建议失败: $e")),
      );
    } finally {
      if (mounted) setState(() => _suggesting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Scaffold(
      backgroundColor: theme.colorScheme.surface,
      appBar: AppBar(title: Text(widget.title)),
      body: Column(
        children: [
          if (_conversation != null)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              color: theme.colorScheme.surfaceContainerHighest,
              child: Text(
                "平台: ${_conversation!["platform"] ?? "-"}  渠道: ${_conversation!["channelId"] ?? "-"}",
                style: theme.textTheme.bodySmall,
              ),
            ),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _messages.isEmpty
                ? Center(
                    child: Text(
                      "暂无消息",
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  )
                : ListView.builder(
                    padding: const EdgeInsets.all(12),
                    itemCount: _messages.length,
                    itemBuilder: (context, index) {
                      final Map<String, dynamic> item = _messages[index];
                      final bool outbound = item["direction"] == "outbound";
                      return Align(
                        alignment: outbound ? Alignment.centerRight : Alignment.centerLeft,
                        child: Container(
                          margin: const EdgeInsets.only(bottom: 8),
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                          constraints: const BoxConstraints(maxWidth: 320),
                          decoration: BoxDecoration(
                            color: outbound
                                ? theme.colorScheme.primaryContainer
                                : theme.colorScheme.surfaceContainerHighest,
                            borderRadius: BorderRadius.circular(14),
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                (item["text"] as String?) ?? "",
                                style: theme.textTheme.bodyMedium,
                              ),
                              const SizedBox(height: 6),
                              Text(
                                outbound
                                    ? "我"
                                    : ((item["senderName"] as String?) ?? (item["senderId"] as String?) ?? "对方"),
                                style: theme.textTheme.labelSmall?.copyWith(
                                  color: theme.colorScheme.onSurfaceVariant,
                                ),
                              ),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
          ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _controller,
                      minLines: 1,
                      maxLines: 4,
                      decoration: const InputDecoration(
                        hintText: "输入回复内容",
                        border: OutlineInputBorder(),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  OutlinedButton(
                    onPressed: _suggesting ? null : _suggestReply,
                    child: _suggesting
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Text("建议"),
                  ),
                  const SizedBox(width: 8),
                  FilledButton(
                    onPressed: _sending ? null : _send,
                    child: _sending
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Text("发送"),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
