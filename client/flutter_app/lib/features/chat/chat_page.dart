import "package:flutter/foundation.dart" show defaultTargetPlatform, kIsWeb, TargetPlatform;
import "package:flutter/material.dart";
import "package:flutter/services.dart";
import "package:http/http.dart" as http;
import "dart:convert";

import "../../core/config/api_config.dart";
import "../../core/presentation/virtual_phone_ui_labels.dart";
import "../../core/models/chat_models.dart";
import "../../core/utils/content_summary_parser.dart";
import "../../core/utils/markdown_strip.dart";
import "../../core/services/speech_service.dart";
import "content_summary_card.dart";
import "content_summary_detail_modal.dart";

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
    this.isActive = true,
    /// 删除单条消息的回调（传入 messageId）
    this.onDeleteMessage,
    /// 删除从某条消息起之后所有消息的回调（传入 messageId）
    this.onDeleteFromMessage,
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
  /// 呼叫 Agent（App 内无需另输 6 位联络号）
  final VoidCallback? onOpenPhoneDialer;
  /// 当前 Tab 是否激活（用于检测从其他 Tab 切回对话页）
  final bool isActive;
  /// 删除单条消息
  final void Function(String messageId)? onDeleteMessage;
  /// 删除从某条消息起之后所有消息
  final void Function(String messageId)? onDeleteFromMessage;

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> with SingleTickerProviderStateMixin {
  final SpeechService _speechService = SpeechService();
  final bool _isListening = false;
  final String _recognizedText = "";
  final ScrollController _scrollController = ScrollController();

  /// 全局删除选择模式状态
  bool _deleteSelectionMode = false;
  /// 触发删除的用户消息 ID（该消息始终被锁定选中，不可取消）
  String? _deleteTriggerMessageId;
  /// 删除选择模式下被选中的消息 ID 集合（含触发用户消息+可选的agent回复）
  final Set<String> _selectedMessageIds = <String>{};

  /// 进入删除选择模式：当前用户消息锁定选中，其agent回复默认全选可取消
  void _enterDeleteMode(String messageId) {
    setState(() {
      _deleteSelectionMode = true;
      _deleteTriggerMessageId = messageId;
      _selectedMessageIds.clear();
      _selectedMessageIds.addAll(_getRelatedMessageIds(messageId));
    });
  }

  /// 切换单条消息的选中状态（触发消息不可取消）
  void _toggleMessageSelection(String messageId, bool selected) {
    if (messageId == _deleteTriggerMessageId) return; // 用户消息不可取消
    setState(() {
      if (selected) {
        _selectedMessageIds.add(messageId);
      } else {
        _selectedMessageIds.remove(messageId);
      }
    });
  }

  /// 确认删除所有选中消息（仅删除被勾选的，倒序逐条删除避免索引偏移）
  void _confirmDeleteSelection() {
    if (_selectedMessageIds.isEmpty || widget.onDeleteMessage == null) return;

    // 按索引从大到小排序，倒序删除避免索引偏移
    final List<MapEntry<int, String>> sorted = <MapEntry<int, String>>[];
    for (final String mid in _selectedMessageIds) {
      final int idx = widget.messages.indexWhere((ChatMessage m) => m.messageId == mid);
      if (idx >= 0) {
        sorted.add(MapEntry<int, String>(idx, mid));
      }
    }
    sorted.sort((MapEntry<int, String> a, MapEntry<int, String> b) => b.key.compareTo(a.key));

    // 倒序逐条删除
    for (final MapEntry<int, String> entry in sorted) {
      widget.onDeleteMessage!(entry.value);
    }

    setState(() {
      _deleteSelectionMode = false;
      _deleteTriggerMessageId = null;
      _selectedMessageIds.clear();
    });
  }

  /// 取消删除选择模式
  void _cancelDeleteMode() {
    setState(() {
      _deleteSelectionMode = false;
      _deleteTriggerMessageId = null;
      _selectedMessageIds.clear();
    });
  }

  /// 滚动状态使用 ValueNotifier，避免 setState 触发整树重建导致掉帧
  final ValueNotifier<bool> _isUserScrollingNotifier = ValueNotifier<bool>(false);
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

  /// ====== 滚动位置保持相关 ======
  bool _isTabActive = false;            // 当前是否在对话 Tab 上（用于屏蔽非活跃时的自动滚动）
                                       // 在 initState 中从 widget.isActive 同步初始值
  double? _savedScrollPosition;         // 离开时保存的滚动像素位置
  double? _savedMaxScrollExtent;        // 离开时的最大可滚动距离
  bool _hasSavedPosition = false;       // 是否有已保存的有效位置可供恢复
                                       // （应用重启后自然重置为 false → 滚到底部）
  bool _isRestoringPosition = false;    // 恢复锁：正在恢复位置时阻止所有自动滚动

  // 预定义常量 - 减少重复创建对象
  static const EdgeInsets _listPadding = EdgeInsets.symmetric(horizontal: 12, vertical: 8);
  static const EdgeInsets _cardPadding = EdgeInsets.all(12);
  static const EdgeInsets _inputPadding = EdgeInsets.fromLTRB(6, 6, 6, 5);
  static const EdgeInsets _inputHorizontalPadding = EdgeInsets.symmetric(horizontal: 10, vertical: 6);

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
    // 同步初始 Tab 激活状态（关键：必须与 widget.isActive 一致，否则首次切走时保存会被跳过）
    _isTabActive = widget.isActive;
    // 注意：ListView 使用 reverse=true，天然从底部开始渲染，无需 jumpTo
  }

  /// 滚动到底部的通用方法（reverse 模式下 bottom = pixels 0）
  void _scrollToBottom({bool instant = false}) {
    if (!_scrollController.hasClients) return;
    // reverse 模式下，pixels=0 就是列表底部（最新消息处）
    // instant 时直接 jumpTo(0)，非 instant 用短动画过渡
    if (instant) {
      _scrollController.jumpTo(0);
      return;
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) return;
      if (_scrollController.position.pixels > 1) {
        _scrollController.animateTo(
          0,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
        );
        // 桌面端保险：再延迟一帧确认滚动到位
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!_scrollController.hasClients) return;
          if (_scrollController.position.pixels > 1) {
            _scrollController.animateTo(
              0,
              duration: const Duration(milliseconds: 150),
              curve: Curves.easeOut,
            );
          }
        });
      }
    });
  }

  void _onScroll() {
    if (!_scrollController.hasClients) return;
    // reverse 模式下：pixels=0 是底部，pixels 越大越靠近顶部
    final double currentScroll = _scrollController.position.pixels;

    // 使用 ValueNotifier 更新，避免触发 setState 导致整树重建和掉帧
    // pixels > 100 表示用户从底部向上滑动了超过 100px
    final bool shouldMarkScrolling = (currentScroll > 100);
    if (_isUserScrollingNotifier.value != shouldMarkScrolling) {
      _isUserScrollingNotifier.value = shouldMarkScrolling;
      if (!shouldMarkScrolling) {
        // 滚回底部时清除新消息标记（仅更新局部状态）
        _hasNewAgentMessage = false;
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

    // ====== 优先处理 Tab 切换（离开 / 进入） ======
    final bool wasActive = _isTabActive;
    final bool nowActive = widget.isActive;

    // 离开对话 Tab → 保存位置
    if (wasActive && !nowActive) {
      print('[ChatScroll] 👋 离开对话Tab: wasActive=$wasActive → nowActive=$nowActive');
      _isTabActive = false;
      _saveScrollPosition();
      return; // 离开后不再处理消息相关滚动
    }

    // 进入（或切回）对话 Tab → 恢复位置或滚到底部
    if (!wasActive && nowActive) {
      print('[ChatScroll] 🏠 进入对话Tab: wasActive=$wasActive → nowActive=$nowActive, hasSaved=$_hasSavedPosition, savedPixels=$_savedScrollPosition');
      _isTabActive = true;
      _restoreOrScrollToBottom();
      return; // 刚进入时跳过后续消息增量滚动逻辑
    }

    // ====== 以下逻辑仅在活跃状态下执行（防止非活跃时被新消息覆盖位置） ======
    if (!_isTabActive) return;

    // 恢复锁：正在恢复位置时，跳过所有自动滚动逻辑，防止被后续 didUpdateWidget 调用覆盖
    if (_isRestoringPosition) {
      print('[ChatScroll] ⛔ 恢复锁生效：跳过自动滚动 (messages=${widget.messages.length}, old=${oldWidget.messages.length})');
      return;
    }

    // 消息数量未变化时，检查是否需要因流式更新而滚动
    final bool messagesUnchanged = widget.messages.length == oldWidget.messages.length;
    if (messagesUnchanged) {
      // Agent 正在流式输出（消息文本在增长），且用户没有主动上滑 → 跟踪到底部
      if (widget.isAgentProcessing && !_isUserScrollingNotifier.value) {
        WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());
      }
      return;
    }

    // 检测是否有新的用户消息
    final bool hasNewUserMessage = widget.messages.length > oldWidget.messages.length &&
        widget.messages.isNotEmpty &&
        widget.messages.last.role == "user";

    // 用户发送消息时，无论是否在滑动，都自动滚动到底部
    if (hasNewUserMessage) {
      _isUserScrollingNotifier.value = false;
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
    if (hasNewAgentMessage && _isUserScrollingNotifier.value) {
      _hasNewAgentMessage = true;
      return;
    }

    // 用户没有主动滑动时，自动滚动到底部
    if (widget.messages.length != oldWidget.messages.length) {
      _isUserScrollingNotifier.value = false;
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
    _isUserScrollingNotifier.dispose();
    super.dispose();
  }

  /// ====== 滚动位置保持：保存当前滚动位置 ======
  void _saveScrollPosition() {
    if (!_scrollController.hasClients) {
      print('[ChatScroll] 💾 保存失败: scrollController 无 client');
      return;
    }
    final double pixels = _scrollController.position.pixels;
    final double maxExtent = _scrollController.position.maxScrollExtent;
    _savedScrollPosition = pixels;
    _savedMaxScrollExtent = maxExtent;
    _hasSavedPosition = true;

    // 埋点：记录滚动位置保存事件（包含位置比例便于分析用户浏览深度）
    final double ratio = maxExtent > 0 ? pixels / maxExtent : 0.0;
    print('[ChatScroll] 💾 保存位置: pixels=$pixels, maxExtent=$maxExtent, ratio=${ratio.toStringAsFixed(2)}');
    _logScrollEvent(
      action: 'save',
      pixels: pixels,
      maxExtent: maxExtent,
      scrollRatio: ratio,
      messageCount: widget.messages.length,
    );
  }

  /// ====== 滚动位置保持：恢复之前保存的滚动位置（reverse 模式） ======
  void _restoreOrScrollToBottom() {
    // 重置滚动状态
    _isUserScrollingNotifier.value = false;
    _hasNewAgentMessage = false;

    // 有已保存的位置 → 恢复到离开时的位置（reverse 模式下 pixels 即为距底部距离）
    if (_hasSavedPosition && _savedScrollPosition != null) {
      final double targetPixels = _savedScrollPosition!;
      print('[ChatScroll] 🔄 开始恢复位置: targetPixels=$targetPixels, savedMaxExtent=$_savedMaxScrollExtent');

      // 加锁：防止后续 didUpdateWidget 调用中的自动滚动覆盖恢复位置
      _isRestoringPosition = true;

      // IndexedStack 切换后需要等待布局完成，用双重 postFrameCallback 保证可靠
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!_scrollController.hasClients) {
          print('[ChatScroll] ⚠️ 恢复第1帧: scrollController 无 client');
          return;
        }
        print('[ChatScroll] 📐 恢复第1帧: maxExtent=${_scrollController.position.maxScrollExtent}, pixels=${_scrollController.position.pixels}');

        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!_scrollController.hasClients) {
            print('[ChatScroll] ⚠️ 恢复第2帧: scrollController 无 client');
            _isRestoringPosition = false; // 解锁
            return;
          }
          final double currentMaxExtent = _scrollController.position.maxScrollExtent;
          double restorePixels = targetPixels;

          // clamp 到有效范围
          if (restorePixels > currentMaxExtent) {
            restorePixels = currentMaxExtent;
          }
          if (restorePixels < 0) {
            restorePixels = 0;
          }

          print('[ChatScroll] ✅ 执行 jumpTo: $restorePixels (目标$targetPixels, 当前max=$currentMaxExtent)');
          _scrollController.jumpTo(restorePixels);

          // 埋点：记录恢复事件
          _logScrollEvent(
            action: 'restore',
            pixels: restorePixels,
            savedPixels: targetPixels,
            maxExtent: currentMaxExtent,
            savedMaxExtent: _savedMaxScrollExtent,
            messageCount: widget.messages.length,
          );

          // 解锁：恢复完成，允许后续自动滚动
          _isRestoringPosition = false;
          print('[ChatScroll] 🔓 恢复锁已解除');
        });
      });
      return;
    }

    // 无保存位置（首次进入 / 应用重启后）
    print('[ChatScroll] 🏁 无保存位置，reverse=true 天然在底部');
    // reverse=true 的 ListView 天然从底部开始渲染，无需任何滚动操作
  }

  /// ====== 埋点：记录滚动位置的保存与恢复事件 ======
  void _logScrollEvent({
    required String action,
    double? pixels,
    double? savedPixels,
    double? maxExtent,
    double? savedMaxExtent,
    double? scrollRatio,
    int? messageCount,
  }) {
    // 输出结构化日志供埋点系统采集
    final StringBuffer buf = StringBuffer('[ChatScroll] action=$action');
    if (pixels != null) buf.write(' | pixels=${pixels.toStringAsFixed(1)}');
    if (savedPixels != null) buf.write(' | savedPixels=${savedPixels.toStringAsFixed(1)}');
    if (maxExtent != null) buf.write(' | maxExtent=${maxExtent.toStringAsFixed(1)}');
    if (savedMaxExtent != null) buf.write(' | savedMaxExtent=${savedMaxExtent.toStringAsFixed(1)}');
    if (scrollRatio != null) buf.write(' | scrollRatio=${scrollRatio.toStringAsFixed(3)}');
    if (messageCount != null) buf.write(' | messageCount=$messageCount');
    buf.write(' | timestamp=${DateTime.now().toIso8601String()}');
    debugPrint(buf.toString());
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

  /// 获取反转后的显示消息列表（用于 reverse ListView，使最新消息在 index 0 = 视觉底部）
  List<Map<String, dynamic>> _getReversedDisplayMessages() {
    final List<Map<String, dynamic>> displayMessages = _getDisplayMessages();
    return List<Map<String, dynamic>>.from(displayMessages.reversed);
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
                color: cs.surfaceContainerHighest.withValues(alpha: 0.6),
                borderRadius: BorderRadius.circular(20),
                border: Border.all(
                  color: cs.outline.withValues(alpha: 0.2),
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
    if (live != null && live.isNotEmpty) {
      // 兜底：如果「实时进度」文本和消息列表里最新一条 assistant 回复撞车
      // （模型违反 prompt 把进度句复读进了最终回复），不要把同一行字再渲一份，
      // 直接退化成「正在收尾…」——避免用户看到两份一样的内容同框。
      if (_isLiveStatusDuplicateOfLatestAssistant(live)) {
        return "Agent 正在收尾…";
      }
      return live;
    }
    final String? progress = progressMessage?.text.trim();
    if (progress != null && progress.isNotEmpty) return progress;
    return "Agent 思考中...";
  }

  /// 实时进度是否和最新一条 assistant 回复文本撞车。
  /// 判定：去掉标点/emoji/空白后做子串包含，任一方向包含即视为重复。
  bool _isLiveStatusDuplicateOfLatestAssistant(String live) {
    String normalize(String s) {
      return s
          .toLowerCase()
          .replaceAll(RegExp(r"[\s\.,!?;:\-\u3002\uff0c\uff01\uff1f\u2026\ud83c-\udbff\udc00-\udfff]+"), "");
    }

    final String liveKey = normalize(live);
    if (liveKey.isEmpty) return false;
    for (int i = widget.messages.length - 1; i >= 0; i--) {
      final ChatMessage m = widget.messages[i];
      if (m.role == "user") return false; // 越过所有 assistant 都没撞上
      if (m.role != "assistant") continue;
      final String msgKey = normalize(m.text);
      if (msgKey.isEmpty) continue;
      if (msgKey.contains(liveKey) || liveKey.contains(msgKey)) {
        return true;
      }
      return false; // 最新一条 assistant 不撞，剩下的也无需看
    }
    return false;
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
              color: cs.onSurface.withValues(alpha: 0.08 * _breathingAnimation!.value),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(
                color: cs.onSurface.withValues(alpha: 0.2 * _breathingAnimation!.value),
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
                        color: cs.onSurface.withValues(alpha: 0.6 * _breathingAnimation!.value),
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
      stripMarkdown(message.text),
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
          color: Colors.grey.withValues(alpha: 0.15),
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: Colors.grey.withValues(alpha: 0.3)),
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
  /// 鼠标悬停消息气泡时自动浮现操作按钮栏
  Widget _buildHoverableMessage({
    required ColorScheme cs,
    required ChatMessage mainMessage,
    required bool isUser,
    ContentSummaryParseResult? contentSummary,
  }) {
    // 所有用户消息都可悬停显示操作按钮
    final bool canShowActions = isUser;
    // 选择模式下，只有当前选中范围内的消息参与（触发用户消息 + 其agent回复）
    final bool inSelectableRange = _deleteSelectionMode && _selectedMessageIds.contains(mainMessage.messageId);
    // 当前消息是否为触发了删除模式的用户消息（锁定不可取消）
    final bool isTrigger = mainMessage.messageId == _deleteTriggerMessageId;

    return _HoverableMessageWidget(
      cs: cs,
      mainMessage: mainMessage,
      isUser: isUser,
      contentSummary: contentSummary,
      onDeleteMessage: widget.onDeleteMessage,
      onDeleteFromMessage: widget.onDeleteFromMessage,
      onOpenGomoku: widget.onOpenGomoku,
      onGetRelatedMessageIds: _getRelatedMessageIds,
      cardPadding: _cardPadding,
      // 全局删除选择状态（从 ChatPage 层级传入）
      deleteSelectionMode: _deleteSelectionMode,
      isSelected: _selectedMessageIds.contains(mainMessage.messageId),
      selectedCount: _selectedMessageIds.length,
      canShowActions: canShowActions,
      inSelectableRange: inSelectableRange,
      isTrigger: isTrigger,
      onEnterDeleteMode: _enterDeleteMode,
      onToggleSelection: _toggleMessageSelection,
      onDeleteConfirm: _confirmDeleteSelection,
      onDeleteCancel: _cancelDeleteMode,
    );
  }

  /// 获取与当前消息关联的消息 ID 列表（用户消息+agent回复配对）
  List<String> _getRelatedMessageIds(String messageId) {
    final int idx = widget.messages.indexWhere((ChatMessage m) => m.messageId == messageId);
    if (idx < 0) return [messageId];

    final List<String> ids = <String>[messageId];
    final ChatMessage current = widget.messages[idx];

    // 如果是用户消息，查找紧随其后的 agent 回复
    if (current.role == "user") {
      for (int i = idx + 1; i < widget.messages.length; i++) {
        if (widget.messages[i].role != "user") {
          ids.add(widget.messages[i].messageId);
          break;
        }
      }
    } else {
      // 如果是 agent 消息，查找其前一条用户消息
      for (int i = idx - 1; i >= 0; i--) {
        if (widget.messages[i].role == "user") {
          ids.insert(0, widget.messages[i].messageId);
          break;
        }
      }
    }

    return ids;
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
          color: Theme.of(context).colorScheme.onSurfaceVariant.withValues(alpha: 0.6),
          fontSize: 11,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final bool showLiveThinking =
        widget.isAgentProcessing && _breathingAnimation != null;
    // reverse 模式下使用反转消息列表（最新消息在 index 0 → 视觉底部）
    final List<Map<String, dynamic>> reversedMessages = _getReversedDisplayMessages();
    final int msgCount = reversedMessages.length;
    // reverse ListView 的 item 顺序（index 0 = 底部）：
    //   [thinkingBubble(底), newestMsg, ..., oldestMsg, collapseButton(顶)]
    final int itemCount = msgCount + (showLiveThinking ? 1 : 0) + (_collapsedCount > 0 && !_isCollapsed ? 1 : 0);
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
                              color: cs.onSurfaceVariant.withValues(alpha: 0.3),
                            ),
                            const SizedBox(height: 16),
                            Text(
                              "开始与 AI 助手对话吧！",
                              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                                color: cs.onSurfaceVariant.withValues(alpha: 0.6),
                              ),
                            ),
                            const SizedBox(height: 8),
                            Text(
                              "输入消息或使用语音开始交流",
                              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                                color: cs.onSurfaceVariant.withValues(alpha: 0.4),
                              ),
                            ),
                          ],
                        ),
                      )
                    else
                      ListView.builder(
                  controller: _scrollController,
                  reverse: true, // 从底部开始渲染，首次进入直接显示最新消息
                  padding: _listPadding,
                  cacheExtent: 500,
                  itemCount: itemCount,
                  itemBuilder: (BuildContext context, int index) {
                    // reverse 模式下 index 0 = 视觉底部
                    // 布局：[thinking?(0), msgs(1..msgCount), collapse?(最后)]
                    int offset = 0;

                    // index 0 → 思考中气泡（最底部，在最新消息下方）
                    if (showLiveThinking) {
                      if (index == 0) {
                        return _buildProgressBubble(
                          cs,
                          _processingStatusText(),
                        );
                      }
                      offset = 1;
                    }

                    final int msgIndex = index - offset; // 反转后的消息索引（0 = 最新）

                    // 最后一个位置 → 折叠按钮（最顶部，在历史消息上方）
                    if (showCollapseButton && msgIndex >= msgCount) {
                      return _buildCollapseButton(cs);
                    }

                    // 正常消息
                    final messageGroup = reversedMessages[msgIndex];
                    final bool isUser = messageGroup['isUser'] as bool;
                    final ChatMessage mainMessage = messageGroup['main'] as ChatMessage;
                    final bool isProgress = messageGroup['isProgress'] as bool;
                    final ContentSummaryParseResult? contentSummary = isUser
                        ? null
                        : ContentSummaryParser.parse(mainMessage.text);

                    // 进度消息：特殊渲染
                    if (isProgress) {
                      return _buildProgressBubble(cs, mainMessage.text);
                    }

                    return _buildHoverableMessage(
                      cs: cs,
                      mainMessage: mainMessage,
                      isUser: isUser,
                      contentSummary: contentSummary,
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
                padding: _inputHorizontalPadding,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    // 语音识别状态提示
                    if (_isListening)
                      Container(
                        margin: const EdgeInsets.only(bottom: 6),
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                        decoration: BoxDecoration(
                          color: cs.errorContainer.withValues(alpha: 0.2),
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(
                            color: cs.error.withValues(alpha: 0.5),
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
                        padding: const EdgeInsets.only(bottom: 6),
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
                    // 滚动到底部按钮（用户滑动时显示）—— 使用 ValueListenableBuilder 避免整树重建
                    ValueListenableBuilder<bool>(
                      valueListenable: _isUserScrollingNotifier,
                      builder: (BuildContext context, bool isUserScrolling, Widget? child) {
                        if (!isUserScrolling) return const SizedBox.shrink();
                        return Padding(
                          padding: const EdgeInsets.only(bottom: 6),
                          child: Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
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
                                    _isUserScrollingNotifier.value = false;
                                    _hasNewAgentMessage = false;
                                    _scrollToBottom();
                                  }
                                },
                                backgroundColor: cs.primaryContainer,
                                child: Icon(Icons.arrow_downward, color: cs.onPrimaryContainer),
                              ),
                            ],
                          ),
                        );
                      },
                    ),
                    // 主输入框容器
                    AnimatedBuilder(
                      animation: _breathingAnimation!,
                      builder: (context, child) {
                        return Container(
                          decoration: BoxDecoration(
                            color: cs.surfaceContainerHigh,
                            borderRadius: BorderRadius.circular(28),
                            border: Border.all(
                              color: cs.outline.withValues(
                                alpha: 0.65 + 0.1 * _breathingAnimation!.value,
                              ),
                            ),
                            boxShadow: [
                              BoxShadow(
                                color: Colors.black.withValues(
                                  alpha: 0.02 + 0.02 * _breathingAnimation!.value,
                                ),
                                blurRadius: 20,
                                offset: const Offset(0, 8),
                              ),
                            ],
                          ),
                          child: child,
                        );
                      },
                      child: Padding(
                        padding: _inputPadding,
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
                                    minLines: 1,
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
                                        color: cs.onSurfaceVariant.withValues(alpha: 0.6),
                                        fontSize: 15,
                                      ),
                                      contentPadding: const EdgeInsets.symmetric(horizontal: 8),
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 4),
                                if (widget.onToggleFullComputerAccess != null)
                                  Container(
                                    decoration: BoxDecoration(
                                      color: widget.fullComputerAccessEnabled
                                          ? cs.primary.withValues(alpha: 0.14)
                                          : cs.surfaceContainerLowest,
                                      shape: BoxShape.circle,
                                      border: widget.fullComputerAccessEnabled
                                          ? Border.all(color: cs.primary.withValues(alpha: 0.45))
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
                                        minWidth: 34,
                                        minHeight: 34,
                                      ),
                                    ),
                                  ),
                                if (widget.onToggleFullComputerAccess != null)
                                  const SizedBox(width: 4),
                                // 发送按钮
                                Container(
                                  decoration: BoxDecoration(
                                    color: cs.surfaceContainerLowest,
                                    shape: BoxShape.circle,
                                    border: Border.all(
                                      color: cs.outline.withValues(alpha: 0.8),
                                    ),
                                  ),
                                  child: IconButton(
                                    icon: Icon(Icons.send, size: 20, color: cs.onSurfaceVariant),
                                    onPressed: widget.onSend,
                                    padding: EdgeInsets.zero,
                                    constraints: const BoxConstraints(
                                      minWidth: 34,
                                      minHeight: 34,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                            // 第二行：加号 + 语音按钮 + 呼叫 Agent
                            Padding(
                              padding: const EdgeInsets.only(top: 4),
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
                                          minWidth: 30,
                                          minHeight: 30,
                                        ),
                                      ),
                                    ),
                                  if (widget.onPickGalleryImage != null)
                                    const SizedBox(width: 6),
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
                                        minWidth: 30,
                                        minHeight: 30,
                                      ),
                                      tooltip: '进入语音模式',
                                    ),
                                  ),
                                  const SizedBox(width: 6),
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
                                          minWidth: 30,
                                          minHeight: 30,
                                        ),
                                        tooltip: VirtualPhoneUiLabels.chatTooltip,
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
        color: cs.primaryContainer.withValues(alpha: 0.35),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: cs.primary.withValues(alpha: 0.35)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Icon(Icons.grid_on, size: 18, color: cs.primary),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  "五子棋对局",
                  style: Theme.of(context).textTheme.titleSmall?.copyWith(
                        color: cs.primary,
                        fontWeight: FontWeight.w600,
                      ),
                  overflow: TextOverflow.ellipsis,
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

/// 独立的 StatefulWidget：管理每条消息的 hover 悬停状态，删除选择状态由父级 ChatPage 统一管理
class _HoverableMessageWidget extends StatelessWidget {
  const _HoverableMessageWidget({
    required this.cs,
    required this.mainMessage,
    required this.isUser,
    required this.cardPadding,
    this.contentSummary,
    this.onDeleteMessage,
    this.onDeleteFromMessage,
    this.onOpenGomoku,
    this.onGetRelatedMessageIds,
    // 全局删除选择状态（由 ChatPage 传入）
    required this.deleteSelectionMode,
    required this.isSelected,
    required this.selectedCount,
    /// 是否可显示悬停操作按钮（所有用户消息为 true）
    required this.canShowActions,
    /// 是否在选择模式的可选范围内（触发用户消息 + 其agent回复）
    required this.inSelectableRange,
    /// 是否为触发了删除模式的用户消息（锁定不可取消）
    required this.isTrigger,
    required this.onEnterDeleteMode,
    required this.onToggleSelection,
    required this.onDeleteConfirm,
    required this.onDeleteCancel,
  });

  final ColorScheme cs;
  final ChatMessage mainMessage;
  final bool isUser;
  final EdgeInsets cardPadding;
  final ContentSummaryParseResult? contentSummary;
  final void Function(String messageId)? onDeleteMessage;
  final void Function(String messageId)? onDeleteFromMessage;
  final void Function(String playUrlOrTableId)? onOpenGomoku;
  final List<String> Function(String messageId)? onGetRelatedMessageIds;

  /// 全局删除选择模式是否激活
  final bool deleteSelectionMode;
  /// 当前消息是否被选中
  final bool isSelected;
  /// 当前已选中的消息总数（用于确认栏显示）
  final int selectedCount;
  /// 是否可显示操作按钮
  final bool canShowActions;
  /// 是否在可选择范围内
  final bool inSelectableRange;
  /// 是否为触发的用户消息（锁定）
  final bool isTrigger;
  /// 回调：进入删除选择模式
  final void Function(String messageId) onEnterDeleteMode;
  /// 回调：切换单条消息选中状态
  final void Function(String messageId, bool selected) onToggleSelection;
  /// 回调：确认删除
  final VoidCallback onDeleteConfirm;
  /// 回调：取消删除模式
  final VoidCallback onDeleteCancel;

  @override
  Widget build(BuildContext context) {
    return _HoverableMessageContent(
      cs: cs,
      mainMessage: mainMessage,
      isUser: isUser,
      cardPadding: cardPadding,
      contentSummary: contentSummary,
      onDeleteMessage: onDeleteMessage,
      onDeleteFromMessage: onDeleteFromMessage,
      onOpenGomoku: onOpenGomoku,
      deleteSelectionMode: deleteSelectionMode,
      isSelected: isSelected,
      selectedCount: selectedCount,
      canShowActions: canShowActions,
      inSelectableRange: inSelectableRange,
      isTrigger: isTrigger,
      onEnterDeleteMode: onEnterDeleteMode,
      onToggleSelection: onToggleSelection,
      onDeleteConfirm: onDeleteConfirm,
      onDeleteCancel: onDeleteCancel,
    );
  }
}

/// 实际的 StatefulWidget，仅管理本地 hover 状态
class _HoverableMessageContent extends StatefulWidget {
  const _HoverableMessageContent({
    required this.cs,
    required this.mainMessage,
    required this.isUser,
    required this.cardPadding,
    this.contentSummary,
    this.onDeleteMessage,
    this.onDeleteFromMessage,
    this.onOpenGomoku,
    required this.deleteSelectionMode,
    required this.isSelected,
    required this.selectedCount,
    required this.canShowActions,
    required this.inSelectableRange,
    required this.isTrigger,
    required this.onEnterDeleteMode,
    required this.onToggleSelection,
    required this.onDeleteConfirm,
    required this.onDeleteCancel,
  });

  final ColorScheme cs;
  final ChatMessage mainMessage;
  final bool isUser;
  final EdgeInsets cardPadding;
  final ContentSummaryParseResult? contentSummary;
  final void Function(String messageId)? onDeleteMessage;
  final void Function(String messageId)? onDeleteFromMessage;
  final void Function(String playUrlOrTableId)? onOpenGomoku;
  final bool deleteSelectionMode;
  final bool isSelected;
  final int selectedCount;
  final bool canShowActions;
  final bool inSelectableRange;
  final bool isTrigger;
  final void Function(String messageId) onEnterDeleteMode;
  final void Function(String messageId, bool selected) onToggleSelection;
  final VoidCallback onDeleteConfirm;
  final VoidCallback onDeleteCancel;

  @override
  State<_HoverableMessageContent> createState() => _HoverableMessageContentState();
}

class _HoverableMessageContentState extends State<_HoverableMessageContent> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) {
        if (!widget.deleteSelectionMode) setState(() => _hovered = false);
      },
      cursor: SystemMouseCursors.basic,
      child: Stack(
        clipBehavior: Clip.none,
        children: <Widget>[
          // 原始消息卡片
          RepaintBoundary(
            child: Align(
              alignment:
                  widget.isUser ? Alignment.centerRight : Alignment.centerLeft,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment:
                    widget.isUser ? CrossAxisAlignment.end : CrossAxisAlignment.start,
                children: [
                  // 删除选择模式：左侧勾选 + 高亮内容（仅当前配对范围内的消息参与）
                  if (widget.inSelectableRange)
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Padding(
                          padding: const EdgeInsets.only(top: 12, right: 8),
                          child: Checkbox(
                            value: widget.isSelected,
                            // 触发删除的用户消息不可取消勾选
                            onChanged: widget.isTrigger ? null : (bool? v) {
                              widget.onToggleSelection(widget.mainMessage.messageId, v ?? true);
                            },
                          ),
                        ),
                        Flexible(child: _buildMessageCard(context, highlight: widget.isSelected)),
                      ],
                    )
                  else
                    _buildMessageCard(context),
                  _buildTimestampInner(widget.mainMessage, widget.isUser, context),
                ],
              ),
            ),
          ),
          // 悬停时浮现操作按钮栏（所有用户消息，非选择模式下，透明背景）
          if (_hovered && !widget.deleteSelectionMode && widget.canShowActions &&
              widget.onDeleteMessage != null &&
              widget.onDeleteFromMessage != null)
            Positioned(
              left: 0,
              right: 0,
              top: 0,
              bottom: -48,
              child: Align(
                alignment: widget.isUser ? Alignment.centerRight : Alignment.centerLeft,
                child: Padding(
                  padding: EdgeInsets.only(right: widget.isUser ? 60 : 0),
                  child: _MessageActionBar(
                  messageText: widget.mainMessage.text,
                  messageId: widget.mainMessage.messageId,
                  onCopy: () async {
                    await _copyMessage(context, widget.mainMessage.text, widget.mainMessage.messageId);
                  },
                  onEdit: () async {
                    await _editMessage(context, widget.mainMessage.messageId, widget.mainMessage.text);
                  },
                  onDeletePressed: () {
                    widget.onEnterDeleteMode(widget.mainMessage.messageId);
                  },
                ),
                ),
              ),
            ),
          // 删除选择模式下的确认/取消按钮栏（仅在触发删除的用户消息下方显示）
          if (widget.deleteSelectionMode && widget.isTrigger)
            Positioned(
              left: 0,
              right: 0,
              top: 0,
              bottom: -56,
              child: Align(
                alignment: widget.isUser ? Alignment.centerRight : Alignment.centerLeft,
                child: Padding(
                  padding: EdgeInsets.only(right: widget.isUser ? 60 : 0),
                  child: _DeleteConfirmBar(
                  selectedCount: widget.selectedCount,
                  isCurrentSelected: widget.isSelected,
                  onToggleSelect: (v) {
                    widget.onToggleSelection(widget.mainMessage.messageId, v);
                  },
                  onConfirm: widget.onDeleteConfirm,
                  onCancel: widget.onDeleteCancel,
                ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  /// 复制消息：调用后端审计接口 + 写入剪贴板
  static Future<void> _copyMessage(BuildContext context, String text, String messageId) async {
    try {
      final Uri uri = Uri.parse("${ApiConfig.httpBase}/chat/message/copy");
      final Map<String, dynamic> requestBody = <String, dynamic>{
        "sessionId": ApiConfig.sessionId,
        "userId": ApiConfig.userId.trim().isEmpty ? null : ApiConfig.userId.trim(),
        "messageId": messageId,
        "text": text,
      };
      final http.Response response = await http.post(
        uri,
        headers: <String, String>{"Content-Type": "application/json"},
        body: jsonEncode(requestBody),
      );
      if (response.statusCode == 200) {
        await Clipboard.setData(ClipboardData(text: text));
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text("已复制到剪贴板"), duration: Duration(seconds: 1)),
          );
        }
      } else {
        // 后端校验失败时仍写入剪贴板（降级体验）
        await Clipboard.setData(ClipboardData(text: text));
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text("已复制到剪贴板"), duration: Duration(seconds: 1)),
          );
        }
      }
    } catch (_) {
      // 网络异常时直接复制文本
      await Clipboard.setData(ClipboardData(text: text));
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text("已复制到剪贴板"), duration: Duration(seconds: 1)),
        );
      }
    }
  }

  /// 编辑消息：弹出编辑对话框 → 用户确认后调用后端编辑 API 触发 Agent 重答
  static Future<void> _editMessage(BuildContext context, String messageId, String originalText) async {
    final TextEditingController editController = TextEditingController(text: originalText);
    final String? result = await showDialog<String>(
      context: context,
      builder: (BuildContext dialogContext) {
        return AlertDialog(
          title: const Text("编辑消息"),
          content: TextField(
            controller: editController,
            maxLines: null,
            autofocus: true,
            decoration: const InputDecoration(
              hintText: "修改消息内容…",
              border: OutlineInputBorder(),
            ),
          ),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(null),
              child: const Text("取消"),
            ),
            FilledButton(
              onPressed: () {
                final String newText = editController.text.trim();
                if (newText.isEmpty || newText == originalText) {
                  Navigator.of(dialogContext).pop(null);
                  return;
                }
                Navigator.of(dialogContext).pop(newText);
              },
              child: const Text("发送"),
            ),
          ],
        );
      },
    );

    editController.dispose();

    // 用户取消或未修改
    if (result == null || result.isEmpty) return;

    try {
      final Uri uri = Uri.parse("${ApiConfig.httpBase}/chat/message/edit");
      final Map<String, dynamic> requestBody = <String, dynamic>{
        "sessionId": ApiConfig.sessionId,
        "userId": ApiConfig.userId.trim().isEmpty ? null : ApiConfig.userId.trim(),
        "messageId": messageId,
        "newText": result,
      };
      final http.Response response = await http.post(
        uri,
        headers: <String, String>{"Content-Type": "application/json"},
        body: jsonEncode(requestBody),
      );
      if (response.statusCode == 200) {
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text("消息已编辑，Agent 正在重新回复…"), duration: Duration(seconds: 2)),
          );
        }
      } else {
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text("编辑失败，请保持聊天页在前台后重试"), duration: Duration(seconds: 2)),
          );
        }
      }
    } catch (_) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text("网络错误，无法连接服务器"), duration: Duration(seconds: 2)),
        );
      }
    }
  }

  /// 构建消息卡片（支持高亮态）
  Widget _buildMessageCard(BuildContext context, {bool highlight = false}) {
    return Card(
      clipBehavior: Clip.antiAlias,
      color: highlight
          ? Colors.red.withValues(alpha: 0.06)
          : (widget.isUser
              ? const Color(0xFF007AFF)
              : widget.cs.surfaceContainerLowest),
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(
          color: highlight
              ? Colors.red.withValues(alpha: 0.35)
              : (widget.isUser
                  ? const Color(0xFF007AFF)
                  : widget.cs.outline.withValues(alpha: 0.6)),
        ),
      ),
      child: Padding(
        padding: widget.cardPadding,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            if (widget.mainMessage.attachmentImageCount > 0)
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
                      "配图 ×${widget.mainMessage.attachmentImageCount}",
                      style: Theme.of(context)
                          .textTheme
                          .labelSmall
                          ?.copyWith(
                            color: Theme.of(context)
                                .colorScheme
                                .primary,
                          ),
                    ),
                  ],
                ),
              ),
            // 消息正文
            _buildMessageTextInner(
              context,
              widget.cs,
              widget.mainMessage,
              isUser: widget.isUser,
              contentSummary: widget.contentSummary,
            ),
            if (!widget.isUser &&
                widget.contentSummary?.summary == null &&
                widget.mainMessage.text.contains(RegExp(r'https?://\S+')))
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: _buildGrayLinksInner(widget.mainMessage.text, context),
              ),
            if (!widget.isUser && widget.mainMessage.playUrl != null && widget.mainMessage.playUrl!.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 10),
                child: _GomokuPlayUrlCard(
                  playUrl: widget.mainMessage.playUrl!,
                  onOpen: widget.onOpenGomoku,
                ),
              ),
          ],
        ),
      ),
    );
  }

  /// 从父级 _ChatPageState 复用的消息文本构建（静态方法避免依赖实例）
  static Widget _buildMessageTextInner(
    BuildContext context,
    ColorScheme cs,
    ChatMessage message, {
    required bool isUser,
    ContentSummaryParseResult? contentSummary,
  }) {
    if (isUser) {
      return Text(
        message.text,
        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
              color: isUser ? cs.onPrimary : cs.onSurface,
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
      stripMarkdown(message.text),
      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
            color: cs.onSurface,
          ),
    );
  }

  /// 构建灰色链接显示组件（从父级复用）
  static Widget _buildGrayLinksInner(String text, BuildContext context) {
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
          color: Colors.grey.withValues(alpha: 0.15),
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: Colors.grey.withValues(alpha: 0.3)),
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

  /// 构建消息时间戳（从父级复用）
  static Widget _buildTimestampInner(ChatMessage message, bool isUser, BuildContext context) {
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
          color: Theme.of(context).colorScheme.onSurfaceVariant.withValues(alpha: 0.6),
          fontSize: 11,
        ),
      ),
    );
  }
}

/// 消息下方悬浮操作按钮栏（复制 / 编辑 / 删除）—— 透明背景
class _MessageActionBar extends StatelessWidget {
  const _MessageActionBar({
    required this.messageText,
    required this.messageId,
    required this.onCopy,
    required this.onEdit,
    required this.onDeletePressed,
  });

  final String messageText;
  final String messageId;
  final VoidCallback onCopy;
  final VoidCallback onEdit;
  final VoidCallback onDeletePressed;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        _ActionButton(
          icon: Icons.content_copy_outlined,
          tooltip: "复制",
          onPressed: onCopy,
        ),
        _ActionButton(
          icon: Icons.edit_outlined,
          tooltip: "编辑",
          onPressed: onEdit,
        ),
        _ActionButton(
          icon: Icons.delete_outline,
          tooltip: "删除",
          iconColor: Colors.red[400],
          onPressed: onDeletePressed,
        ),
      ],
    );
  }
}

/// 删除选择模式下的确认/取消按钮栏
class _DeleteConfirmBar extends StatelessWidget {
  const _DeleteConfirmBar({
    required this.selectedCount,
    required this.isCurrentSelected,
    required this.onToggleSelect,
    required this.onConfirm,
    required this.onCancel,
  });

  final int selectedCount;
  final bool isCurrentSelected;
  final ValueChanged<bool> onToggleSelect;
  final VoidCallback onConfirm;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        // 勾选当前消息 + 显示已选数量
        GestureDetector(
          onTap: () => onToggleSelect(!isCurrentSelected),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Icon(
                  isCurrentSelected ? Icons.check_box : Icons.check_box_outline_blank,
                  size: 16,
                  color: isCurrentSelected ? Colors.red[400] : cs.onSurfaceVariant,
                ),
                const SizedBox(width: 4),
                Text(
                  isCurrentSelected ? "已选择 ($selectedCount条)" : "取消选择",
                  style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(width: 8),
        // 取消按钮
        _ActionButton(
          icon: Icons.close,
          tooltip: "取消",
          onPressed: onCancel,
        ),
        const SizedBox(width: 2),
        // 确认删除按钮
        GestureDetector(
          onTap: isCurrentSelected ? onConfirm : null,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
            decoration: BoxDecoration(
              color: isCurrentSelected ? Colors.red : cs.surfaceContainerHighest.withValues(alpha: 0.5),
              borderRadius: BorderRadius.circular(14),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Icon(Icons.delete_outline, size: 15, color: isCurrentSelected ? Colors.white : cs.onSurfaceVariant.withValues(alpha: 0.4)),
                const SizedBox(width: 4),
                Text(
                  "删除",
                  style: TextStyle(
                    fontSize: 12,
                    color: isCurrentSelected ? Colors.white : cs.onSurfaceVariant.withValues(alpha: 0.4),
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

/// 操作栏中的单个图标按钮（透明背景）
class _ActionButton extends StatelessWidget {
  const _ActionButton({
    required this.icon,
    required this.tooltip,
    required this.onPressed,
    this.iconColor,
  });

  final IconData icon;
  final String tooltip;
  final VoidCallback onPressed;
  final Color? iconColor;

  @override
  Widget build(BuildContext context) {
    final Color defaultColor = Theme.of(context).colorScheme.onSurfaceVariant;
    return IconButton(
      tooltip: tooltip,
      icon: Icon(icon, size: 17, color: iconColor ?? defaultColor),
      visualDensity: VisualDensity.compact,
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
      constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
      style: ButtonStyle(
        backgroundColor: WidgetStateProperty.all<Color>(Colors.transparent),
        overlayColor: WidgetStateProperty.all<Color>(Colors.black.withValues(alpha: 0.05)),
      ),
      onPressed: onPressed,
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
        Colors.grey.withValues(alpha: opacity * 0.4),  // 中间浅色（灰色）
        Colors.grey.withValues(alpha: opacity * 0.6),   // 中间过渡
        Colors.grey.withValues(alpha: opacity * 0.9),   // 外边深色
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
