import "package:flutter/material.dart";
import "dart:async";

class GameChatMessage {
  final String id;
  final String text;
  final bool isUser;
  final DateTime timestamp;

  const GameChatMessage({
    required this.id,
    required this.text,
    required this.isUser,
    required this.timestamp,
  });
}

class GameChatWidget extends StatefulWidget {
  const GameChatWidget({
    super.key,
    required this.messages,
    required this.onSendMessage,
    this.placeholder = "和 Agent 聊聊...",
    this.title = "对局聊天",
    this.width = 260,
    this.initialPosition,
  });

  final List<GameChatMessage> messages;
  final void Function(String message) onSendMessage;
  final String placeholder;
  final String title;
  final double width;
  final Offset? initialPosition;

  @override
  State<GameChatWidget> createState() => _GameChatWidgetState();
}

class _GameChatWidgetState extends State<GameChatWidget> {
  final TextEditingController _controller = TextEditingController();
  final ScrollController _scrollController = ScrollController();
  final FocusNode _focusNode = FocusNode();

  Offset _position = Offset.zero;
  bool _isDragging = false;
  bool _isMinimized = false;

  @override
  void initState() {
    super.initState();
    _focusNode.addListener(_onFocusChange);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      setState(() {
        _position = widget.initialPosition ?? 
            Offset(MediaQuery.of(context).size.width - widget.width - 20, 80);
      });
      if (_scrollController.hasClients) {
        _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
      }
    });
  }

  @override
  void didUpdateWidget(covariant GameChatWidget oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.messages.length > oldWidget.messages.length) {
      _scrollToBottom();
    }
  }

  void _onFocusChange() {
    if (_focusNode.hasFocus) {
      Future.delayed(const Duration(milliseconds: 300), () => _scrollToBottom());
    }
  }

  void _scrollToBottom() {
    if (_scrollController.hasClients) {
      _scrollController.animateTo(
        _scrollController.position.maxScrollExtent,
        duration: const Duration(milliseconds: 300),
        curve: Curves.easeOut,
      );
    }
  }

  void _sendMessage() {
    final text = _controller.text.trim();
    if (text.isEmpty) return;

    widget.onSendMessage(text);
    _controller.clear();
    _focusNode.unfocus();
  }

  @override
  void dispose() {
    _controller.dispose();
    _scrollController.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final double height = _isMinimized ? 56 : 400;

    return Positioned(
      left: _position.dx,
      top: _position.dy,
      child: Material(
        elevation: 8,
        borderRadius: BorderRadius.circular(_isMinimized ? 28 : 16),
        shadowColor: Colors.black.withOpacity(0.3),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeInOut,
          width: widget.width,
          height: height,
          decoration: BoxDecoration(
            color: cs.surface,
            borderRadius: BorderRadius.circular(_isMinimized ? 28 : 16),
            border: Border.all(
              color: cs.outlineVariant.withOpacity(0.5),
              width: 1,
            ),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withValues(alpha: _isDragging ? 0.4 : 0.2),
                blurRadius: _isDragging ? 20 : 12,
                offset: Offset(0, _isDragging ? 8 : 4),
              ),
            ],
          ),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(_isMinimized ? 28 : 16),
            child: Column(
              children: [
                _buildDraggableHeader(cs),
                if (!_isMinimized) ...[
                  Expanded(child: _buildMessageList(cs)),
                  _buildInputArea(cs),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildDraggableHeader(ColorScheme cs) {
    return GestureDetector(
      onPanStart: (_) => setState(() => _isDragging = true),
      onPanUpdate: (details) {
        setState(() {
          _position += details.delta;
        });
      },
      onPanEnd: (_) => setState(() => _isDragging = false),
      child: MouseRegion(
        cursor: SystemMouseCursors.move,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            color: cs.primaryContainer.withOpacity(0.6),
            borderRadius: BorderRadius.only(
              topLeft: const Radius.circular(16),
              topRight: const Radius.circular(16),
              bottomLeft: Radius.circular(_isMinimized ? 28 : 0),
              bottomRight: Radius.circular(_isMinimized ? 28 : 0),
            ),
          ),
        child: Row(
          children: [
            Icon(
              Icons.chat_bubble_outline,
              size: 18,
              color: cs.primary,
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                widget.title,
                style: Theme.of(context).textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w600,
                      color: cs.onSurface,
                    ),
                overflow: TextOverflow.ellipsis,
              ),
            ),
            if (!_isMinimized)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: cs.primary.withOpacity(0.2),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Text(
                  "${widget.messages.length}",
                  style: Theme.of(context).textTheme.labelSmall?.copyWith(
                        color: cs.primary,
                        fontWeight: FontWeight.w600,
                      ),
                ),
              ),
            const SizedBox(width: 8),
            GestureDetector(
              onTap: () => setState(() => _isMinimized = !_isMinimized),
              child: Container(
                padding: const EdgeInsets.all(4),
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: cs.surfaceContainerHighest.withOpacity(0.5),
                ),
                child: Icon(
                  _isMinimized ? Icons.expand_less : Icons.expand_more,
                  size: 16,
                  color: cs.onSurfaceVariant,
                ),
              ),
            ),
          ],
        ),
      ),
      ),
    );
  }

  Widget _buildMessageList(ColorScheme cs) {
    return ListView.builder(
      controller: _scrollController,
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      itemCount: widget.messages.length,
      itemBuilder: (context, index) {
        final message = widget.messages[index];
        final showAvatar = index == 0 ||
            widget.messages[index - 1].isUser != message.isUser;

        return _buildMessageBubble(cs, message, showAvatar);
      },
    );
  }

  Widget _buildMessageBubble(ColorScheme cs, GameChatMessage message, bool showAvatar) {
    final isUser = message.isUser;

    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        mainAxisAlignment: isUser ? MainAxisAlignment.end : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (!isUser && showAvatar) ...[
            CircleAvatar(
              radius: 12,
              backgroundColor: cs.primaryContainer,
              child: Icon(
                Icons.smart_toy_outlined,
                size: 14,
                color: cs.primary,
              ),
            ),
            const SizedBox(width: 6),
          ] else if (!isUser) ...[
            const SizedBox(width: 24),
          ],
          Flexible(
            child: Container(
              constraints: BoxConstraints(
                maxWidth: widget.width * 0.75,
              ),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: isUser ? cs.primary : cs.surfaceContainerHigh,
                borderRadius: BorderRadius.only(
                  topLeft: const Radius.circular(14),
                  topRight: const Radius.circular(14),
                  bottomLeft: Radius.circular(isUser ? 14 : 4),
                  bottomRight: Radius.circular(isUser ? 4 : 14),
                ),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withValues(alpha: 0.05),
                    blurRadius: 3,
                    offset: const Offset(0, 1),
                  ),
                ],
              ),
              child: Text(
                message.text,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: isUser ? cs.onPrimary : cs.onSurface,
                      height: 1.35,
                    ),
              ),
            ),
          ),
          if (isUser && showAvatar) ...[
            const SizedBox(width: 6),
            CircleAvatar(
              radius: 12,
              backgroundColor: cs.tertiaryContainer,
              child: Icon(
                Icons.person_outline,
                size: 14,
                color: cs.onTertiaryContainer,
              ),
            ),
          ] else if (isUser) ...[
            const SizedBox(width: 24),
          ],
        ],
      ),
    );
  }

  Widget _buildInputArea(ColorScheme cs) {
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: cs.surface,
        border: Border(
          top: BorderSide(
            color: cs.outline.withOpacity(0.12),
            width: 1,
          ),
        ),
      ),
      child: SafeArea(
        top: false,
        child: Row(
          children: [
            Expanded(
              child: TextField(
                controller: _controller,
                focusNode: _focusNode,
                style: TextStyle(color: cs.onSurface, fontSize: 13),
                cursorColor: cs.primary,
                maxLines: null,
                textInputAction: TextInputAction.send,
                onSubmitted: (_) => _sendMessage(),
                decoration: InputDecoration(
                  hintText: widget.placeholder,
                  hintStyle: TextStyle(
                    color: cs.onSurfaceVariant.withOpacity(0.6),
                    fontSize: 13,
                  ),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(18),
                    borderSide: BorderSide.none,
                  ),
                  filled: true,
                  fillColor: cs.surfaceContainerHigh.withOpacity(0.5),
                  contentPadding: const EdgeInsets.symmetric(
                    horizontal: 14,
                    vertical: 9,
                  ),
                  isDense: true,
                ),
              ),
            ),
            const SizedBox(width: 6),
            Material(
              color: Colors.transparent,
              child: InkWell(
                borderRadius: BorderRadius.circular(18),
                onTap: _sendMessage,
                child: Container(
                  padding: const EdgeInsets.all(9),
                  decoration: BoxDecoration(
                    color: cs.primary,
                    shape: BoxShape.circle,
                  ),
                  child: Icon(
                    Icons.send_rounded,
                    size: 16,
                    color: cs.onPrimary,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
