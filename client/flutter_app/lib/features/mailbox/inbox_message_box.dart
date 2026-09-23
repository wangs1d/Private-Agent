import "dart:async";

import "package:flutter/material.dart";

import "../../core/services/inbox_api.dart";

/// 站内信消息框：锚定用户头像按钮右侧的浮层卡片。
///
/// 由侧栏用户菜单的「站内信」行触发（菜单先关闭，随后在头像右侧弹出），
/// 让用户一键直达站内信列表，不再混进消息聚合（微信/QQ/飞书会话）面板。
/// 列表/已读走 [InboxApi]（控制面 + 本地双源合并）；未读数变化经
/// [onUnreadChanged] 回传宿主，同步侧栏徽标。
class InboxMessageBox {
  const InboxMessageBox._();

  /// [anchor] 为头像按钮的屏幕 Rect（调用方经 GlobalKey 计算）。
  static Future<void> show(
    BuildContext context, {
    required Rect anchor,
    ValueChanged<int>? onUnreadChanged,
  }) {
    return showDialog<void>(
      context: context,
      barrierColor: Colors.transparent,
      barrierDismissible: true,
      useRootNavigator: true,
      builder: (_) => _InboxBoxOverlay(
        anchor: anchor,
        onUnreadChanged: onUnreadChanged,
      ),
    );
  }
}

class _InboxBoxOverlay extends StatefulWidget {
  const _InboxBoxOverlay({required this.anchor, this.onUnreadChanged});

  final Rect anchor;
  final ValueChanged<int>? onUnreadChanged;

  @override
  State<_InboxBoxOverlay> createState() => _InboxBoxOverlayState();
}

class _InboxBoxOverlayState extends State<_InboxBoxOverlay> {
  static const double _panelWidth = 340;
  static const double _panelMaxHeight = 480;

  final InboxApi _api = InboxApi();
  List<InboxMessageItem> _messages = const <InboxMessageItem>[];
  bool _loading = true;
  bool _markingAll = false;
  String? _error;
  String? _partialError;

  @override
  void initState() {
    super.initState();
    unawaited(_reload());
  }

  Future<void> _reload() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final InboxApiResult<InboxSnapshot> result = await _api.list();
    if (!mounted) return;
    setState(() {
      _loading = false;
      if (result.ok) {
        _messages = result.value?.messages ?? const <InboxMessageItem>[];
        _partialError = result.value?.partialError;
      } else {
        _error = result.error ?? "获取站内信失败";
      }
    });
    widget.onUnreadChanged?.call(_unreadCount);
  }

  int get _unreadCount =>
      _messages.where((InboxMessageItem m) => !m.read).length;

  Future<void> _markAllRead() async {
    if (_markingAll || _unreadCount == 0) return;
    setState(() => _markingAll = true);
    await _api.markRead();
    if (!mounted) return;
    setState(() => _markingAll = false);
    await _reload();
  }

  /// 打开一条消息：详情弹窗 + 未读时标记已读，随后刷新列表与徽标。
  Future<void> _openMessage(InboxMessageItem message) async {
    if (!message.read) {
      unawaited(_api.markRead(ids: <String>[message.messageId]));
    }
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (BuildContext dialogContext) {
        final ThemeData theme = Theme.of(dialogContext);
        return AlertDialog(
          title: Text(message.title),
          content: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                if (message.createdAt != null)
                  Text(
                    _formatTime(message.createdAt!),
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                const SizedBox(height: 12),
                SelectableText(message.body),
              ],
            ),
          ),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text("关闭"),
            ),
          ],
        );
      },
    );
    // 已读状态可能变化：无论是否刚标记过都刷新一次（含徽标）
    await _reload();
  }

  /// 时间展示：今天只看时刻，今年省略年份，更早带年份。
  String _formatTime(DateTime t) {
    final DateTime now = DateTime.now();
    final bool isToday =
        t.year == now.year && t.month == now.month && t.day == now.day;
    final String hhmm =
        "${t.hour.toString().padLeft(2, "0")}:${t.minute.toString().padLeft(2, "0")}";
    if (isToday) return hhmm;
    final String md = "${t.month}月${t.day}日 $hhmm";
    return t.year == now.year ? md : "${t.year}/$md";
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final double screenWidth = MediaQuery.of(context).size.width;
    final double screenHeight = MediaQuery.of(context).size.height;
    // 消息框贴头像按钮右侧；底部与头像底部对齐往上生长（与用户菜单同基准）。
    // 矮窗口下钳制 bottom，避免面板顶部溢出屏幕。
    final double left = (widget.anchor.right + 8).clamp(
      8.0,
      (screenWidth - _panelWidth - 8).clamp(8.0, double.infinity),
    );
    double bottom =
        (screenHeight - widget.anchor.bottom + 8).clamp(8.0, double.infinity);
    final double maxBottom =
        (screenHeight - 8 - _panelMaxHeight).clamp(8.0, double.infinity);
    if (bottom > maxBottom) bottom = maxBottom;

    return Stack(
      children: <Widget>[
        // 点空白关闭（屏障已透明化，这里兜底命中区域）
        Positioned.fill(
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () => Navigator.of(context).pop(),
            child: const SizedBox.shrink(),
          ),
        ),
        Positioned(
          left: left,
          bottom: bottom,
          child: Material(
            color: cs.surfaceContainerHigh,
            surfaceTintColor: Colors.transparent,
            elevation: 12,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(14),
              side: BorderSide(color: cs.outline.withValues(alpha: 0.28)),
            ),
            clipBehavior: Clip.antiAlias,
            child: SizedBox(
              width: _panelWidth,
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: _panelMaxHeight),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    _buildHeader(cs),
                    if (_partialError != null)
                      Padding(
                        padding:
                            const EdgeInsets.fromLTRB(14, 6, 14, 0),
                        child: Text(
                          "部分消息来源暂不可达",
                          style: TextStyle(
                            fontSize: 11,
                            color: cs.onSurfaceVariant,
                          ),
                        ),
                      ),
                    Divider(
                        height: 1, thickness: 1,
                        color: cs.outline.withValues(alpha: 0.2)),
                    Flexible(child: _buildBody(cs)),
                  ],
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildHeader(ColorScheme cs) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 12, 8, 8),
      child: Row(
        children: <Widget>[
          Text(
            "站内信",
            style: TextStyle(
              fontSize: 15,
              fontWeight: FontWeight.w600,
              color: cs.onSurface,
            ),
          ),
          if (_unreadCount > 0) ...<Widget>[
            const SizedBox(width: 8),
            Container(
              padding:
                  const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
              decoration: BoxDecoration(
                color: cs.error,
                borderRadius: BorderRadius.circular(8),
              ),
              constraints:
                  const BoxConstraints(minWidth: 18, minHeight: 16),
              alignment: Alignment.center,
              child: Text(
                _unreadCount > 99 ? "99+" : "$_unreadCount",
                style: TextStyle(
                  color: cs.onError,
                  fontSize: 11,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
          const Spacer(),
          if (_unreadCount > 0)
            TextButton(
              onPressed: _markingAll ? null : _markAllRead,
              style: TextButton.styleFrom(
                padding:
                    const EdgeInsets.symmetric(horizontal: 8),
                minimumSize: const Size(0, 32),
              ),
              child: _markingAll
                  ? SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(
                          strokeWidth: 2, color: cs.primary),
                    )
                  : Text(
                      "全部已读",
                      style: TextStyle(fontSize: 12, color: cs.primary),
                    ),
            ),
          IconButton(
            icon: Icon(Icons.close, size: 18, color: cs.onSurfaceVariant),
            tooltip: "关闭",
            onPressed: () => Navigator.of(context).pop(),
          ),
        ],
      ),
    );
  }

  Widget _buildBody(ColorScheme cs) {
    if (_loading && _messages.isEmpty) {
      return const Center(
        child: SizedBox(
          width: 22,
          height: 22,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }
    if (_error != null) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(
              _error!,
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13, color: cs.error),
            ),
            const SizedBox(height: 12),
            TextButton.icon(
              onPressed: _reload,
              icon: const Icon(Icons.refresh, size: 16),
              label: const Text("重试"),
            ),
          ],
        ),
      );
    }
    if (_messages.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(Icons.inbox_outlined, size: 40, color: cs.outline),
            const SizedBox(height: 10),
            Text(
              "暂无站内信",
              style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant),
            ),
          ],
        ),
      );
    }
    return ListView.builder(
      shrinkWrap: true,
      padding: const EdgeInsets.symmetric(vertical: 4),
      itemCount: _messages.length,
      itemBuilder: (BuildContext _, int index) {
        final InboxMessageItem m = _messages[index];
        return _MessageTile(
          message: m,
          timeText:
              m.createdAt == null ? "" : _formatTime(m.createdAt!),
          onTap: () => unawaited(_openMessage(m)),
        );
      },
    );
  }
}

class _MessageTile extends StatefulWidget {
  const _MessageTile({
    required this.message,
    required this.timeText,
    required this.onTap,
  });

  final InboxMessageItem message;
  final String timeText;
  final VoidCallback onTap;

  @override
  State<_MessageTile> createState() => _MessageTileState();
}

class _MessageTileState extends State<_MessageTile> {
  bool _hovering = false;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final InboxMessageItem m = widget.message;
    final Color bgColor =
        _hovering ? cs.surfaceContainerHigh.withValues(alpha: 0.6) : Colors.transparent;

    return MouseRegion(
      onEnter: (_) => setState(() => _hovering = true),
      onExit: (_) => setState(() => _hovering = false),
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 120),
          color: bgColor,
          padding:
              const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              // 未读圆点列：固定宽度保证已读/未读对齐
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: m.read ? Colors.transparent : cs.primary,
                    shape: BoxShape.circle,
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Row(
                      children: <Widget>[
                        Expanded(
                          child: Text(
                            m.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 13,
                              color: cs.onSurface,
                              fontWeight: m.read
                                  ? FontWeight.w400
                                  : FontWeight.w600,
                            ),
                          ),
                        ),
                        if (widget.timeText.isNotEmpty) ...<Widget>[
                          const SizedBox(width: 8),
                          Text(
                            widget.timeText,
                            style: TextStyle(
                              fontSize: 11,
                              color: cs.onSurfaceVariant,
                            ),
                          ),
                        ],
                      ],
                    ),
                    const SizedBox(height: 3),
                    Text(
                      m.body,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12,
                        color: cs.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
