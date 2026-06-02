import "dart:io";
import "package:flutter/material.dart";
import "package:image_picker/image_picker.dart";
import "package:video_player/video_player.dart";

import "../../core/config/api_config.dart";
import "../../core/services/world_api_client.dart";

/// 好友聊天页面
class FriendChatPage extends StatefulWidget {
  const FriendChatPage({
    super.key,
    required this.api,
    required this.friendActorId,
    required this.friendName,
  });

  final WorldApiClient api;
  final String friendActorId;
  final String friendName;

  @override
  State<FriendChatPage> createState() => _FriendChatPageState();
}

class _FriendChatPageState extends State<FriendChatPage> {
  final TextEditingController _controller = TextEditingController();
  final ScrollController _scrollController = ScrollController();
  final ImagePicker _picker = ImagePicker();
  
  List<Map<String, dynamic>> _messages = [];
  bool _loading = false;
  XFile? _selectedImage;
  XFile? _selectedVideo;
  VideoPlayerController? _videoController;

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
    _videoController?.dispose();
    super.dispose();
  }

  Future<void> _pickImage() async {
    try {
      final XFile? image = await _picker.pickImage(source: ImageSource.gallery);
      if (image != null && mounted) {
        setState(() {
          _selectedImage = image;
          _selectedVideo = null;
          _videoController?.dispose();
          _videoController = null;
        });
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("选择图片失败: $e")),
        );
      }
    }
  }

  Future<void> _pickVideo() async {
    try {
      final XFile? video = await _picker.pickVideo(source: ImageSource.gallery);
      if (video != null && mounted) {
        setState(() {
          _selectedVideo = video;
          _selectedImage = null;
          _videoController?.dispose();
          _videoController = VideoPlayerController.file(File(video.path))
            ..initialize().then((_) {
              if (mounted) {
                setState(() {});
                _videoController?.play();
              }
            });
        });
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("选择视频失败: $e")),
        );
      }
    }
  }

  void _clearAttachment() {
    setState(() {
      _selectedImage = null;
      _selectedVideo = null;
      _videoController?.dispose();
      _videoController = null;
    });
  }

  Future<void> _sendMessage() async {
    final text = _controller.text.trim();
    
    if (text.isEmpty && _selectedImage == null && _selectedVideo == null) {
      return;
    }

    setState(() => _loading = true);

    try {
      String? mediaUrl;
      String? mediaType;

      // 上传图片
      if (_selectedImage != null) {
        final bytes = await _selectedImage!.readAsBytes();
        final result = await widget.api.socialUploadMediaForm(
          sessionId: ApiConfig.effectiveActorId,
          fileBytes: bytes,
          fileName: _selectedImage!.name,
        );
        
        if (result["ok"] == true) {
          mediaUrl = result["mediaUrl"] as String?;
          mediaType = "image";
        }
      }

      // 上传视频
      if (_selectedVideo != null) {
        final bytes = await _selectedVideo!.readAsBytes();
        final result = await widget.api.socialUploadMediaForm(
          sessionId: ApiConfig.effectiveActorId,
          fileBytes: bytes,
          fileName: _selectedVideo!.name,
        );
        
        if (result["ok"] == true) {
          mediaUrl = result["mediaUrl"] as String?;
          mediaType = "video";
        }
      }

      // 发送消息到好友（使用Agent Relay）
      // TODO: 这里需要使用实际的消息发送API
      // 目前使用社交动态作为替代方案
      
      if (text.isNotEmpty || mediaUrl != null) {
        // 添加本地消息
        setState(() {
          _messages.add({
            "text": text,
            "mediaUrl": mediaUrl,
            "mediaType": mediaType,
            "isMe": true,
            "timestamp": DateTime.now().toIso8601String(),
          });
        });

        _controller.clear();
        _clearAttachment();

        // 滚动到底部
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
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("发送失败: $e")),
        );
      }
    } finally {
      if (mounted) {
        setState(() => _loading = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: Text(widget.friendName),
        actions: [
          IconButton(
            icon: const Icon(Icons.info_outline),
            onPressed: () {
              // 显示好友信息
            },
          ),
        ],
      ),
      body: Column(
        children: [
          // 消息列表
          Expanded(
            child: _messages.isEmpty
                ? Center(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(
                          Icons.chat_bubble_outline,
                          size: 64,
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                        const SizedBox(height: 16),
                        Text(
                          "开始聊天吧",
                          style: theme.textTheme.titleMedium?.copyWith(
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                  )
                : ListView.builder(
                    controller: _scrollController,
                    padding: const EdgeInsets.all(12),
                    itemCount: _messages.length,
                    itemBuilder: (context, index) {
                      final message = _messages[index];
                      final isMe = message["isMe"] as bool? ?? false;
                      
                      return _buildMessageBubble(message, isMe, theme);
                    },
                  ),
          ),
          
          // 附件预览
          if (_selectedImage != null || _selectedVideo != null)
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: theme.colorScheme.surfaceContainerHighest,
                border: Border(top: BorderSide(color: theme.colorScheme.outline)),
              ),
              child: Row(
                children: [
                  if (_selectedImage != null)
                    Stack(
                      children: [
                        ClipRRect(
                          borderRadius: BorderRadius.circular(8),
                          child: Image.file(
                            File(_selectedImage!.path),
                            height: 80,
                            width: 80,
                            fit: BoxFit.cover,
                          ),
                        ),
                        Positioned(
                          top: 4,
                          right: 4,
                          child: GestureDetector(
                            onTap: _clearAttachment,
                            child: Container(
                              padding: const EdgeInsets.all(2),
                              decoration: BoxDecoration(
                                color: Colors.black54,
                                shape: BoxShape.circle,
                              ),
                              child: const Icon(
                                Icons.close,
                                size: 16,
                                color: Colors.white,
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  if (_selectedVideo != null)
                    Stack(
                      children: [
                        ClipRRect(
                          borderRadius: BorderRadius.circular(8),
                          child: _videoController != null &&
                                  _videoController!.value.isInitialized
                              ? AspectRatio(
                                  aspectRatio: _videoController!.value.aspectRatio,
                                  child: VideoPlayer(_videoController!),
                                )
                              : Container(
                                  height: 80,
                                  width: 80,
                                  color: Colors.black,
                                  child: const Icon(
                                    Icons.videocam,
                                    color: Colors.white,
                                  ),
                                ),
                        ),
                        Positioned(
                          top: 4,
                          right: 4,
                          child: GestureDetector(
                            onTap: _clearAttachment,
                            child: Container(
                              padding: const EdgeInsets.all(2),
                              decoration: BoxDecoration(
                                color: Colors.black54,
                                shape: BoxShape.circle,
                              ),
                              child: const Icon(
                                Icons.close,
                                size: 16,
                                color: Colors.white,
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  const Spacer(),
                  TextButton(
                    onPressed: _clearAttachment,
                    child: const Text("清除"),
                  ),
                ],
              ),
            ),
          
          // 输入框
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: theme.colorScheme.surface,
              border: Border(top: BorderSide(color: theme.colorScheme.outline)),
            ),
            child: SafeArea(
              child: Row(
                children: [
                  // 图片按钮
                  IconButton(
                    icon: const Icon(Icons.photo),
                    onPressed: _pickImage,
                    tooltip: "发送图片",
                  ),
                  // 视频按钮
                  IconButton(
                    icon: const Icon(Icons.videocam),
                    onPressed: _pickVideo,
                    tooltip: "发送视频",
                  ),
                  // 输入框
                  Expanded(
                    child: TextField(
                      controller: _controller,
                      decoration: InputDecoration(
                        hintText: "输入消息...",
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(24),
                        ),
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 16,
                          vertical: 8,
                        ),
                      ),
                      maxLines: null,
                      textInputAction: TextInputAction.send,
                      onSubmitted: (_) => _sendMessage(),
                    ),
                  ),
                  const SizedBox(width: 8),
                  // 发送按钮
                  IconButton(
                    icon: _loading
                        ? const SizedBox(
                            width: 24,
                            height: 24,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.send),
                    onPressed: _loading ? null : _sendMessage,
                    color: theme.colorScheme.primary,
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildMessageBubble(
    Map<String, dynamic> message,
    bool isMe,
    ThemeData theme,
  ) {
    final text = message["text"] as String? ?? "";
    final mediaUrl = message["mediaUrl"] as String?;
    final mediaType = message["mediaType"] as String?;
    final timestamp = message["timestamp"] as String?;

    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        mainAxisAlignment:
            isMe ? MainAxisAlignment.end : MainAxisAlignment.start,
        children: [
          if (!isMe) ...[
            CircleAvatar(
              radius: 16,
              backgroundColor: theme.colorScheme.secondaryContainer,
              child: Text(
                widget.friendName.isNotEmpty
                    ? widget.friendName[0].toUpperCase()
                    : "?",
                style: TextStyle(
                  color: theme.colorScheme.onSecondaryContainer,
                  fontSize: 12,
                ),
              ),
            ),
            const SizedBox(width: 8),
          ],
          Flexible(
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: isMe
                    ? theme.colorScheme.primaryContainer
                    : theme.colorScheme.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // 图片/视频
                  if (mediaUrl != null) ...[
                    if (mediaType == "image")
                      ClipRRect(
                        borderRadius: BorderRadius.circular(8),
                        child: Image.network(
                          mediaUrl,
                          width: 200,
                          fit: BoxFit.cover,
                          errorBuilder: (_, __, ___) => Container(
                            width: 200,
                            height: 150,
                            color: theme.colorScheme.errorContainer,
                            child: const Icon(Icons.broken_image),
                          ),
                        ),
                      ),
                    if (mediaType == "video")
                      Container(
                        width: 200,
                        height: 150,
                        color: Colors.black,
                        child: const Center(
                          child: Icon(
                            Icons.play_circle_outline,
                            color: Colors.white,
                            size: 48,
                          ),
                        ),
                      ),
                    if (text.isNotEmpty) const SizedBox(height: 8),
                  ],
                  // 文本
                  if (text.isNotEmpty)
                    Text(
                      text,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: isMe
                            ? theme.colorScheme.onPrimaryContainer
                            : theme.colorScheme.onSurface,
                      ),
                    ),
                  // 时间
                  if (timestamp != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Text(
                        DateTime.parse(timestamp)
                            .toString()
                            .substring(11, 16),
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                          fontSize: 10,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
          if (isMe) const SizedBox(width: 8),
        ],
      ),
    );
  }
}
