import "package:flutter/material.dart";

import "mobile_chat_controller.dart";
import "mobile_theme.dart";
import "../core/models/chat_models.dart";
import "../features/chat/message_body_renderer.dart";

/// 手机端对话主界面(白黑极简,跟随主题)。
///
/// - 顶栏：居中标题 + 在线状态点 + 新会话按钮
/// - 消息区：用户黑底白字右对齐、助手浅灰底黑字左对齐
/// - 底部输入栏：圆角输入框 + 纯黑发送按钮
///
/// [controller] 可选：由外部(根组件)注入以共享连接；不传时自建。
class MobileChatPage extends StatefulWidget {
  const MobileChatPage({super.key, this.controller});

  final MobileChatController? controller;

  @override
  State<MobileChatPage> createState() => _MobileChatPageState();
}

class _MobileChatPageState extends State<MobileChatPage> {
  late final MobileChatController _controller;
  final TextEditingController _input = TextEditingController();
  final ScrollController _scroll = ScrollController();
  bool _canSend = false;
  int _lastMessageCount = 0;

  @override
  void initState() {
    super.initState();
    _controller = widget.controller ?? MobileChatController();
    _input.addListener(() {
      final bool now = _input.text.trim().isNotEmpty;
      if (now != _canSend) {
        setState(() => _canSend = now);
      }
    });
  }

  @override
  void didUpdateWidget(MobileChatPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    // 根组件重建时若注入新的控制器(一般不会),做切换。
    if (widget.controller != null && widget.controller != _controller) {
      _controller.dispose();
      _controller = widget.controller!;
      _lastMessageCount = 0;
    }
  }

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    // 仅当控制器是自建时才负责释放;外部注入的由根组件管理。
    if (widget.controller == null) {
      _controller.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Scaffold(
      backgroundColor: p.background,
      appBar: AppBar(
        title: _buildTitle(context, p),
        actions: [
          IconButton(
            tooltip: "删除全部聊天记录",
            icon: const Icon(Icons.delete_sweep_outlined, size: 22),
            color: p.textPrimary,
            onPressed: _confirmClearAllChat,
          ),
          IconButton(
            tooltip: "新会话",
            icon: const Icon(Icons.add_rounded, size: 24),
            color: p.textPrimary,
            onPressed: () => _controller.reset(),
          ),
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: ListenableBuilder(
              listenable: _controller,
              builder: (context, _) {
                _maybeScrollToBottom();
                return _buildMessageList(context, p);
              },
            ),
          ),
          _buildInputBar(context, p),
        ],
      ),
    );
  }

  /// 仅在消息数量变化或新内容到达时滚到底,避免每次键盘输入都触发滚动。
  void _maybeScrollToBottom() {
    final int count = _controller.messages.length;
    final bool needScroll =
        count != _lastMessageCount ||
        (_lastMessageCount > 0 &&
            _controller.isProcessing);
    _lastMessageCount = count;
    if (!needScroll) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOut,
        );
      }
    });
  }

  void _send() {
    final String text = _input.text;
    _controller.send(text);
    _input.clear();
    _maybeScrollToBottom();
  }

  /// 删除全部聊天记录：确认弹窗 → 调服务端清空接口 → 清空本地。
  Future<void> _confirmClearAllChat() async {
    final MobilePalette p = MobileTheme.of(context);
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogCtx) => AlertDialog(
        title: const Text("清空所有聊天记录？"),
        content: const Text("将删除全部聊天内容，并同时清空 AI 助手的记忆。此操作不可恢复。"),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.pop(dialogCtx, false),
            child: const Text("取消"),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogCtx, true),
            child: const Text("删除"),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    final bool ok = await _controller.clearAllChat();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        behavior: SnackBarBehavior.floating,
        backgroundColor: p.surface,
        content: Text(
          ok ? "已清空全部聊天记录与 AI 记忆" : "已清空本地记录(服务端未连接)",
          style: TextStyle(color: p.textPrimary),
        ),
      ),
    );
  }

  Widget _buildTitle(BuildContext context, MobilePalette p) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          "智能助手",
          style: TextStyle(
            color: p.textPrimary,
            fontSize: 17,
            fontWeight: FontWeight.w600,
            letterSpacing: 0.2,
          ),
        ),
        const SizedBox(width: 6),
        // 在线状态点：跟随后端连接状态
        ListenableBuilder(
          listenable: _controller,
          builder: (context, _) {
            return Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: _controller.isConnected
                    ? p.online
                    : p.textMuted,
              ),
            );
          },
        ),
      ],
    );
  }

  Widget _buildMessageList(BuildContext context, MobilePalette p) {
    if (_controller.messages.isEmpty) {
      return _buildEmpty(p);
    }
    return ListView.builder(
      controller: _scroll,
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
      itemCount: _controller.messages.length,
      itemBuilder: (context, index) {
        final ChatMessage m = _controller.messages[index];
        final bool isUser = m.role == "user";
        if (m.streaming && m.text.isEmpty) {
          return _buildThinking(p);
        }
        return _buildBubble(context, m, isUser, p);
      },
    );
  }

  Widget _buildEmpty(MobilePalette p) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 64,
            height: 64,
            decoration: BoxDecoration(
              color: p.surface,
              shape: BoxShape.circle,
            ),
            child: Icon(
              Icons.auto_awesome_outlined,
              size: 30,
              color: p.textPrimary,
            ),
          ),
          const SizedBox(height: 16),
          Text(
            "有什么可以帮你?",
            style: TextStyle(
              color: p.textPrimary,
              fontSize: 17,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            "随时随地,随聊随答\n同一账号与桌面端数据同步",
            textAlign: TextAlign.center,
            style: TextStyle(
              color: p.textSecondary,
              fontSize: 13,
              height: 1.6,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildThinking(MobilePalette p) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 6),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        decoration: BoxDecoration(
          color: p.assistantBubble,
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(6),
            topRight: Radius.circular(MobileTheme.bubbleRadius),
            bottomLeft: Radius.circular(MobileTheme.bubbleRadius),
            bottomRight: Radius.circular(MobileTheme.bubbleRadius),
          ),
        ),
        child: const _ThinkingDots(),
      ),
    );
  }

  Widget _buildBubble(BuildContext context, ChatMessage m, bool isUser, MobilePalette p) {
    final Color bubble = isUser ? p.userBubble : p.assistantBubble;
    final Color text = isUser ? p.userBubbleText : p.assistantBubbleText;
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * 0.78,
        ),
        margin: const EdgeInsets.symmetric(vertical: 6),
        padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 11),
        decoration: BoxDecoration(
          color: bubble,
          borderRadius: BorderRadius.only(
            topLeft: Radius.circular(isUser ? MobileTheme.bubbleRadius : 6),
            topRight: Radius.circular(isUser ? 6 : MobileTheme.bubbleRadius),
            bottomLeft: Radius.circular(MobileTheme.bubbleRadius),
            bottomRight: Radius.circular(MobileTheme.bubbleRadius),
          ),
        ),
        child: isUser
            ? Text(
                m.text,
                style: TextStyle(
                  color: text,
                  fontSize: 16,
                  height: 1.5,
                ),
              )
            // 助手消息：复用桌面端同一共享渲染器，保证卡片 / 图文交错 /
            // [RENDER_AS] 标记等结构化内容与桌面端渲染效果完全一致。
            : Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  buildMessageBody(
                    context,
                    Theme.of(context).colorScheme,
                    m,
                    isUser: false,
                  ),
                  // 边说边出图：流式阶段 `chat.media_ready` 推送的临时照片，
                  // 插在正在打字的正文下方实时展示；`chat.assistant_done` 后
                  // 由 renderBlocks 的最终顺序接管（与桌面端一致）。
                  if (m.pendingMediaCards != null &&
                      m.pendingMediaCards!.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: buildPendingMediaCards(
                        m.pendingMediaCards!,
                        Theme.of(context).colorScheme,
                      ),
                    ),
                ],
              ),
      ),
    );
  }

  Widget _buildInputBar(BuildContext context, MobilePalette p) {
    return Container(
      color: p.surface,
      padding: EdgeInsets.fromLTRB(12, 10, 12, MediaQuery.of(context).padding.bottom + 10),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14),
              clipBehavior: Clip.antiAlias,
              decoration: BoxDecoration(
                color: p.innerFieldBackground,
                borderRadius: BorderRadius.circular(MobileTheme.inputRadius),
              ),
              child: TextField(
                controller: _input,
                textInputAction: TextInputAction.send,
                minLines: 1,
                maxLines: 5,
                onSubmitted: (_) => _send(),
                style: TextStyle(
                  color: p.textPrimary,
                  fontSize: 16,
                  height: 1.4,
                ),
                decoration: InputDecoration(
                  hintText: "输入消息…",
                  hintStyle: TextStyle(color: p.textMuted, fontSize: 16),
                  border: InputBorder.none,
                  isCollapsed: true,
                  contentPadding: const EdgeInsets.symmetric(vertical: 12),
                ),
              ),
            ),
          ),
          const SizedBox(width: 8),
          _buildSendButton(p),
        ],
      ),
      ],
    ),
    );
  }

  Widget _buildSendButton(MobilePalette p) {
    final bool enabled = _canSend;
    return GestureDetector(
      onTap: enabled ? _send : null,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 160),
        width: 44,
        height: 44,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: enabled ? p.accent : p.divider,
        ),
        child: Icon(
          Icons.arrow_upward_rounded,
          color: enabled ? p.onAccent : p.textSecondary,
          size: 22,
        ),
      ),
    );
  }
}

/// 三颗跳动省略号,表示 Agent 正在思考。
class _ThinkingDots extends StatefulWidget {
  const _ThinkingDots();

  @override
  State<_ThinkingDots> createState() => _ThinkingDotsState();
}

class _ThinkingDotsState extends State<_ThinkingDots>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  late final Animation<double> _fade;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 900),
    )..repeat();
    _fade = Tween<double>(begin: 0.3, end: 1).animate(
      CurvedAnimation(parent: _controller, curve: Curves.easeInOut),
    );
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) {
        final double t = _controller.value;
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (int i = 0; i < 3; i++)
              Padding(
                padding: const EdgeInsets.only(right: 4),
                child: Opacity(
                  opacity: _fade.value.clamp(0, 1) * _dotPhase(t, i),
                  child: Container(
                    width: 7,
                    height: 7,
                    decoration: BoxDecoration(
                      color: p.assistantBubbleText,
                      shape: BoxShape.circle,
                    ),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }

  double _dotPhase(double t, int i) {
    final double p = (t - i * 0.2) % 1;
    return p < 0 ? 0 : (0.3 + 0.7 * p);
  }
}
