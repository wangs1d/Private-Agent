import "package:flutter/foundation.dart" show defaultTargetPlatform, kIsWeb, TargetPlatform;
import "package:flutter/material.dart";

import "../../core/models/chat_models.dart";
import "../../core/utils/content_summary_parser.dart";
import "../../core/vision/vision_user_limits.dart";
import "../../core/services/speech_service.dart";
import "content_summary_card.dart";
import "content_summary_detail_modal.dart";
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
    this.onOpenPhoneDialer,
    this.inputFocusNode,
  });

  final List<ChatMessage> messages;
  final TextEditingController controller;
  final FocusNode? inputFocusNode;
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
  /// 打开「后台子 Agent 任务」面板
  final VoidCallback? onOpenBackgroundTasks;
  /// 运行中后台任务数（用于角标）
  final int backgroundTasksBadgeCount;
  /// 打开网络电话拨号面板
  final VoidCallback? onOpenPhoneDialer;

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> with SingleTickerProviderStateMixin {
  final SpeechService _speechService = SpeechService();
  bool _isListening = false;
  String _recognizedText = "";
  final ScrollController _scrollController = ScrollController();
  bool _isUserScrolling = false;
  bool _hasNewAgentMessage = false;
  AnimationController? _breathingController;
  Animation<double>? _breathingAnimation;
  List<Map<String, dynamic>>? _cachedMessageGroups;
  int _cachedMessagesLength = -1;
  /// 消息折叠相关状态
  static const int _collapseThreshold = 30; // 超过此数量时开始折叠
  static const int _visibleCount = 30; // 折叠后显示的消息数量
  bool _isCollapsed = true; // 是否处于折叠状态
  int _collapsedCount = 0; // 被折叠的消息数量
  bool _hasHadMessages = false; // 是否已经加载过消息（用于区分初始加载和后续新消息）

  @override
  void initState() {
    super.initState();
    // Windows SAPI 在启动阶段预初始化会触发原生崩溃 (0xC0000409)，改为用户点麦克风时按需初始化
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.windows) {
      _speechService.initialize();
    }
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
    // 监听滚动：检测用户是否在手动滚动
    _scrollController.addListener(_onScroll);

    // 初始化后自动滚动到最新消息
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients) {
        _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
      }
    });
  }

  /// 滚动到底部的通用方法
  void _scrollToBottom({bool instant = false}) {
    if (_scrollController.hasClients) {
      if (instant) {
        _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
      } else {
        _scrollController.animateTo(
          _scrollController.position.maxScrollExtent,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOut,
        );
      }
    }
  }

  void _onScroll() {
    if (!_scrollController.hasClients) return;
    final double maxScroll = _scrollController.position.maxScrollExtent;
    final double currentScroll = _scrollController.position.pixels;
    final double threshold = maxScroll - 100;

    if (maxScroll - currentScroll > 100) {
      // 用户向上滑动了（不在底部）
      if (!_isUserScrolling) {
        setState(() => _isUserScrolling = true);
      }
    } else {
      // 用户滚动到底部了
      if (_isUserScrolling) {
        setState(() {
          _isUserScrolling = false;
          _hasNewAgentMessage = false;
        });
      }
    }
  }

  @override
  void didUpdateWidget(covariant ChatPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.messages.length != _cachedMessagesLength ||
        widget.isAgentProcessing != oldWidget.isAgentProcessing ||
        widget.agentStatusLine != oldWidget.agentStatusLine) {
      _cachedMessageGroups = null;
    }

    // 检测是否有新的用户消息
    final bool hasNewUserMessage = widget.messages.length > oldWidget.messages.length &&
        widget.messages.isNotEmpty &&
        widget.messages.last.role == "user";

    // 用户发送消息时，无论是否在滑动，都自动滚动到底部
    if (hasNewUserMessage) {
      _isUserScrolling = false;
      _hasNewAgentMessage = false;

      // 如果消息数量超过阈值且当前是展开状态，自动折叠
      if (widget.messages.length > _collapseThreshold && !_isCollapsed) {
        setState(() => _isCollapsed = true);
      }

      WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());
      return;
    }

    // 检测是否有新的 agent 消息
    final bool hasNewAgentMessage = widget.messages.length > oldWidget.messages.length &&
        widget.messages.isNotEmpty &&
        widget.messages.last.role != "user";

    // 用户在滑动时不自动滚动，标记有新消息
    if (hasNewAgentMessage && _isUserScrolling) {
      setState(() => _hasNewAgentMessage = true);
      return;
    }

    // 用户没有主动滑动时，自动滚动到底部
    if (widget.messages.length != oldWidget.messages.length) {
      _isUserScrolling = false;
      _hasNewAgentMessage = false;

      final bool isFirstLoad = !_hasHadMessages && widget.messages.isNotEmpty;
      if (isFirstLoad) _hasHadMessages = true;

      // 如果消息数量超过阈值且当前是展开状态，自动折叠
      if (widget.messages.length > _collapseThreshold && !_isCollapsed) {
        setState(() => _isCollapsed = true);
      }

      WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom(instant: isFirstLoad));
    }
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

  /// 获取用于显示的消息列表（考虑折叠状态）
  List<Map<String, dynamic>> _getDisplayMessages() {
    final List<Map<String, dynamic>> allGroups = _getGroupedMessages();

    // 如果消息数量不超过阈值，不折叠
    if (allGroups.length <= _collapseThreshold) {
      _collapsedCount = 0;
      return allGroups;
    }

    // 计算被折叠的消息数量
    _collapsedCount = allGroups.length - _visibleCount;

    // 如果处于折叠状态，只返回后面的消息
    if (_isCollapsed) {
      return allGroups.sublist(allGroups.length - _visibleCount);
    }

    // 展开状态，返回所有消息
    return allGroups;
  }

  /// 切换折叠/展开状态
  void _toggleCollapse() {
    setState(() {
      _isCollapsed = !_isCollapsed;
      // 如果展开，滚动到之前的位置；如果折叠，滚动到底部
      if (!_isCollapsed) {
        // 展开时保持当前位置（稍后会自动调整）
      } else {
        // 折叠后滚动到底部
        WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());
      }
    });
  }

  /// 构建折叠按钮组件
  Widget _buildCollapseButton(ColorScheme cs) {
    if (_collapsedCount <= 0) return const SizedBox.shrink();

    // 获取被折叠消息的时间范围
    String timeRange = "";
    final List<Map<String, dynamic>> allGroups = _getGroupedMessages();
    if (allGroups.length > _visibleCount) {
      final Map<String, dynamic> firstCollapsed = allGroups[allGroups.length - _visibleCount - 1];
      final Map<String, dynamic> lastCollapsed = allGroups.first;
      final ChatMessage firstMsg = firstCollapsed['main'] as ChatMessage;
      final ChatMessage lastMsg = lastCollapsed['main'] as ChatMessage;

      timeRange = " (${_formatTimeRange(firstMsg.timestamp, lastMsg.timestamp)})";
    }

    return Center(
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 8),
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            onTap: _toggleCollapse,
            borderRadius: BorderRadius.circular(20),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              decoration: BoxDecoration(
                color: cs.surfaceContainerHighest.withOpacity(0.6),
                borderRadius: BorderRadius.circular(20),
                border: Border.all(
                  color: cs.outline.withOpacity(0.2),
                  width: 1,
                ),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Icon(
                    _isCollapsed ? Icons.expand_more : Icons.expand_less,
                    size: 18,
                    color: cs.onSurfaceVariant,
                  ),
                  const SizedBox(width: 6),
                  Text(
                    _isCollapsed
                        ? "查看 $_collapsedCount 条历史消息$timeRange"
                        : "收起历史消息",
                    style: Theme.of(context).textTheme.labelMedium?.copyWith(
                      color: cs.onSurfaceVariant,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// 格式化时间范围
  String _formatTimeRange(DateTime start, DateTime end) {
    final DateTime now = DateTime.now();
    final Duration startDiff = now.difference(start);
    final Duration endDiff = now.difference(end);

    String formatTime(DateTime time) {
      final Duration diff = now.difference(time);
      if (diff.inDays > 7) {
        return "${time.month}/${time.day}";
      } else if (diff.inDays > 0) {
        return "${diff.inDays}天前";
      } else if (diff.inHours > 0) {
        return "${diff.inHours}h前";
      } else {
        return "${diff.inMinutes}m前";
      }
    }

    return "${formatTime(end)} - ${formatTime(start)}";
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

  Widget _buildMessageText(
    ColorScheme cs,
    ChatMessage message, {
    required bool isUser,
    ContentSummaryParseResult? contentSummary,
  }) {
    if (isUser) {
      return Text(
        message.text,
        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
              color: cs.onSurface,
            ),
      );
    }

    if (contentSummary?.summary != null) {
      return ContentSummaryMessageBody(
        summary: contentSummary!.summary!,
        briefText: contentSummary.briefText,
        extraText: contentSummary.cleanedText,
        onCardTap: () => ContentSummaryDetailModal.show(
          context,
          contentSummary.summary!,
        ),
      );
    }

    return Text(
      message.text,
      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
            color: cs.onSurface,
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

  /// 构建消息时间戳
  Widget _buildMessageTimestamp(ChatMessage message, bool isUser) {
    final DateTime now = DateTime.now();
    final DateTime msgTime = message.timestamp;
    final Duration diff = now.difference(msgTime);

    String timeStr;
    if (diff.inMinutes < 1) {
      timeStr = "刚刚";
    } else if (diff.inHours < 1) {
      timeStr = "${diff.inMinutes}分钟前";
    } else if (diff.inDays < 1) {
      timeStr = "${diff.inHours}小时前";
    } else if (diff.inDays < 7) {
      timeStr = "${diff.inDays}天前";
    } else {
      timeStr = "${msgTime.month}/${msgTime.day} ${msgTime.hour.toString().padLeft(2, '0')}:${msgTime.minute.toString().padLeft(2, '0')}";
    }

    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Text(
        timeStr,
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
          color: Theme.of(context).colorScheme.onSurfaceVariant.withOpacity(0.6),
          fontSize: 11,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final List<Map<String, dynamic>> messageGroups = _getGroupedMessages();
    final bool showLiveThinking =
        widget.isAgentProcessing && _breathingAnimation != null;
    final List<Map<String, dynamic>> displayMessages = _getDisplayMessages();
    final int itemCount = displayMessages.length + (showLiveThinking ? 1 : 0) + (_collapsedCount > 0 && !_isCollapsed ? 1 : 0);
    // 如果处于折叠状态，需要在列表开头添加折叠按钮
    final bool showCollapseButton = _collapsedCount > 0;

    return ColoredBox(
          color: cs.surface,
          child: Column(
            children: <Widget>[
              Expanded(
                child: Stack(
                  children: <Widget>[
                    if (widget.messages.isEmpty)
                      Center(
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: <Widget>[
                            Icon(
                              Icons.chat_bubble_outline,
                              size: 64,
                              color: cs.onSurfaceVariant.withOpacity(0.3),
                            ),
                            const SizedBox(height: 16),
                            Text(
                              "开始与 AI 助手对话吧！",
                              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                                color: cs.onSurfaceVariant.withOpacity(0.6),
                              ),
                            ),
                            const SizedBox(height: 8),
                            Text(
                              "输入消息或使用语音开始交流",
                              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                                color: cs.onSurfaceVariant.withOpacity(0.4),
                              ),
                            ),
                          ],
                        ),
                      )
                    else
                      ListView.builder(
                  controller: _scrollController,
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  itemCount: showCollapseButton ? itemCount + 1 : itemCount,
                  itemBuilder: (BuildContext context, int index) {
                    // 如果需要显示折叠按钮且是第一项
                    if (showCollapseButton && index == 0) {
                      return _buildCollapseButton(cs);
                    }

                    // 调整索引（如果显示了折叠按钮）
                    final int adjustedIndex = showCollapseButton ? index - 1 : index;

                    // 检查是否是进度气泡
                    if (showLiveThinking && adjustedIndex == displayMessages.length) {
                      return _buildProgressBubble(
                        cs,
                        _processingStatusText(),
                      );
                    }

                    final messageGroup = displayMessages[adjustedIndex];
                    final bool isUser = messageGroup['isUser'] as bool;
                    final mainMessage = messageGroup['main'] as ChatMessage;
                    final bool isProgress = messageGroup['isProgress'] as bool;
                    final ContentSummaryParseResult? contentSummary = isUser
                        ? null
                        : ContentSummaryParser.parse(mainMessage.text);
                    
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
                                  _buildMessageText(
                                    cs,
                                    mainMessage,
                                    isUser: isUser,
                                    contentSummary: contentSummary,
                                  ),
                                  if (!isUser &&
                                      contentSummary?.summary == null &&
                                      mainMessage.text.contains(RegExp(r'https?://\S+')))
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
                                ],
                              ),
                            ),
                          ),
                          _buildMessageTimestamp(mainMessage, isUser),
                        ],
                      ),
                    );
                  },
                ),
                  ],
                ),
              ),
              ColoredBox(
                color: cs.surface,
                child: SafeArea(
                  top: false,
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
                    // 滚动到底部按钮（用户滑动时显示）
                    if (_isUserScrolling)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: <Widget>[
                            if (_hasNewAgentMessage)
                              Padding(
                                padding: const EdgeInsets.only(right: 12),
                                child: Text(
                                  "Agent 有新消息",
                                  style: TextStyle(
                                    color: cs.primary,
                                    fontSize: 13,
                                    fontWeight: FontWeight.w500,
                                  ),
                                ),
                              ),
                            FloatingActionButton.small(
                              heroTag: 'scroll_to_bottom',
                              onPressed: () {
                                if (_scrollController.hasClients) {
                                  setState(() {
                                    _isUserScrolling = false;
                                    _hasNewAgentMessage = false;
                                  });
                                  _scrollToBottom();
                                }
                              },
                              backgroundColor: cs.primaryContainer,
                              child: Icon(Icons.arrow_downward, color: cs.onPrimaryContainer),
                            ),
                          ],
                        ),
                      ),
                    // 主输入框容器
                    AnimatedBuilder(
                      animation: _breathingAnimation!,
                      builder: (context, child) {
                        return Container(
                          decoration: BoxDecoration(
                            color: cs.surfaceContainerHigh,
                            borderRadius: BorderRadius.circular(24),
                            border: Border.all(
                              color: Colors.white.withOpacity(0.12 + 0.18 * _breathingAnimation!.value),
                              width: 1.5,
                            ),
                            boxShadow: [
                              BoxShadow(
                                color: Colors.white.withOpacity(0.06 * _breathingAnimation!.value),
                                blurRadius: 10,
                                spreadRadius: 2,
                              ),
                            ],
                          ),
                          child: child,
                        );
                      },
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
                                    focusNode: widget.inputFocusNode,
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
                            // 第二行：加号 + 语音按钮 + 网络电话按钮
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
                                  const SizedBox(width: 8),
                                  if (widget.onOpenPhoneDialer != null)
                                    Container(
                                      decoration: BoxDecoration(
                                        color: cs.surfaceContainerHighest,
                                        shape: BoxShape.circle,
                                      ),
                                      child: IconButton(
                                        icon: Icon(
                                          Icons.phone_in_talk,
                                          size: 18,
                                          color: cs.onSurfaceVariant,
                                        ),
                                        onPressed: widget.onOpenPhoneDialer,
                                        padding: EdgeInsets.zero,
                                        constraints: const BoxConstraints(
                                          minWidth: 32,
                                          minHeight: 32,
                                        ),
                                        tooltip: '网络电话',
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