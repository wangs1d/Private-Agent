import "package:flutter/foundation.dart"
    show defaultTargetPlatform, kIsWeb, TargetPlatform;
import "package:flutter/material.dart";
import "package:flutter/services.dart";
import "dart:async";

import "../../core/models/chat_models.dart";
import "../../core/models/turn_state.dart";
import "../../core/presentation/agent_avatar_catalog.dart";
import "../../core/presentation/voice_call_ui_labels.dart";
import "../../core/utils/agent_result_parser.dart";
import "../../core/utils/content_summary_parser.dart";
import "../../core/utils/markdown_strip.dart";
import "../../core/services/speech_service.dart";
import "../../core/services/agent_profile_overlay_launcher.dart";
import "agent_profile_page.dart";
import "agent_result_card.dart";
import "agent_action_choice_card.dart";
import "content_summary_card.dart";
import "content_summary_detail_modal.dart";
import "structured_assistant_message_body.dart";
import "voice_message_bubble.dart";

/// 输入框内图标按钮的视觉强度
/// - muted：默认（onSurfaceVariant 色），用于次要功能
/// - primary：主色 + 弱容器背景，用于需要被一眼找到的入口
enum InputIconTone { muted, primary }

class ChatPage extends StatefulWidget {
  const ChatPage({
    super.key,
    required this.messages,
    required this.controller,
    required this.onSend,
    this.agentName,
    this.agentAvatarUrl,
    this.agentMoodStyle,
    this.agentAvatarPreset,
    this.agentProfile,
    this.onOpenAgentProfile,
    this.galleryPendingCount = 0,
    this.onPickGalleryImage,
    this.onClearGalleryImages,
    this.onEnterVoiceMode,
    this.isAgentProcessing = false,
    this.agentStatusLine,

    /// 「分阶段异步对话交互」阶段一文本：在多步/工具型请求开始时显示的
    /// 即时确认应答（如「好的，让我查一下…」），real chunk 抵达后由父组件清空。
    this.interimAckText,

    /// 「分阶段异步对话交互 v2」结构化状态：null 时退回 v1 思考气泡。
    this.turnState,
    this.onOpenPhoneDialer,
    this.inputFocusNode,
    this.isActive = true,

    /// 删除单条消息的回调（传入 messageId）
    this.onDeleteMessage,

    /// 删除从某条消息起之后所有消息的回调（传入 messageId）
    this.onDeleteFromMessage,

    /// 停止当前 agent 处理（由输入框的发送按钮在处理中态触发）
    this.onStopAgent,

    /// 「选择型卡片」按钮点击回调(可选;null 时仅在 UI 上锁定按钮)
    this.onUserAction,
  });

  final List<ChatMessage> messages;
  final TextEditingController controller;
  final FocusNode? inputFocusNode;
  final VoidCallback onSend;

  /// 用户在「选择型卡片」底部按钮上点击某个 action 的回调。
  /// 父级负责把 action 转成 user message 并发送到后端。
  /// 传 null 时,卡片按钮点击仅在 UI 上锁定,不会触发任何副作用(调试用)。
  /// 回调会携带触发该按钮的卡片 [cardData](含 cardId/title/items),
  /// 供后端做精准审计/埋点,并让 Agent 理解上下文主动衔接。
  final void Function(AgentResultAction action,
      {required AgentResultData cardData})? onUserAction;

  /// 用户给agent起的名字
  final String? agentName;
  final String? agentAvatarUrl;
  final String? agentMoodStyle;
  final String? agentAvatarPreset;
  final AgentProfileData? agentProfile;
  final void Function(GlobalKey avatarKey)? onOpenAgentProfile;

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

  /// `chat.assistant_interim` 推送的即时确认应答（生命周期更短：real chunk 一到就清空）
  final String? interimAckText;

  /// 「分阶段异步对话交互 v2」结构化状态机；null 表示 v1 链路
  final TurnState? turnState;

  /// 呼叫 Agent（App 内无需另输 6 位联络号）
  final VoidCallback? onOpenPhoneDialer;

  /// 当前 Tab 是否激活（用于检测从其他 Tab 切回对话页）
  final bool isActive;

  /// 删除单条消息
  final void Function(String messageId)? onDeleteMessage;

  /// 删除从某条消息起之后所有消息
  final void Function(String messageId)? onDeleteFromMessage;

  /// 停止当前 agent 处理（由输入框的发送按钮在处理中态触发）
  final VoidCallback? onStopAgent;

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage>
    with SingleTickerProviderStateMixin {
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
      final int idx =
          widget.messages.indexWhere((ChatMessage m) => m.messageId == mid);
      if (idx >= 0) {
        sorted.add(MapEntry<int, String>(idx, mid));
      }
    }
    sorted.sort((MapEntry<int, String> a, MapEntry<int, String> b) =>
        b.key.compareTo(a.key));

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
  final ValueNotifier<bool> _isUserScrollingNotifier =
      ValueNotifier<bool>(false);
  bool _hasNewAgentMessage = false;
  AnimationController? _breathingController;
  Animation<double>? _breathingAnimation;

  bool _hasHadMessages = false; // 是否已经加载过消息（用于区分初始加载和后续新消息）

  /// ====== 滚动位置保持相关 ======
  bool _isTabActive = false; // 当前是否在对话 Tab 上（用于屏蔽非活跃时的自动滚动）
  // 在 initState 中从 widget.isActive 同步初始值
  double? _savedScrollPosition; // 离开时保存的滚动像素位置
  double? _savedMaxScrollExtent; // 离开时的最大可滚动距离
  bool _hasSavedPosition = false; // 是否有已保存的有效位置可供恢复
  // （应用重启后自然重置为 false → 滚到底部）
  bool _isRestoringPosition = false; // 恢复锁：正在恢复位置时阻止所有自动滚动

  // 预定义常量 - 减少重复创建对象
  static const EdgeInsets _listPadding =
      EdgeInsets.symmetric(horizontal: 12, vertical: 4);
  static const EdgeInsets _cardPadding = EdgeInsets.all(7);
  static const EdgeInsets _inputHorizontalPadding =
      EdgeInsets.symmetric(horizontal: 4, vertical: 6);

  @override
  void initState() {
    super.initState();
    // Windows SAPI 在启动阶段预初始化会触发原生崩溃 (0xC0000409)，改为用户点麦克风时按需初始化
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.windows) {
      _speechService.initialize();
    }
    // 初始化呼吸动画：agent 工作中输入框的白色光晕靠这个 0~1 的脉动驱动，
    // 周期压到 1.6s 让呼吸感更明显。
    _breathingController = AnimationController(
      duration: const Duration(milliseconds: 1600),
      vsync: this,
    )..repeat(reverse: true);
    _breathingAnimation = Tween<double>(
      begin: 0.0,
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
    // reverse 模式下：pixels=0 是底部（最新消息），pixels 越大越靠近顶部（最旧消息）
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

    // ====== 优先处理 Tab 切换（离开 / 进入） ======
    final bool wasActive = _isTabActive;
    final bool nowActive = widget.isActive;

    // 离开对话 Tab → 保存位置
    if (wasActive && !nowActive) {
      print(
          '[ChatScroll] 👋 离开对话Tab: wasActive=$wasActive → nowActive=$nowActive');
      _isTabActive = false;
      _saveScrollPosition();
      return; // 离开后不再处理消息相关滚动
    }

    // 进入（或切回）对话 Tab → 恢复位置或滚到底部
    if (!wasActive && nowActive) {
      print(
          '[ChatScroll] 🏠 进入对话Tab: wasActive=$wasActive → nowActive=$nowActive, hasSaved=$_hasSavedPosition, savedPixels=$_savedScrollPosition');
      _isTabActive = true;
      _restoreOrScrollToBottom();
      return; // 刚进入时跳过后续消息增量滚动逻辑
    }

    // ====== 以下逻辑仅在活跃状态下执行（防止非活跃时被新消息覆盖位置） ======
    if (!_isTabActive) return;

    // 恢复锁：正在恢复位置时，跳过所有自动滚动逻辑，防止被后续 didUpdateWidget 调用覆盖
    if (_isRestoringPosition) {
      print(
          '[ChatScroll] ⛔ 恢复锁生效：跳过自动滚动 (messages=${widget.messages.length}, old=${oldWidget.messages.length})');
      return;
    }

    // 消息数量未变化时，检查是否需要因流式更新而滚动
    final bool messagesUnchanged =
        widget.messages.length == oldWidget.messages.length;
    if (messagesUnchanged) {
      // Agent 正在流式输出（消息文本在增长），且用户没有主动上滑 → 跟踪到底部
      if (widget.isAgentProcessing && !_isUserScrollingNotifier.value) {
        WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());
      }
      return;
    }

    // 检测是否有新的用户消息
    final bool hasNewUserMessage =
        widget.messages.length > oldWidget.messages.length &&
            widget.messages.isNotEmpty &&
            widget.messages.last.role == "user";

    // 用户发送消息时，无论是否在滑动，都自动滚动到底部
    if (hasNewUserMessage) {
      _isUserScrollingNotifier.value = false;
      _hasNewAgentMessage = false;
      WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());
      return;
    }

    // 检测是否有新的 agent 消息
    final bool hasNewAgentMessage =
        widget.messages.length > oldWidget.messages.length &&
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

      WidgetsBinding.instance
          .addPostFrameCallback((_) => _scrollToBottom(instant: isFirstLoad));
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
    print(
        '[ChatScroll] 💾 保存位置: pixels=$pixels, maxExtent=$maxExtent, ratio=${ratio.toStringAsFixed(2)}');
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
      print(
          '[ChatScroll] 🔄 开始恢复位置: targetPixels=$targetPixels, savedMaxExtent=$_savedMaxScrollExtent');

      // 加锁：防止后续 didUpdateWidget 调用中的自动滚动覆盖恢复位置
      _isRestoringPosition = true;

      // IndexedStack 切换后需要等待布局完成，用双重 postFrameCallback 保证可靠
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!_scrollController.hasClients) {
          print('[ChatScroll] ⚠️ 恢复第1帧: scrollController 无 client');
          return;
        }
        print(
            '[ChatScroll] 📐 恢复第1帧: maxExtent=${_scrollController.position.maxScrollExtent}, pixels=${_scrollController.position.pixels}');

        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!_scrollController.hasClients) {
            print('[ChatScroll] ⚠️ 恢复第2帧: scrollController 无 client');
            _isRestoringPosition = false; // 解锁
            return;
          }
          final double currentMaxExtent =
              _scrollController.position.maxScrollExtent;
          double restorePixels = targetPixels;

          // clamp 到有效范围
          if (restorePixels > currentMaxExtent) {
            restorePixels = currentMaxExtent;
          }
          if (restorePixels < 0) {
            restorePixels = 0;
          }

          print(
              '[ChatScroll] ✅ 执行 jumpTo: $restorePixels (目标$targetPixels, 当前max=$currentMaxExtent)');
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
    if (savedPixels != null)
      buf.write(' | savedPixels=${savedPixels.toStringAsFixed(1)}');
    if (maxExtent != null)
      buf.write(' | maxExtent=${maxExtent.toStringAsFixed(1)}');
    if (savedMaxExtent != null)
      buf.write(' | savedMaxExtent=${savedMaxExtent.toStringAsFixed(1)}');
    if (scrollRatio != null)
      buf.write(' | scrollRatio=${scrollRatio.toStringAsFixed(3)}');
    if (messageCount != null) buf.write(' | messageCount=$messageCount');
    buf.write(' | timestamp=${DateTime.now().toIso8601String()}');
    debugPrint(buf.toString());
  }

  /// 按时间倒序生成所有消息的渲染项列表（最新在 reverse ListView 的 index 0）。
  List<Map<String, dynamic>> _getRenderItems() {
    final List<ChatMessage> sorted = List<ChatMessage>.from(widget.messages)
      ..sort(
          (ChatMessage a, ChatMessage b) => b.timestamp.compareTo(a.timestamp));
    return sorted.map(_messageToGroup).toList();
  }

  /// 处理中气泡文案：`agent_status` > 即时确认应答（interim ack）> 历史流程提示 > 默认
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
    // 「分阶段异步对话交互」阶段一：实时 agent_status 还没到时，
    // 先用服务端推送的即时确认应答顶上（如「好的，让我查一下…」）。
    final String? interim = widget.interimAckText?.trim();
    if (interim != null && interim.isNotEmpty) {
      return interim;
    }
    final String? progress = progressMessage?.text.trim();
    if (progress != null && progress.isNotEmpty) return progress;
    return "Agent 思考中...";
  }

  /// 实时进度是否和最新一条 assistant 回复文本撞车。
  /// 判定：去掉标点/emoji/空白后做子串包含，任一方向包含即视为重复。
  bool _isLiveStatusDuplicateOfLatestAssistant(String live) {
    String normalize(String s) {
      return s.toLowerCase().replaceAll(
          RegExp(
              r"[\s\.,!?;:\-\u3002\uff0c\uff01\uff1f\u2026\ud83c-\udbff\udc00-\udfff]+"),
          "");
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

  // ═══════════════════════════════════════════════════════════
  // 发送按钮（常显，有内容时高亮可点击）
  // ═══════════════════════════════════════════════════════════
  Widget _buildSendButton(ColorScheme cs) {
    return ValueListenableBuilder<TextEditingValue>(
      valueListenable: widget.controller,
      builder: (_, TextEditingValue value, __) {
        final bool canSend = value.text.trim().isNotEmpty;
        return Container(
          key: const ValueKey('input-send-btn'),
          decoration: BoxDecoration(
            color: canSend
                ? cs.primary
                : cs.surfaceContainerHighest.withValues(alpha: 0.8),
            shape: BoxShape.circle,
          ),
          child: IconButton(
            icon: Icon(
              Icons.send_rounded,
              size: 18,
              color: canSend ? cs.onPrimary : cs.onSurfaceVariant,
            ),
            tooltip: "发送",
            onPressed: canSend
                ? () {
                    if (widget.controller.text.trim().isNotEmpty) {
                      widget.onSend();
                    }
                  }
                : null,
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints.tightFor(
              width: 34,
              height: 34,
            ),
            splashRadius: 16,
          ),
        );
      },
    );
  }

  // ═══════════════════════════════════════════════════════════
  // 停止按钮（agent 处理中显示）
  // ═══════════════════════════════════════════════════════════
  Widget _buildStopButton(ColorScheme cs) {
    return Container(
      key: const ValueKey('input-stop-btn'),
      decoration: BoxDecoration(
        color: cs.errorContainer.withValues(alpha: 0.4),
        shape: BoxShape.circle,
        border: Border.all(
          color: cs.error.withValues(alpha: 0.5),
        ),
      ),
      child: IconButton(
        icon: Icon(
          Icons.stop_rounded,
          size: 16,
          color: cs.error,
        ),
        tooltip: "停止",
        onPressed: widget.onStopAgent,
        padding: EdgeInsets.zero,
        constraints: const BoxConstraints.tightFor(
          width: 34,
          height: 34,
        ),
        splashRadius: 16,
      ),
    );
  }

  // ═══════════════════════════════════════════════════════════
  // 输入框内统一的图标按钮样式
  // ═══════════════════════════════════════════════════════════
  Widget _buildInputIconButton({
    required IconData icon,
    required String tooltip,
    required VoidCallback? onTap,
    required ColorScheme cs,
    double size = 20,
    InputIconTone tone = InputIconTone.muted,
  }) {
    final Color iconColor = switch (tone) {
      InputIconTone.muted => cs.onSurfaceVariant,
      InputIconTone.primary => cs.primary,
    };
    return Tooltip(
      message: tooltip,
      child: Material(
        color: tone == InputIconTone.primary
            ? cs.primaryContainer.withValues(alpha: 0.55)
            : Colors.transparent,
        borderRadius: BorderRadius.circular(10),
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: onTap,
          child: SizedBox(
            width: 32,
            height: 32,
            child: Icon(
              icon,
              size: size,
              color: iconColor,
            ),
          ),
        ),
      ),
    );
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
              color: cs.onSurface
                  .withValues(alpha: 0.08 * _breathingAnimation!.value),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(
                color: cs.onSurface
                    .withValues(alpha: 0.2 * _breathingAnimation!.value),
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
                        color: cs.onSurface.withValues(
                            alpha: 0.6 * _breathingAnimation!.value),
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

  void _showAgentProfilePopover(GlobalKey avatarKey) {
    if (widget.agentProfile == null) return;

    final RenderBox? renderBox =
        avatarKey.currentContext?.findRenderObject() as RenderBox?;
    if (renderBox == null) return;

    final Offset position = renderBox.localToGlobal(Offset.zero);
    final Size size = renderBox.size;

    AgentProfileOverlayLauncher.bindHandlers();

    unawaited(AgentProfileOverlayLauncher.show(
      x: (position.dx + size.width + 10).round(),
      y: position.dy.round(),
      profile: widget.agentProfile!,
    ));
  }

  /// 鼠标悬停消息气泡时自动浮现操作按钮栏
  Widget _buildHoverableMessage({
    required ColorScheme cs,
    required ChatMessage mainMessage,
    required bool isUser,
    ContentSummaryParseResult? contentSummary,
  }) {
    // 选择模式下，只有当前选中范围内的消息参与（触发用户消息 + 其agent回复）
    final bool inSelectableRange = _deleteSelectionMode &&
        _selectedMessageIds.contains(mainMessage.messageId);
    // 当前消息是否为触发了删除模式的用户消息（锁定不可取消）
    final bool isTrigger = mainMessage.messageId == _deleteTriggerMessageId;

    return _HoverableMessageWidget(
      cs: cs,
      mainMessage: mainMessage,
      isUser: isUser,
      contentSummary: contentSummary,
      agentName: widget.agentName,
      agentAvatarUrl: widget.agentAvatarUrl,
      agentMoodStyle: widget.agentMoodStyle,
      agentAvatarPreset: widget.agentAvatarPreset,
      onOpenAgentProfile: _showAgentProfilePopover,
      onDeleteMessage: widget.onDeleteMessage,
      onDeleteFromMessage: widget.onDeleteFromMessage,
      onGetRelatedMessageIds: _getRelatedMessageIds,
      cardPadding: _cardPadding,
      // 全局删除选择状态（从 ChatPage 层级传入）
      deleteSelectionMode: _deleteSelectionMode,
      isSelected: _selectedMessageIds.contains(mainMessage.messageId),
      selectedCount: _selectedMessageIds.length,
      inSelectableRange: inSelectableRange,
      isTrigger: isTrigger,
      onEnterDeleteMode: _enterDeleteMode,
      onToggleSelection: _toggleMessageSelection,
      onDeleteConfirm: _confirmDeleteSelection,
      onDeleteCancel: _cancelDeleteMode,
      onUserAction: widget.onUserAction,
    );
  }

  /// 获取与当前消息关联的消息 ID 列表（用户消息+agent回复配对）
  List<String> _getRelatedMessageIds(String messageId) {
    final int idx =
        widget.messages.indexWhere((ChatMessage m) => m.messageId == messageId);
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

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    // 渲染项列表：按 reverse ListView 顺序（index 0 = 视觉底部 = 最新消息），
    // 直接渲染所有消息，不做任何折叠/分桶。
    final List<Map<String, dynamic>> renderItems = _getRenderItems();
    final int itemCount = renderItems.length;

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
                      // reverse 模式下 index 0 = 视觉底部（最新消息）
                      final Map<String, dynamic> messageGroup =
                          renderItems[index];
                      final bool isUser = messageGroup['isUser'] as bool;
                      final ChatMessage mainMessage =
                          messageGroup['main'] as ChatMessage;
                      final bool isProgress =
                          messageGroup['isProgress'] as bool;
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
                        padding: const EdgeInsets.symmetric(
                            horizontal: 12, vertical: 8),
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
                                valueColor:
                                    AlwaysStoppedAnimation<Color>(cs.error),
                              ),
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                _recognizedText.isNotEmpty
                                    ? "正在识别: $_recognizedText"
                                    : "正在聆听...",
                                style: Theme.of(context)
                                    .textTheme
                                    .labelMedium
                                    ?.copyWith(
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
                                style: Theme.of(context)
                                    .textTheme
                                    .labelMedium
                                    ?.copyWith(
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
                      builder: (BuildContext context, bool isUserScrolling,
                          Widget? child) {
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
                                child: Icon(Icons.arrow_downward,
                                    color: cs.onPrimaryContainer),
                              ),
                            ],
                          ),
                        );
                      },
                    ),
                    const SizedBox(height: 8),
                    // 主输入框容器
                    // - agent 工作中：边框附上白色呼吸灯光晕（boxShadow + 边框色同步脉动）
                    // - 空闲时：维持原本的浅灰描边 + 柔和投影
                    AnimatedBuilder(
                      animation: _breathingAnimation!,
                      builder: (context, child) {
                        final double breath = _breathingAnimation!.value;
                        final bool busy = widget.isAgentProcessing;
                        // 0~1 的呼吸强度，busy 时拉到 0.6~1.0，空闲时 0~0.25
                        final double pulse =
                            busy ? (0.6 + 0.4 * breath) : (0.05 + 0.2 * breath);
                        return Container(
                          decoration: BoxDecoration(
                            color: cs.surface,
                            borderRadius: BorderRadius.circular(20),
                            // 外层描边：busy 强白光，idle 弱白光，随呼吸脉动
                            border: Border.all(
                              color: Colors.white
                                  .withValues(alpha: 0.15 + 0.45 * pulse),
                              width: 0.8 + 0.6 * pulse,
                            ),
                            boxShadow: <BoxShadow>[
                              if (busy) ...<BoxShadow>[
                                // 外圈白色光晕（主呼吸）
                                BoxShadow(
                                  color: Colors.white
                                      .withValues(alpha: 0.18 * pulse),
                                  blurRadius: 14 + 10 * breath,
                                  spreadRadius: 0.5 + 1.5 * breath,
                                ),
                                // 内圈近场白雾
                                BoxShadow(
                                  color: Colors.white
                                      .withValues(alpha: 0.28 * breath),
                                  blurRadius: 4,
                                ),
                              ] else ...<BoxShadow>[
                                // 柔和投影，更轻盈
                                BoxShadow(
                                  color: Colors.black.withValues(alpha: 0.08),
                                  blurRadius: 20,
                                  spreadRadius: 0,
                                  offset: const Offset(0, 4),
                                ),
                              ],
                            ],
                          ),
                          child: child,
                        );
                      },
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(8, 8, 6, 8),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: <Widget>[
                            // 第一行：输入框 + 发送/停止按钮
                            Row(
                              crossAxisAlignment: CrossAxisAlignment.end,
                              children: <Widget>[
                                // 中间：输入框
                                Expanded(
                                  child: Padding(
                                    padding: const EdgeInsets.symmetric(
                                        horizontal: 4, vertical: 2),
                                    child: Focus(
                                      // Enter 键发送消息；Shift+Enter 换行
                                      onKeyEvent:
                                          (FocusNode node, KeyEvent event) {
                                        if (event is! KeyDownEvent) {
                                          return KeyEventResult.ignored;
                                        }
                                        final bool isEnter = event.logicalKey ==
                                                LogicalKeyboardKey.enter ||
                                            event.logicalKey ==
                                                LogicalKeyboardKey.numpadEnter;
                                        if (!isEnter) {
                                          return KeyEventResult.ignored;
                                        }
                                        if (HardwareKeyboard
                                            .instance.isShiftPressed) {
                                          return KeyEventResult.ignored;
                                        }
                                        if (widget.controller.text
                                                .trim()
                                                .isNotEmpty &&
                                            !widget.isAgentProcessing) {
                                          widget.onSend();
                                          return KeyEventResult.handled;
                                        }
                                        return KeyEventResult.ignored;
                                      },
                                      child: TextField(
                                        controller: widget.controller,
                                        focusNode: widget.inputFocusNode,
                                        style: TextStyle(
                                            color: cs.onSurface, fontSize: 15),
                                        cursorColor: cs.primary,
                                        maxLines: 6,
                                        minLines: 1,
                                        textInputAction:
                                            TextInputAction.newline,
                                        keyboardType: TextInputType.multiline,
                                        decoration: InputDecoration(
                                          hintText: "",
                                          // 彻底移除 TextField 内部各状态下的内边框（下划线/矩形）
                                          border: InputBorder.none,
                                          enabledBorder: InputBorder.none,
                                          focusedBorder: InputBorder.none,
                                          disabledBorder: InputBorder.none,
                                          errorBorder: InputBorder.none,
                                          focusedErrorBorder: InputBorder.none,
                                          hintStyle: TextStyle(
                                            color: cs.onSurfaceVariant
                                                .withValues(alpha: 0.5),
                                            fontSize: 15,
                                          ),
                                          contentPadding: EdgeInsets.zero,
                                          isDense: true,
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 4),
                                // 右侧：发送/停止按钮（常显，根据状态切换）
                                AnimatedSwitcher(
                                  duration: const Duration(milliseconds: 180),
                                  switchInCurve: Curves.easeOutCubic,
                                  switchOutCurve: Curves.easeInCubic,
                                  transitionBuilder:
                                      (Widget child, Animation<double> anim) {
                                    return FadeTransition(
                                      opacity: anim,
                                      child: ScaleTransition(
                                        scale:
                                            Tween<double>(begin: 0.85, end: 1)
                                                .animate(anim),
                                        child: child,
                                      ),
                                    );
                                  },
                                  child: widget.isAgentProcessing
                                      ? _buildStopButton(cs)
                                      : _buildSendButton(cs),
                                ),
                              ],
                            ),
                            // 第二行：辅助功能按钮（左下：上传图片；右下：语音/通话）
                            Padding(
                              padding: const EdgeInsets.only(top: 2),
                              child: Row(
                                children: <Widget>[
                                  // 左下：上传图片
                                  if (widget.onPickGalleryImage != null)
                                    _buildInputIconButton(
                                      icon: Icons.add_rounded,
                                      tooltip: "上传图片",
                                      onTap: widget.onPickGalleryImage,
                                      cs: cs,
                                      size: 18,
                                    ),
                                  const Spacer(),
                                  // 右下：语音对话模式 —— 召唤屏幕右下角悬浮球
                                  if (widget.onEnterVoiceMode != null)
                                    _buildInputIconButton(
                                      icon: Icons.mic_rounded,
                                      tooltip: "语音对话模式",
                                      onTap: widget.onEnterVoiceMode,
                                      cs: cs,
                                      size: 20,
                                      tone: InputIconTone.primary,
                                    ),
                                  const SizedBox(width: 4),
                                  // 右下：电话按钮
                                  if (widget.onOpenPhoneDialer != null)
                                    _buildInputIconButton(
                                      icon: Icons.phone_in_talk,
                                      tooltip: VoiceCallUiLabels.chatTooltip,
                                      onTap: widget.onOpenPhoneDialer,
                                      cs: cs,
                                      size: 18,
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
  });

  final String playUrl;

  void _open(BuildContext context) {
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
                  "对局",
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
    this.agentName,
    this.agentAvatarUrl,
    this.agentMoodStyle,
    this.agentAvatarPreset,
    this.onOpenAgentProfile,
    this.onDeleteMessage,
    this.onDeleteFromMessage,
    this.onGetRelatedMessageIds,
    // 全局删除选择状态（由 ChatPage 传入）
    required this.deleteSelectionMode,
    required this.isSelected,
    required this.selectedCount,

    /// 是否在选择模式的可选范围内（触发用户消息 + 其agent回复）
    required this.inSelectableRange,

    /// 是否为触发了删除模式的用户消息（锁定不可取消）
    required this.isTrigger,
    required this.onEnterDeleteMode,
    required this.onToggleSelection,
    required this.onDeleteConfirm,
    required this.onDeleteCancel,

    /// 「选择型卡片」按钮点击回调(可选,透传至内容渲染)
    this.onUserAction,
  });

  final ColorScheme cs;
  final ChatMessage mainMessage;
  final bool isUser;
  final EdgeInsets cardPadding;
  final ContentSummaryParseResult? contentSummary;
  final String? agentName;
  final String? agentAvatarUrl;
  final String? agentMoodStyle;
  final String? agentAvatarPreset;
  final void Function(GlobalKey avatarKey)? onOpenAgentProfile;
  final void Function(String messageId)? onDeleteMessage;
  final void Function(String messageId)? onDeleteFromMessage;
  final List<String> Function(String messageId)? onGetRelatedMessageIds;

  /// 全局删除选择模式是否激活
  final bool deleteSelectionMode;

  /// 当前消息是否被选中
  final bool isSelected;

  /// 当前已选中的消息总数（用于确认栏显示）
  final int selectedCount;

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

  /// 「选择型卡片」按钮点击回调(透传至消息正文渲染)
  final void Function(AgentResultAction action,
      {required AgentResultData cardData})? onUserAction;

  @override
  Widget build(BuildContext context) {
    return _HoverableMessageContent(
      cs: cs,
      mainMessage: mainMessage,
      isUser: isUser,
      cardPadding: cardPadding,
      contentSummary: contentSummary,
      agentName: agentName,
      agentAvatarUrl: agentAvatarUrl,
      agentMoodStyle: agentMoodStyle,
      agentAvatarPreset: agentAvatarPreset,
      onOpenAgentProfile: onOpenAgentProfile,
      onDeleteMessage: onDeleteMessage,
      onDeleteFromMessage: onDeleteFromMessage,
      deleteSelectionMode: deleteSelectionMode,
      isSelected: isSelected,
      selectedCount: selectedCount,
      inSelectableRange: inSelectableRange,
      isTrigger: isTrigger,
      onEnterDeleteMode: onEnterDeleteMode,
      onToggleSelection: onToggleSelection,
      onDeleteConfirm: onDeleteConfirm,
      onDeleteCancel: onDeleteCancel,
      onUserAction: onUserAction,
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
    this.agentName,
    this.agentAvatarUrl,
    this.agentMoodStyle,
    this.agentAvatarPreset,
    this.onOpenAgentProfile,
    this.onDeleteMessage,
    this.onDeleteFromMessage,
    required this.deleteSelectionMode,
    required this.isSelected,
    required this.selectedCount,
    required this.inSelectableRange,
    required this.isTrigger,
    required this.onEnterDeleteMode,
    required this.onToggleSelection,
    required this.onDeleteConfirm,
    required this.onDeleteCancel,
    this.onUserAction,
  });

  final ColorScheme cs;
  final ChatMessage mainMessage;
  final bool isUser;
  final EdgeInsets cardPadding;
  final ContentSummaryParseResult? contentSummary;
  final String? agentName;
  final String? agentAvatarUrl;
  final String? agentMoodStyle;
  final String? agentAvatarPreset;
  final void Function(GlobalKey avatarKey)? onOpenAgentProfile;
  final void Function(String messageId)? onDeleteMessage;
  final void Function(String messageId)? onDeleteFromMessage;
  final bool deleteSelectionMode;
  final bool isSelected;
  final int selectedCount;
  final bool inSelectableRange;
  final bool isTrigger;
  final void Function(String messageId) onEnterDeleteMode;
  final void Function(String messageId, bool selected) onToggleSelection;
  final VoidCallback onDeleteConfirm;
  final VoidCallback onDeleteCancel;

  /// 「选择型卡片」按钮点击回调(透传至消息正文渲染)
  final void Function(AgentResultAction action,
      {required AgentResultData cardData})? onUserAction;

  @override
  State<_HoverableMessageContent> createState() =>
      _HoverableMessageContentState();
}

class _HoverableMessageContentState extends State<_HoverableMessageContent> {
  bool _hovered = false;
  final GlobalKey _avatarKey = GlobalKey();

  // ===== 打字机式流式显示 =====
  // 后端 chunk 可能整段/大块到达，这里在气泡渲染层把「已 reveal」的原文前缀
  // 逐字放大，模拟真人打字；历史消息与用户消息直接显示全文。
  static const int _charsPerTick = 2;
  static const Duration _tick = Duration(milliseconds: 24);
  static const Duration _cursorBlink = Duration(milliseconds: 480);

  /// 原始文本（未 strip）的已显示前缀；仅 assistant 流式消息逐字增长。
  String _revealedRaw = "";
  Timer? _typeTimer;
  Timer? _cursorTimer;
  bool _typeCursorOn = false;

  String get _rawTarget => widget.mainMessage.text;

  /// 是否处于打字机展示中（打字中或光标闪烁中）
  bool get _typewriterActive => _typeTimer != null || _cursorTimer != null;

  @override
  void initState() {
    super.initState();
    if (widget.mainMessage.streaming && widget.mainMessage.text.isNotEmpty) {
      // 流式接收中的新消息：从零开始逐字 reveal（覆盖整段一次性到达的场景）
      _revealedRaw = "";
      _typeTimer = Timer.periodic(_tick, (_) => _typeTick());
    } else {
      // 历史消息 / 用户消息直接显示全文
      _revealedRaw = _rawTarget;
    }
  }

  @override
  void didUpdateWidget(covariant _HoverableMessageContent oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.mainMessage.text != oldWidget.mainMessage.text) {
      _syncTypewriter();
    }
  }

  @override
  void dispose() {
    _typeTimer?.cancel();
    _cursorTimer?.cancel();
    super.dispose();
  }

  void _syncTypewriter() {
    if (widget.isUser) {
      _revealedRaw = _rawTarget;
      _stopTypeTimers();
      return;
    }
    final String target = _rawTarget;
    if (target.startsWith(_revealedRaw)) {
      // 前缀延伸 = 流式追加：继续逐字 reveal
      if (_revealedRaw.length < target.length && _typeTimer == null) {
        _typeTimer = Timer.periodic(_tick, (_) => _typeTick());
      }
    } else {
      // 内容被替换（如删除重发）：直接显示全文
      _revealedRaw = target;
      _stopTypeTimers();
      _scheduleRebuild();
    }
  }

  void _typeTick() {
    if (!mounted) {
      _stopTypeTimers();
      return;
    }
    final String target = _rawTarget;
    if (_revealedRaw.length < target.length) {
      int end = _revealedRaw.length + _charsPerTick;
      if (end > target.length) end = target.length;
      _revealedRaw = target.substring(0, end);
      _cursorTimer ??= Timer.periodic(_cursorBlink, (_) {
        if (!mounted) return;
        setState(() => _typeCursorOn = !_typeCursorOn);
      });
      setState(() {});
      if (_revealedRaw.length >= target.length) _stopTypeTimers();
    } else {
      _stopTypeTimers();
    }
  }

  void _stopTypeTimers() {
    _typeTimer?.cancel();
    _typeTimer = null;
    _cursorTimer?.cancel();
    _cursorTimer = null;
    _typeCursorOn = false;
  }

  void _scheduleRebuild() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) setState(() {});
    });
  }

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
              child: _buildMessageRow(context),
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
                alignment: widget.isUser
                    ? Alignment.bottomRight
                    : Alignment.bottomLeft,
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

  /// 构建包含头像、时间、气泡的完整消息行
  Widget _buildMessageRow(BuildContext context) {
    // 给气泡加个最大宽度限制（屏宽 72%），避免长文本横向铺满整行。
    // 用 LayoutBuilder 拿父级可用宽度，比硬编码 MediaQuery 更稳。
    final bool isVoiceMessage = widget.mainMessage.contentType == "audio" &&
        widget.mainMessage.attachments.any(
            (MessageAttachment a) => a.type == MessageAttachmentType.audio);
    final Widget bubble;
    if (isVoiceMessage) {
      final MessageAttachment audio = widget.mainMessage.attachments.firstWhere(
        (MessageAttachment a) => a.type == MessageAttachmentType.audio,
      );
      bubble = LayoutBuilder(
        builder: (BuildContext context, BoxConstraints constraints) {
          final double maxBubbleWidth = constraints.maxWidth * 0.72;
          return ConstrainedBox(
            constraints: BoxConstraints(maxWidth: maxBubbleWidth),
            child: VoiceMessageBubble(
              mediaUrl: audio.url,
              isMe: widget.isUser,
              durationMs:
                  audio.durationMs ?? widget.mainMessage.durationMs ?? 0,
              waveform: audio.waveform ?? widget.mainMessage.waveform,
              transcript: (audio.transcript?.isNotEmpty == true
                      ? audio.transcript
                      : null) ??
                  (widget.mainMessage.text.isNotEmpty
                      ? widget.mainMessage.text
                      : null),
              isRead: true,
            ),
          );
        },
      );
    } else {
      bubble = LayoutBuilder(
        builder: (BuildContext context, BoxConstraints constraints) {
          final double maxBubbleWidth = constraints.maxWidth * 0.72;
          return ConstrainedBox(
            constraints: BoxConstraints(maxWidth: maxBubbleWidth),
            child: _buildMessageCard(context, highlight: widget.isSelected),
          );
        },
      );
    }

    if (widget.inSelectableRange) {
      // 删除选择模式：左侧勾选 + 头像/气泡
      return Row(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.only(top: 12, right: 8),
            child: Checkbox(
              value: widget.isSelected,
              onChanged: widget.isTrigger
                  ? null
                  : (bool? v) {
                      widget.onToggleSelection(
                          widget.mainMessage.messageId, v ?? true);
                    },
            ),
          ),
          if (!widget.isUser) _buildAvatar(context, isUser: false),
          Flexible(child: _buildMessageColumn(bubble)),
          if (widget.isUser) _buildAvatar(context, isUser: true),
        ],
      );
    }

    return Row(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        if (!widget.isUser) _buildAvatar(context, isUser: false),
        Flexible(child: _buildMessageColumn(bubble)),
        if (widget.isUser) _buildAvatar(context, isUser: true),
      ],
    );
  }

  Widget _buildMessageColumn(Widget bubble) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment:
          widget.isUser ? CrossAxisAlignment.end : CrossAxisAlignment.start,
      children: <Widget>[
        _buildMessageHeader(),
        bubble,
      ],
    );
  }

  Widget _buildMessageHeader() {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final String timeStr = _formatTime(widget.mainMessage.timestamp);
    final TextStyle timeStyle = TextStyle(
      fontSize: 10,
      color: cs.onSurfaceVariant,
    );

    if (widget.isUser) {
      return Padding(
        padding: const EdgeInsets.only(bottom: 2, right: 4),
        child: Text(timeStr, style: timeStyle),
      );
    }

    return Padding(
      padding: const EdgeInsets.only(bottom: 2, left: 4),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(
            widget.agentName ?? "AI 助手",
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: cs.onSurface,
            ),
          ),
          const SizedBox(width: 6),
          Text(timeStr, style: timeStyle),
        ],
      ),
    );
  }

  static String _formatTime(DateTime time) {
    return "${time.hour.toString().padLeft(2, '0')}:${time.minute.toString().padLeft(2, '0')}";
  }

  Widget _buildAvatar(BuildContext context, {required bool isUser}) {
    if (isUser) {
      return Container(
        width: 36,
        height: 36,
        margin: const EdgeInsets.only(left: 10, top: 4),
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          gradient: const LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: <Color>[
              Color(0xFF8E8E93),
              Color(0xFF6E6E73),
            ],
          ),
          boxShadow: <BoxShadow>[
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.1),
              blurRadius: 8,
              offset: const Offset(0, 2),
            ),
          ],
          border: Border.all(
            color: Colors.white.withValues(alpha: 0.5),
            width: 1,
          ),
        ),
        alignment: Alignment.center,
        child: const Icon(
          Icons.person_outline,
          size: 18,
          color: Colors.white,
        ),
      );
    }

    final Widget avatar = _buildDefaultAgentAvatar();

    if (widget.onOpenAgentProfile == null) {
      return avatar;
    }
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        key: _avatarKey,
        behavior: HitTestBehavior.opaque,
        onTap: () => widget.onOpenAgentProfile!.call(_avatarKey),
        child: SizedBox(
          width: 46,
          height: 40,
          child: Align(
            alignment: Alignment.topLeft,
            child: avatar,
          ),
        ),
      ),
    );
  }

  Widget _buildDefaultAgentAvatar() {
    final _AgentAvatarPalette palette =
        _AgentAvatarPalette.fromPreset(widget.agentAvatarPreset);
    final Widget fallback = Container(
      width: 36,
      height: 36,
      margin: const EdgeInsets.only(right: 10, top: 4),
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: RadialGradient(
          center: const Alignment(-0.3, -0.3),
          colors: palette.colors,
        ),
        boxShadow: <BoxShadow>[
          BoxShadow(
            color: palette.colors.first.withValues(alpha: 0.32),
            blurRadius: 20,
            offset: Offset.zero,
          ),
        ],
        border: Border.all(
          color: Colors.white.withValues(alpha: 0.4),
          width: 1,
        ),
      ),
      alignment: Alignment.center,
      child: Icon(
        _AgentMoodGlyph.fromMood(widget.agentMoodStyle),
        size: 18,
        color: Colors.white,
      ),
    );
    return Container(
      width: 36,
      height: 36,
      margin: const EdgeInsets.only(right: 10, top: 4),
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        border: Border.all(
          color: Colors.white.withValues(alpha: 0.4),
          width: 1,
        ),
        boxShadow: <BoxShadow>[
          BoxShadow(
            color: palette.colors.first.withValues(alpha: 0.32),
            blurRadius: 20,
            offset: Offset.zero,
          ),
        ],
      ),
      clipBehavior: Clip.antiAlias,
      child: Image.asset(
        agentAvatarAssetPath(widget.agentAvatarPreset),
        fit: BoxFit.cover,
        errorBuilder: (_, __, ___) => fallback,
      ),
    );
  }

  /// 构建消息卡片（支持高亮态）
  Widget _buildMessageCard(BuildContext context, {bool highlight = false}) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final BorderRadius borderRadius = widget.isUser
        ? const BorderRadius.only(
            topLeft: Radius.circular(16),
            topRight: Radius.circular(6),
            bottomLeft: Radius.circular(16),
            bottomRight: Radius.circular(16),
          )
        : const BorderRadius.only(
            topLeft: Radius.circular(6),
            topRight: Radius.circular(16),
            bottomLeft: Radius.circular(16),
            bottomRight: Radius.circular(16),
          );

    final Decoration decoration;
    if (widget.isUser) {
      decoration = BoxDecoration(
        borderRadius: borderRadius,
        color: cs.primaryContainer,
        boxShadow: <BoxShadow>[
          BoxShadow(
            color: cs.primary.withValues(alpha: 0.15),
            blurRadius: 12,
            offset: const Offset(0, 2),
          ),
        ],
      );
    } else {
      decoration = BoxDecoration(
        borderRadius: borderRadius,
        color: cs.surfaceContainerHigh,
        border: Border.all(
          color: cs.outline.withValues(alpha: 0.35),
        ),
        boxShadow: <BoxShadow>[
          BoxShadow(
            color: cs.outline.withValues(alpha: 0.15),
            blurRadius: 12,
            offset: const Offset(0, 2),
          ),
        ],
      );
    }

    return Container(
      decoration: highlight
          ? BoxDecoration(
              borderRadius: borderRadius,
              color: Colors.red.withValues(alpha: 0.08),
              border: Border.all(
                color: Colors.red.withValues(alpha: 0.4),
              ),
            )
          : decoration,
      child: ClipRRect(
        borderRadius: borderRadius,
        child: Padding(
          padding: widget.cardPadding,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              if (widget.mainMessage.attachmentImageCount > 0)
                Padding(
                  padding: const EdgeInsets.only(bottom: 3),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      Icon(
                        Icons.photo_camera_outlined,
                        size: 14,
                        color: widget.isUser
                            ? Theme.of(context).colorScheme.onPrimaryContainer
                            : Theme.of(context).colorScheme.primary,
                      ),
                      const SizedBox(width: 4),
                      Text(
                        "配图 ×${widget.mainMessage.attachmentImageCount}",
                        style: Theme.of(context).textTheme.labelSmall?.copyWith(
                              color: widget.isUser
                                  ? Theme.of(context)
                                      .colorScheme
                                      .onPrimaryContainer
                                  : Theme.of(context).colorScheme.primary,
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
                onUserAction: widget.onUserAction,
                // 打字机：assistant 流式消息用「已 reveal」前缀渲染，
                // 光标随打字闪烁；非打字场景传 null 走原文。
                typewriterRawText:
                    (!widget.isUser && _revealedRaw != _rawTarget)
                        ? _revealedRaw
                        : null,
                typewriterCursor: _typeTimer != null && _typeCursorOn,
              ),
              if (!widget.isUser &&
                  !_typewriterActive &&
                  widget.contentSummary?.summary == null &&
                  widget.mainMessage.text.contains(RegExp(r'https?://\S+')))
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: _buildGrayLinksInner(widget.mainMessage.text, context),
                ),
              if (!widget.isUser &&
                  widget.mainMessage.playUrl != null &&
                  widget.mainMessage.playUrl!.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: _GomokuPlayUrlCard(
                    playUrl: widget.mainMessage.playUrl!,
                  ),
                ),
            ],
          ),
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
    void Function(AgentResultAction action,
            {required AgentResultData cardData})?
        onUserAction,

    /// 打字机「已 reveal」的原文前缀；null 时显示完整原文。
    /// 仅作用于下方纯文本分支（卡片/摘要仍用完整原文解析）。
    String? typewriterRawText,

    /// 是否在文本末尾显示闪烁光标（打字机进行中）
    bool typewriterCursor = false,
  }) {
    if (isUser) {
      return Text(
        message.text,
        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
              color: cs.onPrimaryContainer,
            ),
      );
    }

    // 智能体结果卡片（任务总结 / 工具调用结果）优先级最高，
    // 命中后剥离标记，剩余文本以小字附在卡片下方。
    //
    // actions 非空时,渲染为带按钮的"选择型卡片"——专门给用户做快速决策
    // (如「周六去 / 忽略」「订阅 / 稍后再说」),点击会触发 onUserAction。
    // actions 为空时,保持原有"纯汇报"卡片样式不变。
    final AgentResultParseResult agentResult =
        AgentResultParser.parse(message.text);
    if (agentResult.data != null) {
      final AgentResultData data = agentResult.data!;
      final String remaining = agentResult.cleanedText;
      final Widget card = data.actions.isNotEmpty
          ? AgentActionChoiceCard(
              data: data,
              onAction: onUserAction == null
                  ? null
                  : (AgentResultAction a) => onUserAction(a, cardData: data),
            )
          : AgentResultCard(data: data);
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          card,
          if (remaining.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Text(
                stripMarkdown(remaining),
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: cs.onSurface.withValues(alpha: 0.85),
                      height: 1.4,
                    ),
              ),
            ),
        ],
      );
    }

    if (contentSummary?.summary != null) {
      return ContentSummaryMessageBody(
        summary: contentSummary!.summary!,
        briefText: contentSummary.briefText,
        extraText: contentSummary.cleanedText,
        structuredItems: contentSummary.structuredItems,
        onCardTap: () => ContentSummaryDetailModal.show(
          context,
          contentSummary.summary!,
        ),
      );
    }

    return StructuredAssistantMessageBody(
      text: typewriterRawText ?? message.text,
      cs: cs,
      textTheme: Theme.of(context).textTheme,
      showCursor: typewriterCursor,
    );
/*
        stripMarkdown(typewriterRawText ?? message.text);
    return Text(
      typewriterCursor ? "$displayText▍" : displayText,
      // 用 bodyMedium（14px）做正文：12.5 时一长串文字会尽量横向铺满不换行，
      // 提到 14 后行宽更紧凑、换行更自然，单行不再霸屏。
      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
            color: cs.onSurface,
            height: 1.4,
          ),
    );
*/
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
        margin: const EdgeInsets.only(bottom: 2),
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
        decoration: BoxDecoration(
          color: Colors.grey.withValues(alpha: 0.15),
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: Colors.grey.withValues(alpha: 0.3)),
        ),
        child: Text(
          url,
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Colors.grey[600],
                fontSize: 11,
                height: 1.3,
              ),
        ),
      ));
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: linkWidgets,
    );
  }
}

class _AgentMoodGlyph {
  static IconData fromMood(String? moodStyle) {
    switch (moodStyle) {
      case "funny":
        return Icons.sentiment_very_satisfied_outlined;
      case "sad":
        return Icons.cloud_outlined;
      case "cool":
        return Icons.ac_unit_outlined;
      case "energetic":
        return Icons.bolt_outlined;
      case "mysterious":
        return Icons.nightlight_round_outlined;
      case "gentle":
      default:
        return Icons.smart_toy_outlined;
    }
  }
}

class _AgentAvatarPalette {
  const _AgentAvatarPalette(this.colors);

  final List<Color> colors;

  static _AgentAvatarPalette fromPreset(String? preset) {
    switch (preset) {
      case "ember":
        return const _AgentAvatarPalette(<Color>[
          Color(0xFFFFA24B),
          Color(0xFFFF5A36),
          Color(0xFFC12A2A),
        ]);
      case "tide":
        return const _AgentAvatarPalette(<Color>[
          Color(0xFF62D6FF),
          Color(0xFF118AB2),
          Color(0xFF124E78),
        ]);
      case "eclipse":
        return const _AgentAvatarPalette(<Color>[
          Color(0xFF8C7DFF),
          Color(0xFF473BF0),
          Color(0xFF171738),
        ]);
      case "neon":
        return const _AgentAvatarPalette(<Color>[
          Color(0xFFB8FF52),
          Color(0xFF00C853),
          Color(0xFF00796B),
        ]);
      case "mist":
        return const _AgentAvatarPalette(<Color>[
          Color(0xFFB0BEC5),
          Color(0xFF78909C),
          Color(0xFF455A64),
        ]);
      case "dawn":
      default:
        return const _AgentAvatarPalette(<Color>[
          Color(0xFF3DA4FF),
          Color(0xFF0D6EFD),
          Color(0xFF123A9E),
        ]);
    }
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
                  isCurrentSelected
                      ? Icons.check_box
                      : Icons.check_box_outline_blank,
                  size: 16,
                  color:
                      isCurrentSelected ? Colors.red[400] : cs.onSurfaceVariant,
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
              color: isCurrentSelected
                  ? Colors.red
                  : cs.surfaceContainerHighest.withValues(alpha: 0.5),
              borderRadius: BorderRadius.circular(14),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Icon(Icons.delete_outline,
                    size: 15,
                    color: isCurrentSelected
                        ? Colors.white
                        : cs.onSurfaceVariant.withValues(alpha: 0.4)),
                const SizedBox(width: 4),
                Text(
                  "删除",
                  style: TextStyle(
                    fontSize: 12,
                    color: isCurrentSelected
                        ? Colors.white
                        : cs.onSurfaceVariant.withValues(alpha: 0.4),
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
        overlayColor: WidgetStateProperty.all<Color>(
            Colors.black.withValues(alpha: 0.05)),
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
        Colors.grey.withValues(alpha: opacity * 0.4), // 中间浅色（灰色）
        Colors.grey.withValues(alpha: opacity * 0.6), // 中间过渡
        Colors.grey.withValues(alpha: opacity * 0.9), // 外边深色
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

/// 工具函数：将一条消息转换为渲染用的 group 结构
Map<String, dynamic> _messageToGroup(ChatMessage msg) {
  if (msg.role == "assistant_progress") {
    return <String, dynamic>{
      "isUser": false,
      "main": msg,
      "progress": null,
      "isProgress": true,
    };
  }
  if (msg.role == "user") {
    return <String, dynamic>{
      "isUser": true,
      "main": msg,
      "progress": null,
      "isProgress": false,
    };
  }
  return <String, dynamic>{
    "isUser": false,
    "main": msg,
    "progress": null,
    "isProgress": false,
  };
}
