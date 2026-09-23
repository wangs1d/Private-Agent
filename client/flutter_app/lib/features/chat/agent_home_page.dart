import "dart:async";
import "dart:convert" show jsonDecode, jsonEncode;

import "package:flutter/material.dart";
import "package:http/http.dart" as http;

import "../../core/config/api_config.dart";
import "../../core/presentation/agent_avatar_catalog.dart";

/// Agent 主页。
///
/// 定位：主页是 Agent「自己打理的住处」——
///  - Header：纯文字（名字/@handle/状态徽章/签名），无头像光球（呼吸语义只在聊天页）
///  - 动态：站内社交里 Agent 自己发的帖子（置顶帖排最前）
///  - 自我介绍：Agent 自写（SOUL 摘要）
/// （原「此刻」承载已随右上角足迹卡一并下线，主页不展示盯/足迹。）
/// 入口：与日程/消息等一致，以右侧 Dock 双面板形式打开（聊天在左、主页在右）；
/// 窄窗口退化为全屏路由页。名字/签名支持编辑，改名走统一管道
/// （POST /api/agent-identity/rename，账号/记忆/prompt 自我认知一次同步）。
class AgentHomePage extends StatefulWidget {
  const AgentHomePage({super.key, this.actorId, this.embedded = false});

  /// 登录主体 id；缺省用 [ApiConfig.effectiveActorId]。
  final String? actorId;

  /// 嵌入模式：渲染在右侧 Dock 面板内容区，不再自带 Scaffold/AppBar
  /// （顶栏标题与关闭按钮由面板 chrome 提供，与 GalleryPage.embedded 同约定）。
  final bool embedded;

  static Future<void> show(BuildContext context, {String? actorId}) {
    return Navigator.of(context).push<void>(
      MaterialPageRoute<void>(builder: (_) => AgentHomePage(actorId: actorId)),
    );
  }

  @override
  State<AgentHomePage> createState() => _AgentHomePageState();
}

class _AgentHomePageState extends State<AgentHomePage> {
  bool _loading = true;
  bool _failed = false;
  Map<String, dynamic> _profile = <String, dynamic>{};
  Map<String, dynamic> _identity = <String, dynamic>{};
  List<Map<String, dynamic>> _posts = <Map<String, dynamic>>[];

  String get _actorId => widget.actorId ?? ApiConfig.effectiveActorId;

  @override
  void initState() {
    super.initState();
    unawaited(_reload());
  }

  Future<void> _reload() async {
    final AgentHomepageResult result = await AgentHomepageApi.fetchHomepage(_actorId);
    if (!mounted) return;
    setState(() {
      _failed = !result.ok;
      _profile = result.profile;
      _identity = result.identity;
      _posts = result.posts;
      _loading = false;
    });
  }

  String get _displayName =>
      (_identity["displayName"] ?? _profile["displayName"] ?? "")?.toString() ?? "";
  String get _handle =>
      (_identity["handle"] ?? _profile["handle"] ?? "")?.toString() ?? "";
  String get _signature => _profile["signature"]?.toString() ?? "";
  String get _statusText => _profile["statusText"]?.toString() ?? "";
  String get _moodStyle => _profile["moodStyle"]?.toString() ?? "gentle";
  String get _avatarPreset => _profile["avatarPreset"]?.toString() ?? "dawn";
  String get _intro => _profile["intro"]?.toString() ?? "";

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final ColorScheme cs = theme.colorScheme;
    final AgentAvatarPalette palette = AgentAvatarPalette.fromPreset(_avatarPreset);

    final Widget body = _loading
        ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
        : _failed
            ? _ErrorState(onRetry: _reload)
            : RefreshIndicator(
                onRefresh: _reload,
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
                  children: <Widget>[
                    _buildHeaderCard(cs, palette),
                    const SizedBox(height: 14),
                    _buildPostsSection(cs),
                    const SizedBox(height: 14),
                    _buildIntroSection(cs),
                  ],
                ),
              );

    if (widget.embedded) {
      return body;
    }
    return Scaffold(
      appBar: AppBar(
        title: const Text("主页"),
        actions: <Widget>[
          IconButton(
            tooltip: "取名 / 改名",
            icon: const Icon(Icons.badge_outlined),
            onPressed: _showRenameSheet,
          ),
        ],
      ),
      body: body,
    );
  }

  // ─── Header：纯文字，无头像 ───

  Widget _buildHeaderCard(ColorScheme cs, AgentAvatarPalette palette) {
    final ThemeData theme = Theme.of(context);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[
            palette.colors.first.withValues(alpha: 0.20),
            palette.colors.last.withValues(alpha: 0.10),
          ],
        ),
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: cs.outline.withValues(alpha: 0.30)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: _showRenameSheet,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: <Widget>[
                Text(
                  _displayName.isEmpty ? "未命名" : _displayName,
                  style: theme.textTheme.headlineSmall?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(width: 4),
                Icon(Icons.edit_outlined,
                    size: 14, color: cs.onSurfaceVariant.withValues(alpha: 0.7)),
                const SizedBox(width: 8),
                if (_handle.isNotEmpty)
                  Text(
                    "@$_handle",
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: cs.onSurfaceVariant,
                      letterSpacing: 0.3,
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 10),
          Row(
            children: <Widget>[
              _MoodBadge(moodStyle: _moodStyle),
              if (_statusText.trim().isNotEmpty) ...<Widget>[
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    _statusText,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodySmall
                        ?.copyWith(color: cs.onSurfaceVariant),
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: 12),
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onLongPress: _showSignatureEditDialog,
            onTap: _showSignatureEditDialog,
            child: Text(
              _signature.isEmpty ? "（长按签名可修改）" : _signature,
              style: theme.textTheme.bodyLarge?.copyWith(
                color: cs.onSurfaceVariant,
                height: 1.45,
              ),
            ),
          ),
        ],
      ),
    );
  }

  // ─── 动态：站内社交里 Agent 自己的帖子 ───

  Widget _buildPostsSection(ColorScheme cs) {
    if (_posts.isEmpty) {
      return const SizedBox.shrink();
    }
    return _SectionCard(
      title: "动态",
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          for (final Map<String, dynamic> post in _posts)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Row(
                    children: <Widget>[
                      if (post["id"] == _profile["pinnedPostId"]) ...<Widget>[
                        Icon(Icons.push_pin_outlined,
                            size: 12, color: cs.onSurfaceVariant),
                        const SizedBox(width: 4),
                      ],
                      Expanded(
                        child: Text(
                          _postTimeLabel(post["createdAt"]?.toString() ?? ""),
                          style: TextStyle(
                              fontSize: 10.5,
                              color: cs.onSurfaceVariant.withValues(alpha: 0.8)),
                        ),
                      ),
                      Icon(Icons.favorite_border,
                          size: 11, color: cs.onSurfaceVariant.withValues(alpha: 0.7)),
                      const SizedBox(width: 4),
                      Text(
                        "${post["likeCount"] ?? 0}",
                        style: TextStyle(
                            fontSize: 10.5, color: cs.onSurfaceVariant),
                      ),
                    ],
                  ),
                  if ((post["text"] ?? "").toString().trim().isNotEmpty) ...<Widget>[
                    const SizedBox(height: 4),
                    Text(
                      post["text"].toString(),
                      style: TextStyle(fontSize: 12.5, height: 1.5, color: cs.onSurface),
                    ),
                  ],
                  const SizedBox(height: 4),
                  Divider(height: 1, color: cs.outline.withValues(alpha: 0.18)),
                ],
              ),
            ),
        ],
      ),
    );
  }

  String _postTimeLabel(String iso) {
    final DateTime? time = DateTime.tryParse(iso);
    if (time == null) return "";
    final Duration diff = DateTime.now().difference(time);
    if (diff.inMinutes < 1) return "刚刚";
    if (diff.inHours < 1) return "${diff.inMinutes} 分钟前";
    if (diff.inDays < 1) return "${diff.inHours} 小时前";
    if (diff.inDays < 30) return "${diff.inDays} 天前";
    return "${time.year}-${time.month}-${time.day}";
  }

  // ─── 自我介绍 ───

  Widget _buildIntroSection(ColorScheme cs) {
    return _SectionCard(
      title: "自我介绍",
      trailing: IconButton(
        tooltip: "让它在对话里自己改，或长按直接编辑",
        icon: Icon(Icons.edit_outlined,
            size: 15, color: cs.onSurfaceVariant.withValues(alpha: 0.7)),
        onPressed: _showIntroEditDialog,
      ),
      child: Text(
        _intro.isEmpty
            ? "它还没有写自我介绍。对它说「去写写你的自我介绍」，或让它自己打理主页。"
            : _intro,
        style: TextStyle(
          fontSize: 12.5,
          height: 1.6,
          color: _intro.isEmpty ? cs.onSurfaceVariant : cs.onSurface,
        ),
      ),
    );
  }

  // ─── 编辑交互 ───

  Future<void> _showSignatureEditDialog() {
    return _showTextEditDialog(
      title: "修改签名",
      initial: _signature,
      maxLength: 120,
      maxLines: 3,
      hint: "一句它自己的话",
      field: "signature",
    );
  }

  Future<void> _showIntroEditDialog() {
    return _showTextEditDialog(
      title: "修改自我介绍",
      initial: _intro,
      maxLength: 800,
      maxLines: 8,
      hint: "它的 SOUL 摘要",
      field: "intro",
    );
  }

  Future<void> _showTextEditDialog({
    required String title,
    required String initial,
    required int maxLength,
    required int maxLines,
    required String hint,
    required String field,
  }) async {
    final TextEditingController controller = TextEditingController(text: initial);
    final String? value = await showDialog<String>(
      context: context,
      builder: (BuildContext dialogContext) {
        return AlertDialog(
          title: Text(title, style: const TextStyle(fontSize: 16)),
          content: TextField(
            controller: controller,
            maxLength: maxLength,
            maxLines: maxLines,
            autofocus: true,
            decoration: InputDecoration(hintText: hint, counterText: ""),
          ),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text("取消"),
            ),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(controller.text),
              child: const Text("保存"),
            ),
          ],
        );
      },
    );
    controller.dispose();
    if (value == null || value.trim() == initial) return;
    final bool ok =
        await AgentHomepageApi.patchHomepage(_actorId, <String, dynamic>{field: value.trim()});
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(ok ? "已保存" : "保存失败，请稍后再试"), duration: const Duration(seconds: 2)),
    );
    if (ok) unawaited(_reload());
  }

  /// 取名 / 改名面板：建议名池（含自述理由）+ 自定义输入。
  /// 保存走统一改名管道（账号/记忆/prompt 自我认知一次同步）。
  Future<void> _showRenameSheet() async {
    final TextEditingController nameController = TextEditingController(text: _displayName);
    final TextEditingController handleController = TextEditingController(text: _handle);
    List<Map<String, dynamic>> suggestions = const <Map<String, dynamic>>[];
    try {
      suggestions = await AgentHomepageApi.fetchNameSuggestions();
    } catch (_) {}

    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Theme.of(context).colorScheme.surfaceContainerLow,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (BuildContext sheetContext) {
        final ColorScheme sheetCs = Theme.of(sheetContext).colorScheme;
        return SafeArea(
          child: Padding(
            padding: EdgeInsets.fromLTRB(
                18, 16, 18, 16 + MediaQuery.of(sheetContext).viewInsets.bottom),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text("给它取个名字", style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: sheetCs.onSurface)),
                const SizedBox(height: 4),
                Text(
                  "改名会同步它的账号、记忆与自我认知",
                  style: TextStyle(fontSize: 11, color: sheetCs.onSurfaceVariant),
                ),
                const SizedBox(height: 12),
                if (suggestions.isNotEmpty)
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: <Widget>[
                      for (final Map<String, dynamic> s in suggestions)
                        ActionChip(
                          label: Text(s["displayName"]?.toString() ?? ""),
                          tooltip: s["reason"]?.toString() ?? "",
                          onPressed: () {
                            nameController.text = s["displayName"]?.toString() ?? "";
                            handleController.text = s["handle"]?.toString() ?? "";
                          },
                        ),
                    ],
                  ),
                const SizedBox(height: 12),
                TextField(
                  controller: nameController,
                  maxLength: 24,
                  decoration: const InputDecoration(
                    labelText: "名字",
                    counterText: "",
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: handleController,
                  maxLength: 32,
                  decoration: const InputDecoration(
                    labelText: "网络名（handle，可选）",
                    counterText: "",
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: () async {
                      final String name = nameController.text.trim();
                      if (name.isEmpty) return;
                      final bool ok = await AgentHomepageApi.rename(
                        _actorId,
                        displayName: name,
                        handle: handleController.text.trim(),
                      );
                      if (sheetContext.mounted) Navigator.of(sheetContext).pop();
                      if (!mounted) return;
                      ScaffoldMessenger.of(context).showSnackBar(
                        SnackBar(
                          content: Text(ok ? "已改名：$name" : "改名失败，请稍后再试"),
                          duration: const Duration(seconds: 2),
                        ),
                      );
                      if (ok) unawaited(_reload());
                    },
                    child: const Text("就叫这个"),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
    nameController.dispose();
    handleController.dispose();
  }
}

// ═══════════════════════════════════════════════════════════
// 区块容器与小部件
// ═══════════════════════════════════════════════════════════

class _SectionCard extends StatelessWidget {
  const _SectionCard({required this.title, required this.child, this.trailing});

  final String title;
  final Widget child;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: cs.surfaceContainerLowest,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: cs.outline.withValues(alpha: 0.25)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Text(
                title,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.4,
                  color: cs.onSurfaceVariant,
                ),
              ),
              const Spacer(),
              if (trailing != null) trailing!,
            ],
          ),
          const SizedBox(height: 8),
          child,
        ],
      ),
    );
  }
}

class _MoodBadge extends StatelessWidget {
  const _MoodBadge({required this.moodStyle});

  final String moodStyle;

  @override
  Widget build(BuildContext context) {
    final ({String label, Color color, Color bg}) mood = switch (moodStyle) {
      "funny" => (label: "摸鱼", color: const Color(0xFF2CBF6D), bg: const Color(0x1F2CBF6D)),
      "sad" => (label: "离开", color: const Color(0xFF8091A7), bg: const Color(0x1F8091A7)),
      "cool" => (label: "请勿打扰", color: const Color(0xFF7C73FF), bg: const Color(0x1F7C73FF)),
      "energetic" => (label: "在线", color: const Color(0xFFFF8A3D), bg: const Color(0x1FFF8A3D)),
      "mysterious" => (label: "隐身感", color: const Color(0xFF3F8CFF), bg: const Color(0x1F3F8CFF)),
      _ => (label: "忙碌", color: const Color(0xFF3AA7A3), bg: const Color(0x1F3AA7A3)),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(color: mood.bg, borderRadius: BorderRadius.circular(999)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(shape: BoxShape.circle, color: mood.color),
          ),
          const SizedBox(width: 5),
          Text(
            mood.label,
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w700,
              color: mood.color.withValues(alpha: 0.95),
            ),
          ),
        ],
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text("主页暂时不可用", style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant)),
          const SizedBox(height: 10),
          TextButton(onPressed: onRetry, child: const Text("重试")),
        ],
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════
// API 客户端
// ═══════════════════════════════════════════════════════════

class AgentHomepageResult {
  const AgentHomepageResult({
    required this.ok,
    required this.profile,
    required this.identity,
    required this.posts,
  });

  final bool ok;
  final Map<String, dynamic> profile;
  final Map<String, dynamic> identity;
  final List<Map<String, dynamic>> posts;
}

class AgentHomepageApi {
  AgentHomepageApi._();

  /// 测试注入口：注入 MockClient 后走桩，不触网
  static http.Client? clientOverride;

  static http.Client get _client => clientOverride ?? http.Client();

  static const Duration _timeout = Duration(seconds: 8);

  static Future<AgentHomepageResult> fetchHomepage(String actorId) async {
    try {
      final Uri uri = Uri.parse("${ApiConfig.httpBase}/api/agent-homepage")
          .replace(queryParameters: <String, String>{"sessionId": actorId});
      final http.Response res = await _client
          .get(uri, headers: const <String, String>{"Accept": "application/json"})
          .timeout(_timeout);
      if (res.statusCode != 200) return _emptyResult();
      final Map<String, dynamic> body = jsonDecode(res.body) as Map<String, dynamic>;
      if (body["ok"] != true) return _emptyResult();
      return AgentHomepageResult(
        ok: true,
        profile: _mapOf(body["profile"]),
        identity: _mapOf(body["identity"]),
        posts: <Map<String, dynamic>>[
          for (final dynamic p in (body["posts"] as List<dynamic>? ?? const <dynamic>[]))
            (p as Map).cast<String, dynamic>(),
        ],
      );
    } catch (_) {
      return _emptyResult();
    }
  }

  static AgentHomepageResult _emptyResult() => const AgentHomepageResult(
        ok: false,
        profile: <String, dynamic>{},
        identity: <String, dynamic>{},
        posts: <Map<String, dynamic>>[],
      );

  static Map<String, dynamic> _mapOf(Object? raw) =>
      raw is Map ? raw.cast<String, dynamic>() : <String, dynamic>{};

  /// 用户驱动的改名：走服务端统一改名管道
  static Future<bool> rename(
    String actorId, {
    required String displayName,
    String handle = "",
  }) async {
    try {
      final Uri uri = Uri.parse("${ApiConfig.httpBase}/api/agent-identity/rename");
      final http.Response res = await _client
          .post(
            uri,
            headers: const <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, dynamic>{
              "sessionId": actorId,
              "displayName": displayName,
              if (handle.isNotEmpty) "handle": handle,
            }),
          )
          .timeout(_timeout);
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// 主页文案编辑（签名/状态/自我介绍/置顶）
  static Future<bool> patchHomepage(String actorId, Map<String, dynamic> patch) async {
    try {
      final Uri uri = Uri.parse("${ApiConfig.httpBase}/api/agent-homepage/patch");
      final http.Response res = await _client
          .post(
            uri,
            headers: const <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, dynamic>{"sessionId": actorId, ...patch}),
          )
          .timeout(_timeout);
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// 建议名池（含自述理由）
  static Future<List<Map<String, dynamic>>> fetchNameSuggestions() async {
    final Uri uri = Uri.parse("${ApiConfig.httpBase}/api/agent-name-suggestions");
    final http.Response res = await _client
        .get(uri, headers: const <String, String>{"Accept": "application/json"})
        .timeout(_timeout);
    if (res.statusCode != 200) return const <Map<String, dynamic>>[];
    final Map<String, dynamic> body = jsonDecode(res.body) as Map<String, dynamic>;
    if (body["ok"] != true) return const <Map<String, dynamic>>[];
    return <Map<String, dynamic>>[
      for (final dynamic s in (body["suggestions"] as List<dynamic>? ?? const <dynamic>[]))
        (s as Map).cast<String, dynamic>(),
    ];
  }
}
