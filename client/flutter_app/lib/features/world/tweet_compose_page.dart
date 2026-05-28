import "dart:convert";

import "package:file_picker/file_picker.dart";
import "package:flutter/material.dart";

import "../../core/config/api_config.dart";
import "../../core/services/world_api_client.dart";
import "../../core/services/ws_chat_service.dart";

class TweetComposePage extends StatefulWidget {
  const TweetComposePage({
    super.key,
    required this.sessionId,
    required this.api,
    required this.ws,
  });

  final String sessionId;
  final WorldApiClient api;
  final WsChatService ws;

  @override
  State<TweetComposePage> createState() => _TweetComposePageState();
}

class _TweetComposePageState extends State<TweetComposePage> {
  final TextEditingController _textController = TextEditingController();
  final FocusNode _focusNode = FocusNode();
  
  String? _mediaUrl;
  String _mediaType = "none";
  bool _isPosting = false;
  List<Map<String, dynamic>> _recentTweets = [];
  bool _isLoadingTweets = true;

  static const int _maxChars = 280;

  int get _currentCharCount => _textController.text.length;
  double get _charProgress => _currentCharCount / _maxChars;
  bool get _canPost => _textController.text.trim().isNotEmpty && !_isPosting;
  bool get _isOverLimit => _currentCharCount > _maxChars;

  Color _getCharCountColor() {
    if (_currentCharCount <= _maxChars * 0.8) {
      return Theme.of(context).colorScheme.onSurfaceVariant;
    } else if (_currentCharCount <= _maxChars) {
      return Colors.orange;
    }
    return Colors.red;
  }

  @override
  void initState() {
    super.initState();
    _loadRecentTweets();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _focusNode.requestFocus();
    });
  }

  @override
  void dispose() {
    _textController.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  Future<void> _loadRecentTweets() async {
    try {
      final Map<String, dynamic> r = await widget.api.socialFeed(widget.sessionId);
      if (!mounted) return;
      if (r["ok"] == true && r["feed"] is Map) {
        final List<dynamic>? raw = r["feed"]["posts"] as List<dynamic>?;
        if (raw != null) {
          setState(() {
            _recentTweets = raw
                .whereType<Map<String, dynamic>>()
                .take(10)
                .toList();
            _isLoadingTweets = false;
          });
        }
      } else {
        setState(() => _isLoadingTweets = false);
      }
    } catch (e) {
      if (mounted) setState(() => _isLoadingTweets = false);
    }
  }

  String? _mimeFromFileName(String name) {
    final int dot = name.lastIndexOf(".");
    if (dot < 0 || dot >= name.length - 1) return null;
    switch (name.substring(dot + 1).toLowerCase()) {
      case "jpg":
      case "jpeg":
        return "image/jpeg";
      case "png":
        return "image/png";
      case "gif":
        return "image/gif";
      case "webp":
        return "image/webp";
      case "mp4":
        return "video/mp4";
      case "webm":
        return "video/webm";
      default:
        return null;
    }
  }

  Future<void> _pickAndUploadMedia() async {
    final FilePickerResult? pick = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: const <String>["jpg", "jpeg", "png", "gif", "webp", "mp4", "webm"],
      withData: true,
    );
    
    if (pick == null || pick.files.isEmpty) return;
    
    final PlatformFile f = pick.files.first;
    final List<int>? raw = f.bytes;
    if (raw == null || raw.isEmpty) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text("无法读取文件数据")),
        );
      }
      return;
    }
    
    final String? mime = _mimeFromFileName(f.name);
    if (mime == null) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text("不支持的文件格式")),
        );
      }
      return;
    }
    
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text("正在上传...")),
    );
    
    try {
      Map<String, dynamic> up = await widget.api.socialUploadMediaForm(
        sessionId: widget.sessionId,
        fileBytes: raw,
        fileName: f.name,
      );
      
      if (up["ok"] != true) {
        up = await widget.api.socialUploadMedia(
          sessionId: widget.sessionId,
          mimeType: mime,
          dataBase64: base64Encode(raw),
        );
      }
      
      if (!mounted) return;
      
      if (up["ok"] == true && up["mediaUrl"] != null) {
        setState(() {
          _mediaUrl = up["mediaUrl"].toString();
          _mediaType = up["mediaType"]?.toString() ?? (mime.startsWith("video") ? "video" : "image");
        });
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text("✓ 媒体已添加")),
        );
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("上传失败：$up")),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("上传异常：$e")),
        );
      }
    }
  }

  void _removeMedia() {
    setState(() {
      _mediaUrl = null;
      _mediaType = "none";
    });
  }

  Future<void> _postTweet() async {
    if (!_canPost || _isOverLimit) return;
    
    setState(() => _isPosting = true);
    
    try {
      final Map<String, dynamic> payload = <String, dynamic>{
        "text": _textController.text.trim(),
        "mediaType": _mediaType,
      };
      
      if (_mediaType != "none" && _mediaUrl != null) {
        payload["mediaUrl"] = _mediaUrl!;
      }
      
      widget.ws.sendEvent("world.social.post", payload);
      
      if (!mounted) return;
      
      _textController.clear();
      _removeMedia();
      _focusNode.requestFocus();
      
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text("🎉 推文已发送！"),
          backgroundColor: Color(0xFF1D9BF0),
        ),
      );
      
      _loadRecentTweets();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("发送失败：$e")),
        );
      }
    } finally {
      if (mounted) {
        setState(() => _isPosting = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final bool isDark = cs.brightness == Brightness.dark;

    return Scaffold(
      backgroundColor: isDark ? const Color(0xFF000000) : Colors.white,
      body: Row(
        children: <Widget>[
          _buildSidebar(cs, isDark),
          const VerticalDivider(width: 1),
          Expanded(
            child: Column(
              children: <Widget>[
                _buildTopBar(cs, isDark),
                const Divider(height: 1),
                Expanded(
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Expanded(
                        flex: 2,
                        child: _buildComposeArea(cs, isDark),
                      ),
                      const VerticalDivider(width: 1),
                      Expanded(
                        child: _buildFeedPreview(cs, isDark),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildSidebar(ColorScheme cs, bool isDark) {
    return SizedBox(
      width: 275,
      child: Column(
        children: <Widget>[
          SizedBox(
            height: 56,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              child: SvgIcon.xLogo(size: 30, color: cs.onSurface),
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: _SidebarItem(
              icon: Icons.home_filled,
              label: "首页",
              isSelected: true,
              onTap: () {},
            ),
          ),
          _SidebarItem(
            icon: Icons.search_outlined,
            label: "探索",
            onTap: () {},
          ),
          _SidebarItem(
            icon: Icons.notifications_none_outlined,
            label: "通知",
            onTap: () {},
          ),
          _SidebarItem(
            icon: Icons.mail_outline_outlined,
            label: "私信",
            onTap: () {},
          ),
          _SidebarItem(
            icon: Icons.bookmark_border_outlined,
            label: "书签",
            onTap: () {},
          ),
          _SidebarItem(
            icon: Icons.person_outline_outlined,
            label: "个人资料",
            onTap: () {},
          ),
          _SidebarItem(
            icon: Icons.more_horiz_outlined,
            label: "更多",
            onTap: () {},
          ),
          const Spacer(),
          Padding(
            padding: const EdgeInsets.all(12),
            child: SizedBox(
              width: double.infinity,
              height: 52,
              child: FilledButton.icon(
                onPressed: _focusNode.requestFocus,
                icon: const Icon(Icons.edit, size: 20),
                label: const Text("发推文", style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
                style: FilledButton.styleFrom(
                  backgroundColor: const Color(0xFF1D9BF0),
                  foregroundColor: Colors.white,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(28)),
                ),
              ),
            ),
          ),
          const SizedBox(height: 12),
        ],
      ),
    );
  }

  Widget _buildTopBar(ColorScheme cs, bool isDark) {
    return SizedBox(
      height: 53,
      child: Stack(
        alignment: Alignment.centerLeft,
        children: <Widget>[
          Positioned(
            left: 16,
            child: IconButton(
              tooltip: "关闭",
              icon: Icon(Icons.close, size: 24, color: cs.onSurface),
              onPressed: () {
                _textController.clear();
                _removeMedia();
              },
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(minWidth: 36, minHeight: 36),
            ),
          ),
          Center(
            child: Text(
              "发推文",
              style: TextStyle(
                fontSize: 17,
                fontWeight: FontWeight.w700,
                color: cs.onSurface,
              ),
            ),
          ),
          Positioned(
            right: 16,
            child: AnimatedOpacity(
              opacity: _canPost && !_isOverLimit ? 1.0 : 0.5,
              duration: const Duration(milliseconds: 200),
              child: SizedBox(
                height: 36,
                child: FilledButton(
                  onPressed: _canPost && !_isOverLimit ? _postTweet : null,
                  style: FilledButton.styleFrom(
                    backgroundColor: const Color(0xFF1D9BF0),
                    disabledBackgroundColor: const Color(0xFF2F3336),
                    foregroundColor: Colors.white,
                    disabledForegroundColor: Colors.white.withOpacity(0.5),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
                    padding: const EdgeInsets.symmetric(horizontal: 20),
                  ),
                  child: _isPosting
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                        )
                      : const Text("发布", style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700)),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildComposeArea(ColorScheme cs, bool isDark) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              CircleAvatar(
                radius: 24,
                backgroundColor: const Color(0xFF1D9BF0),
                child: Text(
                  widget.sessionId.isNotEmpty ? widget.sessionId[0].toUpperCase() : "U",
                  style: const TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.w700),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    TextField(
                      controller: _textController,
                      focusNode: _focusNode,
                      maxLines: 8,
                      minLines: 3,
                      maxLength: _maxChars,
                      onChanged: (_) => setState(() {}),
                      style: TextStyle(
                        fontSize: 18,
                        color: cs.onSurface,
                        height: 1.4,
                      ),
                      decoration: InputDecoration(
                        hintText: "有什么新鲜事？！",
                        hintStyle: TextStyle(
                          fontSize: 18,
                          color: cs.onSurfaceVariant.withOpacity(0.6),
                        ),
                        border: InputBorder.none,
                        contentPadding: EdgeInsets.zero,
                        counterText: "",
                      ),
                    ),
                    if (_mediaUrl != null && _mediaType != "none") ...<Widget>[
                      const SizedBox(height: 12),
                      Stack(
                        children: <Widget>[
                          ClipRRect(
                            borderRadius: BorderRadius.circular(16),
                            child: _mediaType == "image"
                                ? Image.network(
                                    _mediaUrl!,
                                    height: 200,
                                    width: double.infinity,
                                    fit: BoxFit.cover,
                                    errorBuilder: (_, __, ___) => Container(
                                      height: 200,
                                      color: cs.surfaceContainerHighest,
                                      child: Center(child: Icon(Icons.broken_image, size: 48, color: cs.outline)),
                                    ),
                                  )
                                : Container(
                                    height: 200,
                                    color: cs.surfaceContainerHighest,
                                    child: Center(
                                      child: Column(
                                        mainAxisAlignment: MainAxisAlignment.center,
                                        children: <Widget>[
                                          Icon(Icons.play_circle_outline, size: 64, color: cs.primary),
                                          const SizedBox(height: 8),
                                          Text("视频附件", style: TextStyle(color: cs.onSurfaceVariant)),
                                        ],
                                      ),
                                    ),
                                  ),
                          ),
                          Positioned(
                            top: 8,
                            right: 8,
                            child: GestureDetector(
                              onTap: _removeMedia,
                              child: Container(
                                padding: const EdgeInsets.all(4),
                                decoration: BoxDecoration(
                                  color: Colors.black.withOpacity(0.7),
                                  shape: BoxShape.circle,
                                ),
                                child: const Icon(Icons.close, size: 16, color: Colors.white),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
          const Divider(height: 32),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: <Widget>[
              Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  _ActionButton(
                    icon: Icons.image_outlined,
                    color: const Color(0xFF1D9BF0),
                    tooltip: "添加图片/视频",
                    onTap: _pickAndUploadMedia,
                  ),
                  const SizedBox(width: 12),
                  _ActionButton(
                    icon: Icons.gif_box_outlined,
                    color: const Color(0xFF1D9BF0),
                    tooltip: "GIF",
                    onTap: () {},
                  ),
                  const SizedBox(width: 12),
                  _ActionButton(
                    icon: Icons.list_alt_outlined,
                    color: const Color(0xFF1D9BF0),
                    tooltip: "投票",
                    onTap: () {},
                  ),
                  const SizedBox(width: 12),
                  _ActionButton(
                    icon: Icons.sentiment_satisfied_alt_outlined,
                    color: const Color(0xFF1D9BF0),
                    tooltip: "表情符号",
                    onTap: () {},
                  ),
                  const SizedBox(width: 12),
                  _ActionButton(
                    icon: Icons.calendar_today_outlined,
                    color: const Color(0xFF1D9BF0),
                    tooltip: "安排",
                    onTap: () {},
                  ),
                  const SizedBox(width: 12),
                  _ActionButton(
                    icon: Icons.location_on_outlined,
                    color: const Color(0xFF1D9BF0),
                    tooltip: "位置",
                    onTap: () {},
                  ),
                ],
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(4),
                  color: _isOverLimit ? Colors.red.withOpacity(0.1) : Colors.transparent,
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    CircularProgressBar(
                      progress: _charProgress.clamp(0.0, 1.0),
                      color: _getCharCountColor(),
                      size: 18,
                    ),
                    const SizedBox(width: 4),
                    Text(
                      "${_maxChars - _currentCharCount}",
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: _isOverLimit ? FontWeight.w700 : FontWeight.w500,
                        color: _getCharCountColor(),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildFeedPreview(ColorScheme cs, bool isDark) {
    return Container(
      color: isDark ? const Color(0xFF16181C) : const Color(0xFFF7F9FA),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
            child: Text(
              "最近动态",
              style: TextStyle(
                fontSize: 17,
                fontWeight: FontWeight.w700,
                color: cs.onSurface,
              ),
            ),
          ),
          const Divider(height: 1),
          Expanded(
            child: _isLoadingTweets
                ? const Center(child: CircularProgressIndicator())
                : _recentTweets.isEmpty
                    ? Center(
                        child: Padding(
                          padding: const EdgeInsets.all(24),
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: <Widget>[
                              Icon(Icons.feed_outlined, size: 48, color: cs.onSurfaceVariant.withOpacity(0.4)),
                              const SizedBox(height: 12),
                              Text(
                                "暂无动态",
                                style: TextStyle(color: cs.onSurfaceVariant.withOpacity(0.6), fontSize: 14),
                              ),
                              const SizedBox(height: 4),
                              Text(
                                "成为第一个发帖的人！",
                                style: TextStyle(color: cs.onSurfaceVariant.withOpacity(0.4), fontSize: 13),
                              ),
                            ],
                          ),
                        ),
                      )
                    : RefreshIndicator(
                        onRefresh: _loadRecentTweets,
                        child: ListView.builder(
                          itemCount: _recentTweets.length,
                          itemBuilder: (BuildContext context, int i) {
                            final Map<String, dynamic> tweet = _recentTweets[i];
                            return _TweetCard(tweet: tweet, cs: cs);
                          },
                        ),
                      ),
          ),
        ],
      ),
    );
  }
}

class _SidebarItem extends StatelessWidget {
  const _SidebarItem({
    required this.icon,
    required this.label,
    this.isSelected = false,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final bool isSelected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(24),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Icon(
                  icon,
                  size: 24,
                  color: isSelected ? const Color(0xFFFFFFFF) : const Color(0xFFE7E9EA),
                  weight: isSelected ? 700 : 400,
                ),
                const SizedBox(width: 16),
                Text(
                  label,
                  style: TextStyle(
                    fontSize: 17,
                    fontWeight: isSelected ? FontWeight.w700 : FontWeight.w400,
                    color: isSelected ? const Color(0xFFFFFFFF) : const Color(0xFFE7E9EA),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ActionButton extends StatelessWidget {
  const _ActionButton({
    required this.icon,
    required this.color,
    required this.tooltip,
    required this.onTap,
  });

  final IconData icon;
  final Color color;
  final String tooltip;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      child: IconButton(
        onPressed: onTap,
        icon: Icon(icon, size: 20, color: color),
        padding: const EdgeInsets.all(8),
        constraints: const BoxConstraints(minWidth: 34, minHeight: 34),
        splashRadius: 18,
      ),
    );
  }
}

class _TweetCard extends StatelessWidget {
  const _TweetCard({required this.tweet, required this.cs});

  final Map<String, dynamic> tweet;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    final String author = tweet["authorSessionId"]?.toString() ?? "";
    final String text = tweet["text"]?.toString() ?? "";
    final String mediaType = tweet["mediaType"]?.toString() ?? "none";
    final String? mediaUrl = tweet["mediaUrl"]?.toString();
    final int likes = (tweet["likeCount"] as num?)?.round() ?? 0;
    final DateTime createdAt = DateTime.tryParse(tweet["createdAt"]?.toString() ?? "") ?? DateTime.now();

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          CircleAvatar(
            radius: 20,
            backgroundColor: const Color(0xFF7856FF),
            child: Text(
              author.isNotEmpty ? author[0].toUpperCase() : "?",
              style: const TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w700),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Text(
                      author.length > 12 ? "${author.substring(0, 10)}..." : author,
                      style: TextStyle(fontWeight: FontWeight.w700, fontSize: 14, color: cs.onSurface),
                    ),
                    const SizedBox(width: 4),
                    Text(
                      "@${author.substring(0, 8)}",
                      style: TextStyle(color: cs.onSurfaceVariant, fontSize: 14),
                    ),
                    const SizedBox(width: 4),
                    Text(
                      "· ${_formatTimeAgo(createdAt)}",
                      style: TextStyle(color: cs.onSurfaceVariant, fontSize: 14),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                SelectableText(
                  text,
                  style: TextStyle(fontSize: 14, height: 1.4, color: cs.onSurface),
                ),
                if (mediaType == "image" && mediaUrl != null && mediaUrl.isNotEmpty) ...<Widget>[
                  const SizedBox(height: 8),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(12),
                    child: Image.network(
                      mediaUrl,
                      height: 150,
                      width: double.infinity,
                      fit: BoxFit.cover,
                      errorBuilder: (_, __, ___) => Container(
                        height: 150,
                        color: cs.surfaceContainerHighest,
                        child: Center(child: Icon(Icons.broken_image, size: 32, color: cs.outline)),
                      ),
                    ),
                  ),
                ],
                const SizedBox(height: 8),
                Row(
                  children: <Widget>[
                    _TweetAction(icon: Icons.chat_bubble_outline, count: 0, color: cs.onSurfaceVariant),
                    const SizedBox(width: 40),
                    _TweetAction(icon: Icons.repeat_outlined, count: 0, color: cs.onSurfaceVariant),
                    const SizedBox(width: 40),
                    _TweetAction(icon: Icons.favorite_border, count: likes, color: cs.onSurfaceVariant),
                    const SizedBox(width: 40),
                    _TweetAction(icon: Icons.bar_chart_outlined, count: 0, color: cs.onSurfaceVariant),
                    const Spacer(),
                    Icon(Icons.share_outlined, size: 18, color: cs.onSurfaceVariant),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  String _formatTimeAgo(DateTime dateTime) {
    final Duration diff = DateTime.now().difference(dateTime);
    if (diff.inMinutes < 1) return "刚刚";
    if (diff.inMinutes < 60) return "${diff.inMinutes}分钟前";
    if (diff.inHours < 24) return "${diff.inHours}小时前";
    if (diff.inDays < 7) return "${diff.inDays}天前";
    return "${dateTime.month}/${dateTime.day}";
  }
}

class _TweetAction extends StatelessWidget {
  const _TweetAction({
    required this.icon,
    required this.count,
    required this.color,
  });

  final IconData icon;
  final int count;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Icon(icon, size: 18, color: color),
        if (count > 0) ...<Widget>[
          const SizedBox(width: 4),
          Text("$count", style: TextStyle(fontSize: 13, color: color)),
        ],
      ],
    );
  }
}

class CircularProgressBar extends StatelessWidget {
  const CircularProgressBar({
    required this.progress,
    required this.color,
    required this.size,
  });

  final double progress;
  final Color color;
  final double size;

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      size: Size(size, size),
      painter: _CircularProgressPainter(progress: progress, color: color),
    );
  }
}

class _CircularProgressPainter extends CustomPainter {
  _CircularProgressPainter({required this.progress, required this.color});

  final double progress;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final Paint backgroundPaint = Paint()
      ..color = color.withOpacity(0.2)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2;

    final Paint foregroundPaint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2
      ..strokeCap = StrokeCap.round;

    final center = Offset(size.width / 2, size.height / 2);
    final radius = (size.width - 4) / 2;

    canvas.drawCircle(center, radius, backgroundPaint);

    final sweepAngle = 2 * 3.141592653589793 * progress;
    canvas.drawArc(
      Rect.fromCircle(center: center, radius: radius),
      -3.141592653589793 / 2,
      sweepAngle,
      false,
      foregroundPaint,
    );
  }

  @override
  bool shouldRepaint(covariant _CircularProgressPainter oldDelegate) {
    return oldDelegate.progress != progress || oldDelegate.color != color;
  }
}

class SvgIcon extends StatelessWidget {
  const SvgIcon.xLogo({super.key, required this.size, required this.color});

  final double size;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      size: Size(size, size),
      painter: _XLogoPainter(color: color),
    );
  }
}

class _XLogoPainter extends CustomPainter {
  _XLogoPainter({required this.color});

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final Paint paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2.5
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;

    final path = Path()
      ..moveTo(size.width * 0.15, size.height * 0.15)
      ..lineTo(size.width * 0.85, size.height * 0.85)
      ..moveTo(size.width * 0.85, size.height * 0.15)
      ..lineTo(size.width * 0.15, size.height * 0.85);

    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(covariant _XLogoPainter oldDelegate) => oldDelegate.color != color;
}
