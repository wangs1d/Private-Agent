import "dart:async";
import "dart:convert" show jsonDecode, jsonEncode;

import "package:flutter/material.dart";
import "package:http/http.dart" as http;

import "../../core/config/api_config.dart";

const Color _kAccentBlue = Color(0xFF18D6F3);
const Color _kAccentGreen = Color(0xFF1ED7A6);
const Color _kAccentOrange = Color(0xFFD7B85A);

/// 代办足迹卡：右侧面板顶部区块，展示 Agent 主动代办/盯梢告知的结果台账
/// （订牛奶 / 缴水电费 / 改日程…）。
///
/// 与对话流的分工：主动消息摘要仍实时推入聊天（必看），本卡只做「可回溯
/// 的代办账本」——未读条目用品牌色竖条 + 染色底 + 状态 pill 醒目提示，
/// 展示 2 秒后自动置已读降噪为灰阶。
class AgentActivitySection extends StatefulWidget {
  const AgentActivitySection({super.key});

  @override
  State<AgentActivitySection> createState() => _AgentActivitySectionState();
}

class _AgentActivitySectionState extends State<AgentActivitySection>
    with SingleTickerProviderStateMixin {
  static const int _visibleLimit = 3;
  static const Duration _refreshInterval = Duration(minutes: 1);

  List<AgentActivity> _activities = const <AgentActivity>[];
  bool _loading = true;
  bool _loadFailed = false;
  Timer? _refreshTimer;

  /// 标题行呼吸点：有未读时出现（复用面板 breathe 动画语言），读完后消失
  late final AnimationController _breatheController;

  @override
  void initState() {
    super.initState();
    _breatheController = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 2),
    )..repeat(reverse: true);
    _load();
    _refreshTimer = Timer.periodic(_refreshInterval, (_) => _load());
  }

  @override
  void dispose() {
    _refreshTimer?.cancel();
    _breatheController.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final List<AgentActivity> activities = await AgentActivityApi.fetch(
      limit: 20,
    );
    if (!mounted) return;
    final bool failed = activities.isEmpty && !AgentActivityApi.lastFetchOk;
    setState(() {
      _activities = activities;
      _loading = false;
      _loadFailed = failed;
    });
  }

  /// 批量置已读并刷新本地态（打开「查看全部足迹」时调用）。
  ///
  /// 未读高亮保留到用户真正交互（点条目看详情 / 打开全部列表）才清除，
  /// 避免「面板常驻可见 → 2 秒自动已读」让醒目态永远一闪而过。
  Future<void> _markAllRead() async {
    final List<String> unreadIds = _activities
        .where((a) => !a.isRead)
        .map((a) => a.id)
        .toList(growable: false);
    if (unreadIds.isEmpty) return;
    final bool ok = await AgentActivityApi.markRead(ids: unreadIds);
    if (!ok || !mounted) return;
    setState(() {
      _activities = <AgentActivity>[
        for (final AgentActivity a in _activities)
          if (unreadIds.contains(a.id)) a.asRead() else a,
      ];
    });
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final int unreadCount = _activities.where((a) => !a.isRead).length;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 2),
          child: Row(
            children: <Widget>[
              if (unreadCount > 0) ...<Widget>[
                FadeTransition(
                  opacity: Tween<double>(begin: 0.35, end: 1.0).animate(
                    CurvedAnimation(
                      parent: _breatheController,
                      curve: Curves.easeInOut,
                    ),
                  ),
                  child: _BreathingDot(color: _kAccentBlue),
                ),
                const SizedBox(width: 6),
              ],
              Text(
                "代办足迹",
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: cs.onSurface,
                  letterSpacing: 0.2,
                ),
              ),
              const Spacer(),
              if (_loading && _activities.isEmpty)
                const SizedBox(
                  width: 12,
                  height: 12,
                  child: CircularProgressIndicator(strokeWidth: 1.6),
                )
              else if (unreadCount > 0)
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                  decoration: BoxDecoration(
                    color: _kAccentBlue,
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text(
                    "$unreadCount 条新",
                    style: const TextStyle(
                      fontSize: 10,
                      fontWeight: FontWeight.w700,
                      color: Color(0xFF06252C),
                      letterSpacing: 0.3,
                    ),
                  ),
                )
              else if (_activities.isNotEmpty)
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                  decoration: BoxDecoration(
                    color: cs.surfaceContainerHighest.withValues(alpha: 0.6),
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text(
                    "共 ${_activities.length} 条",
                    style: TextStyle(
                      fontSize: 10,
                      fontWeight: FontWeight.w600,
                      color: cs.onSurfaceVariant,
                    ),
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: 4),
        if (_loadFailed && _activities.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 4),
            child: Text(
              "足迹暂时不可用",
              style: TextStyle(
                fontSize: 11,
                color: cs.onSurfaceVariant.withValues(alpha: 0.7),
              ),
            ),
          )
        else if (!_loading && _activities.isEmpty)
          _buildEmptyState(cs)
        else
          ...<Widget>[
            for (final AgentActivity activity in _activities.take(_visibleLimit))
              _ActivityTile(
                activity: activity,
                onTap: () => _showDetail(activity),
              ),
            if (_activities.length > _visibleLimit)
              _buildSeeAllRow(cs),
          ],
      ],
    );
  }

  Widget _buildEmptyState(ColorScheme cs) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 22),
      child: Column(
        children: <Widget>[
          Container(
            width: 46,
            height: 46,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Border.all(
                color: cs.outline.withValues(alpha: 0.5),
                strokeAlign: BorderSide.strokeAlignCenter,
                style: BorderStyle.solid,
              ),
            ),
            child: Icon(
              Icons.auto_awesome_outlined,
              size: 19,
              color: cs.onSurfaceVariant.withValues(alpha: 0.7),
            ),
          ),
          const SizedBox(height: 10),
          Text(
            "还没有足迹",
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: cs.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            "我主动帮你办完的事\n会第一时间出现在这里",
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 10,
              height: 1.6,
              color: cs.onSurfaceVariant.withValues(alpha: 0.65),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildSeeAllRow(ColorScheme cs) {
    return Padding(
      padding: const EdgeInsets.only(top: 2),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(6),
          onTap: () => _showAllSheet(cs),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 7),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                Text(
                  "查看全部足迹",
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w500,
                    color: cs.onSurfaceVariant,
                  ),
                ),
                Icon(
                  Icons.chevron_right,
                  size: 13,
                  color: cs.onSurfaceVariant,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// 全量足迹：底部抽屉列表（台账只增，面板视图最多展示 3 条）。
  /// 打开即视为「已全部查看」——批量置已读、熄灭未读高亮。
  Future<void> _showAllSheet(ColorScheme cs) async {
    unawaited(_markAllRead());
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: cs.surfaceContainerLow,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      builder: (BuildContext sheetContext) {
        return SafeArea(
          child: ListView(
            shrinkWrap: true,
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
            children: <Widget>[
              Text(
                "代办足迹",
                style: TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w700,
                  color: cs.onSurface,
                ),
              ),
              const SizedBox(height: 6),
              if (_activities.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 24),
                  child: Text(
                    "还没有足迹",
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 12,
                      color: cs.onSurfaceVariant,
                    ),
                  ),
                )
              else
                for (final AgentActivity activity in _activities)
                  _ActivityTile(
                    activity: activity,
                    onTap: () {
                      Navigator.of(sheetContext).pop();
                      _showDetail(activity);
                    },
                  ),
            ],
          ),
        );
      },
    );
  }

  /// 条目详情浮层：订单/回执关键字段直接展开；点开即视为已读
  Future<void> _showDetail(AgentActivity activity) async {
    final ColorScheme cs = Theme.of(context).colorScheme;
    if (!activity.isRead) {
      unawaited(_markSingleRead(activity));
    }
    await showDialog<void>(
      context: context,
      builder: (BuildContext dialogContext) {
        return AlertDialog(
          backgroundColor: cs.surfaceContainerHigh,
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          contentPadding: const EdgeInsets.fromLTRB(18, 16, 18, 10),
          content: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 260),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    _activityIcon(activity, size: 26, boxSize: 28),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        activity.title,
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w700,
                          color: cs.onSurface,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    _StatusPill(activity: activity, dense: true),
                  ],
                ),
                const SizedBox(height: 10),
                Text(
                  activity.summary,
                  style: TextStyle(
                    fontSize: 12,
                    height: 1.55,
                    color: cs.onSurface.withValues(alpha: 0.85),
                  ),
                ),
                if (activity.detail != null &&
                    activity.detail!.isNotEmpty) ...<Widget>[
                  const SizedBox(height: 10),
                  for (final MapEntry<String, String> entry
                      in activity.detail!.entries)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 5),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          SizedBox(
                            width: 62,
                            child: Text(
                              entry.key,
                              style: TextStyle(
                                fontSize: 11,
                                color: cs.onSurfaceVariant,
                              ),
                            ),
                          ),
                          Expanded(
                            child: Text(
                              entry.value,
                              textAlign: TextAlign.right,
                              style: TextStyle(
                                fontSize: 11,
                                fontWeight: FontWeight.w500,
                                color: cs.onSurface,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                ],
                const SizedBox(height: 8),
                Text(
                  _timeLabel(activity.createdAt),
                  style: TextStyle(
                    fontSize: 10,
                    color: cs.onSurfaceVariant.withValues(alpha: 0.7),
                  ),
                ),
              ],
            ),
          ),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: Text(
                "知道了",
                style: TextStyle(fontSize: 12, color: cs.primary),
              ),
            ),
          ],
        );
      },
    );
  }

  Future<void> _markSingleRead(AgentActivity activity) async {
    final bool ok = await AgentActivityApi.markRead(ids: <String>[activity.id]);
    if (!ok || !mounted) return;
    setState(() {
      _activities = <AgentActivity>[
        for (final AgentActivity a in _activities)
          if (a.id == activity.id) a.asRead() else a,
      ];
    });
  }

  Widget _activityIcon(AgentActivity activity,
      {double size = 15, double boxSize = 30}) {
    final (IconData icon, Color color) = _categoryVisual(activity.category);
    return Container(
      width: boxSize,
      height: boxSize,
      decoration: BoxDecoration(
        color: color.withValues(alpha: activity.isRead ? 0.08 : 0.14),
        borderRadius: BorderRadius.circular(9),
      ),
      child: Icon(icon, size: size, color: activity.isRead ? null : color),
    );
  }
}

(IconData, Color) _categoryVisual(String category) {
  switch (category) {
    case "purchase":
      return (Icons.shopping_bag_outlined, _kAccentBlue);
    case "payment":
      return (Icons.water_drop_outlined, _kAccentGreen);
    case "schedule":
      return (Icons.schedule_outlined, _kAccentOrange);
    default:
      return (Icons.auto_awesome_outlined, _kAccentBlue);
  }
}

String _timeLabel(int ms) {
  final DateTime time = DateTime.fromMillisecondsSinceEpoch(ms);
  final DateTime now = DateTime.now();
  final bool sameDay =
      time.year == now.year && time.month == now.month && time.day == now.day;
  if (sameDay) {
    return "${time.hour.toString().padLeft(2, "0")}:${time.minute.toString().padLeft(2, "0")}";
  }
  final DateTime yesterday = now.subtract(const Duration(days: 1));
  final bool isYesterday = time.year == yesterday.year &&
      time.month == yesterday.month &&
      time.day == yesterday.day;
  if (isYesterday) return "昨天";
  return "${time.month}月${time.day}日";
}

// ═══════════════════════════════════════════════════════════
// 数据模型 + API
// ═══════════════════════════════════════════════════════════

class AgentActivity {
  const AgentActivity({
    required this.id,
    required this.kind,
    required this.category,
    required this.title,
    required this.summary,
    required this.status,
    this.statusLabel,
    this.detail,
    required this.createdAt,
    required this.readAt,
  });

  final String id;
  final String kind;
  final String category;
  final String title;
  final String summary;

  /// pending=进行中 / done=已完成 / failed=未完成 / changed=已调整
  final String status;
  final String? statusLabel;
  final Map<String, String>? detail;
  final int createdAt;
  final int? readAt;

  bool get isRead => readAt != null;

  factory AgentActivity.fromJson(Map<String, dynamic> json) {
    return AgentActivity(
      id: json["id"]?.toString() ?? "",
      kind: json["kind"]?.toString() ?? "",
      category: json["category"]?.toString() ?? "generic",
      title: json["title"]?.toString() ?? "",
      summary: json["summary"]?.toString() ?? "",
      status: json["status"]?.toString() ?? "done",
      statusLabel: json["statusLabel"]?.toString(),
      detail: (json["detail"] as Map?)?.cast<String, String>(),
      createdAt: (json["createdAt"] as num?)?.toInt() ?? 0,
      readAt: (json["readAt"] as num?)?.toInt(),
    );
  }

  AgentActivity asRead() => AgentActivity(
        id: id,
        kind: kind,
        category: category,
        title: title,
        summary: summary,
        status: status,
        statusLabel: statusLabel,
        detail: detail,
        createdAt: createdAt,
        readAt: readAt ?? DateTime.now().millisecondsSinceEpoch,
      );
}

class AgentActivityApi {
  AgentActivityApi._();

  /// 最近一次 fetch 是否成功（区分「真的没有足迹」与「网络不可用」）
  static bool lastFetchOk = true;

  static Future<List<AgentActivity>> fetch({int limit = 20}) async {
    lastFetchOk = false;
    try {
      final Uri uri = Uri.parse("${ApiConfig.httpBase}/agent/activities")
          .replace(queryParameters: <String, String>{
        "actorId": ApiConfig.effectiveActorId,
        "limit": "$limit",
      });
      final http.Response res = await http
          .get(uri, headers: const <String, String>{"Accept": "application/json"})
          .timeout(const Duration(seconds: 8));
      if (res.statusCode != 200) return const <AgentActivity>[];
      final Map<String, dynamic> body =
          jsonDecode(res.body) as Map<String, dynamic>;
      if (body["ok"] != true) return const <AgentActivity>[];
      final List<dynamic> items = body["activities"] as List<dynamic>? ?? const [];
      lastFetchOk = true;
      return <AgentActivity>[
        for (final dynamic item in items)
          AgentActivity.fromJson((item as Map).cast<String, dynamic>()),
      ];
    } catch (_) {
      return const <AgentActivity>[];
    }
  }

  static Future<bool> markRead({List<String>? ids}) async {
    try {
      final Uri uri = Uri.parse("${ApiConfig.httpBase}/agent/activities/read");
      final http.Response res = await http
          .post(
            uri,
            headers: const <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, dynamic>{
              "actorId": ApiConfig.effectiveActorId,
              if (ids != null) "ids": ids,
            }),
          )
          .timeout(const Duration(seconds: 8));
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 条目瓦片：未读=竖条 + 染色底 + 状态 pill；已读=整体降噪灰阶
// ═══════════════════════════════════════════════════════════

class _ActivityTile extends StatelessWidget {
  const _ActivityTile({required this.activity, this.onTap});

  final AgentActivity activity;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final bool unread = !activity.isRead;
    final (_, Color categoryColor) = _categoryVisual(activity.category);

    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: onTap,
          child: Container(
            padding:
                const EdgeInsets.fromLTRB(9, 8, 8, 8),
            decoration: BoxDecoration(
              color: unread
                  ? categoryColor.withValues(alpha: 0.08)
                  : Colors.transparent,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                if (unread) ...<Widget>[
                  Container(
                    width: 3,
                    height: 32,
                    margin: const EdgeInsets.only(right: 6),
                    decoration: BoxDecoration(
                      color: categoryColor,
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                ],
                _CategoryIcon(activity: activity),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        activity.title,
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight:
                              unread ? FontWeight.w600 : FontWeight.w500,
                          color: unread
                              ? cs.onSurface
                              : cs.onSurfaceVariant,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      const SizedBox(height: 2),
                      Text(
                        activity.summary,
                        style: TextStyle(
                          fontSize: 10,
                          color: cs.onSurfaceVariant
                              .withValues(alpha: unread ? 0.95 : 0.6),
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      const SizedBox(height: 4),
                      Row(
                        children: <Widget>[
                          _StatusPill(activity: activity),
                          const Spacer(),
                          Text(
                            _timeLabel(activity.createdAt),
                            style: TextStyle(
                              fontSize: 10,
                              color: cs.onSurfaceVariant,
                            ),
                          ),
                        ],
                      ),
                    ],
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

class _CategoryIcon extends StatelessWidget {
  const _CategoryIcon({required this.activity});

  final AgentActivity activity;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final (IconData icon, Color color) = _categoryVisual(activity.category);
    final bool unread = !activity.isRead;
    return Container(
      width: 30,
      height: 30,
      decoration: BoxDecoration(
        color: unread
            ? color.withValues(alpha: 0.14)
            : cs.surfaceContainerHighest.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(9),
      ),
      child: Icon(
        icon,
        size: 15,
        color: unread ? color : cs.onSurfaceVariant,
      ),
    );
  }
}

class _StatusPill extends StatelessWidget {
  const _StatusPill({required this.activity, this.dense = false});

  final AgentActivity activity;
  final bool dense;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final (String label, Color color) = switch (activity.status) {
      "pending" => (activity.statusLabel ?? "进行中", _kAccentBlue),
      "done" => (activity.statusLabel ?? "已完成", _kAccentGreen),
      "changed" => (activity.statusLabel ?? "已调整", _kAccentOrange),
      "failed" => (activity.statusLabel ?? "未完成", cs.error),
      _ => (activity.statusLabel ?? "已完成", cs.onSurfaceVariant),
    };
    // 已读条目 pill 一律灰阶降噪（设计：状态色只服务于未读与详情浮层）
    final bool muted = activity.isRead && !dense;
    final Color bg = muted
        ? cs.surfaceContainerHighest.withValues(alpha: 0.6)
        : color.withValues(alpha: 0.13);
    final Color fg = muted ? cs.onSurfaceVariant : color;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1.5),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 9,
          fontWeight: FontWeight.w700,
          color: fg,
          letterSpacing: 0.3,
        ),
      ),
    );
  }
}

/// 标题行呼吸圆点：有未读时出现
class _BreathingDot extends StatelessWidget {
  const _BreathingDot({required this.color});

  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 7,
      height: 7,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: color,
        boxShadow: <BoxShadow>[
          BoxShadow(
            color: color.withValues(alpha: 0.8),
            blurRadius: 9,
            spreadRadius: 0,
          ),
        ],
      ),
    );
  }
}
