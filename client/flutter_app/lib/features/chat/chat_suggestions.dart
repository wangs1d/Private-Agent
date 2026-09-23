import "dart:async";

import "package:flutter/gestures.dart";
import "package:flutter/material.dart";

import "../../core/db/local_history_store.dart";
import "../../core/services/chat_suggestions_api.dart";
import "../../core/theme/app_typography.dart";

/// 「为你推荐」共用胶囊：能力标签 + 示例任务文案，黑白细描边极简样式。
///
/// 交互分两路：点胶囊主体 = 直接发送（[onTap]，原有一键路径不变）；
/// 鼠标悬停胶囊时右端淡入「填入输入框」小按钮（[onInsert]），只填不发。
class ChatSuggestionPill extends StatefulWidget {
  const ChatSuggestionPill({
    super.key,
    required this.suggestion,
    required this.onTap,
    this.onInsert,
    this.isNew = false,
    this.compact = false,
  });

  final ChatSuggestion suggestion;

  /// 点击胶囊主体：直接发送（与手打一致的发送链路）。
  final VoidCallback onTap;

  /// 悬停浮现的「填入输入框」小按钮：只把文案放进输入框不发送；
  /// 为 null 时不渲染该按钮。
  final VoidCallback? onInsert;

  /// 「能力上新」角标：由横滑条的上新检测置位（空态列表不标新）。
  final bool isNew;

  /// 紧凑态（对话中横滑条）：文案超长省略；空态纵列用完整文案。
  final bool compact;

  @override
  State<ChatSuggestionPill> createState() => _ChatSuggestionPillState();
}

class _ChatSuggestionPillState extends State<ChatSuggestionPill> {
  bool _hovering = false;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final ColorScheme cs = theme.colorScheme;
    final Color borderColor = cs.outlineVariant;
    final TextStyle tagStyle =
        (theme.textTheme.labelMedium ?? const TextStyle()).copyWith(
      fontSize: AppTypography.caption,
      height: AppTypography.uiLineHeight,
      fontWeight: FontWeight.w600,
      color: cs.onSurface,
    );
    final TextStyle promptStyle =
        (theme.textTheme.bodyMedium ?? const TextStyle()).copyWith(
      fontSize: AppTypography.secondary,
      height: AppTypography.uiLineHeight,
      color: cs.onSurface.withValues(alpha: 0.85),
    );
    final TextStyle badgeStyle =
        (theme.textTheme.labelSmall ?? const TextStyle()).copyWith(
      fontSize: AppTypography.micro,
      height: AppTypography.uiLineHeight,
      color: cs.onSurfaceVariant,
    );

    return MouseRegion(
      onEnter: (PointerEnterEvent _) => setState(() => _hovering = true),
      onExit: (PointerExitEvent _) => setState(() => _hovering = false),
      child: Material(
        color: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(18),
          side: BorderSide(color: borderColor),
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(18),
          onTap: widget.onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(
                horizontal: AppTypography.space3, vertical: AppTypography.space2),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Text(widget.suggestion.tag, style: tagStyle),
                if (widget.suggestion.experimental) ...<Widget>[
                  const SizedBox(width: AppTypography.space1),
                  Text("实验", style: badgeStyle),
                ],
                if (widget.isNew) ...<Widget>[
                  const SizedBox(width: AppTypography.space1),
                  Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: AppTypography.space1, vertical: 1),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(color: borderColor),
                    ),
                    child: Text("新", style: badgeStyle),
                  ),
                ],
                const SizedBox(width: AppTypography.space2),
                flexiblePrompt(promptStyle),
                if (widget.onInsert != null) ...<Widget>[
                  const SizedBox(width: AppTypography.space1),
                  _buildInsertButton(cs),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// 悬停淡入的「填入输入框」：按钮占位常驻（未悬停时只降透明度不收宽度），
  /// 避免悬停瞬间胶囊宽度跳变；未悬停时用 IgnorePointer 吞掉命中，
  /// 保证点击落在胶囊主体上仍走直接发送路径。箭头向下指向输入框方位。
  Widget _buildInsertButton(ColorScheme cs) {
    return AnimatedOpacity(
      opacity: _hovering ? 1 : 0,
      duration: const Duration(milliseconds: 120),
      child: IgnorePointer(
        ignoring: !_hovering,
        child: Tooltip(
          message: "填入输入框（不发送）",
          triggerMode: TooltipTriggerMode.manual,
          child: IconButton(
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(minWidth: 20, minHeight: 20),
            iconSize: 13,
            splashRadius: 12,
            tooltip: null,
            onPressed: widget.onInsert,
            icon: Icon(
              Icons.arrow_downward,
              color: cs.onSurface.withValues(alpha: 0.75),
            ),
          ),
        ),
      ),
    );
  }

  Widget flexiblePrompt(TextStyle style) {
    final Text text = Text(
      widget.suggestion.prompt,
      style: style,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
    );
    if (!widget.compact) return text;
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 260),
      child: text,
    );
  }
}

/// 空会话推荐区：光球下方的纵向列表（冷启动教育场景）。
///
/// 拉取失败或为空时整体收缩为 0，不挡聊天；展示过的能力键会合入
/// 本地「已知能力」集合，避免此后横滑条把它们误标为「上新」。
class EmptyStateSuggestions extends StatefulWidget {
  const EmptyStateSuggestions({
    super.key,
    required this.onSuggestionTap,
    required this.onSuggestionInsert,
    this.localStore,
  });

  /// 点击胶囊主体：直接发送。
  final void Function(String prompt) onSuggestionTap;

  /// 悬停胶囊浮现的「填入输入框」小按钮：只填不发。
  final void Function(String prompt) onSuggestionInsert;

  final LocalHistoryStore? localStore;

  @override
  State<EmptyStateSuggestions> createState() => _EmptyStateSuggestionsState();
}

class _EmptyStateSuggestionsState extends State<EmptyStateSuggestions> {
  final ChatSuggestionsApi _api = ChatSuggestionsApi();
  List<ChatSuggestion>? _suggestions;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final List<ChatSuggestion> items = await _api.fetch();
      if (!mounted) return;
      setState(() => _suggestions = items);
      // 首次见过的能力键全部合入已知集合（不标新、不计频控）
      if (widget.localStore != null && items.isNotEmpty) {
        final ChatSuggestionGovernor governor =
            await ChatSuggestionGovernor.load(widget.localStore!);
        await governor.markSeen(items);
      }
    } catch (_) {
      // 静默降级：推荐区不可用就不展示，不影响聊天主链路
      if (mounted) setState(() => _suggestions = const <ChatSuggestion>[]);
    }
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final List<ChatSuggestion>? items = _suggestions;
    if (items == null || items.isEmpty) return const SizedBox.shrink();

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Text(
          "为你推荐",
          style: (Theme.of(context).textTheme.labelMedium ?? const TextStyle())
              .copyWith(
            fontSize: AppTypography.caption,
            height: AppTypography.uiLineHeight,
            color: cs.onSurfaceVariant,
            letterSpacing: 2,
          ),
        ),
        const SizedBox(height: AppTypography.space3),
        for (int i = 0; i < items.length; i++) ...<Widget>[
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: ChatSuggestionPill(
              suggestion: items[i],
              onTap: () => widget.onSuggestionTap(items[i].prompt),
              onInsert: () => widget.onSuggestionInsert(items[i].prompt),
            ),
          ),
          if (i < items.length - 1) const SizedBox(height: AppTypography.space3),
        ],
      ],
    );
  }
}

/// 横滑条的出现时机治理（出现理由 / 频控 / 已知能力集合的持久化）。
///
/// 持久化在本地存储的单一偏好键里；localStore 为 null 时退化为纯内存
/// （每次启动视一切为已知、频控从零开始）。
class ChatSuggestionGovernor {
  ChatSuggestionGovernor._(this._store, this._data);

  static const String _prefKey = "chatSuggestionsGovernorV1";
  static const int dailyAutoShowCap = 3;

  final LocalHistoryStore? _store;
  final Map<String, dynamic> _data;

  static Future<ChatSuggestionGovernor> load(LocalHistoryStore store) async {
    final Object? raw = await store.getPreference(_prefKey);
    final Map<String, dynamic> data = raw is Map<String, dynamic>
        ? Map<String, dynamic>.from(raw)
        : <String, dynamic>{};
    return ChatSuggestionGovernor._(store, data);
  }

  String get _today {
    final DateTime now = DateTime.now();
    return "${now.year}-${now.month.toString().padLeft(2, "0")}-${now.day.toString().padLeft(2, "0")}";
  }

  Set<String> get knownKeys =>
      ((_data["knownKeys"] as List<dynamic>? ?? const <dynamic>[]))
          .map((e) => e.toString())
          .toSet();

  int get _shownCountToday =>
      _data["shownDate"] == _today
          ? (_data["shownCount"] as num? ?? 0).toInt()
          : 0;

  bool get dailyCapReached => _shownCountToday >= dailyAutoShowCap;

  /// 今天是否已经做过「能力上新」提醒（每天至多一次）。
  bool get newNotifiedToday => _data["newNotifyDate"] == _today;

  /// 从推荐列表里找出本地从未见过的新能力键。
  Set<String> findNewKeys(List<ChatSuggestion> suggestions) {
    final Set<String> known = knownKeys;
    return suggestions
        .map((s) => s.capabilityKey)
        .where((k) => !known.contains(k))
        .toSet();
  }

  Future<void> _save() async {
    final LocalHistoryStore? store = _store;
    if (store == null) return;
    await store.savePreference(_prefKey, _data);
  }

  /// 记一次自动出现（上新提醒与空闲出现共用每日频控额度）。
  Future<void> recordAutoShow() async {
    final int count = _shownCountToday + 1;
    _data["shownDate"] = _today;
    _data["shownCount"] = count;
    await _save();
  }

  /// 记录「能力上新」提醒已发（每天至多一次）。
  Future<void> markNewNotified() async {
    _data["newNotifyDate"] = _today;
    await _save();
  }

  /// 把展示过的能力键合入已知集合（含空态展示、点击发送后的条目）。
  Future<void> markSeen(List<ChatSuggestion> suggestions) async {
    final Set<String> known = knownKeys..addAll(
      suggestions.map((s) => s.capabilityKey),
    );
    _data["knownKeys"] = known.toList();
    await _save();
  }
}

/// 对话中的「为你推荐」横滑条（输入区上方，状态条之上）。
///
/// 出现时机（不常驻，避免噪音）：
/// - Agent 空闲超过 [_idleDelay] → 滑入一次；
/// - 拉到从未见过的能力键（能力上新）→ 当天首次立即滑入并带「新」角标；
/// - 每自然日自动出现至多 [ChatSuggestionGovernor.dailyAutoShowCap] 次；
/// - 用户点 ✕ → 本会话不再自动出现；
/// - Agent 忙碌（处理中/调工具/有后台任务）时整体隐藏，位置让给状态条。
class ChatSuggestionBar extends StatefulWidget {
  const ChatSuggestionBar({
    super.key,
    required this.agentIdle,
    required this.messageCount,
    required this.onSuggestionTap,
    required this.onSuggestionInsert,
    this.localStore,
  });

  /// 父级聚合的空闲态：非处理中、无工具调用、无后台任务。
  final bool agentIdle;
  final int messageCount;

  /// 点击胶囊主体：直接发送，条随即收起。
  final void Function(String prompt) onSuggestionTap;

  /// 悬停胶囊浮现的「填入输入框」小按钮：只填不发（条保持可见，
  /// 等用户编辑后手动发送时随消息数变化自然收起）。
  final void Function(String prompt) onSuggestionInsert;

  final LocalHistoryStore? localStore;

  @override
  State<ChatSuggestionBar> createState() => _ChatSuggestionBarState();
}

class _ChatSuggestionBarState extends State<ChatSuggestionBar> {
  static const Duration _idleDelay = Duration(minutes: 3);
  static const Duration _showDelay = Duration(milliseconds: 250);

  final ChatSuggestionsApi _api = ChatSuggestionsApi();
  ChatSuggestionGovernor? _governor;
  List<ChatSuggestion> _suggestions = const <ChatSuggestion>[];
  Set<String> _newKeys = const <String>{};
  bool _visible = false;
  bool _dismissedThisSession = false;
  bool _bootstrapped = false;

  /// bootstrap 时发现上新但 Agent 正忙：转空闲后立即补展一次。
  bool _pendingNewShow = false;
  /// 横滑条的横向滚动控制器：支撑鼠标滚轮横滚与按住拖拽
  /// （桌面端默认两者都不可用，被截断的胶囊会够不着）。
  final ScrollController _hScroll = ScrollController();
  Timer? _idleTimer;

  /// 鼠标滚轮 → 横向滚动：按 PointerSignalResolver 注册（与其他手势协作），
  /// 已滚到目标方向边缘时不注册，滚轮事件穿透给外层（消息列表）继续滚。
  void _handlePointerSignal(PointerSignalEvent event) {
    if (event is! PointerScrollEvent) return;
    final double delta = event.scrollDelta.dy;
    if (delta == 0 || !_hScroll.hasClients) return;
    final double max = _hScroll.position.maxScrollExtent;
    final double target = (_hScroll.offset + delta).clamp(0.0, max);
    if (target == _hScroll.offset) return;
    GestureBinding.instance.pointerSignalResolver.register(event, (
      PointerSignalEvent _,
    ) {
      _hScroll.position.jumpTo(target);
    });
  }

  @override
  void initState() {
    super.initState();
    _bootstrap();
  }

  Future<void> _bootstrap() async {
    if (widget.localStore != null) {
      _governor = await ChatSuggestionGovernor.load(widget.localStore!);
    }
    try {
      final List<ChatSuggestion> items = await _api.fetch();
      if (!mounted) return;
      _suggestions = items;
    } catch (_) {
      // 静默降级：拉不到推荐就不展示
    }
    if (!mounted) return;
    setState(() => _bootstrapped = true);

    // 能力上新检测：当天首次发现新能力键 → 立即滑入并标「新」
    // （bootstrap 时正忙则记下意图，转空闲后立即补展，不退化为普通空闲出现）
    final ChatSuggestionGovernor? governor = _governor;
    if (governor != null && _suggestions.isNotEmpty) {
      final Set<String> newKeys = governor.findNewKeys(_suggestions);
      if (newKeys.isNotEmpty && !governor.newNotifiedToday) {
        _newKeys = newKeys;
        await governor.markSeen(_suggestions);
        await governor.markNewNotified();
        await governor.recordAutoShow();
        if (!mounted) return;
        if (widget.agentIdle) {
          _show();
        } else {
          _pendingNewShow = true;
        }
        return;
      }
    }
    _scheduleIdleShow();
  }

  void _show() {
    if (!mounted || _dismissedThisSession) return;
    setState(() => _visible = true);
  }

  void _hide() {
    _idleTimer?.cancel();
    _idleTimer = null;
    if (mounted && _visible) setState(() => _visible = false);
  }

  /// 空闲计时：延迟 [_idleDelay] 后滑入（触发时再校验资格）。
  void _scheduleIdleShow() {
    _idleTimer?.cancel();
    if (!widget.agentIdle ||
        _dismissedThisSession ||
        widget.messageCount == 0 ||
        _suggestions.isEmpty ||
        (_governor?.dailyCapReached ?? false)) {
      return;
    }
    _idleTimer = Timer(_idleDelay, () async {
      if (!mounted || _dismissedThisSession || !widget.agentIdle) return;
      final ChatSuggestionGovernor? governor = _governor;
      if (governor != null && governor.dailyCapReached) return;
      setState(() {
        _visible = true;
        _newKeys = const <String>{};
      });
      await governor?.recordAutoShow();
      await governor?.markSeen(_suggestions);
    });
  }

  /// 点击胶囊主体的一键路径：立即发送并收条，重新进入空闲计时，
  /// 条目还有机会在下一轮空闲时再出现。
  void _sendSuggestion(ChatSuggestion suggestion) {
    _hide();
    _newKeys = const <String>{};
    widget.onSuggestionTap(suggestion.prompt);
    _scheduleIdleShow();
  }

  @override
  void didUpdateWidget(covariant ChatSuggestionBar oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Agent 转忙碌：立即隐藏并取消空闲计时（位置让给状态条）
    if (!widget.agentIdle && oldWidget.agentIdle) {
      _hide();
      return;
    }
    // 有新消息（含点击推荐发送）：先收起，再重新进入空闲计时
    if (widget.messageCount > oldWidget.messageCount) {
      _hide();
      _newKeys = const <String>{};
      _pendingNewShow = false;
      if (widget.agentIdle) _scheduleIdleShow();
      return;
    }
    // 转空闲（忙碌结束）：有上新补展意图则立即出现，否则进入空闲计时
    if (widget.agentIdle && !oldWidget.agentIdle) {
      if (_pendingNewShow) {
        _pendingNewShow = false;
        _show();
      } else {
        _scheduleIdleShow();
      }
    }
  }

  @override
  void dispose() {
    _idleTimer?.cancel();
    _hScroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final bool show = _bootstrapped &&
        _visible &&
        widget.agentIdle &&
        _suggestions.isNotEmpty;

    return AnimatedSwitcher(
      duration: _showDelay,
      transitionBuilder: (Widget child, Animation<double> animation) {
        return FadeTransition(
          opacity: animation,
          child: SlideTransition(
            position: Tween<Offset>(
              begin: const Offset(0, 0.3),
              end: Offset.zero,
            ).animate(animation),
            child: child,
          ),
        );
      },
      child: show
          ? Padding(
              key: const ValueKey<bool>(true),
              padding: const EdgeInsets.only(bottom: AppTypography.space2),
              child: Row(
                children: <Widget>[
                  Text(
                    "为你推荐",
                    style:
                        (Theme.of(context).textTheme.labelMedium ?? const TextStyle())
                            .copyWith(
                      fontSize: AppTypography.caption,
                      height: AppTypography.uiLineHeight,
                      color: cs.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(width: AppTypography.space3),
                  Expanded(
                    // 桌面端可用性：鼠标竖滚轮映射为横向滚动（到边后让给外层），
                    // 且允许鼠标按住拖拽滑动——默认 ScrollBehavior 桌面端
                    // 既不响应竖滚轮也不响应鼠标拖拽，截断的胶囊够不着。
                    child: Listener(
                      onPointerSignal: _handlePointerSignal,
                      child: ScrollConfiguration(
                        behavior: ScrollConfiguration.of(context).copyWith(
                          dragDevices: const <PointerDeviceKind>{
                            PointerDeviceKind.mouse,
                            PointerDeviceKind.touch,
                            PointerDeviceKind.stylus,
                            PointerDeviceKind.trackpad,
                          },
                        ),
                        child: SingleChildScrollView(
                          controller: _hScroll,
                          scrollDirection: Axis.horizontal,
                          child: Row(
                            children: <Widget>[
                              for (int i = 0; i < _suggestions.length; i++) ...<Widget>[
                                Padding(
                                  padding: const EdgeInsets.symmetric(
                                      horizontal: AppTypography.space1),
                                  child: ChatSuggestionPill(
                                    suggestion: _suggestions[i],
                                    compact: true,
                                    isNew: _newKeys
                                        .contains(_suggestions[i].capabilityKey),
                                    onTap: () =>
                                        _sendSuggestion(_suggestions[i]),
                                    onInsert: () => widget
                                        .onSuggestionInsert(
                                            _suggestions[i].prompt),
                                  ),
                                ),
                              ],
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                  SizedBox(
                    width: 28,
                    height: 28,
                    child: IconButton(
                      padding: EdgeInsets.zero,
                      iconSize: 16,
                      tooltip: "收起",
                      onPressed: () {
                        setState(() {
                          _dismissedThisSession = true;
                          _pendingNewShow = false;
                        });
                        _hide();
                      },
                      icon: Icon(
                        Icons.close,
                        color: cs.onSurfaceVariant,
                      ),
                    ),
                  ),
                ],
              ),
            )
          : const SizedBox.shrink(key: ValueKey<bool>(false)),
    );
  }
}
