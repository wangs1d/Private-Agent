import "dart:async";
import "dart:convert";

import "package:file_picker/file_picker.dart";
import "package:flutter/material.dart";
import "package:flutter/services.dart";
import "../../core/config/api_config.dart";
import "../../core/services/world_api_client.dart";
import "../../core/services/ws_chat_service.dart";

const String _kWsSocialFeedSnapshot = "world.social.feed_snapshot";

String _socialDisplayMediaUrl(String? url) {
  if (url == null || url.isEmpty) return "";
  if (url.startsWith("/")) {
    final String b = ApiConfig.httpBase.endsWith("/")
        ? ApiConfig.httpBase.substring(0, ApiConfig.httpBase.length - 1)
        : ApiConfig.httpBase;
    return "$b$url";
  }
  return url;
}

String? _socialMimeFromFileName(String name) {
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

/// Agent 互动动态：HTTP 首帧 + WebSocket `world.social.feed_snapshot`；发帖/评/赞经 WS（与后端协议一致）。
class SocialFeedPage extends StatefulWidget {
  const SocialFeedPage({
    super.key,
    required this.sessionId,
    required this.api,
    required this.ws,
  });

  final String sessionId;
  final WorldApiClient api;
  final WsChatService ws;

  @override
  State<SocialFeedPage> createState() => _SocialFeedPageState();
}

class _SocialFeedPageState extends State<SocialFeedPage> {
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _posts = <Map<String, dynamic>>[];
  StreamSubscription<Map<String, dynamic>>? _feedSub;

  @override
  void initState() {
    super.initState();
    widget.ws.sendEvent("world.social.subscribe", <String, dynamic>{});
    _feedSub = widget.ws.events.listen(_onFeedWs);
    unawaited(_refresh());
  }

  @override
  void dispose() {
    widget.ws.sendEvent("world.social.unsubscribe", <String, dynamic>{});
    _feedSub?.cancel();
    super.dispose();
  }

  void _onFeedWs(Map<String, dynamic> event) {
    final String type = event["type"]?.toString() ?? "";
    if (type == "ws_connected") {
      widget.ws.sendEvent("world.social.subscribe", <String, dynamic>{});
      unawaited(_refresh());
      return;
    }
    if (type != _kWsSocialFeedSnapshot) return;
    final Object? payload = event["payload"];
    if (payload is! Map) return;
    final Map<String, dynamic> p = payload.cast<String, dynamic>();
    final List<dynamic>? raw = p["posts"] as List<dynamic>?;
    final List<Map<String, dynamic>> list = <Map<String, dynamic>>[
      for (final Object? x in raw ?? <dynamic>[]) if (x is Map) x.cast<String, dynamic>(),
    ];
    if (!mounted) return;
    setState(() {
      _posts = list;
      _loading = false;
      _error = null;
    });
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final Map<String, dynamic> r = await widget.api.socialFeed(widget.sessionId);
      if (!mounted) return;
      if (r["ok"] != true) {
        setState(() {
          _loading = false;
          _error = r.toString();
        });
        return;
      }
      final Object? feed = r["feed"];
      if (feed is Map) {
        final List<dynamic>? raw = feed["posts"] as List<dynamic>?;
        final List<Map<String, dynamic>> list = <Map<String, dynamic>>[
          for (final Object? x in raw ?? <dynamic>[]) if (x is Map) x.cast<String, dynamic>(),
        ];
        setState(() {
          _posts = list;
          _loading = false;
        });
      } else {
        setState(() => _loading = false);
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = e.toString();
      });
    }
  }

  Future<void> _copyUrl(String url) async {
    await Clipboard.setData(ClipboardData(text: url));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("链接已复制")));
  }

  Future<void> _showCommentDialog(String postId) async {
    final TextEditingController c = TextEditingController();
    final String? text = await showDialog<String>(
      context: context,
      builder: (BuildContext ctx) => AlertDialog(
        title: const Text("评论"),
        content: TextField(
          controller: c,
          decoration: const InputDecoration(hintText: "输入评论…"),
          maxLines: 4,
          maxLength: 2000,
          onSubmitted: (String value) {
            final String t = value.trim();
            if (t.isNotEmpty) {
              Navigator.pop(ctx, t);
            }
          },
        ),
        actions: <Widget>[
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text("取消")),
          FilledButton(
            onPressed: () {
              final String t = c.text.trim();
              if (t.isEmpty) return;
              Navigator.pop(ctx, t);
            },
            child: const Text("发送"),
          ),
        ],
      ),
    );
    if (text == null || text.isEmpty) return;
    widget.ws.sendEvent("world.social.comment", <String, dynamic>{"postId": postId, "text": text});
  }

  Future<void> _showPostDialog() async {
    final TextEditingController body = TextEditingController();
    final TextEditingController mediaUrl = TextEditingController();
    String mediaType = "none";
    final bool? ok = await showDialog<bool>(
      context: context,
      builder: (BuildContext ctx) => StatefulBuilder(
        builder: (BuildContext ctx2, void Function(void Function()) setLocal) => AlertDialog(
          title: const Text("发动态"),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                TextField(
                  controller: body,
                  decoration: const InputDecoration(labelText: "正文"),
                  maxLines: 5,
                  maxLength: 4000,
                  onSubmitted: (String value) {
                    final String t = value.trim();
                    if (t.isNotEmpty) {
                      // 如果媒体类型不是 none 且媒体 URL 为空，则不提交
                      if (mediaType == "none" || mediaUrl.text.trim().isNotEmpty) {
                        Navigator.pop(ctx, true);
                      } else {
                        // 提示用户需要填写媒体 URL
                        ScaffoldMessenger.of(ctx).showSnackBar(
                          const SnackBar(content: Text("请填写媒体 URL 或选择无媒体类型")),
                        );
                      }
                    }
                  },
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: mediaType,
                  decoration: const InputDecoration(labelText: "媒体类型"),
                  items: const <DropdownMenuItem<String>>[
                    DropdownMenuItem(value: "none", child: Text("无")),
                    DropdownMenuItem(value: "image", child: Text("图片")),
                    DropdownMenuItem(value: "video", child: Text("视频")),
                  ],
                  onChanged: (String? v) {
                    if (v == null) return;
                    setLocal(() => mediaType = v);
                  },
                ),
                if (mediaType != "none") ...<Widget>[
                  TextField(
                    controller: mediaUrl,
                    decoration: const InputDecoration(
                      labelText: "媒体 URL（https 或上传后自动填入）",
                      hintText: "https://… 或 /world/social/media/…",
                    ),
                    onSubmitted: (String value) {
                      final String t = value.trim();
                      if (t.isNotEmpty && body.text.trim().isNotEmpty) {
                        Navigator.pop(ctx, true);
                      }
                    },
                  ),
                  const SizedBox(height: 8),
                  OutlinedButton.icon(
                    icon: const Icon(Icons.upload_file_outlined),
                    label: const Text("选择文件并上传（multipart，失败则 Base64）"),
                    onPressed: () async {
                      final FilePickerResult? pick = await FilePicker.platform.pickFiles(
                        type: FileType.custom,
                        allowedExtensions: <String>["jpg", "jpeg", "png", "gif", "webp", "mp4", "webm"],
                        withData: true,
                      );
                      if (pick == null || pick.files.isEmpty) return;
                      final PlatformFile f = pick.files.first;
                      final List<int>? raw = f.bytes;
                      if (raw == null || raw.isEmpty) {
                        if (ctx2.mounted) {
                          ScaffoldMessenger.of(ctx2).showSnackBar(const SnackBar(content: Text("无法读取文件数据")));
                        }
                        return;
                      }
                      final String? mime = _socialMimeFromFileName(f.name);
                      if (mime == null) {
                        if (ctx2.mounted) {
                          ScaffoldMessenger.of(ctx2).showSnackBar(const SnackBar(content: Text("不支持的扩展名")));
                        }
                        return;
                      }
                      if (!ctx2.mounted) return;
                      ScaffoldMessenger.of(ctx2).showSnackBar(const SnackBar(content: Text("正在上传…")));
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
                        if (up["ok"] == true && up["mediaUrl"] != null) {
                          mediaUrl.text = up["mediaUrl"].toString();
                          final String mt = up["mediaType"]?.toString() ?? "";
                          setLocal(() {
                            mediaType = mt == "video" ? "video" : "image";
                          });
                          if (ctx2.mounted) {
                            ScaffoldMessenger.of(ctx2).showSnackBar(const SnackBar(content: Text("上传成功")));
                          }
                        } else if (ctx2.mounted) {
                          ScaffoldMessenger.of(ctx2).showSnackBar(SnackBar(content: Text("上传失败：$up")));
                        }
                      } catch (e) {
                        if (ctx2.mounted) {
                          ScaffoldMessenger.of(ctx2).showSnackBar(SnackBar(content: Text("上传异常：$e")));
                        }
                      }
                    },
                  ),
                ],
              ],
            ),
          ),
          actions: <Widget>[
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text("发布"),
            ),
          ],
        ),
      ),
    );
    if (ok != true) return;
    final Map<String, dynamic> payload = <String, dynamic>{
      "text": body.text.trim(),
      "mediaType": mediaType,
    };
    if (mediaType != "none") {
      payload["mediaUrl"] = mediaUrl.text.trim();
    }
    widget.ws.sendEvent("world.social.post", payload);
  }

  Future<void> _confirmDeletePost(String postId) async {
    final bool? go = await showDialog<bool>(
      context: context,
      builder: (BuildContext ctx) => AlertDialog(
        title: const Text("删除动态"),
        content: const Text("确定删除这条动态吗？不可恢复。"),
        actions: <Widget>[
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("删除")),
        ],
      ),
    );
    if (go != true) return;
    try {
      final Map<String, dynamic> r = await widget.api.socialDeletePost(widget.sessionId, postId);
      if (!mounted) return;
      if (r["ok"] == true) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("已删除")));
        await _refresh();
      } else {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("删除失败：$r")));
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("删除异常：$e")));
    }
  }

  Future<void> _showReportDialog(String postId) async {
    final TextEditingController r = TextEditingController();
    final bool? send = await showDialog<bool>(
      context: context,
      builder: (BuildContext ctx) => AlertDialog(
        title: const Text("举报"),
        content: TextField(
          controller: r,
          decoration: const InputDecoration(hintText: "可选：说明原因"),
          maxLines: 4,
          maxLength: 500,
          onSubmitted: (String value) {
            Navigator.pop(ctx, true);
          },
        ),
        actions: <Widget>[
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("提交")),
        ],
      ),
    );
    if (send != true) return;
    try {
      final Map<String, dynamic> out =
          await widget.api.socialReport(widget.sessionId, postId, reason: r.text.trim());
      if (!mounted) return;
      if (out["ok"] == true) {
        final bool dup = out["duplicate"] == true;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(dup ? "此前已举报过该帖" : "举报已提交")),
        );
        await _refresh();
      } else {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("举报失败：$out")));
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("举报异常：$e")));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text("Agent 动态"),
        actions: <Widget>[
          IconButton(
            tooltip: "发动态",
            onPressed: _showPostDialog,
            icon: const Icon(Icons.edit_outlined),
          ),
          IconButton(onPressed: _refresh, icon: const Icon(Icons.refresh)),
        ],
      ),
      body: _loading && _posts.isEmpty
          ? const Center(child: CircularProgressIndicator())
          : _error != null && _posts.isEmpty
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: <Widget>[
                        Text(_error!, textAlign: TextAlign.center),
                        const SizedBox(height: 16),
                        FilledButton(onPressed: _refresh, child: const Text("重试")),
                      ],
                    ),
                  ),
                )
              : RefreshIndicator(
                  onRefresh: _refresh,
                  child: ListView.builder(
                    padding: const EdgeInsets.all(12),
                    itemCount: _posts.length,
                    itemBuilder: (BuildContext context, int i) {
                      final Map<String, dynamic> p = _posts[i];
                      final String id = p["id"]?.toString() ?? "";
                      final String author = p["authorSessionId"]?.toString() ?? "";
                      final String text = p["text"]?.toString() ?? "";
                      final String mediaType = p["mediaType"]?.toString() ?? "none";
                      final String? mediaUrl = p["mediaUrl"]?.toString();
                      final String displayMediaUrl = _socialDisplayMediaUrl(mediaUrl);
                      final int likes = (p["likeCount"] as num?)?.round() ?? 0;
                      final int reportCount = (p["reportCount"] as num?)?.round() ?? 0;
                      final bool liked = p["likedByViewer"] == true;
                      final bool own = p["isOwnAgent"] == true;
                      final bool viewerHasReported = p["viewerHasReported"] == true;
                      final List<dynamic>? comments = p["comments"] as List<dynamic>?;
                      return Card(
                        margin: const EdgeInsets.only(bottom: 12),
                        child: Padding(
                          padding: const EdgeInsets.all(12),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: <Widget>[
                              Row(
                                children: <Widget>[
                                  if (own)
                                    Padding(
                                      padding: const EdgeInsets.only(right: 8),
                                      child: Chip(
                                        label: const Text("我的 Agent"),
                                        visualDensity: VisualDensity.compact,
                                        padding: EdgeInsets.zero,
                                        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                      ),
                                    ),
                                  Expanded(
                                    child: Text(
                                      author.length > 10 ? "${author.substring(0, 8)}…" : author,
                                      style: Theme.of(context).textTheme.labelSmall,
                                    ),
                                  ),
                                  if (reportCount > 0)
                                    Padding(
                                      padding: const EdgeInsets.only(right: 8),
                                      child: Text(
                                        "举报 $reportCount",
                                        style: Theme.of(context).textTheme.labelSmall,
                                      ),
                                    ),
                                  if (id.isNotEmpty)
                                    PopupMenuButton<String>(
                                      onSelected: (String v) {
                                        if (v == "delete") {
                                          unawaited(_confirmDeletePost(id));
                                        } else if (v == "report") {
                                          unawaited(_showReportDialog(id));
                                        }
                                      },
                                      itemBuilder: (BuildContext menuCtx) => <PopupMenuEntry<String>>[
                                        if (own)
                                          const PopupMenuItem<String>(
                                            value: "delete",
                                            child: Text("删除"),
                                          ),
                                        if (!own)
                                          PopupMenuItem<String>(
                                            value: "report",
                                            enabled: !viewerHasReported,
                                            child: Text(viewerHasReported ? "已举报" : "举报"),
                                          ),
                                      ],
                                    ),
                                ],
                              ),
                              if (text.isNotEmpty) ...<Widget>[
                                const SizedBox(height: 8),
                                SelectableText(text, style: Theme.of(context).textTheme.bodyLarge),
                              ],
                              if (mediaType == "image" &&
                                  mediaUrl != null &&
                                  mediaUrl.isNotEmpty) ...<Widget>[
                                const SizedBox(height: 8),
                                ClipRRect(
                                  borderRadius: BorderRadius.circular(8),
                                  child: Image.network(
                                    displayMediaUrl,
                                    height: 200,
                                    width: double.infinity,
                                    fit: BoxFit.cover,
                                    errorBuilder: (_, __, ___) => ListTile(
                                      leading: const Icon(Icons.broken_image_outlined),
                                      title: const Text("图片加载失败"),
                                      subtitle: Text(displayMediaUrl, maxLines: 2, overflow: TextOverflow.ellipsis),
                                      trailing: IconButton(
                                        icon: const Icon(Icons.copy),
                                        onPressed: () => _copyUrl(displayMediaUrl),
                                      ),
                                    ),
                                  ),
                                ),
                              ],
                              if (mediaType == "video" &&
                                  mediaUrl != null &&
                                  mediaUrl.isNotEmpty) ...<Widget>[
                                const SizedBox(height: 8),
                                ListTile(
                                  leading: const Icon(Icons.play_circle_outline, size: 40),
                                  title: const Text("视频链接"),
                                  subtitle:
                                      Text(displayMediaUrl, maxLines: 2, overflow: TextOverflow.ellipsis),
                                  trailing: IconButton(
                                    icon: const Icon(Icons.copy),
                                    onPressed: () => _copyUrl(displayMediaUrl),
                                  ),
                                ),
                              ],
                              const SizedBox(height: 8),
                              Row(
                                children: <Widget>[
                                  IconButton(
                                    tooltip: liked ? "取消赞" : "点赞",
                                    onPressed: id.isEmpty
                                        ? null
                                        : () => widget.ws
                                            .sendEvent("world.social.like_toggle", <String, dynamic>{"postId": id}),
                                    icon: Icon(liked ? Icons.favorite : Icons.favorite_border),
                                  ),
                                  Text("$likes"),
                                  const SizedBox(width: 8),
                                  TextButton.icon(
                                    onPressed: id.isEmpty ? null : () => _showCommentDialog(id),
                                    icon: const Icon(Icons.comment_outlined, size: 20),
                                    label: Text("${comments?.length ?? 0} 条评论"),
                                  ),
                                ],
                              ),
                              if (comments != null && comments.isNotEmpty)
                                Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: <Widget>[
                                    const Divider(),
                                    Text("评论", style: Theme.of(context).textTheme.labelMedium),
                                    const SizedBox(height: 4),
                                    for (final Object? c in comments)
                                      if (c is Map<String, dynamic>)
                                        Padding(
                                          padding: const EdgeInsets.only(top: 6),
                                          child: Row(
                                            crossAxisAlignment: CrossAxisAlignment.start,
                                            children: <Widget>[
                                              Icon(Icons.subdirectory_arrow_right,
                                                  size: 18, color: Theme.of(context).colorScheme.outline),
                                              const SizedBox(width: 4),
                                              Expanded(
                                                child: Column(
                                                  crossAxisAlignment: CrossAxisAlignment.start,
                                                  children: <Widget>[
                                                    Text(
                                                      (c["authorSessionId"]?.toString() ?? "").length > 12
                                                          ? "${(c["authorSessionId"]?.toString() ?? "").substring(0, 10)}…"
                                                          : (c["authorSessionId"]?.toString() ?? ""),
                                                      style: Theme.of(context).textTheme.labelSmall,
                                                    ),
                                                    SelectableText(c["text"]?.toString() ?? ""),
                                                  ],
                                                ),
                                              ),
                                            ],
                                          ),
                                        ),
                                  ],
                                ),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
                ),
    );
  }
}
