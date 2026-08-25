import "package:flutter/material.dart";

import "mobile_chat_controller.dart";
import "mobile_theme.dart";
import "../core/models/chat_models.dart";

/// 手机端对话主界面(白黑极简)。
///
/// - 顶栏：居中标题 + 在线状态点 + 新会话按钮
/// - 消息区：用户黑底白字右对齐、助手浅灰底黑字左对齐
/// - 底部输入栏：圆角输入框 + 纯黑发送按钮
class MobileChatPage extends StatefulWidget {
  const MobileChatPage({super.key});

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
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: MobileTheme.background,
      appBar: AppBar(
        title: _buildTitle(),
        actions: [
          IconButton(
            tooltip: "新会话",
            icon: const Icon(Icons.add_rounded, size: 24),
            color: MobileTheme.textPrimary,
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
                return _buildMessageList();
              },
            ),
          ),
          _buildInputBar(),
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

  @override
  void initState() {
    super.initState();
    _controller = MobileChatController();
    _input.addListener(() {
      final bool now = _input.text.trim().isNotEmpty;
      if (now != _canSend) {
        setState(() => _canSend = now);
      }
    });
  }

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    _controller.dispose();
    super.dispose();
  }

  void _send() {
    final String text = _input.text;
    _controller.send(text);
    _input.clear();
    _maybeScrollToBottom();
  }

  Widget _buildTitle() {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        const Text(
          "智能助手",
          style: TextStyle(
            color: MobileTheme.textPrimary,
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
                    ? MobileTheme.online
                    : MobileTheme.textMuted,
              ),
            );
          },
        ),
      ],
    );
  }

  Widget _buildMessageList() {
    if (_controller.messages.isEmpty) {
      return _buildEmpty();
    }
    return ListView.builder(
      controller: _scroll,
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
      itemCount: _controller.messages.length,
      itemBuilder: (context, index) {
        final ChatMessage m = _controller.messages[index];
        final bool isUser = m.role == "user";
        if (m.streaming && m.text.isEmpty) {
          return _buildThinking();
        }
        return _buildBubble(m, isUser);
      },
    );
  }

  Widget _buildEmpty() {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 64,
            height: 64,
            decoration: const BoxDecoration(
              color: MobileTheme.surface,
              shape: BoxShape.circle,
            ),
            child: const Icon(
              Icons.auto_awesome_outlined,
              size: 30,
              color: MobileTheme.textPrimary,
            ),
          ),
          const SizedBox(height: 16),
          const Text(
            "有什么可以帮你?",
            style: TextStyle(
              color: MobileTheme.textPrimary,
              fontSize: 17,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 8),
          const Text(
            "随时随地,随聊随答\n同一账号与桌面端数据同步",
            textAlign: TextAlign.center,
            style: TextStyle(
              color: MobileTheme.textSecondary,
              fontSize: 13,
              height: 1.6,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildThinking() {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 6),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        decoration: BoxDecoration(
          color: MobileTheme.assistantBubble,
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(6),
            topRight: const Radius.circular(MobileTheme.bubbleRadius),
            bottomLeft: const Radius.circular(MobileTheme.bubbleRadius),
            bottomRight: const Radius.circular(MobileTheme.bubbleRadius),
          ),
        ),
        child: const _ThinkingDots(),
      ),
    );
  }

  Widget _buildBubble(ChatMessage m, bool isUser) {
    final Color bubble = isUser ? MobileTheme.userBubble : MobileTheme.assistantBubble;
    final Color text = isUser ? MobileTheme.userBubbleText : MobileTheme.assistantBubbleText;
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
            bottomLeft: const Radius.circular(MobileTheme.bubbleRadius),
            bottomRight: const Radius.circular(MobileTheme.bubbleRadius),
          ),
        ),
        child: Text(
          m.text,
          style: TextStyle(
            color: text,
            fontSize: 16,
            height: 1.5,
          ),
        ),
      ),
    );
  }

  Widget _buildInputBar() {
    return Container(
      color: MobileTheme.surface,
      padding: EdgeInsets.fromLTRB(12, 10, 12, MediaQuery.of(context).padding.bottom + 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14),
              clipBehavior: Clip.antiAlias,
              decoration: BoxDecoration(
                color: MobileTheme.innerFieldBackground,
                borderRadius: BorderRadius.circular(MobileTheme.inputRadius),
              ),
              child: TextField(
                controller: _input,
                textInputAction: TextInputAction.send,
                minLines: 1,
                maxLines: 5,
                onSubmitted: (_) => _send(),
                style: const TextStyle(
                  color: MobileTheme.textPrimary,
                  fontSize: 16,
                  height: 1.4,
                ),
                decoration: const InputDecoration(
                  hintText: "输入消息…",
                  hintStyle: TextStyle(color: MobileTheme.textMuted, fontSize: 16),
                  border: InputBorder.none,
                  isCollapsed: true,
                  contentPadding: EdgeInsets.symmetric(vertical: 12),
                ),
              ),
            ),
          ),
          const SizedBox(width: 8),
          _buildSendButton(),
        ],
      ),
    );
  }

  Widget _buildSendButton() {
    final bool enabled = _canSend;
    return GestureDetector(
      onTap: enabled ? _send : null,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 160),
        width: 44,
        height: 44,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: enabled ? MobileTheme.accent : MobileTheme.divider,
        ),
        child: Icon(
          Icons.arrow_upward_rounded,
          color: enabled ? Colors.white : MobileTheme.textSecondary,
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
                    decoration: const BoxDecoration(
                      color: MobileTheme.assistantBubbleText,
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