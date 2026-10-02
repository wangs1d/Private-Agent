import "package:flutter/material.dart";

import "../../core/services/world_api_client.dart";

/// 好友聊天面板（内嵌右侧面板，不再全屏路由）。
///
/// 消息下发真实链路 = 用户在聊天轮里让 agent 调 agent.send_to_peer；本面板
/// 当前仅本地回显输入（发送直连通道 TODO，见 _sendMessage），收到
/// agent.peer_message 推送时的展示由 MailboxPage 的选中联动负责。
class FriendChatPage extends StatefulWidget {
  const FriendChatPage({
    super.key,
    required this.api,
    required this.friendActorId,
    required this.friendName,
    this.onBack,
  });

  final WorldApiClient api;
  final String friendActorId;
  final String friendName;

  /// 面板内返回好友列表（由 MailboxPage 注入；不传则不显示返回键）。
  final VoidCallback? onBack;

  @override
  State<FriendChatPage> createState() => _FriendChatPageState();
}

class _FriendChatPageState extends State<FriendChatPage> {
  final TextEditingController _controller = TextEditingController();
  final ScrollController _scrollController = ScrollController();

  final List<Map<String, dynamic>> _messages = [];
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    // TODO: 加载历史消息（需要后端支持）
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients) {
        _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
      }
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  Future<void> _sendMessage() async {
    final text = _controller.text.trim();
    if (text.isEmpty) return;

    setState(() => _loading = true);

    try {
      // TODO: 直连发送通道（对端 agent.send_to_peer 的 HTTP 出口）尚未建；
      // 当前仅本地回显，真实发送走对 agent 说「给好友发消息」。
      setState(() {
        _messages.add({
          "text": text,
          "isMe": true,
          "timestamp": DateTime.now().toIso8601String(),
        });
      });

      _controller.clear();

      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scrollController.hasClients) {
          _scrollController.animateTo(
            _scrollController.position.maxScrollExtent,
            duration: const Duration(milliseconds: 300),
            curve: Curves.easeOut,
          );
        }
      });
    } finally {
      if (mounted) {
        setState(() => _loading = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Column(
      children: [
        // 面板内细头：返回 + 好友名（替代原全屏 AppBar）
        SizedBox(
          height: 40,
          child: Row(
            children: [
              if (widget.onBack != null)
                IconButton(
                  icon: const Icon(Icons.arrow_back, size: 18),
                  tooltip: "返回好友列表",
                  visualDensity: VisualDensity.compact,
                  onPressed: widget.onBack,
                ),
              Expanded(
                child: Text(
                  widget.friendName,
                  style: theme.textTheme.titleSmall,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
        ),
        // 消息列表
        Expanded(
          child: _messages.isEmpty
              ? Center(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(
                        Icons.chat_bubble_outline,
                        size: 48,
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                      const SizedBox(height: 12),
                      Text(
                        "开始聊天吧",
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 16),
                        child: Text(
                          "直接对 agent 说「给 TA 发消息」即可送达",
                          textAlign: TextAlign.center,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                        ),
                      ),
                    ],
                  ),
                )
              : ListView.builder(
                  controller: _scrollController,
                  padding: const EdgeInsets.all(8),
                  itemCount: _messages.length,
                  itemBuilder: (context, index) {
                    final message = _messages[index];
                    final isMe = message["isMe"] as bool? ?? false;

                    return _buildMessageBubble(message, isMe, theme);
                  },
                ),
        ),
        // 输入行（面板窄幅：仅输入框 + 发送键）
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
          decoration: BoxDecoration(
            color: theme.colorScheme.surface,
            border: Border(top: BorderSide(color: theme.colorScheme.outline)),
          ),
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _controller,
                  style: theme.textTheme.bodySmall,
                  decoration: InputDecoration(
                    hintText: "输入消息...",
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(20),
                    ),
                    contentPadding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 6,
                    ),
                  ),
                  maxLines: null,
                  textInputAction: TextInputAction.send,
                  onSubmitted: (_) => _sendMessage(),
                ),
              ),
              const SizedBox(width: 4),
              IconButton(
                icon: _loading
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.send, size: 20),
                onPressed: _loading ? null : _sendMessage,
                color: theme.colorScheme.primary,
                visualDensity: VisualDensity.compact,
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildMessageBubble(
    Map<String, dynamic> message,
    bool isMe,
    ThemeData theme,
  ) {
    final text = message["text"] as String? ?? "";
    final timestamp = message["timestamp"] as String?;

    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        mainAxisAlignment:
            isMe ? MainAxisAlignment.end : MainAxisAlignment.start,
        children: [
          if (!isMe) ...[
            CircleAvatar(
              radius: 12,
              backgroundColor: theme.colorScheme.secondaryContainer,
              child: Text(
                widget.friendName.isNotEmpty
                    ? widget.friendName[0].toUpperCase()
                    : "?",
                style: TextStyle(
                  color: theme.colorScheme.onSecondaryContainer,
                  fontSize: 10,
                ),
              ),
            ),
            const SizedBox(width: 6),
          ],
          Flexible(
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: isMe
                    ? theme.colorScheme.primaryContainer
                    : theme.colorScheme.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (text.isNotEmpty)
                    Text(
                      text,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: isMe
                            ? theme.colorScheme.onPrimaryContainer
                            : theme.colorScheme.onSurface,
                      ),
                    ),
                  if (timestamp != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(
                        DateTime.parse(timestamp)
                            .toString()
                            .substring(11, 16),
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                          fontSize: 9,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
          if (isMe) const SizedBox(width: 6),
        ],
      ),
    );
  }
}
