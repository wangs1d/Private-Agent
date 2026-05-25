import "package:flutter/material.dart";

import "../../core/models/chat_models.dart";
import "../../core/vision/vision_user_limits.dart";
import "../../core/services/speech_service.dart";
import "voice_mode_page.dart";

class ChatPage extends StatefulWidget {
  const ChatPage({
    super.key,
    required this.messages,
    required this.controller,
    required this.onSend,
    this.agentName,
    this.galleryPendingCount = 0,
    this.onPickGalleryImage,
    this.onClearGalleryImages,
    this.onEnterVoiceMode,
    this.isAgentProcessing = false,
    this.agentStatusLine,
    this.onOpenGomoku,
    this.fullComputerAccessEnabled = false,
    this.onToggleFullComputerAccess,
    this.onOpenBackgroundTasks,
    this.backgroundTasksBadgeCount = 0,
  });

  final List<ChatMessage> messages;
  final TextEditingController controller;
  final VoidCallback onSend;
  /// 用户给agent起的名字
  final String? agentName;
  /// 已选相册图张数，待发。
  final int galleryPendingCount;
  final VoidCallback? onPickGalleryImage;
  final VoidCallback? onClearGalleryImages;
  /// 进入语音模式的回调
  final VoidCallback? onEnterVoiceMode;
  /// Agent是否正在处理中（流式输出）
  final bool isAgentProcessing;
  /// `chat.agent_status` 推送的口语化进度，优先于固定「思考中」
  final String? agentStatusLine;
  /// 在 App 内打开五子棋对局（tableId 或 playUrl）
  final void Function(String playUrlOrTableId)? onOpenGomoku;
  /// 是否为本轮消息开启「完全访问电脑」（默认 false = 沙箱）
  final bool fullComputerAccessEnabled;
  final VoidCallback? onToggleFullComputerAccess;
  /// 打开「后台子 Agent 任务」面板（对话框右上角）
  final VoidCallback? onOpenBackgroundTasks;
  /// 运行中后台任务数（用于角标）
  final int backgroundTasksBadgeCount;

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> with SingleTickerProviderStateMixin {
  final SpeechService _speechService = SpeechService();
  bool _isListening = false;
  String _recognizedText = "";
  final ScrollController _scrollController = ScrollController();
  AnimationController? _breathingController;
  Animation<double>? _breathingAnimation;
  List<Map<String, dynamic>>? _cachedMessageGroups;
  int _cachedMessagesLength = -1;

  @override
  void initState() {
    super.initState();
    // 预初始化语音服务
    _speechService.initialize();
    // 初始化呼吸动画
    _breathingController = AnimationController(
      duration: const Duration(milliseconds: 2000),
      vsync: this,
    )..repeat(reverse: true);
    _breathingAnimation = Tween<double>(
      begin: 0.3,
      end: 1.0,
    ).animate(CurvedAnimation(
      parent: _breathingController!,
      curve: Curves.easeInOut,
    ));
  }

  @override
  void didUpdateWidget(covariant ChatPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.messages.length != _cachedMessagesLength ||
        widget.isAgentProcessing != oldWidget.isAgentProcessing ||
        widget.agentStatusLine != oldWidget.agentStatusLine) {
      _cachedMessageGroups = null;
    }
    // 当消息列表长度变化时，自动滚动到底部
    if (widget.messages.length != oldWidget.messages.length) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scrollController.hasClients) {
          _scrollController.animateTo(
            _scrollController.position.maxScrollExtent,
            duration: const Duration(milliseconds: 300),
            curve: Curves.easeOut,
          );
        }
      });
    }
    // 当Agent处理状态改变时（开始/结束），也尝试滚动到底部
    if (widget.isAgentProcessing != oldWidget.isAgentProcessing) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scrollController.hasClients) {
          _scrollController.animateTo(
            _scrollController.position.maxScrollExtent,
            duration: const Duration(milliseconds: 300),
            curve: Curves.easeOut,
          );
        }
      });
    }
    // 每次更新都检查是否需要滚动到底部（确保最新消息可见）
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients) {
        // 如果当前不在底部附近，则滚动到底部
        final double maxScroll = _scrollController.position.maxScrollExtent;
        final double currentScroll = _scrollController.position.pixels;
        // 如果距离底部超过100像素，则滚动到底部
        if (maxScroll - currentScroll > 100) {
          _scrollController.animateTo(
            maxScroll,
            duration: const Duration(milliseconds: 300),
            curve: Curves.easeOut,
          );
        }
      }
    });
  }

  @override
  void dispose() {
    _breathingController?.dispose();
    _speechService.cancel();
    _scrollController.dispose();
    super.dispose();
  }

  Future<void> _handleVoiceInput() async {
    if (_isListening) {
      // 如果正在录音，则停止并发送
      await _speechService.stopListening();
      setState(() => _isListening = false);
      
      // 如果有识别到的文本，直接发送
      if (_recognizedText.isNotEmpty) {
        widget.controller.text = _recognizedText;
        widget.onSend();
        setState(() => _recognizedText = "");
      }
      return;
    }

    setState(() {
      _isListening = true;
      _recognizedText = "";
    });

    await _speechService.startListening(
      onResult: (String text) {
        setState(() {
          _recognizedText = text;
        });
      },
    );
  }

  /// 将消息分组：用户消息单独一组；助手正文按条展示（进度由 `agentStatusLine` 提供，勿把短回复当流程提示吞掉）。
  List<Map<String, dynamic>> _getGroupedMessages() {
    if (_cachedMessageGroups != null &&
        widget.messages.length == _cachedMessagesLength &&
        !widget.isAgentProcessing) {
      return _cachedMessageGroups!;
    }

    final List<Map<String, dynamic>> groups = <Map<String, dynamic>>[];
  
    for (int i = 0; i < widget.messages.length; i++) {
      final ChatMessage currentMessage = widget.messages[i];
      
      // 进度消息特殊处理
      if (currentMessage.role == "assistant_progress") {
        groups.add(<String, dynamic>{
          "isUser": false,
          "main": currentMessage,
          "progress": null,
          "isProgress": true,
        });
      } else if (currentMessage.role == "user") {
        groups.add(<String, dynamic>{
          "isUser": true,
          "main": currentMessage,
          "progress": null,
          "isProgress": false,
        });
      } else {
        groups.add(<String, dynamic>{
          "isUser": false,
          "main": currentMessage,
          "progress": null,
          "isProgress": false,
        });
      }
    }

    _cachedMessageGroups = groups;
    _cachedMessagesLength = widget.messages.length;
    return groups;
  }

  /// 处理中气泡文案：`agent_status` > 历史流程提示 > 默认
  String _processingStatusText([ChatMessage? progressMessage]) {
    final String? live = widget.agentStatusLine?.trim();
    if (live != null && live.isNotEmpty) return live;
    final String? progress = progressMessage?.text.trim();
    if (progress != null && progress.isNotEmpty) return progress;
    return "Agent 思考中...";
  }

  Widget _buildProgressBubble(ColorScheme cs, String text) {
    return Align(
      alignment: Alignment.centerLeft,
      child: AnimatedBuilder(
        animation: _breathingAnimation!,
        builder: (context, child) {
          return Container(
            margin: const EdgeInsets.symmetric(vertical: 4),
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            decoration: BoxDecoration(
              color: cs.onSurface.withOpacity(0.08 * _breathingAnimation!.value),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(
                color: cs.onSurface.withOpacity(0.2 * _breathingAnimation!.value),
                width: 1,
              ),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                CustomPaint(
                  size: const Size(10, 10),
                  painter: _BreathingDotPainter(
                    opacity: _breathingAnimation!.value,
                  ),
                ),
                const SizedBox(width: 6),
                Text(
                  text,
                  style: Theme.of(context).textTheme.labelSmall?.copyWith(
                        color: cs.onSurface.withOpacity(0.6 * _breathingAnimation!.value),
                        fontWeight: FontWeight.w500,
                      ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  /// 构建灰色链接显示组件
  Widget _buildGrayLinks(String text) {
    final RegExp urlRegex = RegExp(r'https?://\S+');
    final Iterable<RegExpMatch> matches = urlRegex.allMatches(text);
    
    if (matches.isEmpty) return const SizedBox.shrink();
    
    final List<Widget> linkWidgets = [];
    for (final match in matches) {
      final String url = match.group(0)!;
      linkWidgets.add(Container(
        margin: const EdgeInsets.only(bottom: 4),
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        decoration: BoxDecoration(
          color: Colors.grey.withOpacity(0.15),
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: Colors.grey.withOpacity(0.3)),
        ),
        child: Text(
          url,
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
            color: Colors.grey[600],
            fontSize: 12,
          ),
        ),
      ));
    }
    
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: linkWidgets,
    );
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final List<Map<String, dynamic>> messageGroups = _getGroupedMessages();
    final bool showLiveThinking =
        widget.isAgentProcessing && _breathingAnimation != null;
    final int itemCount = messageGroups.length + (showLiveThinking ? 1 : 0);

    return ColoredBox(
      color: cs.surface,
      child: Column(
        children: <Widget>[
          Expanded(
            child: Stack(
              children: [
                ListView.builder(
                  controller: _scrollController,
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  itemCount: itemCount,
                  itemBuilder: (BuildContext context, int index) {
                    if (showLiveThinking && index == messageGroups.length) {
                      return _buildProgressBubble(
                        cs,
                        _processingStatusText(),
                      );
                    }

                    final messageGroup = messageGroups[index];
                    final bool isUser = messageGroup['isUser'] as bool;
                    final mainMessage = messageGroup['main'] as ChatMessage;
                    final bool isProgress = messageGroup['isProgress'] as bool;
                    
                    // 进度消息：特殊渲染
                    if (isProgress) {
                      return _buildProgressBubble(cs, mainMessage.text);
                    }
                    
                    return Align(
                      alignment:
                          isUser ? Alignment.centerRight : Alignment.centerLeft,
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: 
                            isUser ? CrossAxisAlignment.end : CrossAxisAlignment.start,
                        children: [
                          Card(
                            clipBehavior: Clip.antiAlias,
                            color: isUser
                                ? cs.surfaceContainerHigh
                                : cs.surfaceContainer,
                            elevation: 0,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(12),
                              side: BorderSide(
                                color: cs.outline.withOpacity(0.28),
                              ),
                            ),
                            child: Padding(
                              padding: const EdgeInsets.all(12),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                mainAxisSize: MainAxisSize.min,
                                children: <Widget>[
                                  if (mainMessage.attachmentImageCount > 0)
                                    Padding(
                                      padding: const EdgeInsets.only(bottom: 6),
                                      child: Row(
                                        mainAxisSize: MainAxisSize.min,
                                        children: <Widget>[
                                          Icon(
                                            Icons.photo_camera_outlined,
                                            size: 16,
                                            color: Theme.of(context).colorScheme.primary,
                                          ),
                                          const SizedBox(width: 4),
                                          Text(
                                            "配图 ×${mainMessage.attachmentImageCount}",
                                            style: Theme.of(context).textTheme.labelSmall?.copyWith(
                                                  color: Theme.of(context).colorScheme.primary,
                                                ),
                                          ),
                                        ],
                                      ),
                                    ),
                                  Text(
                                    mainMessage.text,
                                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                                          color: cs.onSurface,
                                        ),
                                  ),
                                  // 将agent消息中的链接显示为灰色
                                  if (!isUser && mainMessage.text.contains(RegExp(r'https?://\S+')))
                                    Padding(
                                      padding: const EdgeInsets.only(top: 6),
                                      child: _buildGrayLinks(mainMessage.text),
                                    ),
                                  if (!isUser && mainMessage.playUrl != null && mainMessage.playUrl!.isNotEmpty)
                                    Padding(
                                      padding: const EdgeInsets.only(top: 10),
                                      child: _GomokuPlayUrlCard(
                                        playUrl: mainMessage.playUrl!,
                                        onOpen: widget.onOpenGomoku,
                                      ),
                                    ),
                                  // 将agent消息中的链接显示为灰色
                                  if (!isUser && mainMessage.text.contains(RegExp(r'https?://\S+')))
                                    Padding(
                                      padding: const EdgeInsets.only(top: 6),
                                      child: _buildGrayLinks(mainMessage.text),
                                    ),
                                ],
                              ),
                            ),
                          ),
                        ],
                      ),
                    );
                  },
                ),
                if (widget.onOpenBackgroundTasks != null)
                  Positioned(
                    top: 4,
                    right: 4,
                    child: Material(
                      color: cs.surfaceContainerHigh.withValues(alpha: 0.94),
                      elevation: 1,
                      shadowColor: Colors.black26,
                      borderRadius: BorderRadius.circular(20),
                      child: IconButton(
                        tooltip: "查看后台任务",
                        visualDensity: VisualDensity.compact,
                        onPressed: widget.onOpenBackgroundTasks,
                        icon: Badge(
                          isLabelVisible: widget.backgroundTasksBadgeCount > 0,
                          label: Text(
                            widget.backgroundTasksBadgeCount > 9
                                ? "9+"
                                : "${widget.backgroundTasksBadgeCount}",
                          ),
                          child: const Icon(Icons.pending_actions_outlined, size: 22),
                        ),
                      ),
                    ),
                  ),
                // 滚动到底部按钮
                Positioned(
                  right: 16,
                  bottom: 16,
                  child: AnimatedOpacity(
                    opacity: _scrollController.hasClients && 
                             _scrollController.position.pixels < _scrollController.position.maxScrollExtent - 100 
                             ? 1.0 : 0.0,
                    duration: const Duration(milliseconds: 300),
                    child: IgnorePointer(
                      ignoring: !(_scrollController.hasClients && 
                                 _scrollController.position.pixels < _scrollController.position.maxScrollExtent - 100),
                      child: FloatingActionButton.small(
                        heroTag: 'scroll_to_bottom',
                        onPressed: () {
                          if (_scrollController.hasClients) {
                            _scrollController.animateTo(
                              _scrollController.position.maxScrollExtent,
                              duration: const Duration(milliseconds: 300),
                              curve: Curves.easeOut,
                            );
                          }
                        },
                        backgroundColor: cs.primaryContainer,
                        child: Icon(Icons.arrow_downward, color: cs.onPrimaryContainer),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
          ColoredBox(
            color: cs.surface,
            child: SafeArea(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    // 语音识别状态提示
                    if (_isListening)
                      Container(
                        margin: const EdgeInsets.only(bottom: 8),
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                        decoration: BoxDecoration(
                          color: cs.errorContainer.withOpacity(0.2),
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(
                            color: cs.error.withOpacity(0.5),
                            width: 1,
                          ),
                        ),
                        child: Row(
                          children: <Widget>[
                            SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                valueColor: AlwaysStoppedAnimation<Color>(cs.error),
                              ),
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                _recognizedText.isNotEmpty
                                    ? "正在识别: $_recognizedText"
                                    : "正在聆听...",
                                style: Theme.of(context).textTheme.labelMedium?.copyWith(
                                      color: cs.error,
                                    ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    if (widget.galleryPendingCount > 0)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: Row(
                          children: <Widget>[
                            Expanded(
                              child: Text(
                                widget.galleryPendingCount > 1
                                    ? "已选 ${widget.galleryPendingCount} 张图，发送时传给 Agent"
                                    : "已选图片，发送时传给 Agent",
                                style: Theme.of(context).textTheme.labelMedium?.copyWith(
                                      color: cs.primary,
                                    ),
                              ),
                            ),
                            if (widget.onClearGalleryImages != null)
                              TextButton(
                                onPressed: widget.onClearGalleryImages,
                                child: const Text("清除"),
                              ),
                          ],
                        ),
                      ),
                    // 主输入框容器
                    Container(
                      decoration: BoxDecoration(
                        color: cs.surfaceContainerHigh,
                        borderRadius: BorderRadius.circular(24),
                        border: Border.all(
                          color: cs.outline.withOpacity(0.2),
                          width: 1,
                        ),
                      ),
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(8, 8, 8, 8),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: <Widget>[
                            // 第一行：输入框 + 发送/打断按钮
                            Row(
                              crossAxisAlignment: CrossAxisAlignment.center,
                              children: <Widget>[
                                Flexible(
                                  flex: 3,
                                  child: TextField(
                                    controller: widget.controller,
                                    style: TextStyle(color: cs.onSurface),
                                    cursorColor: cs.primary,
                                    maxLines: null,
                                    textInputAction: TextInputAction.send,
                                    keyboardType: TextInputType.multiline,
                                    onSubmitted: (_) {
                                      // 按下 Enter 键时发送消息
                                      if (widget.controller.text.trim().isNotEmpty) {
                                        widget.onSend();
                                      }
                                    },
                                    decoration: InputDecoration(
                                      hintText: "发消息或输入\"/\"选择技能",
                                      border: InputBorder.none,
                                      hintStyle: TextStyle(
                                        color: cs.onSurfaceVariant.withOpacity(0.6),
                                        fontSize: 15,
                                      ),
                                      contentPadding: const EdgeInsets.symmetric(horizontal: 8),
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 6),
                                if (widget.onToggleFullComputerAccess != null)
                                  Container(
                                    decoration: BoxDecoration(
                                      color: widget.fullComputerAccessEnabled
                                          ? cs.primary.withOpacity(0.18)
                                          : cs.surfaceContainerHighest,
                                      shape: BoxShape.circle,
                                      border: widget.fullComputerAccessEnabled
                                          ? Border.all(color: cs.primary.withOpacity(0.45))
                                          : null,
                                    ),
                                    child: IconButton(
                                      icon: Icon(
                                        widget.fullComputerAccessEnabled
                                            ? Icons.lock_open_rounded
                                            : Icons.shield_outlined,
                                        size: 20,
                                        color: widget.fullComputerAccessEnabled
                                            ? cs.primary
                                            : cs.onSurfaceVariant,
                                      ),
                                      tooltip: widget.fullComputerAccessEnabled
                                          ? "完全访问：已开启（可控制电脑等高权限操作）"
                                          : "沙箱模式：点击开启完全访问",
                                      onPressed: widget.onToggleFullComputerAccess,
                                      padding: EdgeInsets.zero,
                                      constraints: const BoxConstraints(
                                        minWidth: 36,
                                        minHeight: 36,
                                      ),
                                    ),
                                  ),
                                if (widget.onToggleFullComputerAccess != null)
                                  const SizedBox(width: 6),
                                // 发送按钮
                                Container(
                                  decoration: BoxDecoration(
                                    color: cs.surfaceContainerHighest,
                                    shape: BoxShape.circle,
                                  ),
                                  child: IconButton(
                                    icon: Icon(Icons.send, size: 20, color: cs.onSurfaceVariant),
                                    onPressed: widget.onSend,
                                    padding: EdgeInsets.zero,
                                    constraints: const BoxConstraints(
                                      minWidth: 36,
                                      minHeight: 36,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                            // 第二行：加号 + 语音按钮
                            Padding(
                              padding: const EdgeInsets.only(top: 6),
                              child: Row(
                                children: <Widget>[
                                  // 加号按钮
                                  if (widget.onPickGalleryImage != null)
                                    Container(
                                      decoration: BoxDecoration(
                                        color: cs.surfaceContainerHighest,
                                        shape: BoxShape.circle,
                                      ),
                                      child: IconButton(
                                        icon: Icon(Icons.add, size: 18, color: cs.onSurfaceVariant),
                                        onPressed: widget.onPickGalleryImage,
                                        padding: EdgeInsets.zero,
                                        constraints: const BoxConstraints(
                                          minWidth: 32,
                                          minHeight: 32,
                                        ),
                                      ),
                                    ),
                                  if (widget.onPickGalleryImage != null)
                                    const SizedBox(width: 8),
                                  // 语音按钮 - 点击进入语音模式
                                  Container(
                                    decoration: BoxDecoration(
                                      color: cs.surfaceContainerHighest,
                                      shape: BoxShape.circle,
                                    ),
                                    child: IconButton(
                                      icon: Icon(
                                        Icons.mic_none,
                                        size: 18,
                                        color: cs.onSurfaceVariant,
                                      ),
                                      onPressed: widget.onEnterVoiceMode,
                                      padding: EdgeInsets.zero,
                                      constraints: const BoxConstraints(
                                        minWidth: 32,
                                        minHeight: 32,
                                      ),
                                      tooltip: '进入语音模式',
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _GomokuPlayUrlCard extends StatelessWidget {
  const _GomokuPlayUrlCard({
    required this.playUrl,
    this.onOpen,
  });

  final String playUrl;
  final void Function(String playUrlOrTableId)? onOpen;

  void _open(BuildContext context) {
    if (onOpen != null) {
      onOpen!(playUrl);
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text("无法打开对局：未配置内嵌入口")),
    );
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: cs.primaryContainer.withOpacity(0.35),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: cs.primary.withOpacity(0.35)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Icon(Icons.grid_on, size: 18, color: cs.primary),
              const SizedBox(width: 6),
              Text(
                "五子棋对局",
                style: Theme.of(context).textTheme.titleSmall?.copyWith(
                      color: cs.primary,
                      fontWeight: FontWeight.w600,
                    ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            "Agent 已开好棋局，你执白棋（后手）。",
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: cs.onSurfaceVariant,
                ),
          ),
          const SizedBox(height: 10),
          FilledButton.icon(
            onPressed: () => _open(context),
            icon: const Icon(Icons.sports_esports, size: 18),
            label: const Text("在 App 内进入对局"),
          ),
        ],
      ),
    );
  }
}

/// 技能按钮组件
class _SkillButton extends StatelessWidget {
  const _SkillButton({
    required this.icon,
    required this.label,
    required this.color,
    required this.onPressed,
  });

  final IconData icon;
  final String label;
  final Color color;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return OutlinedButton.icon(
      onPressed: onPressed,
      icon: Icon(icon, size: 16, color: color),
      label: Text(
        label,
        style: TextStyle(
          fontSize: 13,
          color: color,
          fontWeight: FontWeight.w500,
        ),
      ),
      style: OutlinedButton.styleFrom(
        foregroundColor: color,
        side: BorderSide(color: color.withOpacity(0.3)),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        minimumSize: Size.zero,
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
        ),
      ),
    );
  }
}

/// 呼吸灯小球绘制器 - 中间浅外边深
class _BreathingDotPainter extends CustomPainter {
  final double opacity;

  _BreathingDotPainter({required this.opacity});

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = size.width / 2;

    // 创建径向渐变：中间浅，外边深（纯灰色系）
    final gradient = RadialGradient(
      colors: [
        Colors.grey.withOpacity(opacity * 0.4),  // 中间浅色（灰色）
        Colors.grey.withOpacity(opacity * 0.6),   // 中间过渡
        Colors.grey.withOpacity(opacity * 0.9),   // 外边深色
      ],
      stops: const [0.0, 0.5, 1.0],
      center: Alignment.center,
    );

    final paint = Paint()
      ..shader = gradient.createShader(
        Rect.fromCircle(center: center, radius: radius),
      )
      ..style = PaintingStyle.fill;

    canvas.drawCircle(center, radius, paint);
  }

  @override
  bool shouldRepaint(covariant _BreathingDotPainter oldDelegate) {
    return oldDelegate.opacity != opacity;
  }
}
