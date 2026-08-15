import "dart:async";
import "dart:convert";
import "dart:io";

import "package:flutter/foundation.dart";
import "package:flutter/material.dart";
import "package:http/http.dart" as http;
import "package:permission_handler/permission_handler.dart";
import "package:window_manager/window_manager.dart";

import "core/config/api_config.dart";
import "core/theme/app_theme.dart";
import "core/presentation/location_permission_dialog.dart";
import "core/presentation/voice_call_ui_labels.dart";
import "core/presentation/entrance_animation.dart";
import "core/db/isar_local_history_store.dart";
import "core/models/agent_relay_models.dart";
import "core/models/chat_models.dart";
import "core/models/schedule_models.dart";
import "core/models/wallet_models.dart";
import "core/models/turn_state.dart";
import "core/utils/agent_result_parser.dart";
import "core/utils/assistant_text_sanitizer.dart";
import "core/services/schedule_api_client.dart";
import "core/services/schedule_offline_delete_queue.dart";
import "core/services/schedule_reminder_sync.dart";
import "core/services/world_api_client.dart";
import "core/services/client_location_service.dart";
import "core/services/multi_agent_api_client.dart";
import "core/services/agent_sphere_mood_bridge.dart";
import "core/services/agent_sphere_embodiment_mapper.dart";
import "core/services/sphere_embodiment_motion_bridge.dart";
import "core/services/agent_sphere_interact_bridge.dart";
import "core/services/desktop_bridge_service.dart";
import "core/services/sphere_entity_controller.dart";
import "core/services/user_preferences_api.dart";
import "features/chat/briefing_settings_page.dart";
import "core/services/windows_webview_bootstrap.dart";
import "core/services/ws_chat_service.dart";
import "core/utils/play_url_utils.dart";
import "features/mailbox/mailbox_page.dart";
import "features/mailbox/message_hub_page.dart";
import "features/chat/agent_profile_page.dart";
import "features/chat/chat_page.dart";
import "features/chat/chat_layout.dart";
import "features/chat/right_side_panel.dart";
import "core/services/split_ratio_preference.dart";
import "features/chat/sidebar_user_menu.dart";
import "features/chat/floating_agent_sphere.dart";
import "features/chat/morning_briefing_card.dart";
// 语音对话模式已迁移到独立的 PySide6 桌面悬浮球（client/voice-orb-py）。
import "features/chat/voiceprint_registration_page.dart";
import "core/services/agent_sphere_voice_controller.dart";
import "core/services/connected_call_launcher.dart";
import "core/services/briefing_delivery_api.dart";
import "core/services/desktop_notification_launcher.dart";
import "core/services/incoming_call_launcher.dart";
import "core/services/mobile_briefing_launcher.dart";
import "core/services/outgoing_call_launcher.dart";
import "core/services/tts_player.dart";
import "core/services/windows_titlebar_theme.dart";
import "features/integrations/wechat_claw_binding_page.dart";
import "features/devices/devices_page.dart";
import "core/vision/pick_gallery_vision.dart";
import "core/vision/vision_wire_frame.dart";
import "features/schedule/schedule_page.dart";
import "features/wallet/wallet_page.dart";
import "app/app_helpers.dart";
import "widgets/app_sidebar.dart";

void main() async {
  runZonedGuarded(() async {
    WidgetsFlutterBinding.ensureInitialized();
    unawaited(bootstrapWindowsWebView());
    if (Platform.isWindows || Platform.isMacOS || Platform.isLinux) {
      await windowManager.ensureInitialized();
      final WindowOptions options = WindowOptions(
        size: const Size(1280, 800),
        center: true,
        backgroundColor: Colors.transparent,
        skipTaskbar: false,
        // 保留原生标题栏（关闭/最小化/最大化按钮），
        // 与 windows/runner 里的 pai/window_titlebar 深色标题栏主题一致。
        titleBarStyle: TitleBarStyle.normal,
      );
      await windowManager.waitUntilReadyToShow(options, () async {
        await windowManager.show();
        await windowManager.focus();
      });
    }
    runApp(const PrivateAiApp());
  }, (error, stack) {
    // 兜底所有未捕获的异步异常，防止 Flutter engine 断连崩溃
    debugPrint('[UNCAUGHT] $error\n$stack');
  });
}

/// side 模式下 NextbotChatLayout 内嵌的 [VerticalDragDivider] 宽度。
/// 与 [NextbotChatLayout] 内部 `_dividerWidth` 保持一致。
const double _kSidePanelDividerWidth = 8.0;

class PrivateAiApp extends StatefulWidget {
  const PrivateAiApp({super.key});

  @override
  State<PrivateAiApp> createState() => _PrivateAiAppState();
}

class _PrivateAiAppState extends State<PrivateAiApp> {
  final GlobalKey<NavigatorState> _rootNavigatorKey =
      GlobalKey<NavigatorState>();
  final IsarLocalHistoryStore _store =
      IsarLocalHistoryStore(userPin: ApiConfig.localPin);
  final WsChatService _ws = WsChatService(url: ApiConfig.wsUrl);
  final WorldApiClient _worldApi = WorldApiClient(baseUrl: ApiConfig.httpBase);
  final ScheduleApiClient _scheduleApi =
      ScheduleApiClient(baseUrl: ApiConfig.httpBase);
  final MultiAgentApiClient _multiAgentApi =
      MultiAgentApiClient(baseUrl: ApiConfig.httpBase);
  final UserPreferencesApi _preferencesApi =
      UserPreferencesApi(baseUrl: ApiConfig.httpBase);
  final BriefingDeliveryApi _briefingDeliveryApi =
      BriefingDeliveryApi(baseUrl: ApiConfig.httpBase);
  final ValueNotifier<int> _scheduleReloadSignal = ValueNotifier<int>(0);

  /// 缓存日程 Future，避免每次 build 重建导致 FutureBuilder 反复重置为 waiting（卡片闪烁/震动）
  Future<List<ScheduleEvent>>? _cachedScheduleFuture;
  final TextEditingController _inputController = TextEditingController();
  final FocusNode _inputFocusNode = FocusNode();

  /// `null` 尚未询问；`true` 随消息静默抓拍；`false` 仅文字模式
  // ignore: unused_field
  bool? _visionCameraConsent;

  /// 用户从相册/文件选取、待发的图（可多张，优先于摄像头帧）)
  final List<VisionWireFrame> _pendingGalleryFrames = <VisionWireFrame>[];

  final List<ChatMessage> _messages = <ChatMessage>[];
  final Map<String, int> _assistantMessageIndexById = <String, int>{};
  final Map<String, String> _pendingPlayUrlByTraceId = <String, String>{};
  final List<WalletLedgerItem> _ledger = <WalletLedgerItem>[];
  final List<AgentRelayMessage> _relayInbound = <AgentRelayMessage>[];
  double _balance = 1000;
  double _frozen = 0;
  int _tabIndex = 0;

  /// 用户给agent起的名字
  String? _agentName;
  AgentProfileData _agentProfile = const AgentProfileData(
    displayName: "AI助手",
    handle: "ai_agent",
    signature: "今天也在认真发光。",
    avatarUrl: null,
    moodStyle: UserPreferencesApi.moodGentle,
    statusText: "刚把今天的对话别在衣领上，准备继续陪你往下走。",
    avatarPreset: "dawn",
    lastProfileEvent: "这是 Agent 当前默认的主页状态。",
    updatedAt: null,
  );

  /// 当前用户在「主题」菜单里选中的模式
  /// (light → warm, dark → dark, system → 跟随 MediaQuery.platformBrightness)
  ///
  /// 初始值从 [AppThemeController] 反推:
  /// warm → light, dark → dark。系统跟随模式不会被反推出来,
  /// 因为 AppThemeController 只记实际渲染的两个 variant。
  ThemeChoice _themeChoice =
      AppThemeController.instance.value == AppThemeVariant.warm
          ? ThemeChoice.light
          : ThemeChoice.dark;

  /// 当前右侧面板要展示的内容
  /// - null: 未打开
  /// - RightPanelKind.friends:     好友（MailboxPage）
  /// - RightPanelKind.messages:   消息聚合（MessageHubPage）
  RightPanelKind? _rightPanel;

  /// 左聊天区 / 右分栏面板 的宽度比例（0.1~0.9），持久化到本地。
  double _splitRatio = SplitRatioPreference.defaultRatio;

  /// 保存打开面板前的 splitRatio，用于关闭时恢复
  double _previousSplitRatio = SplitRatioPreference.defaultRatio;

  /// 保存打开面板前的 side 模式右面板总占位（含 8px 拖拽条），
  /// 关闭时恢复——避免工具面板打开期间被 split 模式改写后回不去。
  double _previousRightPanelWidth = kRightSidePanelWidth + _kSidePanelDividerWidth;

  /// split 模式下右面板的实际宽度，由 [NextbotChatLayout] 通过
  /// [NextbotChatLayout.onRightPanelWidthChanged] 同步过来，
  /// 用于给 AppBar / Sidebar 等加右边距，避免右面板覆盖顶部栏。
  ///
  /// 语义为"总右占位"：side 模式下包含 8px 拖拽条 + [kRightSidePanelWidth] 的
  /// 面板内容(220+8=228)，split 模式即 chat_layout 报告的 rightWidth。
  double _rightPanelWidth = kRightSidePanelWidth + _kSidePanelDividerWidth;

  Map<String, int> _unreadByPlatform = <String, int>{};
  Timer? _messagePollTimer;
  bool _messageBadgeHovering = false;

  /// 关闭右侧面板
  void _closeRightPanel() {
    if (_rightPanel == null) return;
    setState(() {
      _rightPanel = null;
      // 恢复打开面板前的 splitRatio
      _splitRatio = _previousSplitRatio;
      // 恢复打开面板前的 side 模式右面板总占位（含 8px 拖拽条），
      // 避免工具面板打开期间被 split 模式把宽度改写后回不去。
      _rightPanelWidth = _previousRightPanelWidth;
    });
  }

  /// 加载持久化的分栏比例。
  void _loadSplitRatio() {
    SplitRatioPreference.load().then((double r) {
      if (mounted && (r - _splitRatio).abs() > 0.001) {
        setState(() => _splitRatio = r);
      }
    });
  }

  /// 拖动分割条时更新比例（节流写盘）。
  void _setSplitRatio(double r) {
    final double clamped = r.clamp(0.1, 0.9);
    if ((clamped - _splitRatio).abs() < 0.001) return;
    setState(() => _splitRatio = clamped);
    SplitRatioPreference.save(clamped);
  }

  /// 同步右面板实际宽度（来自 [NextbotChatLayout] 的 onRightPanelWidthChanged）。
  void _setRightPanelWidth(double width) {
    if ((width - _rightPanelWidth).abs() < 0.5) return;
    setState(() => _rightPanelWidth = width);
  }

  /// 日历面板重新加载信号
  final ValueNotifier<int> _calendarReloadSignal = ValueNotifier<int>(0);

  /// 与 userId 对齐的电脑桥接在线状态（由服务端 `desktop.bridge.sync` 推送）
  // ignore: unused_field
  bool? _desktopBridgeOnline;
  String? _desktopBridgeLastSummary;

  /// 是否已初始化完成
  bool _isInitialized = false;

  /// 是否正在播放进场动画
  bool _showEntranceAnimation = true;

  /// Agent是否正在处理中（用于显示响应状态指示器)
  bool _isAgentProcessing = false;

  /// 已上报服务端的「处理中 UI」状态，避免重复 WS 事件
  bool? _reportedAgentProcessingUiActive;

  /// 服务端`chat.agent_status` 推送的口语化进度（替换固定「思考中」）
  String? _agentStatusLine;

  /// `chat.agent_status` 携带的可选进度百分比（0-90，长工具心跳推进）。
  /// null = 无进度条（仅文本状态）；非 null = 渲染进度条。
  int? _agentStatusPercent;

  /// 服务端`chat.assistant_interim` 推送的即时确认应答（仅在首条 chunk 之前展示）。
  /// 与 `_agentStatusLine` 并存但生命周期更短：real chunk 一到立即让位。
  String? _interimAckText;

  /// 「分阶段异步对话交互 v2」结构化状态机。
  /// 取代 v1 的 `_interimAckText` 自由短句 + `_agentStatusLine` 自由文本。
  /// 当前为骨架：先在内存里把事件跑通，UI 改造下一轮再做（_ChatPage 接 TurnState）。
  TurnState? _turnState;

  /// 用户消息已发出、服务端 turn_started 抵达前的"本地占位"句柄。
  /// 用于在用户点发送的同一帧立即显示「正在思考…」（不等服务端）。
  TurnState? _pendingLocalTurn;

  /// 与 Agent 同步委派进行中：屏蔽内部工具对进度条的覆盖
  bool _subAgentDelegationActive = false;
  final Set<String> _backgroundRunningTaskIds = <String>{};
  final List<Map<String, dynamic>> _pendingAsyncConfirmations =
      <Map<String, dynamic>>[];
  bool _isSubmittingAsyncConfirmation = false;

  Timer? _assistantChunkFlushTimer;
  Timer? _agentReplyWatchdog;
  String? _pendingAssistantChunkMessageId;
  String? _pendingAgentUserMessageId;
  final StringBuffer _pendingAssistantChunkText = StringBuffer();
  final AssistantTextSanitizer _assistantTextSanitizer =
      AssistantTextSanitizer();

  /// 垫词（phase="interim"）独立气泡的本地序号兜底。
  /// 服务端 chunk 自带 sequence，通常无需走到这里。
  int _interimChunkSeq = 0;

  // Phase 2：429 回压指数退避重试状态
  String? _pendingRetryText;
  int _pendingRetryCount = 0;

  /// 记录被打断的回复内容，用于后续整)
  final List<String> _interruptedResponses = <String>[];
  static const Duration _agentReplyTimeout = Duration(minutes: 3);

  /// 网络电话悬浮按钮状态 null=无通话, ringing=正在呼叫, connected=已接通 ended=通话结束
  // ignore: unused_field
  String? _phoneCallStatus;
  String? _phoneCallToActorId;

  /// 已弹窗处理的「其与 Agent 来电」callId，避免重复弹)
  String? _peerIncomingDialogCallId;

  /// 通话中是否静音（与 ConnectedCallWindow 同步）
  // ignore: unused_field
  bool _phoneMuted = false;

  /// 通话中是否免提（与 ConnectedCallWindow 同步）
  // ignore: unused_field
  bool _phoneSpeakerOn = true;
  bool _desktopNotificationNeedsFeedback = false;
  String _desktopNotificationFeedbackChannel = "websocket";
  DateTime? _lastDesktopBriefingAt;
  StreamSubscription<String>? _mobileBriefingTapSub;
  bool _notificationPermissionChecked = false;
  Map<String, dynamic>? _pendingDesktopBriefingPayload;

  @override
  void initState() {
    super.initState();
    // 桌面端独立来电悬浮窗事件绑定
    // 所有来电（无论来源）统一走同一套回调
    // accept  : 用户点了接听 → 拉起主窗 + 等待 call_connecting
    // decline : 用户点了挂断 → 停 TTS + 关窗 + 清状态
    // timeout : 振铃超时（默认 30s）
    IncomingCallLauncher.bindHandlers(
      onAccept: _handleNativeCallAccept,
      onDecline: _handleNativeCallDecline,
      onTimeout: _handleNativeCallTimeout,
    );
    // 加载持久化的分栏比例
    _loadSplitRatio();
    // 桌面端独立"通话中"窗口事件绑定
    // hangup       : 用户点了挂断
    // muteToggle   : 用户点了静音，参数 newMuted
    // speakerToggle: 用户点了免提，参数 newOn
    ConnectedCallLauncher.bindHandlers(
      onHangUp: _handleConnectedHangup,
      onMuteToggle: _handleMuteToggle,
      onSpeakerToggle: _handleSpeakerToggle,
    );
    DesktopNotificationLauncher.bindHandlers(
      onConfirm: _handleDesktopNotificationConfirm,
      onDismiss: _handleDesktopNotificationDismiss,
      onTimeout: _handleDesktopNotificationTimeout,
    );
    MobileBriefingLauncher.bind();
    _mobileBriefingTapSub =
        MobileBriefingLauncher.payloads.listen((String payload) {
      unawaited(_openBriefingFromPayload(payload));
    });
    OutgoingCallLauncher.bindHandlers(onHangUp: _handleOutgoingCallHangup);
    // 今日安排面板数据刷新：设置（创建/删除）提醒日程后，通过信号刷新右侧面板
    _scheduleReloadSignal.addListener(_onScheduleReloadSignal);
    _bootstrap();
  }

  @override
  void dispose() {
    DesktopBridgeService.instance.stop();
    unawaited(AgentSphereVoiceController.instance.dispose());
    unawaited(TtsPlayer.instance.dispose());
    unawaited(_mobileBriefingTapSub?.cancel());
    IncomingCallLauncher.unbind();
    ConnectedCallLauncher.unbind();
    DesktopNotificationLauncher.unbind();
    unawaited(MobileBriefingLauncher.unbind());
    OutgoingCallLauncher.unbind();
    _inputFocusNode.dispose();
    _inputController.dispose();
    _scheduleReloadSignal.removeListener(_onScheduleReloadSignal);
    _scheduleReloadSignal.dispose();
    _calendarReloadSignal.dispose();
    _stopMessagePolling();
    _voiceOrbProcess?.kill();
    super.dispose();
  }

  Future<void> _bootstrap() async {
    try {
      await _store.init();
    } catch (e) {
      debugPrint("[Bootstrap] _store.init() failed: $e");
      // 尝试继续运行，使用空存储
      try {
        await _store.init(); // 重试一次
      } catch (e2) {
        debugPrint("[Bootstrap] _store.init() retry also failed: $e2");
        // 不再抛出，让应用继续运行
      }
    }

    // 一次性清理历史上「裸 taskId」格式的孤儿日程事项（详见 store 注释）。
    // 修复 WS 块后此函数是幂等的：没有孤儿时返回 0。
    try {
      final int removed = await _store.cleanOrphanScheduleEvents();
      if (removed > 0) {
        debugPrint(
            "[schedule] cleaned $removed orphan schedule event(s) on boot");
      }
    } catch (e) {
      debugPrint("[schedule] cleanOrphanScheduleEvents failed: $e");
    }

    try {
      final int migrated = await _store.migrateAssistantTimestampFrames();
      if (migrated > 0) {
        debugPrint(
            "[chat] sanitized $migrated assistant message(s) with legacy timestamp frames");
      }
    } catch (e) {
      debugPrint("[chat] migrateAssistantTimestampFrames failed: $e");
    }

    try {
      await _store.saveSession(
        ChatSession(
          sessionId: ApiConfig.effectiveActorId,
          title: "默认会话",
          createdAt: DateTime.now(),
        ),
      );
    } catch (e) {
      debugPrint("[Bootstrap] saveSession failed: $e");
      // 继续运行
    }

    final List<ChatMessage> cachedMessages = (await _store
            .listMessages(ApiConfig.effectiveActorId))
        .map(_sanitizeLoadedChatMessage)
        .toList();

    // 修复历史遗留的重复消息：旧版本 saveMessage 按 messageId 直接 append，
    // 同一 messageId 可能在本地 store 里被存成多条（流式入列表 + done 兜底 +
    // 缓存恢复后事件重放等路径叠加），导致「同一条回复渲染两次」。
    // 这里按 messageId 去重保序：同 id 保留内容更完整的一条（文本更长优先，
    // 相同长度则保留时间更晚的一条），并收集被剔除的重复 id 供 store 清理。
    final List<ChatMessage> dedupedMessages = <ChatMessage>[];
    final Map<String, int> messageIndexById = <String, int>{};
    final Set<String> duplicateMessageIds = <String>{};
    for (final ChatMessage m in cachedMessages) {
      final int? existingIdx = messageIndexById[m.messageId];
      if (existingIdx == null) {
        messageIndexById[m.messageId] = dedupedMessages.length;
        dedupedMessages.add(m);
        continue;
      }
      final ChatMessage existing = dedupedMessages[existingIdx];
      if (m.text.length > existing.text.length ||
          (m.text.length == existing.text.length &&
              m.timestamp.isAfter(existing.timestamp))) {
        dedupedMessages[existingIdx] = m;
      }
      duplicateMessageIds.add(m.messageId);
    }

    // 内容级去重：修复「同一段正文被渲染成两条消息」的历史遗留。
    // 旧版本服务端把主回复正文既按段推成 interim 消息（interim-$trace-$seq），
    // 又推成 stream 主回复（assistant-$trace），前端会得到内容完全相同的相邻
    // 两条 assistant 消息。仅对相邻 assistant 消息做比较：trim 后文本一致即视为
    // 同一回复的重复渲染，保留先出现的一条（stream 主回复通常更完整），删除
    // 靠后的那条。非相邻消息不做比较，避免误删正常对话中恰好相同的回复。
    final List<ChatMessage> contentDedupedMessages = <ChatMessage>[];
    final Set<String> contentDuplicateMessageIds = <String>{};
    for (final ChatMessage m in dedupedMessages) {
      final bool isContentDup = contentDedupedMessages.isNotEmpty &&
          contentDedupedMessages.last.role == "assistant" &&
          m.role == "assistant" &&
          contentDedupedMessages.last.text.trim() == m.text.trim();
      if (isContentDup) {
        contentDuplicateMessageIds.add(m.messageId);
        continue;
      }
      contentDedupedMessages.add(m);
    }
    // 同步清理 store 中内容重复的消息（避免刷新后再次加载出来）
    for (final String messageId in contentDuplicateMessageIds) {
      try {
        await _store.deleteMessage(messageId);
        debugPrint(
            "[chat] dedupe: cleaned content-duplicate messageId=$messageId");
      } catch (e) {
        debugPrint("[chat] content dedupe cleanup failed for $messageId: $e");
      }
    }

    final List<AgentRelayMessage> cachedRelay =
        await _store.listRelayInbound(ApiConfig.effectiveActorId);

    final bool? visionConsent = await _store.getVisionCameraConsent();

    setState(() {
      _messages.addAll(contentDedupedMessages);
      // 关键：从缓存恢复后必须重建 assistant 消息索引，
      // 否则后续 chat.assistant_chunk / chat.assistant_done 事件按 messageId
      // 去重时找不到记录，会把同一条 agent 消息重复入列表，造成「同一条回复渲染两次」。
      _rebuildAssistantIndex();
      _relayInbound
        ..clear()
        ..addAll(cachedRelay);
      _visionCameraConsent = visionConsent;
      // 设置agent名字占位符
      _agentName = "AI助手";
      _isInitialized = true;
    });

    // 异步清理本地 store 里已剔除的重复消息（不阻塞首帧渲染）
    if (duplicateMessageIds.isNotEmpty) {
      unawaited(_cleanupDuplicateMessages(
          dedupedMessages, messageIndexById, duplicateMessageIds));
    }

    unawaited(_loadAgentProfile());
    _onScheduleReloadSignal();
    unawaited(_flushScheduleOfflineDeletes());

    _ws.onConnected = () {
      SphereEmbodimentMotionBridge.instance.setMainAgentLinked(true);
      _sendSessionInit();
      unawaited(_flushScheduleOfflineDeletes());
      if (!kIsWeb && defaultTargetPlatform == TargetPlatform.windows) {
        DesktopBridgeService.instance.start();
        unawaited(_tryShowDesktopLaunchBriefing());
      }
    };
    ClientLocationService.bindPreferences(
      read: _store.getPreference,
      write: _store.savePreference,
    );
    _ws.connect();
    _startMessagePolling();
    unawaited(_consumePendingMobileBriefingLaunch());
    unawaited(_ensureAndroidNotificationPermission());
    unawaited(_tryShowMobileLaunchBriefing());

    AgentSphereInteractBridge.instance.bind((String action, {String? text}) {
      if (!_ws.isConnected) return;
      _ws.sendEvent("agent.embodiment.interact", <String, dynamic>{
        "sessionId": ApiConfig.effectiveActorId,
        "userId": ApiConfig.effectiveActorId,
        "action": action,
        if (text != null && text.trim().isNotEmpty) "text": text.trim(),
      });
      if (action == "wake" || action == "chat") {
        AgentSphereMoodBridge.instance.listening();
      }
    });

    AgentSphereMoodBridge.instance.addFocusListener(() {
      if (_tabIndex != 0) {
        setState(() => _tabIndex = 0);
      }
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _inputFocusNode.requestFocus();
      });
    });

    final AgentSphereVoiceController voiceCtrl =
        AgentSphereVoiceController.instance;
    voiceCtrl.onRecognizedText = (String text) {
      final String t = text.trim();
      if (t.isEmpty) return;
      _inputController.text = t;
      unawaited(_sendMessage());
    };
    voiceCtrl.onRequestVoiceprintRegistration = () {
      if (!mounted) return;
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (BuildContext ctx) => VoiceprintRegistrationPage(
            userId: ApiConfig.effectiveActorId,
            onRegistrationComplete: () {
              Navigator.of(ctx).pop();
              voiceCtrl.markVoiceprintRegistered();
            },
          ),
        ),
      );
    };

    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      await _promptLocationConsentIfNeeded();
    });
    _ws.events.listen((Map<String, dynamic> event) async {
      final String type = event["type"] as String? ?? "";
      final Map<String, dynamic> payload =
          (event["payload"] as Map?)?.cast<String, dynamic>() ??
              <String, dynamic>{};
      try {
        _syncAgentSphereFromWs(type, payload);
        // 服务端按需请求实时位置：Agent 需要位置时（如天气工具）才拉一次 GPS。
        if (type == "agent.location_request") {
          final String jobId = payload["jobId"]?.toString() ?? "";
          final ClientLocationPayload? loc =
              await ClientLocationService.getCurrentLocationForChat();
          if (loc != null) {
            _ws.sendEvent("client.location_report", <String, dynamic>{
              if (jobId.isNotEmpty) "jobId": jobId,
              ...loc.toJson(),
            });
          }
        }
        if (type == "connection_error") {
          SphereEmbodimentMotionBridge.instance.setMainAgentLinked(false);
          final bool hadPendingTurn =
              _isAgentProcessing && _pendingAgentUserMessageId != null;
          _disarmAgentReplyWatchdog();
          if (hadPendingTurn) {
            _handleAgentReplyTimeout(showSnackBar: false);
          } else {
            _pendingAgentUserMessageId = null;
            if (_isAgentProcessing || _agentStatusLine != null) {
              _clearAgentProcessingState();
            }
          }
          final String message = payload["message"]?.toString() ?? "无法连接到服务器";
          if (mounted) {
            ScaffoldMessenger.maybeOf(context)?.showSnackBar(
              SnackBar(
                content: Text(message),
                action: SnackBarAction(
                  label: "重试",
                  onPressed: _ws.retryConnect,
                ),
              ),
            );
          }
        }
        if (type == "ws_disconnected") {
          SphereEmbodimentMotionBridge.instance.setMainAgentLinked(false);
          if (_isAgentProcessing && _pendingAgentUserMessageId != null) {
            _disarmAgentReplyWatchdog();
            _handleAgentReplyTimeout(showSnackBar: false);
          }
          final String message = payload["message"]?.toString() ?? "与服务器的连接已断开";
          if (mounted) {
            ScaffoldMessenger.maybeOf(context)?.showSnackBar(
              SnackBar(
                content: Text(message),
                action: SnackBarAction(
                  label: "重试",
                  onPressed: _ws.retryConnect,
                ),
              ),
            );
          }
        }
        if (type == "error.event") {
          // 与当前chat 轮次无关的错误需立即解除「思考中」；CHAT_HANDLER_ERROR 仍会→ assistant_done←
          final String? traceId = payload["traceId"]?.toString();
          final bool chatTurnError = traceId != null &&
              traceId.isNotEmpty &&
              traceId == _pendingAgentUserMessageId;
          if (_isAgentProcessing && !chatTurnError) {
            _disarmAgentReplyWatchdog();
            _pendingAgentUserMessageId = null;
            _clearAgentProcessingState();
          }
          final String message = payload["message"]?.toString() ?? "服务器处理失败";
          if (mounted) {
            ScaffoldMessenger.maybeOf(context)?.showSnackBar(
              SnackBar(content: Text(message)),
            );
          }
        }
        if (type == "tool.call") {
          if (_isAgentProcessing) {
            final String toolName = payload["toolName"]?.toString() ?? "";
            if (_subAgentDelegationActive &&
                !isMasterInvokeSubAgentTool(toolName)) {
              return;
            }
            final String? userStatusLine =
                payload["userStatusLine"]?.toString().trim();
            final String? preamble =
                payload["assistantPreamble"]?.toString().trim();
            // 行动宣告由 chat.assistant_interim 确定性下发（服务端路由后立即发），
            // 这里 preamble 仅作 userStatusLine 的备选来源走输入框状态行。
            final String line =
                (userStatusLine != null && userStatusLine.isNotEmpty)
                    ? userStatusLine
                    : (preamble != null && preamble.isNotEmpty)
                        ? preamble
                        : "";
            if (isMasterInvokeSubAgentTool(toolName)) {
              _subAgentDelegationActive = true;
            }
            if (line.isNotEmpty) {
              _updateAgentStatusLine(line);
            }
          }
        }
        if (type == "tool.result") {
          final Map<String, dynamic>? result =
              (payload["result"] as Map?)?.cast<String, dynamic>();
          final String? playUrl = PlayUrlUtils.fromToolResult(result);
          if (playUrl != null) {
            final String? traceId = payload["traceId"]?.toString();
            if (traceId != null && traceId.isNotEmpty) {
              _pendingPlayUrlByTraceId[traceId] = playUrl;
              _attachPlayUrlToAssistantMessage("assistant-$traceId", playUrl);
            }
          }
          final String toolName = payload["toolName"]?.toString() ?? "";
          final bool toolOk = payload["ok"] == true;
          if (isMasterInvokeSubAgentTool(toolName) && result != null) {
            final bool delegateOk = result["ok"] != false;
            if (!toolOk || !delegateOk) {
              _subAgentDelegationActive = false;
              final String err =
                  result["error"]?.toString().trim() ?? "与 Agent 委派失败，请稍后重试";
              if (err.isNotEmpty) {
                _updateAgentStatusLine(err);
              }
            } else {
              final String? uiDoneLine =
                  result["uiDoneLine"]?.toString().trim();
              if (uiDoneLine != null && uiDoneLine.isNotEmpty) {
                _subAgentDelegationActive = false;
                _updateAgentStatusLine(uiDoneLine);
              } else if (result["background"] == true) {
                _subAgentDelegationActive = false;
                final String bgLine =
                    result["message"]?.toString().trim() ?? "助手已在后台处理，稍后会汇总结果";
                _updateAgentStatusLine(bgLine);
              }
            }
          }
          if (toolOk && result != null) {
            try {
              final String normalizedTool = toolName.replaceAll("_", ".");
              if (normalizedTool == "calendar.delete_task") {
                final String? deletedId = result["taskId"]?.toString();
                if (deletedId != null && deletedId.isNotEmpty) {
                  await removeLocalScheduleForDeletedTask(_store, deletedId);
                  _notifyScheduleViewsChanged();
                }
              } else {
                final bool synced = await upsertLocalScheduleFromToolResult(
                  _store,
                  toolName,
                  result,
                );
                if (synced) {
                  _notifyScheduleViewsChanged();
                }
              }
            } catch (e, st) {
              debugPrint("[schedule] tool.result sync failed: $e\n$st");
            }
          }
        }
        if (type == "chat.audio_transcript") {
          // 服务端 ASR 完成后回推转写结果（与 chat.user_message.contentType=audio 对应）。
          // 把 transcript 写回对应 user 消息的 attachment，让语音气泡直接显示识别文本，
          // 方便用户验证 ASR 准确率 + 留有可读副本。
          final String? msgId = payload["messageId"]?.toString();
          if (msgId == null || msgId.isEmpty) return;
          final String transcript = payload["transcript"]?.toString() ?? "";
          final bool ok = payload["ok"] == true;
          if (!ok && transcript.isEmpty) {
            // ASR 失败：用 snackbar 提示，不静默
            if (mounted) {
              ScaffoldMessenger.maybeOf(context)?.showSnackBar(
                SnackBar(
                  content: Text(
                    "ASR 识别失败：${payload["error"]?.toString() ?? "未知原因"}",
                  ),
                ),
              );
            }
            return;
          }
          final int idx = _messages.indexWhere(
            (ChatMessage m) => m.messageId == msgId,
          );
          if (idx < 0) return;
          final ChatMessage prev = _messages[idx];
          // 只更新 audio 类型的 attachment；text 字段不动（audio 消息 text 始终为空）
          final List<MessageAttachment> newAttachments = <MessageAttachment>[];
          for (final MessageAttachment a in prev.attachments) {
            if (a.type == MessageAttachmentType.audio) {
              newAttachments.add(MessageAttachment(
                type: a.type,
                url: a.url,
                durationMs: a.durationMs,
                waveform: a.waveform,
                transcript: transcript,
                mimeType: a.mimeType,
              ));
            } else {
              newAttachments.add(a);
            }
          }
          final ChatMessage updated = ChatMessage(
            messageId: prev.messageId,
            sessionId: prev.sessionId,
            role: prev.role,
            text: prev.text,
            timestamp: prev.timestamp,
            attachmentImageCount: prev.attachmentImageCount,
            playUrl: prev.playUrl,
            attachments: newAttachments,
            contentType: prev.contentType,
            durationMs: prev.durationMs,
            waveform: prev.waveform,
          );
          setState(() {
            _messages[idx] = updated;
          });
          // 异步持久化（失败也不阻塞 UI；saveMessage 内部按 messageId 覆盖）
          unawaited(_store.saveMessage(updated).catchError((Object e) {
            debugPrint("[chat.audio_transcript] saveMessage failed: $e");
          }));
        }
        if (type == "schedule.tasks_changed") {
          try {
            final String action = payload["action"]?.toString() ?? "created";
            final String? taskId = payload["taskId"]?.toString();
            // 服务端推送的日程变更事件（created/updated/deleted）
            // tool.result 路径由 upsertLocalScheduleFromToolResult 处理
            // occurrence 变更以 taskId@<iso> 格式的 id 推送，此处仅处理删除
            // 通过 _scheduleReloadSignal 通知 syncServerRemindersToLocal 刷新
            if (action == "deleted" && taskId != null && taskId.isNotEmpty) {
              await removeLocalScheduleForDeletedTask(_store, taskId);
            }
            await _syncScheduleFromServer();
          } catch (e, st) {
            debugPrint("[schedule] schedule.tasks_changed failed: $e\n$st");
          }
        }
        if (type == "schedule.reminder_fired") {
          try {
            final String title =
                payload["title"]?.toString().trim().isNotEmpty == true
                    ? payload["title"]!.toString().trim()
                    : "提醒";
            final String message =
                payload["message"]?.toString().trim().isNotEmpty == true
                    ? payload["message"]!.toString().trim()
                    : (payload["reminderMessage"]?.toString().trim() ?? "到点了");

            final BuildContext? navCtx = _rootNavigatorKey.currentContext;
            if (navCtx != null && navCtx.mounted) {
              _showReminderPopupDialog(
                navCtx,
                title,
                message,
                "high",
                true,
                "我知道了",
              );
            }

            await _syncScheduleFromServer();
          } catch (e, st) {
            debugPrint("[schedule] schedule.reminder_fired failed: $e\n$st");
          }
        }
        if (type == "chat.agent_status") {
          final String line = payload["line"]?.toString().trim() ?? "";
          if (line.isEmpty) return;
          final String phase = payload["phase"]?.toString() ?? "";
          // 丢弃「已结束轮次」的迟到状态事件：避免在 chat.assistant_done 之后
          // 子 Agent 收尾或网络排队把 _isAgentProcessing 重新点亮，导致底部
          // 「思考中」气泡和真实回复同框出现。
          final String? statusTraceId = payload["traceId"]?.toString();
          final String? activeTraceId = _pendingAgentUserMessageId;
          if (statusTraceId == null ||
              statusTraceId.isEmpty ||
              activeTraceId == null ||
              statusTraceId != activeTraceId) {
            return;
          }
          if (phase == "delegate_start") {
            _subAgentDelegationActive = true;
          } else if (phase == "delegate_done") {
            _subAgentDelegationActive = false;
          }
          // 进度百分比（可选）：长工具心跳推进进度条
          final dynamic rawPercent = payload["percent"];
          final int? percent = rawPercent is num ? rawPercent.toInt() : null;
          _updateAgentStatusLine(line, ensureProcessing: true, percent: percent);
        }
        if (type == "chat.assistant_interim") {
          // 已废弃：被动聊天路径已改为通过 chat.assistant_chunk + phase="interim"
          // 推送首段文本，与主回复共用同一 messageId，不再作为独立消息入列表。
          // 此分支仅保留兼容旧服务端（主动通知路径仍可能发此事件），直接忽略。
        }
        // ===== 「分阶段异步对话交互 v2」三件套 =====
        if (type == "chat.turn_started") {
          // 阶段 0：服务端确认收到，路由开始。客户端用服务端 t0 替换本地占位，
          // 让首字延迟测量更准。
          _handleTurnStartedV2(payload);
        }
        if (type == "chat.intent_detected") {
          // 阶段 1：意图已识别。结构化 mode / plan / subAgents 落到 TurnState。
          _handleIntentDetectedV2(payload);
        }
        if (type == "chat.execution_event") {
          // 阶段 2：执行事件（工具 / 子 Agent / thought / log）。
          _handleExecutionEventV2(payload);
        }
        if (type == "agent.async_task_update") {
          final String taskId = payload["taskId"]?.toString() ?? "";
          final String status = payload["status"]?.toString() ?? "";
          if (status == "running") {
            if (mounted) {
              setState(() {
                if (taskId.isNotEmpty) {
                  _backgroundRunningTaskIds.add(taskId);
                }
              });
            } else {
              if (taskId.isNotEmpty) {
                _backgroundRunningTaskIds.add(taskId);
              }
            }
          }
          if (status == "awaiting_confirmation") {
            _enqueueAsyncConfirmation(payload);
            return;
          }
          await _appendAsyncTaskReportMessage(payload);
        }
        // ===== /v2 =====
        if (type == "chat.assistant_chunk") {
          _resetAgentReplyWatchdog();
          // 丢弃「已结束轮次」的迟到 chunk：避免在 chat.assistant_done 之后
          // 网络重排 / 子 Agent 回调把 _isAgentProcessing 重新点亮。
          final String? chunkAssistantMessageId =
              payload["messageId"]?.toString();
          final String? chunkTraceId = payload["traceId"]?.toString();
          final String? activeTraceId = _pendingAgentUserMessageId;
          if (activeTraceId == null ||
              ((chunkTraceId == null || chunkTraceId.isEmpty) &&
                  (chunkAssistantMessageId == null ||
                      !chunkAssistantMessageId.endsWith(activeTraceId))) ||
              (chunkTraceId != null &&
                  chunkTraceId.isNotEmpty &&
                  chunkTraceId != activeTraceId)) {
            return;
          }
          // 纯流式渲染：phase="interim" 是「垫词 / 主动在场互动」类首段
          //（"好的，我帮你看看…" / presence 闲聊）。多步回复架构下它属于
          // agent 的独立一步（承接 / 边聊边干），应作为独立 assistant 消息入列表，
          // 让用户实时看到 agent 正在回应，而不是被丢弃。
          // 主回复（phase="stream"）则走正常流式渲染路径。
          final String chunkPhase = payload["phase"]?.toString() ?? "";
          if (chunkPhase == "interim") {
            // 仍可借助 _clearInterimAck 清掉旧的 interim ack 气泡（若有）
            _clearInterimAck();
            if (!_isAgentProcessing) {
              setState(() => _isAgentProcessing = true);
              _notifyAgentProcessingUi(true);
            }
            // 与服务端共用同一 trace，但用独立 messageId 渲染为独立气泡，
            // 与主回复分开，形成「垫词 → 互动 → 结果」的多步回复效果。
            // interim 是 LLM 自主生成的完整句子（非 token 流），无需 sanitizer
            // 缓冲，也不应污染 _pendingAssistantChunkText 兜底文本。
            final String interimSeq = payload["sequence"]?.toString() ??
                "${_interimChunkSeq++}";
            final String interimMessageId =
                "interim-$activeTraceId-$interimSeq";
            final String interimChunk = payload["chunk"]?.toString() ?? "";
            if (interimChunk.isEmpty) return;
            _appendChunkToMessageList(interimMessageId, interimChunk);
            return;
          }
          _clearInterimAck();
          if (!_isAgentProcessing) {
            setState(() => _isAgentProcessing = true);
            _notifyAgentProcessingUi(true);
          }
          final String messageId = chunkAssistantMessageId ??
              (activeTraceId.isNotEmpty
                  ? "assistant-$activeTraceId"
                  : "assistant-streaming");
          final String chunk = payload["chunk"]?.toString() ?? "";
          // 关键：chunk 文字直接入列表（新建或续写），让用户实时看到回复内容。
          // 同时进缓冲，供 done 时做兜底比对。
          final String visibleChunk = _enqueueAssistantChunk(messageId, chunk);
          if (visibleChunk.isEmpty) return;
          _appendChunkToMessageList(messageId, visibleChunk);
          // v2：把 chunk 同步累加进 TurnState.streamBuffer（UI 改造后用作流式正文源）
          _turnState?.appendChunk(visibleChunk);
        }
        if (type == "chat.assistant_done") {
          final String? doneTraceId = payload["traceId"]?.toString();
          final String? activeTraceId = _pendingAgentUserMessageId;
          if (doneTraceId != null &&
              doneTraceId.isNotEmpty &&
              activeTraceId != null &&
              doneTraceId != activeTraceId) {
            return;
          }
          final String bufferedText = _takePendingAssistantChunkText();
          // 关键：先在 traceId 上打「本轮已结束」标记，再做后续副作用。
          // 否则清状态与清 traceId 之间存在竞态：迟到的 chunk/agent_status
          // 会看到 _pendingAgentUserMessageId 还有值，重新点亮思考气泡。
          _pendingAgentUserMessageId = null;
          _disarmAgentReplyWatchdog();
          _flushAssistantChunks();
          // v2：done=true 让 _clearAgentProcessingState 内部调 markDone（而非 markCanceled）
          _clearAgentProcessingState(done: true);

          // Phase 2：检测 429 回压（"服务繁忙"），自动指数退避重试
          final String finalTextRaw = payload["finalText"]?.toString() ?? "";
          if (finalTextRaw.contains("服务繁忙") &&
              _pendingRetryText != null &&
              _pendingRetryCount < 3) {
            _pendingRetryCount++;
            final int delaySec = 1 << (_pendingRetryCount - 1); // 1s, 2s, 4s
            debugPrint(
                "[429-retry] 检测到回压，${delaySec}s 后重试 (第 $_pendingRetryCount 次)");
            // 不显示"服务繁忙"消息，保持思考状态
            _isAgentProcessing = true;
            _notifyAgentProcessingUi(true);
            Future.delayed(Duration(seconds: delaySec), () {
              if (mounted && _pendingRetryText != null) {
                final String retryText = _pendingRetryText!;
                _pendingRetryText = null;
                _sendMessage(text: retryText, isRetry: true);
              }
            });
            return;
          }
          // 正常完成或重试次数用尽，清空重试状态
          _pendingRetryText = null;
          _pendingRetryCount = 0;
          final String messageId = payload["messageId"]?.toString() ??
              ((doneTraceId != null && doneTraceId.isNotEmpty)
                  ? "assistant-$doneTraceId"
                  : "assistant-final");
          final String finalText =
              _sanitizeAssistantVisibleText(payload["finalText"]?.toString() ?? "");
          final String fallbackText = "抱歉，我暂时无法生成回复，请稍后重试";
          final String resolvedText = finalText.trim().isNotEmpty
              ? finalText
              : (bufferedText.isNotEmpty ? bufferedText : fallbackText);
          final String traceKey = (doneTraceId?.isNotEmpty == true)
              ? doneTraceId!
              : (messageId.startsWith("assistant-")
                  ? messageId.substring("assistant-".length)
                  : "");
          final String? playUrl = (traceKey.isNotEmpty
                  ? _pendingPlayUrlByTraceId.remove(traceKey)
                  : null) ??
              _playUrlForAssistantMessageId(messageId) ??
              PlayUrlUtils.fromAssistantText(resolvedText);
          final int? idx = _messageIndexById(messageId);
          if (idx != null) {
            // 默认保留流式阶段已经显示出来的正文，避免 done 到来时整段闪烁替换；
            // 但如果 finalText 明显更“最终态”（例如带结构化卡片标记，或当前文本是原始 JSON），
            // 则应覆盖中间态文本，否则会把工具原始返回错误地留在聊天气泡里。
            setState(() {
              final ChatMessage previous = _messages[idx];
              final String currentText = previous.text;
              final String nextText =
                  _shouldReplaceAssistantTextOnDone(currentText, resolvedText)
                      ? resolvedText
                      : currentText;
              final String? existingPlayUrl = previous.playUrl;
              _messages[idx] = ChatMessage(
                messageId: previous.messageId,
                sessionId: previous.sessionId,
                role: previous.role,
                text: nextText,
                timestamp: previous.timestamp,
                attachmentImageCount: previous.attachmentImageCount,
                playUrl: playUrl ?? existingPlayUrl,
                attachments: previous.attachments,
                contentType: previous.contentType,
                durationMs: previous.durationMs,
                waveform: previous.waveform,
              );
            });
            await _store.saveMessage(_messages[idx]);
          } else {
            // 极端边界：完全没收到任何 chunk（只收到 done），用 finalText 兜底
            final ChatMessage finalMessage = ChatMessage(
              messageId: messageId,
              sessionId: ApiConfig.effectiveActorId,
              role: "assistant",
              text: resolvedText,
              timestamp: DateTime.now(),
              playUrl: playUrl,
            );
            setState(() {
              _messages.add(finalMessage);
              _assistantMessageIndexById[messageId] = _messages.length - 1;
            });
            await _store.saveMessage(finalMessage);
          }
          unawaited(_loadAgentProfile());
        }
        if (type == "agent.peer_message") {
          final String messageId =
              payload["messageId"]?.toString() ?? "relay-unknown";
          final String fromSessionId =
              payload["fromSessionId"]?.toString() ?? "";
          final String toSessionId = payload["toSessionId"]?.toString() ?? "";
          final String body = payload["text"]?.toString() ?? "";
          final String? subject = payload["subject"]?.toString();
          final String receivedRaw = payload["receivedAt"]?.toString() ??
              DateTime.now().toIso8601String();
          DateTime receivedAt = DateTime.now();
          try {
            receivedAt = DateTime.parse(receivedRaw);
          } catch (_) {}
          final AgentRelayMessage inbound = AgentRelayMessage(
            messageId: messageId,
            fromSessionId: fromSessionId,
            toSessionId: toSessionId,
            text: body,
            subject: (subject == null || subject.isEmpty) ? null : subject,
            receivedAt: receivedAt,
          );
          setState(() {
            final int dup = _relayInbound
                .indexWhere((AgentRelayMessage x) => x.messageId == messageId);
            if (dup >= 0) {
              _relayInbound[dup] = inbound;
            } else {
              _relayInbound.insert(0, inbound);
            }
          });
          await _store.upsertRelayMessage(ApiConfig.effectiveActorId, inbound);
          if (mounted) {
            ScaffoldMessenger.maybeOf(context)?.showSnackBar(
              SnackBar(
                content: Text("收到来自 $fromSessionId 的中继消息"),
              ),
            );
          }
        }
        // ====== Agent 语音消息（voice.send_message 工具触发）======
        // 服务端推送 `agent.voice.message` 事件，客户端落为一条 assistant
        // 语音消息（contentType=audio + attachments=[audio]），渲染为微信式
        // 可重播语音气泡。mediaUrl 为 null（TTS 失败降级）时退化为纯文本。
        if (type == "agent.voice.message") {
          final String messageId = payload["messageId"]?.toString() ??
              "voice-${DateTime.now().microsecondsSinceEpoch}";
          final String text = payload["text"]?.toString() ?? "";
          final String transcript = payload["transcript"]?.toString() ?? text;
          final String? mediaUrl = payload["mediaUrl"]?.toString();
          final int durationMs = (payload["durationMs"] as num?)?.toInt() ?? 0;
          final String? skippedReason = payload["skippedReason"]?.toString();
          // 去重：同 messageId 已存在则不重复入列表
          final bool exists = _messages.any((m) => m.messageId == messageId);
          if (!exists) {
            final List<MessageAttachment> attachments = <MessageAttachment>[];
            if (mediaUrl != null && mediaUrl.isNotEmpty) {
              attachments.add(MessageAttachment(
                type: MessageAttachmentType.audio,
                url: mediaUrl,
                durationMs: durationMs,
                transcript: transcript.isEmpty ? null : transcript,
                mimeType: "audio/mpeg",
              ));
            }
            final ChatMessage voiceMsg = ChatMessage(
              messageId: messageId,
              sessionId: ApiConfig.effectiveActorId,
              role: "assistant",
              // 有 mediaUrl 时正文留空（避免文字气泡重复展示 transcript）；
              // 无 mediaUrl 时正文回退为 transcript 或失败原因，让用户能看见文字内容
              text: (mediaUrl == null || mediaUrl.isEmpty)
                  ? (transcript.isNotEmpty
                      ? transcript
                      : (skippedReason?.isNotEmpty == true
                          ? "语音消息生成失败：$skippedReason"
                          : "语音消息生成失败"))
                  : "",
              timestamp: DateTime.now(),
              contentType: "audio",
              durationMs: durationMs > 0 ? durationMs : null,
              attachments: attachments,
            );
            setState(() {
              _messages.add(voiceMsg);
              _assistantMessageIndexById[messageId] = _messages.length - 1;
            });
            unawaited(_store.saveMessage(voiceMsg).catchError((Object e) {
              debugPrint("[chat] voice message saveMessage failed: $e");
            }));
          }
        }
        // ====== 振铃前摇阶段（ringing_start） ======
        // Agent 呼叫用户时，先推振铃事件，客户端进入"来电中"动画+倒计时
        if (type == "agent.proactive_message") {
          final String title = payload["title"]?.toString() ?? "Agent 主动联系";
          final String text = payload["text"]?.toString() ?? "";
          if (mounted) {
            final controller = ScaffoldMessenger.maybeOf(context)?.showSnackBar(
              SnackBar(
                content: Text("$title\n$text"),
                duration: const Duration(seconds: 8),
                action: SnackBarAction(
                  label: "知道了",
                  onPressed: () {
                    _sendContactFeedback(
                      channel: "websocket",
                      responded: true,
                      feedback: "positive",
                      quietHours: _isQuietHoursNow(),
                    );
                  },
                ),
              ),
            );
            controller?.closed.then((dynamic reason) {
              if (reason != SnackBarClosedReason.action) {
                _sendContactFeedback(
                  channel: "websocket",
                  responded: false,
                  feedback: "neutral",
                  quietHours: _isQuietHoursNow(),
                );
              }
            });
          }
        }
        if (type == "agent.proactive_voice") {
          final String title = payload["title"]?.toString() ?? "Agent 语音联系";
          final String text = payload["text"]?.toString() ?? "";
          // 取 TTS 音频并播放（修复：原实现仅显示 SnackBar 未播放音频）
          final Object? ttsRaw = payload["tts"];
          String? ttsBase64;
          if (ttsRaw is Map) {
            final Object? fmt = ttsRaw["format"];
            final Object? b64 = ttsRaw["base64"];
            if (fmt?.toString() == "mp3" && b64 is String && b64.isNotEmpty) {
              ttsBase64 = b64;
            }
          }
          if (ttsBase64 != null) {
            unawaited(TtsPlayer.instance.playFromBase64(ttsBase64));
          }
          if (mounted) {
            final controller = ScaffoldMessenger.maybeOf(context)?.showSnackBar(
              SnackBar(
                content: Text("$title\n$text"),
                duration: const Duration(seconds: 10),
                action: SnackBarAction(
                  label: "收到了",
                  onPressed: () {
                    _sendContactFeedback(
                      channel: "voice",
                      responded: true,
                      feedback: "positive",
                      quietHours: _isQuietHoursNow(),
                    );
                  },
                ),
              ),
            );
            controller?.closed.then((dynamic reason) {
              if (reason != SnackBarClosedReason.action) {
                _sendContactFeedback(
                  channel: "voice",
                  responded: false,
                  feedback: "neutral",
                  quietHours: _isQuietHoursNow(),
                );
              }
            });
          }
        }
        // ====== Agent 底层语音能力：voice.speak 工具触发的即时播报 ======
        // 轻量事件：客户端后台播放 TTS 音频，无强制 UI（可选显示简短提示）。
        if (type == "agent.voice.speak") {
          final String text = payload["text"]?.toString() ?? "";
          final Object? ttsRaw = payload["tts"];
          String? ttsBase64;
          if (ttsRaw is Map) {
            final Object? fmt = ttsRaw["format"];
            final Object? b64 = ttsRaw["base64"];
            if (fmt?.toString() == "mp3" && b64 is String && b64.isNotEmpty) {
              ttsBase64 = b64;
            }
          }
          if (ttsBase64 != null) {
            unawaited(TtsPlayer.instance.playFromBase64(ttsBase64));
          } else if (text.isNotEmpty && mounted) {
            // TTS 未启用兜底：用 SnackBar 显示文本
            ScaffoldMessenger.maybeOf(context)?.showSnackBar(
              SnackBar(
                content: Text(text),
                duration: const Duration(seconds: 6),
              ),
            );
          }
        }
        // ====== Agent 底层语音能力：voice.speak 工具触发的提醒式播报 ======
        // 带标题/优先级，客户端显示卡片 + 播放音频。
        if (type == "agent.voice.alarm") {
          final String title = payload["title"]?.toString() ?? "语音提醒";
          final String text = payload["text"]?.toString() ?? "";
          final String priority = payload["priority"]?.toString() ?? "medium";
          final Object? ttsRaw = payload["tts"];
          String? ttsBase64;
          if (ttsRaw is Map) {
            final Object? fmt = ttsRaw["format"];
            final Object? b64 = ttsRaw["base64"];
            if (fmt?.toString() == "mp3" && b64 is String && b64.isNotEmpty) {
              ttsBase64 = b64;
            }
          }
          if (ttsBase64 != null) {
            unawaited(TtsPlayer.instance.playFromBase64(ttsBase64));
          }
          if (mounted) {
            ScaffoldMessenger.maybeOf(context)?.showSnackBar(
              SnackBar(
                content: Text("[$priority] $title\n$text"),
                duration: const Duration(seconds: 8),
              ),
            );
          }
        }
        if (type == "agent.phone.ringing_start") {
          if (!mounted) return;
          final String direction =
              payload["direction"]?.toString() ?? "agent_to_user";
          final String ringStyle =
              payload["ringStyle"]?.toString() ?? "reminder";
          final String callerLabel = VoiceCallUiLabels.incomingCallerLabel(
            direction: direction,
            fromPhone: payload["fromPhone"]?.toString(),
          );
          final int ringMs =
              (payload["ringDurationMs"] as num?)?.toInt() ?? 30000;

          setState(() {
            _phoneCallStatus = "ringing";
            _phoneCallToActorId = callerLabel;
          });

          // 唤起独立悬浮来电窗（脱离主窗口存在，主窗最小化也能看到 + 听到铃声）。
          // Windows 桌面端走原生 Win32 窗；其他平台由 IncomingCallLauncher
          // 内部 MissingPluginException 兜底，silently return false。
          unawaited(OutgoingCallLauncher.hide());
          unawaited(ConnectedCallLauncher.hide());
          unawaited(
            IncomingCallLauncher.show(
              callerName: callerLabel,
              subtitle: ringStyle == "reminder" ? "语音提醒" : "来电中",
              callerInitial:
                  callerLabel.isNotEmpty ? callerLabel.characters.first : "A",
              ringTimeoutMs: ringMs,
            ),
          );
        }

        // ====== 电话接通事件（call_connecting）—— 前摇结束后推送 ======
        // 包含 TTS 音频（base64 mp3）。
        // 设计：接通后不弹任何嵌入式 UI，改用独立的 Win32 "通话中"窗口
        // （仿电脑微信电话：头像 + 名称 + 计时 + 静音/免提/挂断）。
        // TTS 音频在后台播；头像呼吸光晕随 TTS 播放节奏。
        if (type == "agent.phone.call_connecting") {
          final String direction =
              payload["direction"]?.toString() ?? "agent_to_user";
          final String fromPhone = payload["fromPhone"]?.toString() ?? "";
          final String callerLabel = VoiceCallUiLabels.incomingCallerLabel(
            direction: direction,
            fromPhone: fromPhone,
          );

          if (!mounted) return;
          setState(() {
            _phoneCallStatus = "connected";
            _phoneCallToActorId = callerLabel;
            _phoneMuted = false;
            _phoneSpeakerOn = true;
          });

          // 关掉来电/拨号时可能残留的过渡弹窗
          final BuildContext? navCtx = _rootNavigatorKey.currentContext;
          if (navCtx != null && navCtx.mounted) {
            final nav = Navigator.of(navCtx, rootNavigator: true);
            int maxPops = 10;
            while (nav.canPop() && maxPops-- > 0 && navCtx.mounted) {
              nav.pop();
            }
          }

          // 弹独立"通话中"窗口
          unawaited(IncomingCallLauncher.hide());
          unawaited(OutgoingCallLauncher.hide());
          unawaited(
            ConnectedCallLauncher.show(
              callerName: callerLabel,
              callerInitial:
                  callerLabel.isNotEmpty ? callerLabel.characters.first : "A",
            ),
          );

          // 取 TTS 音频（mp3 base64），后台播放；同时开启头像呼吸光
          final Object? ttsRaw = payload["tts"];
          String? ttsBase64;
          if (ttsRaw is Map) {
            final Object? fmt = ttsRaw["format"];
            final Object? b64 = ttsRaw["base64"];
            if (fmt?.toString() == "mp3" && b64 is String && b64.isNotEmpty) {
              ttsBase64 = b64;
            }
          }

          if (ttsBase64 != null) {
            unawaited(TtsPlayer.instance.playFromBase64(ttsBase64));
            unawaited(ConnectedCallLauncher.setTalking(true));
            // TTS 播完自动关掉呼吸光（TtsPlayer 完成后回调）
            TtsPlayer.instance.addOnCompleted(_onTtsCompleted);
          }
        }

        // ====== 提醒弹窗事件（reminder_popup）—— 服务端 popup 级别提醒 ======
        if (type == "reminder_popup") {
          final String title = payload["title"]?.toString() ?? "提醒";
          final String message = payload["message"]?.toString() ?? "";
          final String priority = payload["priority"]?.toString() ?? "normal";
          final bool showConfirm = payload["showConfirmButton"] == true;
          final String confirmText =
              payload["confirmText"]?.toString() ?? "我知道了";

          final BuildContext? navCtx = _rootNavigatorKey.currentContext;
          if (navCtx != null && navCtx.mounted) {
            _showReminderPopupDialog(
                navCtx, title, message, priority, showConfirm, confirmText);
          }
        }

        // ====== Legacy 来电事件（agent.phone.incoming）—— 无前摇直接来电 ======
        // 与 ringing_start 统一走原生悬浮窗，不再使用嵌入式 Flutter dialog
        if (type == "agent.phone.incoming") {
          final String direction = payload["direction"]?.toString() ?? "";
          final String ringStyle = payload["ringStyle"]?.toString() ?? "peer";
          final bool userActionRequired = payload["userActionRequired"] == true;
          final bool isPeerIncoming = userActionRequired ||
              (direction == "agent_to_agent" && ringStyle == "peer");
          if (isPeerIncoming && direction != "agent_to_user") {
            _presentPeerAgentIncoming(payload);
            return;
          }
          final String fromPhone = payload["fromPhone"]?.toString() ?? "";
          final String callerLabel = VoiceCallUiLabels.incomingCallerLabel(
            direction: direction,
            fromPhone: fromPhone,
          );
          final int ringMs =
              (payload["ringDurationMs"] as num?)?.toInt() ?? 30000;

          if (!mounted) return;
          setState(() {
            _phoneCallStatus = "ringing";
            _phoneCallToActorId = callerLabel;
          });

          // 统一走原生独立悬浮窗
          unawaited(
            IncomingCallLauncher.show(
              callerName: callerLabel,
              subtitle: ringStyle == "reminder" ? "语音提醒" : "来电中",
              callerInitial:
                  callerLabel.isNotEmpty ? callerLabel.characters.first : "A",
              ringTimeoutMs: ringMs,
            ),
          );
        }
        if (type == "morning.briefing") {
          await _handleMorningBriefingEvent(payload);
        }
        if (type == "agent.phone.call_status") {
          final String status = payload["status"]?.toString() ?? "unknown";
          final String toActorId = payload["toActorId"]?.toString() ?? "";
          final String? fromPhone = payload["fromPhone"]?.toString();
          if (!mounted) return;
          final bool shouldClearPhoneState =
              status == "ended" || status == "agent_handled";
          setState(() {
            if (fromPhone != null && fromPhone.isNotEmpty) {
              _phoneCallToActorId = VoiceCallUiLabels.incomingCallerLabel(
                direction: payload["direction"]?.toString() ?? "agent_to_agent",
                fromPhone: fromPhone,
              );
            } else {
              _phoneCallToActorId =
                  toActorId.isNotEmpty ? toActorId : _phoneCallToActorId;
            }
            if (shouldClearPhoneState) {
              // 通话结束：立刻清状态
              _phoneCallStatus = null;
              _phoneCallToActorId = null;
              _peerIncomingDialogCallId = null;
              _phoneMuted = false;
              _phoneSpeakerOn = true;
            } else if (status == "answered_by_user") {
              _phoneCallStatus = "connected";
            } else {
              _phoneCallStatus = status;
            }
          });
          if (status == "answered_by_user") {
            _sendContactFeedback(
              channel: "phone_call",
              responded: true,
              feedback: "positive",
              quietHours: _isQuietHoursNow(),
            );
          }
          if (shouldClearPhoneState) {
            // 通话结束/转交：摘掉 TTS 完成回调 + 停 TTS + 关独立"通话中"窗口
            // （不弹任何 UI；清状态由原生 hangup 回调或后续事件统一处理）
            TtsPlayer.instance.removeOnCompleted(_onTtsCompleted);
            unawaited(TtsPlayer.instance.stop());
            unawaited(IncomingCallLauncher.hide());
            unawaited(OutgoingCallLauncher.hide());
            unawaited(ConnectedCallLauncher.hide());
          }
        }
        if (type == "desktop.bridge.sync") {
          final bool? on = payload["bridgeOnline"] as bool?;
          final Map<String, dynamic>? lt =
              (payload["lastTask"] as Map?)?.cast<String, dynamic>();
          final String? nextSummary = lt == null
              ? null
              : (lt["summary"]?.toString() ?? lt["error"]?.toString());
          final String? previousSummary = _desktopBridgeLastSummary;
          setState(() {
            _desktopBridgeOnline = on;
            _desktopBridgeLastSummary = nextSummary;
          });
          if (nextSummary != null &&
              nextSummary.trim().isNotEmpty &&
              nextSummary != previousSummary) {
            _showDesktopBridgeToast(
              on == false ? "桌面同步: $nextSummary" : "桌面同步: $nextSummary",
            );
          }
        }

        if (type == "wallet.simulate.result") {
          final double nextBalance =
              (payload["ledger"]?["balance"] as num?)?.toDouble() ?? _balance;
          final double nextFrozen =
              (payload["ledger"]?["frozen"] as num?)?.toDouble() ?? _frozen;
          setState(() {
            _balance = nextBalance;
            _frozen = nextFrozen;
            _ledger.insert(
              0,
              WalletLedgerItem(
                id: payload["auditId"]?.toString() ?? DateTime.now().toString(),
                action: payload["action"]?.toString() ?? "wallet_action",
                amount: (payload["amount"] as num?)?.toDouble() ?? 0,
                success: payload["ok"] as bool? ?? false,
                createdAt: DateTime.now(),
                reason: payload["reason"]?.toString(),
              ),
            );
          });
        }
      } catch (e, st) {
        debugPrint("[ws] event handler failed for $type: $e\n$st");
      }
    });
  }

  /// 主服务恢复后补删离线队列中的服务端日程删除/同步
  Future<void> _flushScheduleOfflineDeletes() async {
    final ScheduleOfflineDeleteFlushResult result =
        await flushScheduleOfflineDeleteQueue(_store, _scheduleApi);
    if (result.flushed > 0) {
      _notifyScheduleViewsChanged();
    }
  }

  void _notifyScheduleViewsChanged() {
    _scheduleReloadSignal.value += 1;
    _calendarReloadSignal.value += 1;
  }

  /// 今日安排面板数据刷新：把「已设置的安排」（本地日程中的今日事项）
  /// 接进右侧面板的 FutureBuilder，数据变化时重新构建 future 并 setState。
  void _onScheduleReloadSignal() {
    if (!mounted) return;
    setState(() {
      _cachedScheduleFuture = _loadTodayScheduleFuture();
    });
  }

  Future<List<ScheduleEvent>> _loadTodayScheduleFuture() {
    final DateTime now = DateTime.now();
    return _store
        .listScheduleEventsForDay(DateTime(now.year, now.month, now.day));
  }

  Future<void> _syncScheduleFromServer() async {
    final String sessionId = ApiConfig.effectiveActorId.trim();
    if (sessionId.isEmpty) {
      _notifyScheduleViewsChanged();
      return;
    }
    try {
      await syncServerRemindersToLocal(_store, _scheduleApi, sessionId);
    } catch (e, st) {
      debugPrint("[schedule] syncServerRemindersToLocal failed: $e\n$st");
    } finally {
      _notifyScheduleViewsChanged();
    }
  }

  String? _playUrlForAssistantMessageId(String messageId) {
    final String? traceKey = messageId.startsWith("assistant-")
        ? messageId.substring("assistant-".length)
        : null;
    if (traceKey != null) {
      final String? pending = _pendingPlayUrlByTraceId[traceKey];
      if (pending != null) return pending;
    }
    final int? idx = _messageIndexById(messageId);
    if (idx == null) return null;
    return _messages[idx].playUrl;
  }

  String _enqueueAssistantChunk(String messageId, String chunk) {
    if (chunk.isEmpty) return "";
    if (_pendingAssistantChunkMessageId != null &&
        _pendingAssistantChunkMessageId != messageId) {
      _flushAssistantChunks();
      _pendingAssistantChunkText.clear();
      _assistantTextSanitizer.reset();
    }
    _pendingAssistantChunkMessageId = messageId;
    final String visibleChunk = _assistantTextSanitizer.ingest(chunk);
    if (visibleChunk.isEmpty) return "";
    _pendingAssistantChunkText.write(visibleChunk);
    _assistantChunkFlushTimer ??= Timer(const Duration(milliseconds: 32), () {
      _assistantChunkFlushTimer = null;
      _flushAssistantChunks();
    });
    return visibleChunk;
  }

  /// 把 chunk 文字直接追加到消息列表（新建或续写），实现"边说边看"效果。
  /// 与 _enqueueAssistantChunk 配合：前者管缓冲（供 done 兜底），后者管显示。
  void _appendChunkToMessageList(String messageId, String chunk) {
    if (chunk.isEmpty) return;
    // 用带兜底的索引查询：即使索引失真也能命中已存在的消息，避免重复插入
    final int? existingIdx = _messageIndexById(messageId);
    if (existingIdx != null && existingIdx < _messages.length) {
      // 续写已存在的消息
      setState(() {
        final ChatMessage previous = _messages[existingIdx];
        _messages[existingIdx] = ChatMessage(
          messageId: previous.messageId,
          sessionId: previous.sessionId,
          role: previous.role,
          text: previous.text + chunk,
          timestamp: previous.timestamp,
          attachmentImageCount: previous.attachmentImageCount,
          playUrl: previous.playUrl,
          // 流式追加中，保持 streaming 标志，渲染层打字机持续逐字展示
          streaming: previous.streaming,
        );
      });
    } else {
      // 新建一条 assistant 消息入列表（streaming=true：渲染层从头做打字机效果，
      // 等 chat.assistant_done 重建消息时该标志自动回落为 false）
      final ChatMessage newMsg = ChatMessage(
        messageId: messageId,
        sessionId: ApiConfig.effectiveActorId,
        role: "assistant",
        text: chunk,
        timestamp: DateTime.now(),
        streaming: true,
      );
      setState(() {
        _messages.add(newMsg);
        _assistantMessageIndexById[messageId] = _messages.length - 1;
      });
      unawaited(_store.saveMessage(newMsg).catchError((Object e) {
        debugPrint("[chat] chunk saveMessage failed: $e");
      }));
    }
  }

  void _flushAssistantChunks() {
    // 关键设计变更：流式阶段（agent 还在干活、思考气泡还在）期间，
    // **不要把 chunk 拼到消息列表**——避免用户看到「思考中」和「回复正文」同框。
    // 只清空缓冲，文本留到 chat.assistant_done 拿到 finalText 后再一次性入列表。
    // 缓冲本身仍保留（被 _handleAgentReplyTimeout / _sendMessage 中断分支用作
    // _interruptedResponses / 兜底文本）。
    _assistantChunkFlushTimer?.cancel();
    _assistantChunkFlushTimer = null;
    _pendingAssistantChunkMessageId = null;
  }

  String _takePendingAssistantChunkText() {
    final String buffered = _pendingAssistantChunkText.toString().trim();
    final String pending = _assistantTextSanitizer.drainPending().trim();
    _pendingAssistantChunkText.clear();
    _assistantTextSanitizer.reset();
    if (buffered.isEmpty) return pending;
    if (pending.isEmpty) return buffered;
    return buffered + pending;
  }

  String _sanitizeAssistantVisibleText(String text) {
    return stripAssistantProtocolFrames(text);
  }

  bool _shouldReplaceAssistantTextOnDone(
    String streamedText,
    String finalText,
  ) {
    final String current = streamedText.trim();
    final String resolved = finalText.trim();
    if (resolved.isEmpty) return false;
    if (current.isEmpty) return true;
    if (current == resolved) return false;
    if (_containsStructuredAssistantMarkers(resolved)) return true;
    if (_looksLikeRawToolJson(current) && !_looksLikeRawToolJson(resolved)) {
      return true;
    }
    return false;
  }

  bool _containsStructuredAssistantMarkers(String text) {
    return text.contains("[CONTENT_SUMMARY_V2_START]") ||
        text.contains("[AGENT_RESULT_CARD_START]");
  }

  bool _looksLikeRawToolJson(String text) {
    final String trimmed = text.trimLeft();
    if (!trimmed.startsWith("{")) return false;
    return trimmed.contains('"items"') &&
        (trimmed.contains('"snippet"') ||
            trimmed.contains('"publishedAt"') ||
            trimmed.contains('"searchDateLocal"'));
  }

  ChatMessage _sanitizeLoadedChatMessage(ChatMessage message) {
    if (message.role != "assistant") return message;
    final String sanitizedText = _sanitizeAssistantVisibleText(message.text);
    if (sanitizedText == message.text) return message;
    return ChatMessage(
      messageId: message.messageId,
      sessionId: message.sessionId,
      role: message.role,
      text: sanitizedText,
      timestamp: message.timestamp,
      attachmentImageCount: message.attachmentImageCount,
      playUrl: message.playUrl,
      attachments: message.attachments,
      contentType: message.contentType,
      durationMs: message.durationMs,
      waveform: message.waveform,
    );
  }

  void _clearAgentProcessingState({bool done = false}) {
    if (!_isAgentProcessing &&
        _agentStatusLine == null &&
        _agentStatusPercent == null &&
        _interimAckText == null &&
        !_subAgentDelegationActive &&
        _turnState == null &&
        _pendingLocalTurn == null) {
      return;
    }
    setState(() {
      _isAgentProcessing = false;
      _agentStatusLine = null;
      _agentStatusPercent = null;
      _interimAckText = null;
      _subAgentDelegationActive = false;
      // v2：按调用方语义收尾 TurnState。
      // - done=true（chat.assistant_done）：markDone，UI 顶栏切「已收尾」后消失
      // - done=false（timeout/error/中断）：markCanceled，UI 顶栏切「已停止」后消失
      if (done) {
        _turnState?.markDone();
      } else {
        _turnState?.markCanceled();
      }
      _turnState = null;
      _pendingLocalTurn = null;
    });
    _notifyAgentProcessingUi(false);
  }

  /// v2：用户点 TurnPanel 顶栏「停止」按钮时的软取消。
  /// 不发 WS 事件——只本地清状态，让后续 chunk/agent_status 因 traceId 不匹配被过滤。
  /// 服务端 LLM 调用仍在后台跑（无法硬中断），但客户端不再接收/渲染。
  void _cancelCurrentTurn() {
    if (!_isAgentProcessing) return;
    _disarmAgentReplyWatchdog();
    _pendingAgentUserMessageId = null;
    _flushAssistantChunks();
    _takePendingAssistantChunkText();
    _clearAgentProcessingState(done: false);
  }

  /// interim 已改为作为独立 assistant 消息入列表（见 chat.assistant_interim
  /// handler），_interimAckText 字段不再被设置；_clearInterimAck 保留为 no-op
  /// 兼容旧调用点（chunk handler）。
  void _clearInterimAck() {
    if (_interimAckText == null) return;
    setState(() {
      _interimAckText = null;
    });
  }

  // ============================================================
  // 「分阶段异步对话交互 v2」事件 handlers
  // 骨架：仅在内存里把事件流跑通并维护 _turnState。
  // UI 改造（chat_page 接 TurnState 渲染顶栏 / 折叠面板 / 流式正文）下一轮再做。
  // ============================================================

  /// 阶段 0：服务端确认收到，路由开始。
  /// 用服务端 t0 替换本地占位（让首字延迟测量更准）；
  /// 若 traceId 与本轮不匹配或已无活动轮次，丢弃。
  void _handleTurnStartedV2(Map<String, dynamic> payload) {
    final String? traceId = payload["traceId"]?.toString();
    final String? activeTraceId = _pendingAgentUserMessageId;
    if (traceId == null ||
        traceId.isEmpty ||
        activeTraceId == null ||
        traceId != activeTraceId) {
      return;
    }
    final dynamic t0Raw = payload["t0"];
    final DateTime t0 = t0Raw is num
        ? DateTime.fromMillisecondsSinceEpoch(t0Raw.toInt())
        : DateTime.now();
    // 替换本地占位为服务端权威 t0
    _turnState = TurnState(
      traceId: traceId,
      sessionId: payload["sessionId"]?.toString() ?? "",
      t0: t0,
      phase: TurnPhase.routing,
    );
    _pendingLocalTurn = null;
    if (mounted) setState(() {});
  }

  /// 阶段 1：意图已识别。mode / plan / subAgents 落到 TurnState。
  void _handleIntentDetectedV2(Map<String, dynamic> payload) {
    final String? traceId = payload["traceId"]?.toString();
    final String? activeTraceId = _pendingAgentUserMessageId;
    if (traceId == null ||
        traceId.isEmpty ||
        activeTraceId == null ||
        traceId != activeTraceId) {
      return;
    }
    final TurnState? ts = _turnState;
    if (ts == null || ts.traceId != traceId) return;

    final List<dynamic> reasonsRaw =
        (payload["reasons"] as List<dynamic>?) ?? const <dynamic>[];
    final List<dynamic> planRaw =
        (payload["plan"] as List<dynamic>?) ?? const <dynamic>[];
    final List<dynamic> subAgentsRaw =
        (payload["subAgents"] as List<dynamic>?) ?? const <dynamic>[];

    setState(() {
      ts.applyIntentDetected(
        mode: TurnIntentMode.fromWire(payload["mode"]?.toString()),
        reasons: reasonsRaw.map((e) => e.toString()).toList(),
        plan: planRaw
            .whereType<Map<String, dynamic>>()
            .map(TurnPlanStep.fromWire)
            .toList(),
        subAgents: subAgentsRaw
            .whereType<Map<String, dynamic>>()
            .map(TurnSubAgent.fromWire)
            .toList(),
      );
    });
  }

  /// 阶段 2：执行事件（工具调用 / 子 Agent / thought / log 兜底）。
  void _handleExecutionEventV2(Map<String, dynamic> payload) {
    final String? traceId = payload["traceId"]?.toString();
    final String? activeTraceId = _pendingAgentUserMessageId;
    if (traceId == null ||
        traceId.isEmpty ||
        activeTraceId == null ||
        traceId != activeTraceId) {
      return;
    }
    final TurnState? ts = _turnState;
    if (ts == null || ts.traceId != traceId) return;

    final String kind = payload["kind"]?.toString() ?? "log";
    final String? eventId = payload["eventId"]?.toString();
    if (eventId == null) return;

    setState(() {
      ts.applyExecutionEvent(
        eventId: eventId,
        kind: kind,
        toolCall: payload["toolCall"] is Map<String, dynamic>
            ? payload["toolCall"] as Map<String, dynamic>
            : null,
        toolResult: payload["toolResult"] is Map<String, dynamic>
            ? payload["toolResult"] as Map<String, dynamic>
            : null,
        agentStart: payload["agentStart"] is Map<String, dynamic>
            ? payload["agentStart"] as Map<String, dynamic>
            : null,
        agentDone: payload["agentDone"] is Map<String, dynamic>
            ? payload["agentDone"] as Map<String, dynamic>
            : null,
        planStep: payload["planStep"] is Map<String, dynamic>
            ? payload["planStep"] as Map<String, dynamic>
            : null,
        thought: payload["thought"]?.toString(),
        log: payload["log"]?.toString(),
      );
    });
  }

  /// 与聊天页「处理中」气泡同步；active=false 时服务端锁定本轮不再合并消息）
  void _notifyAgentProcessingUi(bool active) {
    if (_reportedAgentProcessingUiActive == active) return;
    _reportedAgentProcessingUiActive = active;
    if (!_ws.isConnected) return;
    final Map<String, dynamic> payload = <String, dynamic>{
      "sessionId": ApiConfig.sessionId,
      "active": active,
    };
    final String uid = ApiConfig.userId.trim();
    if (uid.isNotEmpty) {
      payload["userId"] = uid;
    }
    _ws.sendEvent("chat.agent_processing_ui", payload);
  }

  void _armAgentReplyWatchdog(String userMessageId) {
    _pendingAgentUserMessageId = userMessageId;
    _agentReplyWatchdog?.cancel();
    _agentReplyWatchdog = Timer(_agentReplyTimeout, _handleAgentReplyTimeout);
  }

  void _resetAgentReplyWatchdog() {
    if (_pendingAgentUserMessageId == null) return;
    _agentReplyWatchdog?.cancel();
    _agentReplyWatchdog = Timer(_agentReplyTimeout, _handleAgentReplyTimeout);
  }

  void _disarmAgentReplyWatchdog() {
    _agentReplyWatchdog?.cancel();
    _agentReplyWatchdog = null;
  }

  void _handleAgentReplyTimeout({bool showSnackBar = true}) {
    if (!mounted) return;
    final bool wasProcessing = _isAgentProcessing;
    final String buffered = _pendingAssistantChunkText.toString().trim();
    // 关键：和 chat.assistant_done 一样，traceId 一定要先于 _clearAgentProcessingState
    // 清掉，否则迟到的 chunk 会看到 _isAgentProcessing=false 但 traceId 还在，
    // 重新把思考气泡点亮。
    final String? userMessageId = _pendingAgentUserMessageId;
    _pendingAgentUserMessageId = null;
    _flushAssistantChunks();
    final String assistantMessageId = userMessageId != null
        ? "assistant-$userMessageId"
        : "assistant-timeout-${DateTime.now().microsecondsSinceEpoch}";
    const String fallbackText = "抱歉，等待回复超时，请稍后重试";
    final int? idx = _messageIndexById(assistantMessageId);
    if (idx != null) {
      setState(() {
        final ChatMessage previous = _messages[idx];
        if (previous.text.trim().isEmpty) {
          _messages[idx] = ChatMessage(
            messageId: previous.messageId,
            sessionId: previous.sessionId,
            role: previous.role,
            text: fallbackText,
            timestamp: previous.timestamp,
            attachmentImageCount: previous.attachmentImageCount,
            playUrl: previous.playUrl,
          );
        }
      });
    } else if (wasProcessing || userMessageId != null) {
      // 新语义：流式期间 chunk 没进列表，超时分支是 agent 文本能进列表的唯一入口。
      // 优先用 _pendingAssistantChunkText 里已经缓冲到的部分流式片段作为兜底文
      // 本；如果缓冲是空的（连一个 chunk 都没收到），才用纯兜底文案。
      final String timeoutText =
          buffered.isNotEmpty ? "$buffered\n\n⚠️ 后续内容超时未到，已截断。" : fallbackText;
      final ChatMessage timeoutMessage = ChatMessage(
        messageId: assistantMessageId,
        sessionId: ApiConfig.effectiveActorId,
        role: "assistant",
        text: timeoutText,
        timestamp: DateTime.now(),
      );
      setState(() {
        _messages.add(timeoutMessage);
        _assistantMessageIndexById[assistantMessageId] = _messages.length - 1;
      });
      unawaited(_store.saveMessage(timeoutMessage));
    }
    _takePendingAssistantChunkText();
    _clearAgentProcessingState();
    _disarmAgentReplyWatchdog();
    if (showSnackBar && wasProcessing) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        const SnackBar(content: Text("Agent 回复超时，请检查网络或稍后重试")),
      );
    }
  }

  void _updateAgentStatusLine(
    String line, {
    bool ensureProcessing = false,
    int? percent,
  }) {
    final String trimmed = line.trim();
    if (trimmed.isEmpty) return;
    _resetAgentReplyWatchdog();
    setState(() {
      if (ensureProcessing) {
        _isAgentProcessing = true;
      }
      _agentStatusLine = trimmed;
      // 进度百分比：null 表示该事件不带进度（保持上次值或清为 null）
      _agentStatusPercent = percent;
    });
    if (ensureProcessing) {
      _notifyAgentProcessingUi(true);
    }
  }

  void _attachPlayUrlToAssistantMessage(String messageId, String playUrl) {
    final int? idx = _messageIndexById(messageId);
    if (idx == null) return;
    final ChatMessage previous = _messages[idx];
    if (previous.playUrl == playUrl) return;
    setState(() {
      _messages[idx] = ChatMessage(
        messageId: previous.messageId,
        sessionId: previous.sessionId,
        role: previous.role,
        text: previous.text,
        timestamp: previous.timestamp,
        attachmentImageCount: previous.attachmentImageCount,
        playUrl: playUrl,
      );
    });
  }

  /// 首次在「无相册附件」的发送路径上询问一次；结果写入本地，之后不再弹窗询问
  Future<void> _pickGalleryImage() async {
    final List<VisionWireFrame> frames = await pickGalleryVisionWireFrames();
    if (!mounted || frames.isEmpty) {
      return;
    }
    setState(() {
      _pendingGalleryFrames
        ..clear()
        ..addAll(frames);
    });
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text("已选择 ${frames.length} 张图片，发送时将一并传与 Agent")),
    );
  }

  void _clearPendingGalleryFrames() {
    if (_pendingGalleryFrames.isEmpty) {
      return;
    }
    setState(_pendingGalleryFrames.clear);
  }

  Future<void> _reportEmbodimentState() async {
    if (!_ws.isConnected || !mounted) return;
    final BuildContext? ctx = _rootNavigatorKey.currentContext;
    final double dpr = ctx != null ? MediaQuery.devicePixelRatioOf(ctx) : 1.0;
    final Map<String, dynamic>? report =
        await SphereEntityController.instance.collectStateReport(dpr);
    if (report == null) return;
    _ws.sendEvent("agent.embodiment.state", report);
  }

  void _syncAgentSphereFromWs(String type, Map<String, dynamic> payload) {
    if (type == "agent.embodiment.command") {
      final String? action = payload["action"]?.toString();
      if (action == "query_state") {
        unawaited(_reportEmbodimentState());
        return;
      }
      AgentSphereMoodBridge.instance.forwardMessage(<String, dynamic>{
        "type": "agent-sphere:command",
        "action": payload["action"],
        if (payload["x"] != null) "x": payload["x"],
        if (payload["y"] != null) "y": payload["y"],
        if (payload["z"] != null) "z": payload["z"],
        if (payload["strength"] != null) "strength": payload["strength"],
        if (payload["screenX"] != null) "screenX": payload["screenX"],
        if (payload["screenY"] != null) "screenY": payload["screenY"],
      });
      return;
    }
    final AgentSpherePatch? patch =
        AgentSphereEmbodimentMapper.mapWsEvent(type, payload);
    if (patch != null) {
      AgentSphereMoodBridge.instance.applyEmbodimentPatch(patch);
    }
  }

  void _sendSessionInit() {
    final Map<String, dynamic> sessionInit = <String, dynamic>{
      "sessionId": ApiConfig.sessionId,
      "deviceId": "local-device",
      "userAlias": "owner",
    };
    final String uid = ApiConfig.userId.trim();
    if (uid.isNotEmpty) {
      sessionInit["userId"] = uid;
    }
    _ws.sendEvent("session.init", sessionInit);
  }

  Future<void> _sendMessage({String? text, bool isRetry = false}) async {
    if (!_ws.isConnected) {
      _ws.retryConnect();
      if (mounted) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          const SnackBar(content: Text("正在连接服务器，请稍后再发消息")),
        );
      }
      return;
    }
    final String effectiveText = text ?? _inputController.text.trim();

    List<VisionWireFrame>? attachmentFrames;
    if (_pendingGalleryFrames.isNotEmpty) {
      attachmentFrames = List<VisionWireFrame>.from(_pendingGalleryFrames);
      setState(_pendingGalleryFrames.clear);
    }

    if (effectiveText.isEmpty && attachmentFrames == null) {
      return;
    }

    // 如果Agent正在处理中，说明用户要打断当前回复
    if (_isAgentProcessing) {
      final String interruptedText = _takePendingAssistantChunkText();
      if (interruptedText.isNotEmpty) {
        _interruptedResponses.add(interruptedText);
      }

      _disarmAgentReplyWatchdog();
      _pendingAgentUserMessageId = null;
      _clearAgentProcessingState(done: false);
      _assistantChunkFlushTimer?.cancel();
      _assistantChunkFlushTimer = null;
      _pendingAssistantChunkMessageId = null;
    }

    final int attachCount = attachmentFrames?.length ?? 0;
    final ChatMessage userMessage = ChatMessage(
      messageId: "msg-${DateTime.now().microsecondsSinceEpoch}",
      sessionId: ApiConfig.effectiveActorId,
      role: "user",
      text: effectiveText.isEmpty ? "（见图）" : effectiveText,
      timestamp: DateTime.now(),
      attachmentImageCount: attachCount,
    );

    // Phase 2：保存重试文本，供 429 回压时指数退避重发
    _pendingRetryText = effectiveText;
    if (isRetry) {
      // 重试时不重复添加用户消息（首次已添加）
    } else {
      setState(() {
        _messages.add(userMessage);
        _inputController.clear();
        _isAgentProcessing = true;
        _agentStatusLine = null;
      });
    }
    _notifyAgentProcessingUi(true);
    AgentSphereMoodBridge.instance.listening();
    if (!isRetry) {
      await _store.saveMessage(userMessage);
    }
    final Map<String, dynamic> userMsg = <String, dynamic>{
      "sessionId": ApiConfig.sessionId,
      "messageId": userMessage.messageId,
      "text": effectiveText.isEmpty && attachmentFrames != null
          ? ""
          : effectiveText,
      "timestamp": DateTime.now().toIso8601String(),
    };
    if (attachmentFrames != null && attachmentFrames.isNotEmpty) {
      userMsg["visionFrames"] =
          attachmentFrames.map((VisionWireFrame f) => f.toJson()).toList();
    }
    if (ApiConfig.userId.trim().isNotEmpty) {
      userMsg["userId"] = ApiConfig.userId.trim();
    }

    // 位置不再随每条消息实时拉取（避免每次发消息都走 GPS + 逆地理）。
    // 改为按需：Agent 需要位置（如 weather.get_local 工具）时服务端下发
    // agent.location_request，客户端响应后实时回传；天气面板也会主动上报缓存。
    userMsg["agentAccessMode"] = "full";

    // 如果有被打断的回复，将其添加到消息上下文中（作为系统提示文本
    if (_interruptedResponses.isNotEmpty) {
      final String interruptedContext =
          _interruptedResponses.join("\n\n--- 用户打断 ---\n\n");
      userMsg["interruptedContext"] = interruptedContext;
      // 清空已整合的打断历史
      _interruptedResponses.clear();
    }

    _armAgentReplyWatchdog(userMessage.messageId);

    // v2 阶段 0：本地立即建占位 TurnState，让用户感知到「已发送 / 正在思考」，
    // 不等服务端 chat.turn_started 回来（豆包式即时反馈的关键）。
    _pendingLocalTurn = TurnState(
      traceId: userMessage.messageId,
      sessionId: ApiConfig.effectiveActorId,
      t0: DateTime.now(),
    );
    if (mounted) setState(() {});

    final bool sent = _ws.sendEvent("chat.user_message", userMsg);
    if (!sent) {
      _disarmAgentReplyWatchdog();
      _pendingAgentUserMessageId = null;
      _clearAgentProcessingState();
      if (mounted) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          const SnackBar(content: Text("消息未发出：与服务器的连接尚未就绪")),
        );
      }
    }
  }

  /// 「选择型卡片」底部按钮点击处理:
  /// 用户点击选择型卡片上的按钮后的处理流程。
  ///
  /// 设计意图:点击是一个**静默决策**,不应该把按钮 label 当作用户发言
  /// 插到聊天流里(那样会让对话历史显得啰嗦、割裂)。正确的体验是:
  ///   1. 用户点按钮 → 按钮进入「已选」态(视觉反馈由卡片自身完成)
  ///   2. **不在聊天流里追加用户消息气泡**
  ///   3. 直接通过 WS 发送 `chat.user_action` 事件,携带卡片标题/条目摘要
  ///   4. 后端把摘要注入到 user_message 的 text 中,让 Agent 理解
  ///      「用户在 X 卡片上选择了 Y」并**主动产生一条衔接回复**
  ///   5. Agent 的回复作为 assistant 消息正常显示在聊天流
  ///
  /// 与 [_sendMessage] 的区别:
  ///   - 不在 _messages 里追加用户消息
  ///   - 不走输入框(controller)
  ///   - 不发 chat.user_message,改发 chat.user_action(携带 actionId/cardId/variant/payload)
  ///   - 复用「打断当前回复」「置 processing」等通用逻辑,保证按钮与键盘输入在 Agent 端一致
  ///   - [cardData] 由 chat_page 在渲染时绑定,包含 cardId/title/items,
  ///     用于后端审计/埋点精准定位到具体卡片,并让 Agent 理解上下文主动衔接
  Future<void> _handleCardAction(
    AgentResultAction action, {
    required AgentResultData cardData,
  }) async {
    if (!_ws.isConnected) {
      _ws.retryConnect();
      if (mounted) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          const SnackBar(content: Text("正在连接服务器，请稍后再试")),
        );
      }
      return;
    }
    final String label = action.label.trim();
    if (label.isEmpty) return;

    // 如果 Agent 正在处理中,先把当前被截断的回复纳入上下文(与键盘输入同语义)
    if (_isAgentProcessing) {
      final String interruptedText = _takePendingAssistantChunkText();
      if (interruptedText.isNotEmpty) {
        _interruptedResponses.add(interruptedText);
      }
      _disarmAgentReplyWatchdog();
      _pendingAgentUserMessageId = null;
      _clearAgentProcessingState(done: false);
      _assistantChunkFlushTimer?.cancel();
      _assistantChunkFlushTimer = null;
      _pendingAssistantChunkMessageId = null;
    }

    // 用一个内部 traceId 关联本轮 Agent 回复(不添加用户消息气泡到 _messages)
    final String actionMessageId =
        "action-${DateTime.now().microsecondsSinceEpoch}";

    setState(() {
      _isAgentProcessing = true;
      _agentStatusLine = null;
    });
    _notifyAgentProcessingUi(true);
    AgentSphereMoodBridge.instance.listening();

    _armAgentReplyWatchdog(actionMessageId);

    // 本地占位 TurnState:让用户立即看到「Agent 正在思考衔接回复」反馈
    _pendingLocalTurn = TurnState(
      traceId: actionMessageId,
      sessionId: ApiConfig.effectiveActorId,
      t0: DateTime.now(),
    );
    if (mounted) setState(() {});

    final bool sent = _ws.sendCardAction(
      sessionId: ApiConfig.sessionId,
      messageId: actionMessageId,
      actionId: action.id,
      label: label,
      cardId: cardData.cardId,
      variant: action.variant,
      actionPayload: action.payload,
      cardTitle: cardData.title,
      cardItems: cardData.items
          .map((AgentResultItem it) => it.text)
          .toList(growable: false),
      userId:
          ApiConfig.userId.trim().isNotEmpty ? ApiConfig.userId.trim() : null,
    );
    if (!sent) {
      _disarmAgentReplyWatchdog();
      _pendingAgentUserMessageId = null;
      _clearAgentProcessingState();
      if (mounted) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          const SnackBar(content: Text("按钮点击未发出：与服务器的连接尚未就绪")),
        );
      }
    }
  }

  void _selectTab(int index) {
    setState(() => _tabIndex = index);
  }

  /// 好友入口：不再切整页 tab，而是从右侧滑出好友面板
  void _openAgentLinkTab() {
    setState(() {
      _tabIndex = 0;
      _rightPanel = RightPanelKind.friends;
      // 保存当前 splitRatio，关闭时恢复
      _previousSplitRatio = _splitRatio;
      // 保存 side 模式下的原右面板宽度，关闭时恢复
      _previousRightPanelWidth = _rightPanelWidth;
      _splitRatio = RightPanelKind.friends.defaultSplitRatio;
    });
  }

  /// 消息入口：从右侧滑出消息聚合面板
  void _openMessagesPanel() {
    setState(() {
      _tabIndex = 0;
      _rightPanel = RightPanelKind.messages;
      // 保存当前 splitRatio，关闭时恢复
      _previousSplitRatio = _splitRatio;
      // 保存 side 模式下的原右面板宽度，关闭时恢复
      _previousRightPanelWidth = _rightPanelWidth;
      _splitRatio = RightPanelKind.messages.defaultSplitRatio;
    });
  }

  Future<void> _pollUnreadMessages() async {
    try {
      final result = await _worldApi.getMessageConversations(limit: 200);
      if (!mounted) return;
      if (result["ok"] == true) {
        final List<dynamic> conversations = result["conversations"] ?? [];
        final Map<String, int> byPlatform = <String, int>{};
        for (final dynamic c in conversations) {
          final Map<String, dynamic> conv = c as Map<String, dynamic>;
          final int unread = (conv["unreadCount"] as num?)?.toInt() ?? 0;
          if (unread <= 0) continue;
          final String platform = conv["platform"] as String? ?? "generic";
          byPlatform[platform] = (byPlatform[platform] ?? 0) + unread;
        }
        if (mounted) {
          setState(() => _unreadByPlatform = byPlatform);
        }
      }
    } catch (_) {}
  }

  void _startMessagePolling() {
    _stopMessagePolling();
    _pollUnreadMessages();
    _messagePollTimer = Timer.periodic(const Duration(seconds: 15), (_) {
      _pollUnreadMessages();
    });
  }

  void _stopMessagePolling() {
    _messagePollTimer?.cancel();
    _messagePollTimer = null;
  }

  /// 日程入口：不再弹出居中弹窗，而是与好友/消息/设备一致，从右侧滑出 split 双栏面板
  void _openSchedulePanel() {
    setState(() {
      _tabIndex = 0;
      _rightPanel = RightPanelKind.schedule;
      // 保存当前 splitRatio，关闭时恢复
      _previousSplitRatio = _splitRatio;
      // 保存 side 模式下的原右面板宽度，关闭时恢复
      _previousRightPanelWidth = _rightPanelWidth;
      _splitRatio = RightPanelKind.schedule.defaultSplitRatio;
    });
  }

  void _openWalletDialog() {
    // 用 NavigatorState 顶层推 dialog，避免 State context 触发出栈/Localizations 问题
    final NavigatorState? navigator = _rootNavigatorKey.currentState;
    if (navigator == null) {
      // 兜底走原 showDialog 路径
      final BuildContext? navCtx = _rootNavigatorKey.currentContext;
      final BuildContext ctx = navCtx ?? context;
      if (!ctx.mounted) return;
      WalletDialog.show(ctx, balance: _balance);
      return;
    }
    showDialog<void>(
      context: navigator.context,
      useRootNavigator: true,
      barrierDismissible: true,
      builder: (BuildContext _) => WalletDialog(balance: _balance),
    );
  }

  /// 常用工具「手机」入口：跳转到"真实手机"功能页
  /// 与"虚拟电话"区分——这里对接的是用户自己的手机（拨号/通讯录/短信等）。
  void _openPhoneDevicesDialog() {
    final BuildContext? navCtx = _rootNavigatorKey.currentContext;
    if (navCtx == null || !navCtx.mounted) return;
    // TODO(phone-devices): 等 lib/features/phone_devices/phone_devices_page.dart
    // 的 PhoneDevicesPage 类完成后，把下面三行解注释：
    // Navigator.of(navCtx).push<void>(
    //   MaterialPageRoute<void>(
    //     builder: (BuildContext context) => const PhoneDevicesPage(),
    //     fullscreenDialog: true,
    //   ),
    // );
    ScaffoldMessenger.maybeOf(navCtx)?.showSnackBar(
      const SnackBar(content: Text("「手机」功能页正在准备中")),
    );
  }

  /// 常用工具「笔记」入口：跳转到与笔记 Agent 的独立对话页（独立 WebSocket 命名空间，
  /// 记忆写入 context=notes）。
  Future<Map<String, dynamic>> _runAsyncCenterAction(
    String channel,
    String action,
    String targetId,
  ) async {
    final Map<String, dynamic> result =
        await _multiAgentApi.runAsyncCenterAction(
      sessionId: ApiConfig.effectiveActorId,
      channel: channel,
      action: action,
      targetId: targetId,
    );
    final Map<String, dynamic> snapshot =
        (result["snapshot"] as Map?)?.cast<String, dynamic>() ?? result;
    _syncBackgroundTaskBadgeFromSnapshot(snapshot);
    return result;
  }

  void _syncBackgroundTaskBadgeFromSnapshot(Map<String, dynamic> snapshot) {
    final Map<String, dynamic> background =
        ((snapshot["channels"] as Map?)?["backgroundTasks"] as Map?)
                ?.cast<String, dynamic>() ??
            snapshot;
    final List<dynamic> running =
        background["running"] as List<dynamic>? ?? <dynamic>[];
    final Set<String> nextIds = running
        .map((dynamic item) => (item as Map)["taskId"]?.toString() ?? "")
        .where((String id) => id.isNotEmpty)
        .toSet();
    if (!mounted) {
      _backgroundRunningTaskIds
        ..clear()
        ..addAll(nextIds);
      return;
    }
    setState(() {
      _backgroundRunningTaskIds
        ..clear()
        ..addAll(nextIds);
    });
  }

  void _enqueueAsyncConfirmation(Map<String, dynamic> payload) {
    final String taskId = payload["taskId"]?.toString() ?? "";
    if (taskId.isEmpty) return;
    if (!mounted) {
      _backgroundRunningTaskIds.remove(taskId);
      _pendingAsyncConfirmations.removeWhere(
        (Map<String, dynamic> item) => item["taskId"]?.toString() == taskId,
      );
      _pendingAsyncConfirmations.add(Map<String, dynamic>.from(payload));
      return;
    }
    setState(() {
      _backgroundRunningTaskIds.remove(taskId);
      _pendingAsyncConfirmations.removeWhere(
        (Map<String, dynamic> item) => item["taskId"]?.toString() == taskId,
      );
      _pendingAsyncConfirmations.add(Map<String, dynamic>.from(payload));
    });
  }

  Future<void> _handleAsyncConfirmationAction(
    Map<String, dynamic> payload,
    String action,
  ) async {
    final String taskId = payload["taskId"]?.toString() ?? "";
    if (taskId.isEmpty || _isSubmittingAsyncConfirmation) return;
    if (mounted) {
      setState(() => _isSubmittingAsyncConfirmation = true);
    } else {
      _isSubmittingAsyncConfirmation = true;
    }
    try {
      final Map<String, dynamic> result = await _runAsyncCenterAction(
        "background_task",
        action,
        taskId,
      );
      final bool ok = result["ok"] == true;
      if (!ok) {
        final String error =
            result["error"]?.toString().trim().isNotEmpty == true
                ? result["error"]!.toString()
                : "操作未成功，请稍后再试";
        if (mounted) {
          ScaffoldMessenger.maybeOf(context)?.showSnackBar(
            SnackBar(content: Text(error)),
          );
        }
        return;
      }
      if (!mounted) {
        _pendingAsyncConfirmations.removeWhere(
          (Map<String, dynamic> item) => item["taskId"]?.toString() == taskId,
        );
        return;
      }
      setState(() {
        _pendingAsyncConfirmations.removeWhere(
          (Map<String, dynamic> item) => item["taskId"]?.toString() == taskId,
        );
      });
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          SnackBar(content: Text("处理失败，请稍后重试")),
        );
      }
    } finally {
      if (mounted) {
        setState(() => _isSubmittingAsyncConfirmation = false);
      } else {
        _isSubmittingAsyncConfirmation = false;
      }
    }
  }

  Widget _buildAsyncConfirmationOverlay() {
    if (_pendingAsyncConfirmations.isEmpty) {
      return const SizedBox.shrink();
    }
    final Map<String, dynamic> payload = _pendingAsyncConfirmations.first;
    final List<String> actions = confirmationActionsFor(payload);
    if (actions.isEmpty) {
      return const SizedBox.shrink();
    }
    final String agentName = payload["agentName"]?.toString() ?? "后台任务";
    final String summary = payload["userFacingText"]?.toString().trim() ?? "";
    final String taskDescription =
        payload["taskDescription"]?.toString().trim() ?? "";
    final ThemeData theme = Theme.of(context);
    final ColorScheme cs = theme.colorScheme;

    return Positioned(
      top: 88,
      right: 20,
      child: SafeArea(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 360),
          child: Material(
            elevation: 10,
            borderRadius: BorderRadius.circular(18),
            color: cs.surface,
            child: Container(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
              decoration: BoxDecoration(
                color: cs.surface,
                borderRadius: BorderRadius.circular(18),
                border: Border.all(
                  color: cs.outlineVariant.withValues(alpha: 0.65),
                ),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    "$agentName 需要你的决定",
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    summary.isNotEmpty ? summary : "这项异步任务已经走到需要你拍板的阶段。",
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: cs.onSurfaceVariant,
                      height: 1.35,
                    ),
                  ),
                  if (taskDescription.isNotEmpty) ...<Widget>[
                    const SizedBox(height: 10),
                    Text(
                      taskDescription,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: cs.onSurfaceVariant.withValues(alpha: 0.9),
                      ),
                    ),
                  ],
                  const SizedBox(height: 14),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: actions.map((String action) {
                      final String label =
                          asyncConfirmationActionLabel(action, payload);
                      final bool primary =
                          isPrimaryAsyncConfirmationAction(action);
                      if (primary) {
                        return FilledButton(
                          onPressed: _isSubmittingAsyncConfirmation
                              ? null
                              : () => unawaited(
                                    _handleAsyncConfirmationAction(
                                      payload,
                                      action,
                                    ),
                                  ),
                          child: Text(label),
                        );
                      }
                      return OutlinedButton(
                        onPressed: _isSubmittingAsyncConfirmation
                            ? null
                            : () => unawaited(
                                  _handleAsyncConfirmationAction(
                                    payload,
                                    action,
                                  ),
                                ),
                        child: Text(label),
                      );
                    }).toList(),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _appendAsyncTaskReportMessage(
      Map<String, dynamic> payload) async {
    final String taskId = payload["taskId"]?.toString() ?? "";
    final String status = payload["status"]?.toString() ?? "";
    final String text = payload["userFacingText"]?.toString().trim() ?? "";
    if (taskId.isEmpty || text.isEmpty || status == "running") return;
    final String messageId = "async-task-$taskId-$status";
    // 带兜底的索引查询：索引失真时也能识别已存在的消息，防止重复追加
    if (_messageIndexById(messageId) != null) return;
    final ChatMessage message = ChatMessage(
      messageId: messageId,
      sessionId: ApiConfig.effectiveActorId,
      role: "assistant",
      text: text,
      timestamp: DateTime.now(),
    );
    if (!mounted) {
      _messages.add(message);
      _assistantMessageIndexById[messageId] = _messages.length - 1;
      _backgroundRunningTaskIds.remove(taskId);
      unawaited(_store.saveMessage(message).catchError((Object e) {
        debugPrint("[chat] async task saveMessage failed: $e");
      }));
      return;
    }
    setState(() {
      _messages.add(message);
      _assistantMessageIndexById[messageId] = _messages.length - 1;
      _backgroundRunningTaskIds.remove(taskId);
    });
    unawaited(_store.saveMessage(message).catchError((Object e) {
      debugPrint("[chat] async task saveMessage failed: $e");
    }));
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      SnackBar(content: Text(status == "completed" ? "后台任务已完成" : "后台任务执行失败")),
    );
  }

  Future<void> _openWechatClawBinding() async {
    final BuildContext? navCtx = _rootNavigatorKey.currentContext;
    if (navCtx == null || !navCtx.mounted) return;
    await openWechatClawBinding(navCtx);
  }

  /// 删除单条消息（本地 + 通知服务端清除上下文）
  Future<void> _deleteSingleMessage(String messageId) async {
    await _store.deleteMessage(messageId);
    // 通知服务端同步清除 ChatThreadStore
    _ws.sendEvent("chat.clear_history", <String, dynamic>{
      "sessionId": ApiConfig.sessionId,
    });
    setState(() {
      final int idx =
          _messages.indexWhere((ChatMessage m) => m.messageId == messageId);
      if (idx >= 0) {
        _messages.removeAt(idx);
        // 重建索引：被删除位置之后的索引全部前移
        _rebuildAssistantIndex();
      }
    });
  }

  /// 删除从某条消息起之后的所有消息（含该条）—— 本地 + 服务端同步
  Future<void> _deleteMessagesFrom(String fromMessageId) async {
    final int fromIdx =
        _messages.indexWhere((ChatMessage m) => m.messageId == fromMessageId);
    if (fromIdx < 0) return;

    // 批量删除 store 中对应的消息
    for (int i = fromIdx; i < _messages.length; i++) {
      await _store.deleteMessage(_messages[i].messageId);
    }
    // 通知服务端同步清除 ChatThreadStore
    _ws.sendEvent("chat.clear_history", <String, dynamic>{
      "sessionId": ApiConfig.sessionId,
    });
    setState(() {
      _messages.removeRange(fromIdx, _messages.length);
      _rebuildAssistantIndex();
    });
  }

  /// 重建 assistant 消息索引（删除后索引失效需重建）
  void _rebuildAssistantIndex() {
    _assistantMessageIndexById.clear();
    for (int i = 0; i < _messages.length; i++) {
      if (_messages[i].role != "user") {
        _assistantMessageIndexById[_messages[i].messageId] = i;
      }
    }
  }

  /// 按 messageId 定位消息在 [_messages] 中的下标（根源防线）。
  ///
  /// 优先查 [_assistantMessageIndexById] 索引；索引未命中或指向错误时
  /// 回退全列表扫描并回写索引。所有「add 前先判断是否已存在」的入口
  /// 都必须走这里，保证索引与列表永远一致——任何索引失真（历史脏数据、
  /// 删除/重建遗漏、缓存恢复后未重建等）都不会再导致同一条消息被重复插入。
  int? _messageIndexById(String messageId) {
    final int? fromIndex = _assistantMessageIndexById[messageId];
    if (fromIndex != null &&
        fromIndex >= 0 &&
        fromIndex < _messages.length &&
        _messages[fromIndex].messageId == messageId) {
      return fromIndex;
    }
    // 索引缺失或指向了别的消息 → 回退全列表扫描，并顺手修复索引
    _assistantMessageIndexById.remove(messageId);
    for (int i = 0; i < _messages.length; i++) {
      if (_messages[i].messageId == messageId) {
        if (_messages[i].role != "user") {
          _assistantMessageIndexById[messageId] = i;
        }
        return i;
      }
    }
    return null;
  }

  /// 清理本地 store 中同 messageId 的重复记录：
  /// deleteMessage 按 messageId 全删（无法只删一条），所以先删光，
  /// 再把去重后保留的那条重新落盘。
  Future<void> _cleanupDuplicateMessages(
    List<ChatMessage> dedupedMessages,
    Map<String, int> messageIndexById,
    Set<String> duplicateMessageIds,
  ) async {
    for (final String messageId in duplicateMessageIds) {
      try {
        final int? keptIdx = messageIndexById[messageId];
        if (keptIdx == null || keptIdx >= dedupedMessages.length) continue;
        await _store.deleteMessage(messageId);
        await _store.saveMessage(dedupedMessages[keptIdx]);
        debugPrint("[chat] dedupe: cleaned duplicate messageId=$messageId");
      } catch (e) {
        debugPrint("[chat] dedupe cleanup failed for $messageId: $e");
      }
    }
  }

  void _sendPeerIncomingResponse(String callId, String action) {
    if (!_ws.isConnected) {
      _ws.retryConnect();
      return;
    }
    _ws.sendEvent("voice.incoming_response", <String, dynamic>{
      "callId": callId,
      "action": action,
    });
  }

  void _sendContactFeedback({
    required String channel,
    required bool responded,
    String? feedback,
    int? responseTimeMs,
    bool? quietHours,
  }) {
    _ws.sendContactFeedback(
      sessionId: ApiConfig.effectiveActorId,
      channel: channel,
      responded: responded,
      feedback: feedback,
      responseTimeMs: responseTimeMs,
      quietHours: quietHours,
    );
  }

  bool _isQuietHoursNow() {
    final int hour = DateTime.now().hour;
    return hour >= 23 || hour < 8;
  }

  // ====== 桌面端独立来电悬浮窗回调 ======

  /// 原生悬浮窗点接听：
  /// - agent_to_agent：发 voice.incoming_response("accept") 通知服务器
  /// - agent_to_user：服务器自动推进 ringing→connecting，客户端只需切换 UI
  void _handleNativeCallAccept() {
    final String? peerCallId = _peerIncomingDialogCallId;
    if (peerCallId != null && peerCallId.isNotEmpty) {
      _sendPeerIncomingResponse(peerCallId, "accept");
    }
    if (!mounted) return;
    setState(() {
      _phoneCallStatus = "connecting";
      _peerIncomingDialogCallId = null;
    });
    unawaited(IncomingCallLauncher.bringMainWindowToFront());
    unawaited(ConnectedCallLauncher.resetDuration());
  }

  /// 原生悬浮窗点挂断：
  /// - agent_to_agent：发 voice.incoming_response("decline")
  /// - agent_to_user：本地停止 TTS + 关窗 + contact feedback
  void _handleNativeCallDecline() {
    final String? peerCallId = _peerIncomingDialogCallId;
    if (peerCallId != null && peerCallId.isNotEmpty) {
      _sendPeerIncomingResponse(peerCallId, "decline");
    } else {
      _sendContactFeedback(
        channel: "phone_call",
        responded: false,
        feedback: "negative",
        quietHours: _isQuietHoursNow(),
      );
    }
    unawaited(TtsPlayer.instance.stop());
    unawaited(IncomingCallLauncher.hide());
    unawaited(OutgoingCallLauncher.hide());
    unawaited(ConnectedCallLauncher.hide());
    if (mounted) {
      setState(() {
        _phoneCallStatus = null;
        _phoneCallToActorId = null;
        _peerIncomingDialogCallId = null;
      });
    }
  }

  /// 原生悬浮窗振铃超时：
  /// - agent_to_agent：发 voice.incoming_response("decline")（服务器也有自己的超时兜底）
  /// - agent_to_user：contact feedback negative
  void _handleNativeCallTimeout() {
    final String? peerCallId = _peerIncomingDialogCallId;
    if (peerCallId != null && peerCallId.isNotEmpty) {
      _sendPeerIncomingResponse(peerCallId, "decline");
    } else {
      _sendContactFeedback(
        channel: "phone_call",
        responded: false,
        feedback: "negative",
        quietHours: _isQuietHoursNow(),
      );
    }
    unawaited(TtsPlayer.instance.stop());
    unawaited(IncomingCallLauncher.hide());
    unawaited(OutgoingCallLauncher.hide());
    unawaited(ConnectedCallLauncher.hide());
    if (mounted) {
      setState(() {
        _phoneCallStatus = null;
        _phoneCallToActorId = null;
        _peerIncomingDialogCallId = null;
      });
    }
  }

  /// 用户在聊天页底部"📞 通话中"按钮上点挂断的入口
  // ignore: unused_element
  void _hangupFromPhoneButton() {
    unawaited(TtsPlayer.instance.stop());
    unawaited(IncomingCallLauncher.hide());
    unawaited(OutgoingCallLauncher.hide());
    unawaited(ConnectedCallLauncher.hide());
    if (mounted) {
      setState(() {
        _phoneCallStatus = null;
        _phoneCallToActorId = null;
        _peerIncomingDialogCallId = null;
        _phoneMuted = false;
        _phoneSpeakerOn = true;
      });
    }
  }

  /// "通话中"窗口里点了挂断：关窗 + 停 TTS + 清状态
  void _handleConnectedHangup() {
    unawaited(TtsPlayer.instance.stop());
    unawaited(IncomingCallLauncher.hide());
    unawaited(OutgoingCallLauncher.hide());
    unawaited(ConnectedCallLauncher.hide());
    if (mounted) {
      setState(() {
        _phoneCallStatus = null;
        _phoneCallToActorId = null;
        _peerIncomingDialogCallId = null;
        _phoneMuted = false;
        _phoneSpeakerOn = true;
      });
    }
  }

  /// TTS 播完回调：关头像呼吸光
  void _onTtsCompleted() {
    unawaited(ConnectedCallLauncher.setTalking(false));
  }

  /// "通话中"窗口里点了静音：本地状态同步 + 通知 server
  void _handleMuteToggle(bool newMuted) {
    if (!mounted) return;
    setState(() => _phoneMuted = newMuted);
    _ws.sendEvent("phone.mute", {"muted": newMuted});
  }

  /// "通话中"窗口里点了免提：本地状态同步 + 通知 server
  void _handleSpeakerToggle(bool newOn) {
    if (!mounted) return;
    setState(() => _phoneSpeakerOn = newOn);
    _ws.sendEvent("phone.speaker", {"on": newOn});
  }

  void _handleDesktopNotificationConfirm() {
    final Map<String, dynamic>? pendingBriefing =
        _pendingDesktopBriefingPayload;
    _pendingDesktopBriefingPayload = null;
    if (pendingBriefing != null) {
      unawaited(
          _handleMorningBriefingEvent(pendingBriefing, forceDialog: true));
      return;
    }
    if (_desktopNotificationNeedsFeedback) {
      _sendContactFeedback(
        channel: _desktopNotificationFeedbackChannel,
        responded: true,
        feedback: "positive",
        quietHours: _isQuietHoursNow(),
      );
    }
    _desktopNotificationNeedsFeedback = false;
  }

  void _handleDesktopNotificationDismiss() {
    _desktopNotificationNeedsFeedback = false;
    _pendingDesktopBriefingPayload = null;
  }

  void _handleDesktopNotificationTimeout() {
    _desktopNotificationNeedsFeedback = false;
    _pendingDesktopBriefingPayload = null;
  }

  void _handleOutgoingCallHangup() {
    _ws.sendEvent("phone.hang_up", <String, dynamic>{});
    unawaited(OutgoingCallLauncher.hide());
    if (!mounted) return;
    setState(() {
      _phoneCallStatus = null;
      _phoneCallToActorId = null;
    });
  }

  /// 显示服务端推送的提醒弹窗（reminder_popup 事件）
  /// 用于智能提醒系统的 popup 级别——在屏幕右下角弹出通知卡片
  Future<void> _showReminderPopupDialog(
    BuildContext? navCtx,
    String title,
    String message,
    String priority,
    bool showConfirm,
    String confirmText,
  ) async {
    _desktopNotificationNeedsFeedback = showConfirm;
    _desktopNotificationFeedbackChannel = "websocket";
    final bool shown = await DesktopNotificationLauncher.show(
      title: title,
      message: message,
      priority: priority,
      showConfirmButton: showConfirm,
      confirmText: confirmText,
    );
    if (shown || navCtx == null || !navCtx.mounted) {
      return;
    }

    final Color accentColor = switch (priority) {
      "urgent" => Colors.red,
      "high" => Colors.orange,
      _ => const Color(0xFF4B5563),
    };

    final IconData iconData = switch (priority) {
      "urgent" => Icons.warning_amber_rounded,
      "high" => Icons.notifications_active_rounded,
      _ => Icons.info_outline_rounded,
    };

    // 右下角通知卡片 —— 类似微信/QQ 的系统通知
    showGeneralDialog<void>(
      context: navCtx,
      barrierDismissible: true,
      barrierLabel: "",
      barrierColor: Colors.transparent,
      transitionDuration: const Duration(milliseconds: 300),
      pageBuilder: (ctx, anim1, anim2) => const SizedBox.shrink(),
      transitionBuilder: (ctx, anim1, anim2, child) {
        return FadeTransition(
          opacity: anim1,
          child: SlideTransition(
            position: Tween<Offset>(
              begin: const Offset(0.3, 0.5), // 从右下角滑入
              end: Offset.zero,
            ).animate(
                CurvedAnimation(parent: anim1, curve: Curves.easeOutCubic)),
            child: Align(
              alignment: Alignment.bottomRight,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(0, 0, 24, 40),
                child: Material(
                  elevation: 12,
                  borderRadius: BorderRadius.circular(16),
                  color: Theme.of(ctx).colorScheme.surface,
                  clipBehavior: Clip.antiAlias,
                  child: Container(
                    constraints: const BoxConstraints(maxWidth: 380),
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(
                        color: accentColor.withValues(alpha: 0.2),
                        width: 1,
                      ),
                    ),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        // 标题行：图标 + 标题 + 关闭按钮
                        Row(
                          children: [
                            Icon(iconData, size: 20, color: accentColor),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                title,
                                style: TextStyle(
                                  fontSize: 15,
                                  fontWeight: FontWeight.w600,
                                  color: accentColor,
                                ),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                            // 关闭按钮
                            GestureDetector(
                              onTap: () => Navigator.of(ctx).pop(),
                              child: Icon(
                                Icons.close,
                                size: 18,
                                color: Theme.of(ctx)
                                    .colorScheme
                                    .onSurfaceVariant
                                    .withValues(alpha: 0.6),
                              ),
                            ),
                          ],
                        ),

                        const SizedBox(height: 10),

                        // 正文内容
                        Text(
                          message,
                          style: TextStyle(
                            fontSize: 14,
                            height: 1.5,
                            color: Theme.of(ctx).colorScheme.onSurface,
                          ),
                          maxLines: 4,
                          overflow: TextOverflow.ellipsis,
                        ),

                        const SizedBox(height: 14),

                        // 底部操作栏
                        if (showConfirm)
                          Align(
                            alignment: Alignment.centerRight,
                            child: TextButton(
                              onPressed: () {
                                _sendContactFeedback(
                                  channel: "websocket",
                                  responded: true,
                                  feedback: "positive",
                                  quietHours: _isQuietHoursNow(),
                                );
                                Navigator.of(ctx).pop();
                              },
                              style: TextButton.styleFrom(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 16,
                                  vertical: 6,
                                ),
                              ),
                              child: Text(confirmText),
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  void _presentPeerAgentIncoming(Map<String, dynamic> payload) {
    final String callId = payload["callId"]?.toString() ?? "";
    if (callId.isEmpty) return;
    if (_peerIncomingDialogCallId == callId) return;

    final String fromPhone = payload["fromPhone"]?.toString() ?? "";
    final String callerLabel = VoiceCallUiLabels.incomingCallerLabel(
      direction: "agent_to_agent",
      fromPhone: fromPhone,
    );
    if (!mounted) return;
    setState(() {
      _peerIncomingDialogCallId = callId;
      _phoneCallStatus = "ringing";
      _phoneCallToActorId = callerLabel;
    });

    // 统一走原生独立悬浮窗（不再使用嵌入式 Flutter dialog）
    unawaited(
      IncomingCallLauncher.show(
        callerName: callerLabel,
        subtitle: "其他 Agent 来电",
        callerInitial:
            callerLabel.isNotEmpty ? callerLabel.characters.first : "A",
        ringTimeoutMs: 30000,
      ),
    );
  }

  void _callMyAgentViaPhone(String? message) {
    if (!_ws.isConnected) {
      _ws.retryConnect();
      if (mounted) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          const SnackBar(content: Text("正在连接服务器，请稍后再试")),
        );
      }
      return;
    }

    final Map<String, dynamic> callPayload = <String, dynamic>{};
    if (message != null && message.isNotEmpty) {
      callPayload["userMessage"] = message;
    }
    _ws.sendEvent("phone.call_my_agent", callPayload);
    unawaited(
      OutgoingCallLauncher.show(
        callerName: _phoneCallToActorId ?? "Agent",
        subtitle:
            message?.trim().isNotEmpty == true ? message!.trim() : "姝ｅ湪鍛煎彨",
        callerInitial: (_phoneCallToActorId?.isNotEmpty ?? false)
            ? _phoneCallToActorId!.characters.first
            : "A",
      ),
    );
    return;
  }

  /// 弹窗询问 GPS 定位权限：仅询问一次，未显式拒绝则默认同意并立即拉一次 GPS。
  Future<void> _promptLocationConsentIfNeeded() async {
    final bool? existing = await ClientLocationService.getLocationConsent();
    if (existing != null) {
      if (existing) {
        unawaited(ClientLocationService.warmUpGpsIfConsented());
      }
      return;
    }

    final BuildContext? ctx = _rootNavigatorKey.currentContext;
    if (ctx == null || !ctx.mounted) {
      return;
    }

    final bool? allow = await showLocationPermissionDialog(context: ctx);
    // 默认同意：用户没显式点「暂不允许」就视为允许，让 Agent 默认能拿到实时位置。
    final bool decided = allow ?? true;
    await ClientLocationService.setLocationConsent(decided);
    if (decided) {
      await ClientLocationService.requestGpsAfterConsent();
    }
  }

  void _showDesktopBridgeToast(String message) {
    if (!mounted) return;
    final ScaffoldMessengerState? messenger =
        ScaffoldMessenger.maybeOf(context);
    if (messenger == null) return;
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(
            message,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
          duration: const Duration(seconds: 3),
        ),
      );
  }

  Widget? _buildAppBarTitle() {
    if (_tabIndex == 0) {
      return null;
    }
    final String title = kTabTitles[_tabIndex];
    if (title.isEmpty) {
      return null;
    }
    return Text(title);
  }

  /// 启动独立的 PySide6 语音悬浮球进程，并隐藏当前 Flutter 窗口，
  /// 进入纯语音模式（屏幕上只保留悬浮球）。
  /// 由 ChatPage 输入框中的语音按钮通过 onEnterVoiceMode 回调触发。
  ///
  /// 环境变量 PAI_WS_URL / PAI_HTTP_BASE / PAI_SESSION_ID / PAI_ACTOR_ID
  /// 会传递给 voice-orb-py，使其复用当前 session 与后端通信。
  Future<void> _invokeVoiceOrb() async {
    if (!Platform.isWindows) {
      // 非桌面平台：保留原入口但不执行（后续可扩展 macOS/Linux）
      debugPrint("[VoiceOrb] external PySide6 orb is only supported on Windows");
      return;
    }
    if (_voiceOrbProcess != null && _voiceOrbReady) {
      // 已有进程在跑且悬浮球已就绪：直接隐藏主窗口并把焦点交过去
      await windowManager.hide();
      return;
    }
    if (_voiceOrbProcess != null && !_voiceOrbReady) {
      // 进程启动中，忽略重复点击
      return;
    }

    final Directory? orbDir = _findVoiceOrbDir();
    if (orbDir == null) {
      debugPrint(
          "[VoiceOrb] voice-orb-py not found (cwd: ${Directory.current.path})");
      return;
    }
    final String script =
        "${orbDir.path}${Platform.pathSeparator}main.py";

    final Map<String, String> env = Map<String, String>.from(Platform.environment);
    env["PAI_WS_URL"] = ApiConfig.wsUrl;
    env["PAI_HTTP_BASE"] = ApiConfig.httpBase;
    env["PAI_SESSION_ID"] = ApiConfig.sessionId;
    env["PAI_ACTOR_ID"] = ApiConfig.effectiveActorId;
    env["PAI_USER_ID"] = ApiConfig.localPin;
    // 告知悬浮球父进程（本 Flutter 应用）的 PID：
    // 应用退出/重启后，悬浮球检测到父进程消失会自动结束，避免残留悬浮窗。
    env["PAI_ORB_PARENT_PID"] = "$pid";

    try {
      _voiceOrbProcess = await Process.start(
        "python",
        <String>[script],
        workingDirectory: orbDir.path,
        environment: env,
      );
      _voiceOrbProcess!.stdout
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .listen(_onVoiceOrbStdout);
      _voiceOrbProcess!.stderr
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .listen((String line) => debugPrint("[VoiceOrb][err] $line"));
      _voiceOrbProcess!.exitCode.then((int code) {
        debugPrint("[VoiceOrb] process exited with code $code");
        _voiceOrbProcess = null;
        _voiceOrbReadyTimer?.cancel();
        _voiceOrbReadyTimer = null;
        if (_voiceOrbReady) {
          // 悬浮球进程退出（崩溃/被关闭）且主窗口已被隐藏时，立即恢复页面，
          // 避免应用"卡退"式地消失后无法找回。
          _voiceOrbReady = false;
          _restorePageMode();
        } else {
          _voiceOrbReady = false;
        }
      });
      // 就绪看门狗：10s 内未收到 ORB_READY（python 启动失败/挂起），
      // 终止子进程并恢复主窗口，防止主窗口被无限期隐藏。
      _voiceOrbReadyTimer?.cancel();
      _voiceOrbReadyTimer = Timer(const Duration(seconds: 10), () {
        if (_voiceOrbProcess != null && !_voiceOrbReady) {
          debugPrint("[VoiceOrb] ready timeout, restoring page mode");
          _voiceOrbProcess?.kill();
          _voiceOrbProcess = null;
          _restorePageMode();
        }
      });
    } on Exception catch (e) {
      debugPrint("[VoiceOrb] failed to start: $e");
    }
  }

  /// 恢复 Flutter 主窗口（从悬浮球模式回到页面模式）。
  Future<void> _restorePageMode() async {
    await windowManager.show();
    await windowManager.focus();
  }

  Process? _voiceOrbProcess;
  bool _voiceOrbReady = false;
  Timer? _voiceOrbReadyTimer;

  /// 从进程工作目录 / 可执行文件目录向上逐级查找 client/voice-orb-py。
  /// 兼容 flutter run（cwd = client/flutter_app）与从仓库根目录启动两种形态。
  static Directory? _findVoiceOrbDir() {
    final List<String> seeds = <String>[
      Directory.current.path,
      File(Platform.resolvedExecutable).parent.path,
    ];

    for (final String seed in seeds) {
      Directory dir = Directory(seed);
      for (int i = 0; i < 15; i++) {
        final Directory candidate = Directory(
          "${dir.path}${Platform.pathSeparator}client"
          "${Platform.pathSeparator}voice-orb-py",
        );
        if (candidate.existsSync()) {
          return candidate;
        }
        final Directory parent = dir.parent;
        if (parent.path == dir.path) break;
        dir = parent;
      }
    }
    return null;
  }

  void _onVoiceOrbStdout(String line) {
    debugPrint("[VoiceOrb][out] $line");
    if (line.contains("__VOICE_ORB_EVENT__:ORB_READY")) {
      _voiceOrbReadyTimer?.cancel();
      _voiceOrbReadyTimer = null;
      _voiceOrbReady = true;
      // 悬浮球窗口已就绪，隐藏 Flutter 主窗口进入纯语音模式
      windowManager.hide();
    } else if (line.contains("__VOICE_ORB_EVENT__:PAGE_MODE_REQUESTED")) {
      // 用户点击悬浮球的"回到页面模式"，恢复 Flutter 主窗口
      _restorePageMode();
    }
  }

  Widget _buildMessageNotificationBadge() {
    if (_unreadByPlatform.isEmpty) {
      return const SizedBox.shrink();
    }

    final int totalUnread =
        _unreadByPlatform.values.fold(0, (int a, int b) => a + b);

    return MouseRegion(
      onEnter: (_) {
        if (mounted) setState(() => _messageBadgeHovering = true);
      },
      onExit: (_) {
        if (mounted) setState(() => _messageBadgeHovering = false);
      },
      child: Stack(
        clipBehavior: Clip.none,
        children: <Widget>[
          Tooltip(
            message: "消息聚合",
            child: Material(
              color: Colors.transparent,
              child: InkWell(
                borderRadius: BorderRadius.circular(20),
                onTap: _openMessagesPanel,
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 6,
                  ),
                  child: Badge(
                    label: Text(
                      totalUnread > 99 ? "99+" : totalUnread.toString(),
                    ),
                    child: Icon(
                      Icons.notifications_outlined,
                      size: 22,
                      color: Theme.of(context).colorScheme.onSurface,
                    ),
                  ),
                ),
              ),
            ),
          ),
          if (_messageBadgeHovering)
            Positioned(
              top: 44,
              left: 4,
              child: _buildPlatformPopup(),
            ),
        ],
      ),
    );
  }

  Widget _buildPlatformPopup() {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final List<MapEntry<String, int>> entries = _unreadByPlatform.entries
        .map((e) => MapEntry<String, int>(platformDisplayName(e.key), e.value))
        .toList();

    return Material(
      elevation: 8,
      borderRadius: BorderRadius.circular(12),
      color: cs.surface,
      surfaceTintColor: cs.surfaceTint,
      child: Container(
        constraints: const BoxConstraints(minWidth: 180),
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
              child: Text(
                "未读消息",
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: cs.onSurfaceVariant,
                ),
              ),
            ),
            const Divider(height: 8),
            ...entries.map(
              (entry) => Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 6,
                ),
                child: Row(
                  children: <Widget>[
                    _platformIcon(entry.key),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        entry.key,
                        style: TextStyle(
                          fontSize: 13,
                          color: cs.onSurface,
                        ),
                      ),
                    ),
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 2,
                      ),
                      decoration: BoxDecoration(
                        color: cs.primaryContainer,
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Text(
                        entry.value > 99 ? "99+" : entry.value.toString(),
                        style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w600,
                          color: cs.onPrimaryContainer,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _platformIcon(String displayName) {
    IconData icon;
    Color color;
    switch (displayName) {
      case "微信":
        icon = Icons.wechat;
        color = const Color(0xFF07C160);
        break;
      case "QQ":
        icon = Icons.chat;
        color = const Color(0xFF12B7F5);
        break;
      case "飞书":
        icon = Icons.flutter_dash;
        color = const Color(0xFF3370FF);
        break;
      default:
        icon = Icons.message;
        color = Theme.of(context).colorScheme.primary;
    }
    return Icon(icon, size: 20, color: color);
  }

  @override
  Widget build(BuildContext context) {
    // 如果还未初始化，显示加载界面
    if (!_isInitialized) {
      return ValueListenableBuilder<AppThemeVariant>(
        valueListenable: AppThemeController.instance,
        builder: (BuildContext _, AppThemeVariant variant, __) {
          final bool isLightTheme = variant == AppThemeVariant.warm;
          final Color loadingColor =
              isLightTheme ? AppPalette.warmOnSurface : Colors.white;
          return MaterialApp(
            navigatorKey: _rootNavigatorKey,
            title: "",
            theme: AppTheme.of(variant),
            home: Scaffold(
              backgroundColor: AppPalette.resolveMainPanel(variant),
              body: Center(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    CircularProgressIndicator(
                      color: loadingColor,
                    ),
                    const SizedBox(height: 16),
                    Text(
                      '正在初始化...',
                      style: TextStyle(
                        color: loadingColor.withValues(alpha: 0.7),
                        fontSize: 14,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      );
    }

    // 监听主题控制器，切换配色时重建整个 MaterialApp。
    return ValueListenableBuilder<AppThemeVariant>(
      valueListenable: AppThemeController.instance,
      builder: (BuildContext _, AppThemeVariant variant, __) {
        // 同步 Windows 标题栏颜色跟随主题
        unawaited(WindowsTitleBarTheme.setDarkMode(
          _showEntranceAnimation || variant == AppThemeVariant.dark,
        ));
        return MaterialApp(
          navigatorKey: _rootNavigatorKey,
          title: "",
          theme: AppTheme.of(variant),
          home: Builder(
            builder: (BuildContext context) {
              return Scaffold(
                body: Stack(
                  clipBehavior: Clip.none,
                  children: <Widget>[
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: <Widget>[
                        AppSidebar(
                          tabIndex: _tabIndex,
                          onTabSelected: _selectTab,
                          currentTheme: _themeChoice,
                          onSetLightTheme: _setLightTheme,
                          onSetDarkTheme: _setDarkTheme,
                          onSetSystemTheme: _setSystemTheme,
                          onOpenMessages: _openMessagesPanel,
                          onOpenUserMenuSettings: _openUserMenuSettings,
                          onOpenUserMenuHelp: _openUserMenuHelp,
                          onOpenWechatClaw: _openWechatClawBinding,
                          onOpenDevices: _openDevicesPage,
                          onOpenBriefingSettings: _openBriefingSettings,
                          onLogout: _logout,
                          totalUnread: _unreadByPlatform.values
                              .fold(0, (int a, int b) => a + b),
                        ),
                        VerticalDivider(
                          width: 1,
                          thickness: 1,
                          color: AppPalette.resolveSidebarSeparator(variant),
                        ),
                        Expanded(
                          child: RepaintBoundary(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: <Widget>[
                                // 当右侧面板显示时（side 或 split 模式），
                                // 给 AppBar 右侧加相应边距，把被右面板覆盖的部分
                                // 从 AppBar 中裁掉。split 模式使用 [NextbotChatLayout]
                                // 同步过来的实际动态宽度。
                                Padding(
                                  padding: EdgeInsets.only(
                                    right: _appBarRightInset(),
                                  ),
                                  child: AppBar(
                                    automaticallyImplyLeading: false,
                                    // 顶栏与左侧边栏同色(深色主题下为 #131313 的深灰),
                                    // 与聊天主背景的纯黑 (#0F0F0F) 形成可识别但克制的对比
                                    backgroundColor:
                                        AppPalette.resolveSidebar(variant),
                                    foregroundColor:
                                        AppPalette.resolveAppBarForeground(
                                            variant),
                                    surfaceTintColor: Colors.transparent,
                                    elevation: 0,
                                    scrolledUnderElevation: 0,
                                    leadingWidth: 160,
                                    leading: _tabIndex == 0
                                        ? Align(
                                            alignment: Alignment.centerLeft,
                                            child: Padding(
                                              padding: const EdgeInsets.only(
                                                  left: 4),
                                              child:
                                                  _buildMessageNotificationBadge(),
                                            ),
                                          )
                                        : null,
                                    title: _buildAppBarTitle(),
                                    actions: const <Widget>[],
                                  ),
                                ),
                                Expanded(
                                  child: MainPanel(
                                    child: _buildMainContent(),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ],
                    ),
                    const FloatingAgentSphere(),
                    _buildAsyncConfirmationOverlay(),
                    // 右侧面板：top:0 顶到屏幕最顶部，
                    // 在面板宽度范围内覆盖 AppBar / 侧边栏 / 主内容。
                    // side 模式 288px，split 模式动态宽度。
                    // 仅在 chat tab + 宽屏时显示。
                    _buildRightPanelOverlay(),
                    // 进场动画层（覆盖在主界面上方，播完后自动消失层
                    if (_showEntranceAnimation)
                      IgnorePointer(
                        child: EntranceAnimation(
                          onAnimationComplete: () {
                            if (mounted) {
                              setState(() => _showEntranceAnimation = false);
                            }
                          },
                        ),
                      ),
                  ],
                ),
              );
            },
          ),
        );
      },
    );
  }

  /// 「主题」→「亮色」
  void _setLightTheme() {
    setState(() => _themeChoice = ThemeChoice.light);
    AppThemeController.instance.setVariant(AppThemeVariant.warm);
  }

  /// 「主题」→「暗色」
  void _setDarkTheme() {
    setState(() => _themeChoice = ThemeChoice.dark);
    AppThemeController.instance.setVariant(AppThemeVariant.dark);
  }

  /// 「主题」→「跟随系统」
  /// 读取当前平台亮度,立即套用;平台亮度后续变化不会自动重算
  /// (用户需要重新点一次才会重新同步)。
  void _setSystemTheme() {
    final Brightness platformBrightness = MediaQuery.platformBrightnessOf(
      context,
    );
    setState(() => _themeChoice = ThemeChoice.system);
    AppThemeController.instance.setVariant(
      platformBrightness == Brightness.dark
          ? AppThemeVariant.dark
          : AppThemeVariant.warm,
    );
  }

  /// 用户菜单「设置」:暂未实现,先弹个 SnackBar 留位
  void _openUserMenuSettings() {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text("设置:暂未开放"),
        duration: Duration(seconds: 2),
      ),
    );
  }

  /// 用户菜单「帮助与反馈」:暂未实现,先弹个 SnackBar 留位
  void _openUserMenuHelp() {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text("帮助与反馈:暂未开放"),
        duration: Duration(seconds: 2),
      ),
    );
  }

  /// 用户菜单「我的设备」:与对话框构成双面板分栏
  void _openDevicesPage() {
    setState(() {
      _tabIndex = 0;
      _rightPanel = RightPanelKind.devices;
      // 保存当前 splitRatio，关闭时恢复
      _previousSplitRatio = _splitRatio;
      // 保存 side 模式下的原右面板宽度，关闭时恢复
      _previousRightPanelWidth = _rightPanelWidth;
      _splitRatio = RightPanelKind.devices.defaultSplitRatio;
    });
  }

  /// 用户菜单「每日简报」:打开简报设置页（启用开关 / 时间 / 模式 / sections）
  void _openBriefingSettings() {
    final BuildContext? ctx = _rootNavigatorKey.currentContext;
    if (ctx == null) return;
    Navigator.of(ctx).push<void>(
      MaterialPageRoute<void>(
        builder: (BuildContext _) => BriefingSettingsPage(
          api: _preferencesApi,
          sessionId: ApiConfig.effectiveActorId,
        ),
      ),
    );
  }

  /// 用户菜单「退出登录」:先弹确认,确认后弹 SnackBar 占位
  Future<void> _logout() async {
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext ctx) {
        return AlertDialog(
          title: const Text("退出登录"),
          content: const Text("确定要退出当前账号吗?"),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text("取消"),
            ),
            FilledButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text("退出"),
            ),
          ],
        );
      },
    );
    if (confirmed != true || !mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text("退出登录:暂未开放"),
        duration: Duration(seconds: 2),
      ),
    );
  }

  Future<void> _handleMorningBriefingEvent(
    Map<String, dynamic> payload, {
    bool markDesktopShown = false,
    bool forceDialog = false,
  }) async {
    final String mode =
        payload["mode"]?.toString() ?? UserPreferencesApi.modeCard;
    final String narrationText = payload["narrationText"]?.toString() ?? "";
    final Object? rawBriefing = payload["briefing"];
    final Map<String, dynamic> briefing =
        rawBriefing is Map ? rawBriefing.cast<String, dynamic>() : payload;
    final String modeLabel = switch (mode) {
      UserPreferencesApi.modeVoice => "语音",
      UserPreferencesApi.modeWindow => "独立窗口",
      _ => "卡片",
    };

    if (markDesktopShown) {
      _lastDesktopBriefingAt = DateTime.now();
    }

    if (mode == UserPreferencesApi.modeVoice && narrationText.isNotEmpty) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        const SnackBar(content: Text("已开始播报今日简报")),
      );
      if (!forceDialog) {
        return;
      }
    }

    if (mode == UserPreferencesApi.modeWindow &&
        !forceDialog &&
        !kIsWeb &&
        defaultTargetPlatform == TargetPlatform.windows) {
      final bool alreadyDelivered =
          await _isBriefingDeliveredElsewhere(preferredChannel: "desktop");
      if (alreadyDelivered) return;
      _pendingDesktopBriefingPayload = <String, dynamic>{
        "mode": mode,
        "narrationText": narrationText,
        "briefing": briefing,
      };
      final String message = buildDesktopBriefingSummary(briefing);
      _desktopNotificationNeedsFeedback = false;
      _desktopNotificationFeedbackChannel = "websocket";
      final bool shown = await DesktopNotificationLauncher.show(
        title: "每日简报",
        message: message,
        priority: "normal",
        showConfirmButton: true,
        confirmText: "打开查看",
        autoCloseMs: 0,
      );
      if (shown) {
        await _markBriefingDelivered("desktop");
        return;
      }
      _pendingDesktopBriefingPayload = null;
    }

    if (!kIsWeb &&
        defaultTargetPlatform == TargetPlatform.android &&
        !forceDialog) {
      final bool alreadyDelivered =
          await _isBriefingDeliveredElsewhere(preferredChannel: "mobile");
      if (alreadyDelivered) return;
      final String payloadText = jsonEncode(<String, dynamic>{
        "mode": mode,
        "narrationText": narrationText,
        "briefing": briefing,
      });
      await MobileBriefingLauncher.showBriefingNotification(
        title: "每日简报",
        message: buildMobileBriefingSummary(briefing),
        payload: payloadText,
      );
      await _markBriefingDelivered("mobile");
      return;
    }

    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (BuildContext dialogContext) {
        return Dialog(
          insetPadding:
              const EdgeInsets.symmetric(horizontal: 24, vertical: 24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: Padding(
              padding: const EdgeInsets.all(8),
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    MorningBriefingCard(
                      briefing: briefing,
                      narrationText: narrationText,
                      modeLabel: modeLabel,
                      onSpeak: (String text) {
                        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
                          SnackBar(content: Text(text)),
                        );
                      },
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.end,
                        children: <Widget>[
                          TextButton(
                            onPressed: () => Navigator.of(dialogContext).pop(),
                            child: const Text("知道了"),
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
      },
    );
    if (defaultTargetPlatform == TargetPlatform.windows) {
      await _markBriefingDelivered("desktop");
    } else if (defaultTargetPlatform == TargetPlatform.android) {
      await _markBriefingDelivered("mobile");
    }
  }

  Future<void> _tryShowDesktopLaunchBriefing() async {
    try {
      final Map<String, dynamic> prefs =
          await _preferencesApi.getPreferences(ApiConfig.effectiveActorId);
      final Object? rawMb = prefs["morningBriefing"];
      final Map<String, dynamic> mb =
          rawMb is Map ? rawMb.cast<String, dynamic>() : <String, dynamic>{};
      if (mb["enabled"] == false || mb["showOnDesktopLaunch"] == false) {
        return;
      }
      final DateTime now = DateTime.now();
      if (_lastDesktopBriefingAt != null &&
          now.difference(_lastDesktopBriefingAt!).inMinutes < 10) {
        return;
      }
      if (await _isBriefingDeliveredElsewhere(preferredChannel: "desktop")) {
        return;
      }
      final Uri uri = Uri.parse(
        "${ApiConfig.httpBase}/api/morning-briefing?sessionId=${Uri.encodeQueryComponent(ApiConfig.effectiveActorId)}&format=narration",
      );
      final http.Response res =
          await http.get(uri).timeout(const Duration(seconds: 10));
      if (res.statusCode != 200) return;
      final Map<String, dynamic> data =
          jsonDecode(res.body) as Map<String, dynamic>;
      final Object? briefingRaw = data["briefing"];
      if (briefingRaw is! Map) return;
      await _handleMorningBriefingEvent(
        <String, dynamic>{
          "mode": mb["mode"]?.toString() ?? UserPreferencesApi.modeWindow,
          "narrationText": data["narrationText"]?.toString() ?? "",
          "briefing": briefingRaw.cast<String, dynamic>(),
        },
        markDesktopShown: true,
      );
    } catch (_) {
      // ignore desktop launch briefing failures
    }
  }

  Future<void> _tryShowMobileLaunchBriefing() async {
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) return;
    try {
      final Map<String, dynamic> prefs =
          await _preferencesApi.getPreferences(ApiConfig.effectiveActorId);
      final Object? rawMb = prefs["morningBriefing"];
      final Map<String, dynamic> mb =
          rawMb is Map ? rawMb.cast<String, dynamic>() : <String, dynamic>{};
      if (mb["enabled"] == false) return;
      if (await _isBriefingDeliveredElsewhere(preferredChannel: "mobile")) {
        return;
      }
      final Uri uri = Uri.parse(
        "${ApiConfig.httpBase}/api/morning-briefing?sessionId=${Uri.encodeQueryComponent(ApiConfig.effectiveActorId)}&format=narration",
      );
      final http.Response res =
          await http.get(uri).timeout(const Duration(seconds: 10));
      if (res.statusCode != 200) return;
      final Map<String, dynamic> data =
          jsonDecode(res.body) as Map<String, dynamic>;
      final Object? briefingRaw = data["briefing"];
      if (briefingRaw is! Map) return;
      await _handleMorningBriefingEvent(
        <String, dynamic>{
          "mode": mb["mode"]?.toString() ?? UserPreferencesApi.modeCard,
          "narrationText": data["narrationText"]?.toString() ?? "",
          "briefing": briefingRaw.cast<String, dynamic>(),
        },
      );
    } catch (_) {
      // ignore mobile launch briefing failures
    }
  }

  Future<void> _consumePendingMobileBriefingLaunch() async {
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) return;
    final String? payload = await MobileBriefingLauncher.consumeLaunchPayload();
    if (payload == null || payload.isEmpty) return;
    await _openBriefingFromPayload(payload);
  }

  Future<void> _openBriefingFromPayload(String payload) async {
    try {
      final Map<String, dynamic> data =
          jsonDecode(payload) as Map<String, dynamic>;
      await _markBriefingDelivered("mobile");
      await _handleMorningBriefingEvent(data, forceDialog: true);
    } catch (_) {
      // ignore invalid mobile briefing payload
    }
  }

  Future<void> _ensureAndroidNotificationPermission() async {
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) return;
    if (_notificationPermissionChecked) return;
    _notificationPermissionChecked = true;
    try {
      final PermissionStatus status = await Permission.notification.status;
      if (status.isDenied) {
        await Permission.notification.request();
      }
    } catch (_) {
      // ignore notification permission failures
    }
  }

  Future<bool> _isBriefingDeliveredElsewhere({
    required String preferredChannel,
  }) async {
    try {
      final Map<String, dynamic> status =
          await _briefingDeliveryApi.getStatus(ApiConfig.effectiveActorId);
      final String? deliveredAt = status["deliveredAt"]?.toString();
      final String? deliveredChannel = status["deliveredChannel"]?.toString();
      if (deliveredAt == null || deliveredAt.isEmpty) return false;
      if (deliveredChannel == null || deliveredChannel.isEmpty) return false;
      return deliveredChannel != preferredChannel;
    } catch (_) {
      return false;
    }
  }

  Future<void> _markBriefingDelivered(String channel) async {
    try {
      await _briefingDeliveryApi.markDelivered(
        ApiConfig.effectiveActorId,
        channel: channel,
      );
    } catch (_) {
      // ignore delivery mark failures
    }
  }

  Future<void> _loadAgentProfile() async {
    try {
      final Map<String, dynamic> prefs =
          await _preferencesApi.getPreferences(ApiConfig.effectiveActorId);
      final AgentProfileData profile = AgentProfileData.fromPreferences(prefs);
      if (!mounted) return;
      setState(() {
        _agentProfile = profile;
        _agentName = profile.displayName;
      });
    } catch (_) {
      // keep defaults when profile loading fails
    }
  }

  /// 是否在主区显示右侧快捷功能面板（同时也是裁剪 AppBar / 占位宽度的依据）。
  /// 条件：chat tab + 宽屏 (>= 820) + 无右抽屉打开。
  bool _shouldShowRightSidePanel() {
    if (_tabIndex != 0) return false;
    if (_rightPanel != null) return false;
    return MediaQuery.sizeOf(context).width >= 820;
  }

  /// AppBar 右侧需要让出的宽度。
  /// - side 模式：右面板宽度(由 NextbotChatLayout 同步) — 此宽度是总占位
  ///   (含 8px 拖拽条)，与 Positioned 的 width 一致。
  /// - split 模式：[NextbotChatLayout] 同步过来的动态宽度 [_rightPanelWidth]
  /// - 其他：0
  double _appBarRightInset() {
    if (_shouldShowRightSidePanel()) return _rightPanelWidth;
    if (_rightPanel != null && _tabIndex == 0) return _rightPanelWidth;
    return 0;
  }

  /// 在外层 Stack 顶层用 [Positioned] 渲染右侧面板（side 或 split 模式），
  /// 使面板从屏幕最顶部 (top:0) 贯通到底部，覆盖宽度范围内的 AppBar。
  ///
  /// - side 模式：宽度 = [_rightPanelWidth]（由 NextbotChatLayout 拖动条控制），
  ///   渲染 [RightSidePanel]（今日安排 / 常用工具 / 桌宠）。
  /// - split 模式：宽度 = [NextbotChatLayout] 同步过来的动态宽度，
  ///   渲染 [_buildSplitPanel]（顶栏 + 自定义内容）。
  Widget _buildRightPanelOverlay() {
    if (_tabIndex != 0) {
      return const SizedBox.shrink();
    }
    final double screenWidth = MediaQuery.sizeOf(context).width;
    if (screenWidth < 820) {
      return const SizedBox.shrink();
    }
    if (_rightPanel != null) {
      // split 模式：动态宽度 + 顶栏面板
      return Positioned(
        top: 0,
        right: 0,
        bottom: 0,
        width: _rightPanelWidth,
        child: _buildSplitPanel(),
      );
    }
    // side 模式：动态宽度(可拖拽) + RightSidePanel
    //
    // [NextbotChatLayout] 内部的 Row = Expanded(chat) | VerticalDragDivider(8)
    // | SizedBox(占位), 报告的总右占位 = [kDividerWidth] + 占位 = 220 等。
    // 这里 Positioned 只覆盖占位(不含 divider 8px), 拖拽条才能在 chat 与
    // 面板之间露出来, 用户才能拖动。
    return Positioned(
      top: 0,
      right: 0,
      bottom: 0,
      width: _rightPanelWidth - _kSidePanelDividerWidth,
      child: RightSidePanel(
        scheduleFuture: _cachedScheduleFuture,
        onAgentLink: _openAgentLinkTab,
        onSchedule: _openSchedulePanel,
        onWallet: _openWalletDialog,
        onPhone: _openPhoneDevicesDialog,
        onMessages: _openMessagesPanel,
        // 天气面板实时位置 → 上报服务端缓存，供 Agent 按需复用（无 jobId 纯上报）
        onReportLocation: (location) {
          _ws.sendEvent("client.location_report", location);
        },
      ),
    );
  }

  /// split 模式的右分栏面板：顶栏（标题 + 关闭按钮）+ 自定义内容。
  /// 背景使用 cs.surface 跟随主题（黑/白）。
  Widget _buildSplitPanel() {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Material(
      color: cs.surface,
      surfaceTintColor: Colors.transparent,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          _buildSplitPanelHeader(cs),
          Expanded(
            child: Container(
              decoration: BoxDecoration(
                color: cs.surface,
                border: Border(
                  top: BorderSide(color: cs.outline.withValues(alpha: 0.25)),
                ),
              ),
              child: _buildRightPanelContent(),
            ),
          ),
        ],
      ),
    );
  }

  /// split 面板顶栏：拖拽指示 + 标题 + 关闭按钮。
  Widget _buildSplitPanelHeader(ColorScheme cs) {
    // 标题栏背景跟随主题主色（黑色主题下为纯黑），
    // 因此文字/图标在暗色下用纯白保证可读性，暖色下用主题前景色。
    final bool isDark =
        Theme.of(context).brightness == Brightness.dark;
    final Color fg = isDark ? Colors.white : cs.onSurface;
    final Color fgMuted = isDark ? Colors.white : cs.onSurfaceVariant;
    return Container(
      height: 40,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(
        // 标题栏与主面板同色，显式绑定主题主色，杜绝任何残留的浅色渲染
        color: AppPalette.resolveMainPanel(AppThemeController.instance.value),
        border: Border(
          left: BorderSide(color: cs.outline.withValues(alpha: 0.35)),
          bottom: BorderSide(color: cs.outline.withValues(alpha: 0.25)),
        ),
      ),
      child: Row(
        children: <Widget>[
          Icon(Icons.drag_indicator, size: 16, color: fgMuted),
          const SizedBox(width: 8),
          Text(
            _rightPanel == null ? "" : rightPanelTitle(_rightPanel!),
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w600,
              color: fg,
            ),
          ),
          const Spacer(),
          IconButton(
            icon: Icon(Icons.close, size: 18, color: fgMuted),
            tooltip: "关闭面板",
            visualDensity: VisualDensity.compact,
            onPressed: _closeRightPanel,
          ),
        ],
      ),
    );
  }

  /* 旧浮层实现（已替换为 NextbotChatLayout 内嵌分栏）
  Widget _buildRightPanelOverlayLegacy() {
    if (_rightPanel == null) {
      return const SizedBox.shrink();
    }
    // 根据屏幕宽度计算面板绝对像素宽度:小屏几乎占满,宽屏固定 480
    final double screenWidth = MediaQuery.sizeOf(context).width;
    final double panelWidth = screenWidth < 820 ? screenWidth * 0.92 : 480.0;
    return RightSidePanel(
      visible: true,
      title: rightPanelTitle(_rightPanel!),
      onClose: _closeRightPanel,
      panelWidth: panelWidth,
      child: _buildRightPanelContent(),
    );
  }
  */

  /// 右侧面板要渲染的具体内容
  Widget _buildRightPanelContent() {
    switch (_rightPanel) {
      case RightPanelKind.friends:
        return MailboxPage(api: _worldApi, ws: _ws);
      case RightPanelKind.messages:
        return MessageHubPage(api: _worldApi);
      case RightPanelKind.devices:
        return const DevicesPage();
      case RightPanelKind.schedule:
        return SchedulePage(
          store: _store,
          scheduleApi: _scheduleApi,
          sessionId: ApiConfig.effectiveActorId,
          reloadListenable: _calendarReloadSignal,
        );
      case null:
        return const SizedBox.shrink();
    }
  }

  Widget _buildMainContent() {
    final double screenWidth = MediaQuery.sizeOf(context).width;

    if (_tabIndex != 0 || screenWidth < 820) {
      return _buildTabStack();
    }
    return NextbotChatLayout(
      useSplit: _rightPanel != null,
      splitRatio: _splitRatio,
      onSplitRatioChanged: _setSplitRatio,
      onRightPanelWidthChanged: _setRightPanelWidth,
      // side 模式下也启用拖拽：把当前宽度(含 8px 拖拽条)传下去,
      // NextbotChatLayout 内部会保留此值作为初始/外部同步值。
      // split 模式下该参数会被忽略,这里统一传当前宽度即可,
      // 避免打开工具面板时传 null 把内部的 _sidePanelWidth 重置成默认值。
      sidePanelWidth: _rightPanelWidth,
      child: _buildChatPage(context),
    );
  }

  /// 构建聊天页（宽屏布局与 Tab 栈共用）
  Widget _buildChatPage(BuildContext context) {
    return ChatPage(
      messages: _messages,
      controller: _inputController,
      inputFocusNode: _inputFocusNode,
      onSend: _sendMessage,
      agentName: _agentName,
      agentAvatarUrl: _agentProfile.avatarUrl,
      agentMoodStyle: _agentProfile.moodStyle,
      agentAvatarPreset: _agentProfile.avatarPreset,
      agentProfile: _agentProfile,
      galleryPendingCount: _pendingGalleryFrames.length,
      onPickGalleryImage: _pickGalleryImage,
      onClearGalleryImages: _clearPendingGalleryFrames,
      isAgentProcessing: _isAgentProcessing,
      agentStatusLine: _agentStatusLine,
      agentStatusPercent: _agentStatusPercent,
      interimAckText: _interimAckText,
      // v2：把结构化状态机注入到 ChatPage；v1 链路下传 null 不影响
      turnState: _turnState ?? _pendingLocalTurn,
      isActive: _tabIndex == 0,
      // 语音对话模式入口（输入框右下 mic 按钮）—— 召唤屏幕右下角 VoiceOrb 悬浮球
      onEnterVoiceMode: _invokeVoiceOrb,
      onOpenPhoneDialer: () {
        _callMyAgentViaPhone(null);
      },
      onDeleteMessage: _deleteSingleMessage,
      onDeleteFromMessage: _deleteMessagesFrom,
      onStopAgent: _cancelCurrentTurn,
      onUserAction: _handleCardAction,
    );
  }

  /// 根级 Tab 栈：Windows 桌面球形 Agent 为单一原生实体（槽位锚定+ 桌面漫游）
  ///
  /// 注：已不再作为整页 tab 出现，而是从右侧滑出折叠面板。
  /// 为了不破坏 _tabIndex 的取值约定,这里保留 1(好友占位),
  /// 渲染为空 SizedBox —— _openAgentLinkTab
  Widget _buildTabStack() {
    return Builder(
      builder: (BuildContext context) {
        return IndexedStack(
          index: _tabIndex,
          children: <Widget>[
            _buildChatPage(context),
            const SizedBox.shrink(), // 1: 好友 → 右侧面板
            // 2: 钱包由 dialog 弹出,栈里不占位
            const SizedBox.shrink(),
          ],
        );
      },
    );
  }
}
