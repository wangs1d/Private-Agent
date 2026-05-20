import "package:flutter/material.dart";
import "package:url_launcher/url_launcher.dart";

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

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> {
  final SpeechService _speechService = SpeechService();
  bool _isListening = false;
  String _recognizedText = "";
  final ScrollController _scrollController = ScrollController();

  @override
  void initState() {
    super.initState();
    // 预初始化语音服务
    _speechService.initialize();
  }

  @override
  void didUpdateWidget(covariant ChatPage oldWidget) {
    super.didUpdateWidget(oldWidget);
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
  }

  @override
  void dispose() {
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

  /// 将消息分组：用户消息 + 其后的流程提示消息
  List<Map<String, dynamic>> _getGroupedMessages() {
    final List<Map<String, dynamic>> groups = [];
    int i = 0;
    
    while (i < widget.messages.length) {
      final currentMessage = widget.messages[i];
      
      // 如果是用户消息
      if (currentMessage.role == "user") {
        ChatMessage? progressMsg;
        
        // 查找下一条消息是否是流程提示
        if (i + 1 < widget.messages.length) {
          final nextMessage = widget.messages[i + 1];
          if (nextMessage.role != "user" && nextMessage.text.isNotEmpty) {
            if (nextMessage.text.contains("正在") || 
                nextMessage.text.contains("创建") || 
                nextMessage.text.contains("处理") ||
                nextMessage.text.contains("思考")) {
              progressMsg = nextMessage;
              i++; // 跳过这条流程消息
            }
          }
        }
        
        groups.add({
          'isUser': true,
          'main': currentMessage,
          'progress': progressMsg,
        });
      } else {
        // 非用户消息（且不包含进度关键词），直接添加
        groups.add({
          'isUser': false,
          'main': currentMessage,
          'progress': null,
        });
      }
      
      i++;
    }
    
    return groups;
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;

    return ColoredBox(
      color: cs.surface,
      child: Column(
        children: <Widget>[
          // Agent响应状态指示器（左上角）
          if (widget.isAgentProcessing)
            Container(
              margin: const EdgeInsets.only(left: 12, top: 8),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: cs.primaryContainer.withOpacity(0.3),
                borderRadius: BorderRadius.circular(16),
                border: Border.all(
                  color: cs.primary.withOpacity(0.5),
                  width: 1,
                ),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  SizedBox(
                    width: 12,
                    height: 12,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      valueColor: AlwaysStoppedAnimation<Color>(cs.primary),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Text(
                    "Agent 思考中...",
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                          color: cs.primary,
                          fontWeight: FontWeight.w500,
                        ),
                  ),
                ],
              ),
            ),
          Expanded(
            child: ListView.builder(
              controller: _scrollController,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              itemCount: _getGroupedMessages().length,
              itemBuilder: (BuildContext context, int index) {
                final messageGroup = _getGroupedMessages()[index];
                final bool isUser = messageGroup['isUser'] as bool;
                final mainMessage = messageGroup['main'] as ChatMessage;
                final progressMessage = messageGroup['progress'] as ChatMessage?;
                
                return Align(
                  alignment:
                      isUser ? Alignment.centerRight : Alignment.centerLeft,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: 
                        isUser ? CrossAxisAlignment.end : CrossAxisAlignment.start,
                    children: [
                      Card(
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
                              if (!isUser && mainMessage.playUrl != null && mainMessage.playUrl!.isNotEmpty)
                                Padding(
                                  padding: const EdgeInsets.only(top: 10),
                                  child: _GomokuPlayUrlCard(playUrl: mainMessage.playUrl!),
                                ),
                            ],
                          ),
                        ),
                      ),
                      // 如果是用户消息，且有后续的流程提示，显示在下方左侧
                      if (isUser && progressMessage != null)
                        Container(
                          margin: const EdgeInsets.only(top: 4, left: 8),
                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                          decoration: BoxDecoration(
                            color: cs.primaryContainer.withOpacity(0.3),
                            borderRadius: BorderRadius.circular(12),
                            border: Border.all(
                              color: cs.primary.withOpacity(0.5),
                              width: 1,
                            ),
                          ),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: <Widget>[
                              SizedBox(
                                width: 10,
                                height: 10,
                                child: CircularProgressIndicator(
                                  strokeWidth: 1.5,
                                  valueColor: AlwaysStoppedAnimation<Color>(cs.primary),
                                ),
                              ),
                              const SizedBox(width: 6),
                              Text(
                                progressMessage.text,
                                style: Theme.of(context).textTheme.labelSmall?.copyWith(
                                      color: cs.primary,
                                      fontWeight: FontWeight.w500,
                                    ),
                              ),
                            ],
                          ),
                        ),
                    ],
                  ),
                );
              },
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
                            // 第一行：输入框 + 发送按钮
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
  const _GomokuPlayUrlCard({required this.playUrl});

  final String playUrl;

  Future<void> _open(BuildContext context) async {
    final Uri uri = Uri.parse(playUrl);
    final bool ok = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!ok && context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("无法打开对局链接：$playUrl")),
      );
    }
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
          SelectableText(
            playUrl,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  fontFamily: "monospace",
                  color: cs.onSurfaceVariant,
                ),
          ),
          const SizedBox(height: 10),
          FilledButton.icon(
            onPressed: () => _open(context),
            icon: const Icon(Icons.open_in_new, size: 18),
            label: const Text("进入对局"),
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
