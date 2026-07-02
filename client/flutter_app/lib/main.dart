import "dart:async";
import "dart:convert";

import "package:flutter/foundation.dart";
import "package:flutter/material.dart";
import "package:flutter/scheduler.dart";
import "package:http/http.dart" as http;
import "package:permission_handler/permission_handler.dart";

import "core/config/api_config.dart";
import "core/theme/app_theme.dart";
import "core/presentation/location_permission_dialog.dart";
import "core/presentation/virtual_phone_ui_labels.dart";
import "core/presentation/entrance_animation.dart";
import "core/db/isar_local_history_store.dart";
import "core/models/agent_relay_models.dart";
import "core/models/chat_models.dart";
import "core/models/schedule_models.dart";
import "core/models/wallet_models.dart";
import "core/models/turn_state.dart";
import "core/services/schedule_api_client.dart";
import "core/services/schedule_offline_delete_queue.dart";
import "core/services/schedule_reminder_sync.dart";
import "core/services/world_api_client.dart";
import "core/services/client_location_service.dart";
import "core/services/agent_sphere_mood_bridge.dart";
import "core/services/agent_sphere_embodiment_mapper.dart";
import "core/services/sphere_embodiment_motion_bridge.dart";
import "core/services/agent_sphere_interact_bridge.dart";
import "core/services/desktop_bridge_service.dart";
import "core/services/phone_bridge_service.dart";
import "core/services/sphere_entity_controller.dart";
import "core/services/translate_overlay_launcher.dart";
import "core/services/user_preferences_api.dart";
import "core/services/windows_webview_bootstrap.dart";
import "core/services/ws_chat_service.dart";
import "core/utils/play_url_utils.dart";
import "features/mailbox/mailbox_page.dart";
import "features/mailbox/message_hub_page.dart";
import "features/notes/notes_chat_page.dart";
import "features/chat/agent_profile_page.dart";
import "features/chat/chat_page.dart";
import "features/chat/chat_layout.dart";
import "features/chat/right_side_panel.dart";
import "features/chat/floating_agent_sphere.dart";
import "features/chat/morning_briefing_card.dart";
import "features/chat/voice_mode_page.dart";
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
import "features/gomoku/gomoku_page.dart";
import "features/game_center/game_center_page.dart";
import "features/integrations/wechat_claw_binding_page.dart";
import "core/vision/pick_gallery_vision.dart";
import "core/vision/vision_wire_frame.dart";
import "features/schedule/schedule_page.dart";
import "features/skill_store/skill_store_page.dart";
import "features/wallet/wallet_page.dart";

void main() {
  runZonedGuarded(() {
    WidgetsFlutterBinding.ensureInitialized();
    unawaited(bootstrapWindowsWebView());
    runApp(const PrivateAiApp());
  }, (error, stack) {
    // 兜底所有未捕获的异步异常，防止 Flutter engine 断连崩溃
    debugPrint('[UNCAUGHT] $error\n$stack');
  });
}

/// 侧栏 hover 延后到下一帧，避免 AnimatedCrossFade 切换时触发mouse_tracker 断言失败
void _deferSidebarHover(VoidCallback fn) {
  SchedulerBinding.instance.addPostFrameCallback((_) => fn());
}

/// 右侧抽屉要展示的内容种类。
enum _RightPanelKind { friends, games, messages }

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

  /// 是否显示右上角日历面板
  bool _showCalendarPanel = false;

  /// 当前右侧面板要展示的内容
  /// - null: 未打开
  /// - _RightPanelKind.friends:     好友（MailboxPage）
  /// - _RightPanelKind.games:      游戏（GameCenterPage）
  /// - _RightPanelKind.messages:   消息聚合（MessageHubPage）
  _RightPanelKind? _rightPanel;

  Map<String, int> _unreadByPlatform = <String, int>{};
  Timer? _messagePollTimer;
  bool _messageBadgeHovering = false;

  /// 关闭右侧面板
  void _closeRightPanel() {
    if (_rightPanel == null) return;
    setState(() => _rightPanel = null);
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

  /// 对话输入框：默认沙箱；开启后可授权桌面/钱包等高权限工具
  bool _fullComputerAccessEnabled = false;

  /// 服务端`chat.agent_status` 推送的口语化进度（替换固定「思考中」）
  String? _agentStatusLine;

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

  Timer? _assistantChunkFlushTimer;
  Timer? _agentReplyWatchdog;
  String? _pendingAssistantChunkMessageId;
  String? _pendingAgentUserMessageId;
  final StringBuffer _pendingAssistantChunkText = StringBuffer();

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
    // decline : 用户点了挂断 → 发 phone.hangup
    // timeout : 振铃超时（默认 30s）
    IncomingCallLauncher.bindHandlers(
      onAccept: _handleNativeCallAccept,
      onDecline: _handleNativeCallDecline,
      onTimeout: _handleNativeCallTimeout,
    );
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
    // 独立翻译悬浮窗事件绑定（原生 HWND 窗口，C++ 端 → MethodChannel → 这里）
    //   - close: 用户点 ✕（已自动隐藏窗口，无需重开）
    //   - clear: 用户点清空（清掉所有卡片）
    //   - langChanged: 用户点了语言下拉（参数为目标语言 code）
    TranslateOverlayLauncher.bindHandlers(
      onCloseClicked: (_) {/* 窗口已自动 hide，不需要做什么 */},
      onClearClicked: (_) {/* 同上 */},
      onLangChange: _handleTranslateLangChange,
    );
    _bootstrap();
  }

  @override
  void dispose() {
    DesktopBridgeService.instance.stop();
    PhoneBridgeService.instance.stop();
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
    _scheduleReloadSignal.dispose();
    _calendarReloadSignal.dispose();
    _stopMessagePolling();
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

    final List<ChatMessage> cachedMessages =
        await _store.listMessages(ApiConfig.effectiveActorId);

    final List<AgentRelayMessage> cachedRelay =
        await _store.listRelayInbound(ApiConfig.effectiveActorId);

    final bool? visionConsent = await _store.getVisionCameraConsent();

    setState(() {
      _messages.addAll(cachedMessages);
      _relayInbound
        ..clear()
        ..addAll(cachedRelay);
      _visionCameraConsent = visionConsent;
      // 设置agent名字占位符
      _agentName = "AI助手";
      _isInitialized = true;
    });

    unawaited(_loadAgentProfile());
    unawaited(_flushScheduleOfflineDeletes());

    _ws.onConnected = () {
      SphereEmbodimentMotionBridge.instance.setMainAgentLinked(true);
      _sendSessionInit();
      unawaited(_flushScheduleOfflineDeletes());
      if (!kIsWeb && defaultTargetPlatform == TargetPlatform.windows) {
        DesktopBridgeService.instance.start();
        unawaited(_tryShowDesktopLaunchBriefing());
      }
      if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) {
        PhoneBridgeService.instance.start();
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
                !_isMasterInvokeSubAgentTool(toolName)) {
              return;
            }
            final String? userStatusLine =
                payload["userStatusLine"]?.toString().trim();
            final String? preamble =
                payload["assistantPreamble"]?.toString().trim();
            final String line =
                (userStatusLine != null && userStatusLine.isNotEmpty)
                    ? userStatusLine
                    : (preamble != null && preamble.isNotEmpty)
                        ? preamble
                        : "";
            if (_isMasterInvokeSubAgentTool(toolName)) {
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
          if (_isMasterInvokeSubAgentTool(toolName) && result != null) {
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
                  _cachedScheduleFuture = null; // 清除缓存，触发 FutureBuilder 重建
                }
              } else {
                final bool synced = await upsertLocalScheduleFromToolResult(
                  _store,
                  toolName,
                  result,
                );
                if (synced) {
                  _notifyScheduleViewsChanged();
                  _cachedScheduleFuture = null; // 清除缓存，触发 FutureBuilder 重建
                }
              }
            } catch (e, st) {
              debugPrint("[schedule] tool.result sync failed: $e\n$st");
            }
          }
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
            _cachedScheduleFuture = null; // 清除缓存
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
          _updateAgentStatusLine(line, ensureProcessing: true);
        }
        if (type == "chat.assistant_interim") {
          // 分阶段消息交付阶段一：服务端在多步/工具型请求开始时推送的
          // 即时确认应答（如「好的，让我查一下…」）。作为独立 assistant 消息
          // 入列表并保留——工具执行期间呼吸灯亮，chat.assistant_done 抵达后
          // 再追加结果消息，形成「首条 → 工具 → 结果」的两段式对话。
          final String? interimTraceId = payload["traceId"]?.toString();
          final String? activeTraceId = _pendingAgentUserMessageId;
          if (interimTraceId == null ||
              interimTraceId.isEmpty ||
              activeTraceId == null ||
              interimTraceId != activeTraceId) {
            return;
          }
          final String text = payload["text"]?.toString().trim() ?? "";
          if (text.isEmpty) return;
          // interim 到达说明服务端已开始处理，重置回复超时计时器
          _resetAgentReplyWatchdog();
          final String interimMessageId = "interim-$interimTraceId";
          // 去重：同一 traceId 的 interim 只入一次
          if (_assistantMessageIndexById.containsKey(interimMessageId)) {
            return;
          }
          final ChatMessage interimMsg = ChatMessage(
            messageId: interimMessageId,
            sessionId: ApiConfig.effectiveActorId,
            role: "assistant",
            text: text,
            timestamp: DateTime.now(),
          );
          setState(() {
            _messages.add(interimMsg);
            _assistantMessageIndexById[interimMessageId] = _messages.length - 1;
          });
          await _store.saveMessage(interimMsg);
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
          // interim 已作为独立 assistant 消息入列表并保留，chunk 无需让位；
          // _clearInterimAck 现为 no-op（_interimAckText 不再被设置）。
          _clearInterimAck();
          if (!_isAgentProcessing) {
            setState(() => _isAgentProcessing = true);
            _notifyAgentProcessingUi(true);
          }
          final String messageId = chunkAssistantMessageId ??
              ((activeTraceId != null && activeTraceId.isNotEmpty)
                  ? "assistant-$activeTraceId"
                  : "assistant-streaming");
          final String chunk = payload["chunk"]?.toString() ?? "";
          // 关键：流式期间 chunk 只进缓冲（_flushAssistantChunks 现在不入列表），
          // **绝对不要**用「chunked 末行」去覆盖 agentStatusLine——那会把回复正文
          // 顶到思考气泡里。思考气泡只能由 chat.agent_status / tool.call / tool.result
          // 这些"agent 在干的事"来更新。
          _enqueueAssistantChunk(messageId, chunk);
          // v2：把 chunk 同步累加进 TurnState.streamBuffer（UI 改造后用作流式正文源）
          _turnState?.appendChunk(chunk);
        }
        if (type == "chat.assistant_done") {
          final String bufferedText =
              _pendingAssistantChunkText.toString().trim();
          final String? doneTraceId = payload["traceId"]?.toString();
          final String? activeTraceId = _pendingAgentUserMessageId;
          if (doneTraceId != null &&
              doneTraceId.isNotEmpty &&
              activeTraceId != null &&
              doneTraceId != activeTraceId) {
            return;
          }
          // 关键：先在 traceId 上打「本轮已结束」标记，再做后续副作用。
          // 否则清状态与清 traceId 之间存在竞态：迟到的 chunk/agent_status
          // 会看到 _pendingAgentUserMessageId 还有值，重新点亮思考气泡。
          _pendingAgentUserMessageId = null;
          _disarmAgentReplyWatchdog();
          _flushAssistantChunks();
          // v2：done=true 让 _clearAgentProcessingState 内部调 markDone（而非 markCanceled）
          _clearAgentProcessingState(done: true);
          final String messageId = payload["messageId"]?.toString() ??
              ((doneTraceId != null && doneTraceId.isNotEmpty)
                  ? "assistant-$doneTraceId"
                  : "assistant-final");
          final String finalText = payload["finalText"]?.toString() ?? "";
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
          final int? idx = _assistantMessageIndexById[messageId];
          if (idx != null) {
            setState(() {
              final ChatMessage previous = _messages[idx];
              final String nextText = resolvedText.trim().isNotEmpty
                  ? resolvedText
                  : (previous.text.trim().isNotEmpty
                      ? previous.text
                      : fallbackText);
              _messages[idx] = ChatMessage(
                messageId: previous.messageId,
                sessionId: previous.sessionId,
                role: previous.role,
                text: nextText,
                timestamp: previous.timestamp,
                attachmentImageCount: previous.attachmentImageCount,
                playUrl: playUrl ?? previous.playUrl,
              );
            });
            await _store.saveMessage(_messages[idx]);
          } else {
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
          _takePendingAssistantChunkText();
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
        if (type == "agent.phone.ringing_start") {
          if (!mounted) return;
          final String direction =
              payload["direction"]?.toString() ?? "agent_to_user";
          final String ringStyle =
              payload["ringStyle"]?.toString() ?? "reminder";
          final String callerLabel = VirtualPhoneUiLabels.incomingCallerLabel(
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
          final String callerLabel = VirtualPhoneUiLabels.incomingCallerLabel(
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
          final String callerLabel = VirtualPhoneUiLabels.incomingCallerLabel(
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
              _phoneCallToActorId = VirtualPhoneUiLabels.incomingCallerLabel(
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
      _cachedScheduleFuture = null; // 失效缓存
    }
  }

  void _notifyScheduleViewsChanged() {
    _scheduleReloadSignal.value += 1;
    _calendarReloadSignal.value += 1;
    _cachedScheduleFuture = null;
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
    final int? idx = _assistantMessageIndexById[messageId];
    if (idx == null) return null;
    return _messages[idx].playUrl;
  }

  void _enqueueAssistantChunk(String messageId, String chunk) {
    if (chunk.isEmpty) return;
    if (_pendingAssistantChunkMessageId != null &&
        _pendingAssistantChunkMessageId != messageId) {
      _flushAssistantChunks();
    }
    _pendingAssistantChunkMessageId = messageId;
    _pendingAssistantChunkText.write(chunk);
    _assistantChunkFlushTimer ??= Timer(const Duration(milliseconds: 32), () {
      _assistantChunkFlushTimer = null;
      _flushAssistantChunks();
    });
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
    _pendingAssistantChunkText.clear();
    return buffered;
  }

  void _clearAgentProcessingState({bool done = false}) {
    if (!_isAgentProcessing &&
        _agentStatusLine == null &&
        _interimAckText == null &&
        !_subAgentDelegationActive &&
        _turnState == null &&
        _pendingLocalTurn == null) {
      return;
    }
    setState(() {
      _isAgentProcessing = false;
      _agentStatusLine = null;
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
    final int? idx = _assistantMessageIndexById[assistantMessageId];
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

  String _shortLiveStatusLine(String text) {
    final String trimmed = text.trim();
    if (trimmed.isEmpty) return "";
    final List<String> lines = trimmed
        .split(RegExp(r"\r?\n"))
        .map((String s) => s.trim())
        .where((String s) => s.isNotEmpty)
        .toList();
    String line = lines.isNotEmpty ? lines.last : trimmed;
    if (line.length > 120) {
      line = "${line.substring(0, 119)}…";
    }
    return line;
  }

  bool _isMasterInvokeSubAgentTool(String toolName) {
    final String n = toolName.trim();
    return n == "master.invoke_sub_agent" || n == "master_invoke_sub_agent";
  }

  void _updateAgentStatusLine(String line, {bool ensureProcessing = false}) {
    final String trimmed = line.trim();
    if (trimmed.isEmpty) return;
    _resetAgentReplyWatchdog();
    setState(() {
      if (ensureProcessing) {
        _isAgentProcessing = true;
      }
      _agentStatusLine = trimmed;
    });
    if (ensureProcessing) {
      _notifyAgentProcessingUi(true);
    }
  }

  void _attachPlayUrlToAssistantMessage(String messageId, String playUrl) {
    final int? idx = _assistantMessageIndexById[messageId];
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

  Future<void> _sendMessage() async {
    if (!_ws.isConnected) {
      _ws.retryConnect();
      if (mounted) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          const SnackBar(content: Text("正在连接服务器，请稍后再发消息")),
        );
      }
      return;
    }
    final String text = _inputController.text.trim();

    List<VisionWireFrame>? attachmentFrames;
    if (_pendingGalleryFrames.isNotEmpty) {
      attachmentFrames = List<VisionWireFrame>.from(_pendingGalleryFrames);
      setState(_pendingGalleryFrames.clear);
    }

    if (text.isEmpty && attachmentFrames == null) {
      return;
    }

    // 如果Agent正在处理中，说明用户要打断当前回复
    if (_isAgentProcessing) {
      // 保存当前未完成的回复内容
      if (_pendingAssistantChunkText.isNotEmpty) {
        _interruptedResponses.add(_pendingAssistantChunkText.toString());
        _pendingAssistantChunkText.clear();
      }

      // 清除当前的流式响应状态
      _disarmAgentReplyWatchdog();
      _pendingAgentUserMessageId = null;
      setState(() {
        _isAgentProcessing = false;
        _agentStatusLine = null;
        _pendingAssistantChunkMessageId = null;
      });

      // 取消定时器
      _assistantChunkFlushTimer?.cancel();
      _assistantChunkFlushTimer = null;
    }

    final int attachCount = attachmentFrames?.length ?? 0;
    final ChatMessage userMessage = ChatMessage(
      messageId: "msg-${DateTime.now().microsecondsSinceEpoch}",
      sessionId: ApiConfig.effectiveActorId,
      role: "user",
      text: text.isEmpty ? "（见图）" : text,
      timestamp: DateTime.now(),
      attachmentImageCount: attachCount,
    );
    setState(() {
      _messages.add(userMessage);
      _inputController.clear();
      _isAgentProcessing = true;
      _agentStatusLine = null;
    });
    _notifyAgentProcessingUi(true);
    AgentSphereMoodBridge.instance.listening();
    await _store.saveMessage(userMessage);
    final Map<String, dynamic> userMsg = <String, dynamic>{
      "sessionId": ApiConfig.sessionId,
      "messageId": userMessage.messageId,
      "text": text.isEmpty && attachmentFrames != null ? "" : text,
      "timestamp": DateTime.now().toIso8601String(),
    };
    if (attachmentFrames != null && attachmentFrames.isNotEmpty) {
      userMsg["visionFrames"] =
          attachmentFrames.map((VisionWireFrame f) => f.toJson()).toList();
    }
    if (ApiConfig.userId.trim().isNotEmpty) {
      userMsg["userId"] = ApiConfig.userId.trim();
    }

    // 前端 GPS 定位（优先于 IP 地理库）
    final ClientLocationPayload? clientLocation =
        await ClientLocationService.getCurrentLocation();
    if (clientLocation != null) {
      userMsg["clientLocation"] = clientLocation.toJson();
    }
    userMsg["agentAccessMode"] =
        _fullComputerAccessEnabled ? "full" : "sandbox";

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

  static const List<String> _kTabTitles = <String>[
    "",
    "",
    "",
    "技能商城",
    "游戏",
  ];

  void _selectTab(int index) {
    setState(() => _tabIndex = index);
  }

  /// 好友入口：不再切整页 tab，而是从右侧滑出好友面板
  void _openAgentLinkTab() {
    setState(() {
      _tabIndex = 0;
      _rightPanel = _RightPanelKind.friends;
    });
  }

  /// 游戏入口：不再切整页 tab，而是从右侧滑出游戏面板
  void _openGameCenterTab() {
    setState(() {
      _tabIndex = 0;
      _rightPanel = _RightPanelKind.games;
    });
  }

  /// 消息入口：从右侧滑出消息聚合面板
  void _openMessagesPanel() {
    setState(() {
      _tabIndex = 0;
      _rightPanel = _RightPanelKind.messages;
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

  void _openSchedulePanel() {
    setState(() {
      _tabIndex = 0;
      _showCalendarPanel = true;
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

  /// 常用工具「翻译」入口：唤起独立翻译悬浮窗（与主应用同进程，HWND + GDI 自绘）。
  ///
  /// 跟之前走 Python 托盘 IPC 不同，这里直接调
  /// `pai/translate_overlay` MethodChannel，让 windows/runner 端
  /// `TranslateOverlayWindow` 起一个原生 HWND 窗口。
  /// 可拖动、可设 on-top、点 ✕ 只隐藏（不退出进程）。
  Future<void> _openTranslatePage() async {
    final BuildContext? navCtx = _rootNavigatorKey.currentContext;
    if (navCtx == null) return;
    final ScaffoldMessengerState? messenger = ScaffoldMessenger.maybeOf(navCtx);

    final ok = await TranslateOverlayLauncher.show();
    if (ok) {
      messenger?.showSnackBar(
        const SnackBar(
          content: Text(
            "已唤起翻译悬浮窗 · 在桌面上自由拖动  ·  鼠标悬停文字自动翻译",
          ),
          duration: Duration(seconds: 4),
        ),
      );
    } else {
      messenger?.showSnackBar(
        const SnackBar(
          content: Text(
            "唤起失败：当前平台暂不支持独立翻译窗口（仅 Windows 桌面版）",
          ),
          duration: Duration(seconds: 5),
        ),
      );
    }
  }

  void _handleTranslateLangChange(String langCode) {
    // 1) 把新语言同步到原生窗口（让顶栏按钮文字立刻更新）
    // 2) 持久化到本地偏好（_preferencesApi，TODO: 加 setString 后再写）
    debugPrint("[translate] lang changed: $langCode");
    final label = _translateLangLabel(langCode);
    unawaited(TranslateOverlayLauncher.setLanguage(
      code: langCode,
      label: label,
    ));
  }

  String _translateLangLabel(String code) {
    switch (code) {
      case 'zh':
        return '中文';
      case 'en':
        return 'English';
      case 'ja':
        return '日本語';
      case 'ko':
        return '한국어';
      case 'fr':
        return 'Français';
      case 'de':
        return 'Deutsch';
      case 'es':
        return 'Español';
      case 'ru':
        return 'Русский';
      case 'zh-Hant':
        return '繁體';
      case 'auto':
        return '自动检测';
      default:
        return '中文';
    }
  }

  /// 常用工具「笔记」入口：跳转到与笔记 Agent 的独立对话页（独立 WebSocket 命名空间，
  /// 记忆写入 context=notes）。
  void _openNotesChat() {
    final BuildContext? navCtx = _rootNavigatorKey.currentContext;
    if (navCtx == null || !navCtx.mounted) return;
    Navigator.of(navCtx).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => NotesChatPage(),
      ),
    );
  }

  Future<void> _openWechatClawBinding() async {
    final BuildContext? navCtx = _rootNavigatorKey.currentContext;
    if (navCtx == null || !navCtx.mounted) return;
    await openWechatClawBinding(navCtx);
  }

  /// 打开五子棋对局（从 playUrl / tableId 解析）)
  void _openGomokuGame(String playUrlOrTableId) {
    final String? tableId = PlayUrlUtils.parseTableId(playUrlOrTableId);
    if (tableId == null || tableId.isEmpty) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        SnackBar(content: Text("无法识别对局 playUrlOrTableId")),
      );
      return;
    }
    final BuildContext? navCtx = _rootNavigatorKey.currentContext;
    if (navCtx == null || !navCtx.mounted) return;
    Navigator.of(navCtx).push<void>(
      MaterialPageRoute<void>(
        builder: (BuildContext context) => GomokuPage(
          agentActorId: ApiConfig.effectiveActorId,
          api: _worldApi,
          ws: _ws,
          tableId: tableId,
        ),
      ),
    );
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

  void _sendPeerIncomingResponse(String callId, String action) {
    if (!_ws.isConnected) {
      _ws.retryConnect();
      return;
    }
    _ws.sendEvent("phone.incoming_response", <String, dynamic>{
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

  /// 原生悬浮窗点接听：拉起主窗口 + 走 _phoneCallStatus = "connecting" 状态，
  /// 等待服务端 call_connecting 事件推送正式通话内容
  void _handleNativeCallAccept() {
    _ws.sendEvent("phone.accept", <String, dynamic>{});
    if (!mounted) return;
    setState(() => _phoneCallStatus = "connecting");
    // 拉起主窗口（如果最小化）
    unawaited(IncomingCallLauncher.bringMainWindowToFront());
    unawaited(ConnectedCallLauncher.resetDuration());
  }

  /// 原生悬浮窗点挂断：发 phone.hangup + 反馈 + 清状态
  void _handleNativeCallDecline() {
    _ws.sendEvent("phone.hangup", {});
    _sendContactFeedback(
      channel: "phone_call",
      responded: false,
      feedback: "negative",
      quietHours: _isQuietHoursNow(),
    );
    unawaited(TtsPlayer.instance.stop());
    unawaited(IncomingCallLauncher.hide());
    unawaited(OutgoingCallLauncher.hide());
    unawaited(ConnectedCallLauncher.hide());
    if (mounted) {
      setState(() {
        _phoneCallStatus = null;
        _phoneCallToActorId = null;
      });
    }
  }

  /// 原生悬浮窗振铃超时：按"未接"处理，反馈 negative
  void _handleNativeCallTimeout() {
    _sendContactFeedback(
      channel: "phone_call",
      responded: false,
      feedback: "negative",
      quietHours: _isQuietHoursNow(),
    );
    unawaited(TtsPlayer.instance.stop());
    unawaited(IncomingCallLauncher.hide());
    unawaited(OutgoingCallLauncher.hide());
    unawaited(ConnectedCallLauncher.hide());
    if (mounted) {
      setState(() {
        _phoneCallStatus = null;
        _phoneCallToActorId = null;
      });
    }
  }

  /// 用户在聊天页底部"📞 通话中"按钮上点挂断的入口
  // ignore: unused_element
  void _hangupFromPhoneButton() {
    _ws.sendEvent("phone.hangup", {});
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

  /// "通话中"窗口里点了挂断：发 phone.hangup + 关窗 + 停 TTS + 清状态
  void _handleConnectedHangup() {
    _ws.sendEvent("phone.hangup", {});
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
    final String callerLabel = VirtualPhoneUiLabels.incomingCallerLabel(
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

  /// 根据网络 IP 展示推测位置，并询问是否开启 GPS 定位权限（灰色弹窗，仅询问一次）)
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
    final bool decided = allow ?? false;
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
    final String title = _kTabTitles[_tabIndex];
    if (title.isEmpty) {
      return null;
    }
    return Text(title);
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
        .map((e) => MapEntry<String, int>(_platformDisplayName(e.key), e.value))
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

  String _platformDisplayName(String platform) {
    switch (platform) {
      case "wechat":
        return "微信";
      case "qq":
        return "QQ";
      case "feishu":
        return "飞书";
      default:
        return "其他";
    }
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
                        _AppSidebar(
                          tabIndex: _tabIndex,
                          onTabSelected: _selectTab,
                          onWechatClawTap: _openWechatClawBinding,
                          onToggleTheme: _toggleTheme,
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
                                AppBar(
                                  automaticallyImplyLeading: false,
                                  leading: _tabIndex == 0
                                      ? _buildMessageNotificationBadge()
                                      : null,
                                  title: _buildAppBarTitle(),
                                  actions: const <Widget>[],
                                ),
                                Expanded(
                                  child: MainPanel(
                                    child: _buildMainContentWithCalendar(),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ],
                    ),
                    const FloatingAgentSphere(),
                    // 右侧抽屉：top:0 顶到屏幕最顶部，覆盖侧边栏、AppBar、主内容、日历面板
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

  void _toggleTheme() {
    AppThemeController.instance.toggle();
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
      final String message = _buildDesktopBriefingSummary(briefing);
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
        message: _buildMobileBriefingSummary(briefing),
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

  String _buildMobileBriefingSummary(Map<String, dynamic> briefing) {
    final List<String> parts = <String>[];
    final Object? weather = briefing["weather"];
    if (weather is Map) {
      final String condition = weather["condition"]?.toString() ?? "";
      final Object? temp = weather["temperature"];
      if (condition.isNotEmpty || temp != null) {
        parts.add(
          [
            if (condition.isNotEmpty) condition,
            if (temp != null) "${temp.toString()}°C",
          ].join(" "),
        );
      }
    }
    final Object? schedule = briefing["todaySchedule"];
    if (schedule is List && schedule.isNotEmpty) {
      final Object? first = schedule.first;
      if (first is Map) {
        final String title = first["title"]?.toString() ?? "";
        final String time = first["time"]?.toString() ?? "";
        if (title.isNotEmpty) {
          parts.add(time.isEmpty ? title : "$time $title");
        }
      }
    }
    final Object? notes = briefing["pendingNotes"];
    if (notes is List && notes.isNotEmpty) {
      parts.add("还有 ${notes.length} 条待办提醒");
    }
    return parts.isEmpty ? "点击查看今天的简报内容" : parts.join(" · ");
  }

  String _buildDesktopBriefingSummary(Map<String, dynamic> briefing) {
    final List<String> lines = <String>[];
    final String greeting = briefing["agentGreeting"]?.toString() ??
        briefing["greeting"]?.toString() ??
        "";
    if (greeting.isNotEmpty) {
      lines.add(greeting);
    }
    final Object? weather = briefing["weather"];
    if (weather is Map) {
      final String condition = weather["condition"]?.toString() ?? "";
      final String temperature = weather["temperature"]?.toString() ?? "";
      final String description = weather["description"]?.toString() ?? "";
      final String weatherLine = [
        condition,
        temperature.isEmpty ? "" : "$temperature°C",
        description
      ].where((String item) => item.trim().isNotEmpty).join(" · ");
      if (weatherLine.isNotEmpty) {
        lines.add("天气：$weatherLine");
      }
    }
    final Object? outfit = briefing["outfitTip"];
    if (outfit is Map) {
      final String suggestion = outfit["suggestion"]?.toString() ?? "";
      if (suggestion.isNotEmpty) {
        lines.add("穿衣：$suggestion");
      }
    }
    final Object? schedule = briefing["todaySchedule"];
    if (schedule is List && schedule.isNotEmpty) {
      final List<String> top = <String>[];
      for (final Object? item in schedule.take(3)) {
        if (item is Map) {
          final String time = item["time"]?.toString() ?? "";
          final String title = item["title"]?.toString() ?? "";
          if (title.isNotEmpty) {
            top.add(time.isEmpty ? title : "$time $title");
          }
        }
      }
      if (top.isNotEmpty) {
        lines.add("安排：${top.join("；")}");
      }
    }
    final Object? notes = briefing["pendingNotes"];
    if (notes is List && notes.isNotEmpty) {
      final List<String> top = <String>[];
      for (final Object? item in notes.take(3)) {
        if (item is Map) {
          final String title = item["title"]?.toString() ?? "";
          if (title.isNotEmpty) top.add(title);
        } else if (item != null && item.toString().trim().isNotEmpty) {
          top.add(item.toString());
        }
      }
      if (top.isNotEmpty) {
        lines.add("待办：${top.join("；")}");
      }
    }
    return lines.isEmpty ? "今天的简报已经准备好了。" : lines.join("\n");
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

  Widget _buildGameCenterPage() {
    return GameCenterPage(
      actorId: ApiConfig.effectiveActorId,
      api: _worldApi,
      ws: _ws,
    );
  }

  Widget _buildMainContentWithCalendar() {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Stack(
      children: <Widget>[
        _buildMainContent(),
        if (_showCalendarPanel && _tabIndex == 0)
          GestureDetector(
            onTap: () => setState(() => _showCalendarPanel = false),
            child: Container(
              color: cs.onSurface.withValues(alpha: 0.12),
              alignment: Alignment.center,
              child: GestureDetector(
                onTap: () {},
                child: Material(
                  elevation: 24,
                  borderRadius: BorderRadius.circular(16),
                  color: cs.surfaceContainerLowest,
                  surfaceTintColor: Colors.transparent,
                  clipBehavior: Clip.antiAlias,
                  child: SizedBox(
                    width: 560,
                    height: MediaQuery.of(context).size.height * 0.8,
                    child: _buildScheduleSidebar(),
                  ),
                ),
              ),
            ),
          ),
        // 右侧抽屉挂在外层 Scaffold Stack 顶层(见 build 中 _buildRightPanelOverlay 调用)
        // 这里不再渲染,避免顶在 AppBar 下方
      ],
    );
  }

  /// 渲染右侧滑入面板(挂在外层 Scaffold Stack 顶层，top:0 顶到屏幕最顶)
  Widget _buildRightPanelOverlay() {
    if (_rightPanel == null) {
      return const SizedBox.shrink();
    }
    // 根据屏幕宽度计算面板绝对像素宽度:小屏几乎占满,宽屏固定 480
    final double screenWidth = MediaQuery.sizeOf(context).width;
    final double panelWidth = screenWidth < 820 ? screenWidth * 0.92 : 480.0;
    return RightSidePanel(
      visible: true,
      title: _rightPanelTitle(_rightPanel!),
      onClose: _closeRightPanel,
      panelWidth: panelWidth,
      child: _buildRightPanelContent(),
    );
  }

  /// 右侧面板标题
  String _rightPanelTitle(_RightPanelKind kind) {
    switch (kind) {
      case _RightPanelKind.friends:
        return "好友";
      case _RightPanelKind.games:
        return "游戏中心";
      case _RightPanelKind.messages:
        return "消息聚合";
    }
  }

  /// 右侧面板要渲染的具体内容
  Widget _buildRightPanelContent() {
    switch (_rightPanel) {
      case _RightPanelKind.friends:
        return MailboxPage(api: _worldApi, ws: _ws);
      case _RightPanelKind.games:
        return _buildGameCenterPage();
      case _RightPanelKind.messages:
        return MessageHubPage(api: _worldApi);
      case null:
        return const SizedBox.shrink();
    }
  }

  Widget _buildScheduleSidebar() {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return ColoredBox(
      color: cs.surface,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(24, 20, 16, 8),
            child: Row(
              children: <Widget>[
                Text(
                  "日程",
                  style: TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.w600,
                    color: cs.onSurface,
                  ),
                ),
                const Spacer(),
                IconButton(
                  tooltip: "关闭",
                  icon: const Icon(Icons.close, size: 22),
                  onPressed: () => setState(() => _showCalendarPanel = false),
                  visualDensity: VisualDensity.compact,
                  padding: EdgeInsets.zero,
                  constraints:
                      const BoxConstraints.tightFor(width: 32, height: 32),
                  iconSize: 20,
                  color: cs.onSurfaceVariant.withValues(alpha: 0.7),
                ),
              ],
            ),
          ),
          Expanded(
            child: SchedulePage(
              store: _store,
              scheduleApi: _scheduleApi,
              sessionId: ApiConfig.effectiveActorId,
              reloadListenable: _calendarReloadSignal,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildMainContent() {
    final double screenWidth = MediaQuery.sizeOf(context).width;

    if (_tabIndex != 0 || screenWidth < 820) {
      return _buildTabStack();
    }
    return JarvisChatLayout(
      scheduleFuture: _cachedScheduleFuture,
      onAgentLink: _openAgentLinkTab,
      onGames: _openGameCenterTab,
      onSchedule: _openSchedulePanel,
      onWallet: _openWalletDialog,
      onPhone: _openPhoneDevicesDialog,
      onTranslate: _openTranslatePage,
      onNotes: _openNotesChat,
      onMessages: _openMessagesPanel,
      rightPanelVisible: _rightPanel != null,
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
      interimAckText: _interimAckText,
      // v2：把结构化状态机注入到 ChatPage；v1 链路下传 null 不影响
      turnState: _turnState ?? _pendingLocalTurn,
      onOpenGomoku: _openGomokuGame,
      fullComputerAccessEnabled: _fullComputerAccessEnabled,
      isActive: _tabIndex == 0,
      onToggleFullComputerAccess: () {
        setState(() {
          _fullComputerAccessEnabled = !_fullComputerAccessEnabled;
        });
        if (!mounted) return;
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          SnackBar(
            content: Text(
              _fullComputerAccessEnabled
                  ? "已开启完全访问：Agent 可请求控制电脑等高权限操作"
                  : "已切换为沙箱模式：高权限工具将被限制",
            ),
            duration: const Duration(seconds: 2),
          ),
        );
      },
      onEnterVoiceMode: () {
        Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (BuildContext ctx) => VoiceModePage(
              onExit: () => Navigator.of(ctx).pop(),
            ),
          ),
        );
      },
      onOpenPhoneDialer: () {
        _callMyAgentViaPhone(null);
      },
      onDeleteMessage: _deleteSingleMessage,
      onDeleteFromMessage: _deleteMessagesFrom,
      onStopAgent: _cancelCurrentTurn,
    );
  }

  /// 根级 Tab 栈：Windows 桌面球形 Agent 为单一原生实体（槽位锚定+ 桌面漫游）
  ///
  /// 注：好友 / 游戏已不再作为整页 tab 出现，而是从右侧滑出折叠面板。
  /// 为了不破坏 _tabIndex 的取值约定,这里保留 1(好友占位) 和 4(游戏占位),
  /// 但渲染为空 SizedBox —— _openAgentLinkTab / _openGameCenterTab
  /// 会把 _tabIndex 重置为 0 并设置 _rightPanel,实际不会停留在这两个 tab。
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
            SkillStorePage(api: _worldApi),
            const SizedBox.shrink(), // 4: 游戏 → 右侧面板
          ],
        );
      },
    );
  }
}

class _AppSidebar extends StatefulWidget {
  const _AppSidebar({
    required this.tabIndex,
    required this.onTabSelected,
    required this.onWechatClawTap,
    required this.onToggleTheme,
  });

  final int tabIndex;
  final ValueChanged<int> onTabSelected;
  final VoidCallback onWechatClawTap;

  /// 切换「深色 / 暖色」主题
  final VoidCallback onToggleTheme;

  @override
  State<_AppSidebar> createState() => _AppSidebarState();
}

class _AppSidebarState extends State<_AppSidebar> {
  static const List<_SidebarItemSpec> _kItems = <_SidebarItemSpec>[
    _SidebarItemSpec(
      iconOutlined: Icons.chat_bubble_outline_rounded,
      iconFilled: Icons.chat_rounded,
      label: '对话',
      tabIndex: 0,
    ),
    _SidebarItemSpec(
      iconOutlined: Icons.store_outlined,
      iconFilled: Icons.store,
      label: '技能商城',
      tabIndex: 2,
    ),
  ];

  // 预定义常量
  static const double _sidebarWidth = 64.0;
  static const EdgeInsets _sidebarPadding =
      EdgeInsets.symmetric(horizontal: 10, vertical: 8);

  @override
  Widget build(BuildContext context) {
    // 跟随当前主题（侧栏底部的「主题切换」按钮会改变 AppThemeController 的值，
    // 父级 ValueListenableBuilder 触发整个 MaterialApp 重建，使这里取到新色）。
    final AppThemeVariant variant = AppThemeController.instance.value;
    final Color bgColor = AppPalette.resolveSidebar(variant);
    final Color dividerColor = AppPalette.resolveSidebarDivider(variant);

    return Container(
      width: _sidebarWidth,
      decoration: BoxDecoration(color: bgColor),
      clipBehavior: Clip.hardEdge,
      child: Material(
        color: bgColor,
        child: SafeArea(
          child: Padding(
            padding: _sidebarPadding,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                const SizedBox(height: 16),
                Expanded(
                  child: SingleChildScrollView(
                    padding: EdgeInsets.zero,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: <Widget>[
                        for (int i = 0; i < _kItems.length; i += 1)
                          _SidebarNavItem(
                            key: ValueKey<String>(_kItems[i].label),
                            spec: _kItems[i],
                            selected: widget.tabIndex == _kItems[i].tabIndex,
                            onTap: () =>
                                widget.onTabSelected(_kItems[i].tabIndex),
                          ),
                      ],
                    ),
                  ),
                ),
                Divider(height: 1, color: dividerColor),
                const SizedBox(height: 6),
                Flexible(
                  fit: FlexFit.loose,
                  child: Tooltip(
                    message: "绑定微信 Claw",
                    child: _WechatClawSidebarFooter(
                      onTap: widget.onWechatClawTap,
                    ),
                  ),
                ),
                const SizedBox(height: 2),
                Flexible(
                  fit: FlexFit.loose,
                  child: Tooltip(
                    message:
                        variant == AppThemeVariant.warm ? "切换为深色主题" : "切换为浅色主题",
                    child: _ThemeToggleSidebarFooter(
                      isWarm: variant == AppThemeVariant.warm,
                      onTap: widget.onToggleTheme,
                    ),
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

class _SidebarItemSpec {
  const _SidebarItemSpec({
    required this.iconOutlined,
    required this.iconFilled,
    required this.label,
    required this.tabIndex,
  });

  final IconData iconOutlined;
  final IconData iconFilled;
  final String label;
  final int tabIndex;
}

class _SidebarNavItem extends StatefulWidget {
  const _SidebarNavItem({
    super.key,
    required this.spec,
    required this.selected,
    required this.onTap,
  });

  final _SidebarItemSpec spec;
  final bool selected;
  final VoidCallback onTap;

  @override
  State<_SidebarNavItem> createState() => _SidebarNavItemState();
}

class _SidebarNavItemState extends State<_SidebarNavItem> {
  bool _hovering = false;

  @override
  Widget build(BuildContext context) {
    final bool selected = widget.selected;
    final bool hovering = _hovering;
    final _SidebarItemSpec spec = widget.spec;
    final ColorScheme cs = Theme.of(context).colorScheme;
    final AppThemeVariant variant = AppThemeController.instance.value;

    final Color bgColor = selected
        ? cs.surfaceContainerHigh.withValues(alpha: 0.6)
        : (hovering
            ? cs.surfaceContainer.withValues(alpha: 0.6)
            : Colors.transparent);

    final Color iconColor = selected
        ? AppPalette.resolveSidebarIconSelected(variant)
        : (hovering
            ? AppPalette.resolveSidebarIconHover(variant)
            : AppPalette.resolveSidebarIconDefault(variant));

    final Widget button = MouseRegion(
      onEnter: (_) => _deferSidebarHover(() {
        if (mounted) setState(() => _hovering = true);
      }),
      onExit: (_) => _deferSidebarHover(() {
        if (mounted) setState(() => _hovering = false);
      }),
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: widget.onTap,
        behavior: HitTestBehavior.opaque,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOutCubic,
          width: 40,
          height: 40,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: bgColor,
            borderRadius: BorderRadius.circular(8),
          ),
          child: Icon(
            selected ? spec.iconFilled : spec.iconOutlined,
            size: 20,
            color: iconColor,
          ),
        ),
      ),
    );

    return Tooltip(
      message: spec.label,
      child: button,
    );
  }
}

class _WechatClawSidebarFooter extends StatefulWidget {
  const _WechatClawSidebarFooter({
    required this.onTap,
  });

  final VoidCallback onTap;

  @override
  State<_WechatClawSidebarFooter> createState() =>
      _WechatClawSidebarFooterState();
}

class _WechatClawSidebarFooterState extends State<_WechatClawSidebarFooter> {
  bool _hovering = false;

  @override
  Widget build(BuildContext context) {
    final AppThemeVariant variant = AppThemeController.instance.value;
    final ColorScheme cs = Theme.of(context).colorScheme;
    final Color bgColor = _hovering
        ? cs.surfaceContainer.withValues(alpha: 0.6)
        : Colors.transparent;
    final Color iconColor = _hovering
        ? AppPalette.resolveSidebarIconHover(variant)
        : AppPalette.resolveSidebarIconDefault(variant);

    return MouseRegion(
      onEnter: (_) => _deferSidebarHover(() {
        if (mounted) setState(() => _hovering = true);
      }),
      onExit: (_) => _deferSidebarHover(() {
        if (mounted) setState(() => _hovering = false);
      }),
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: widget.onTap,
        behavior: HitTestBehavior.opaque,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOutCubic,
          width: 40,
          height: 40,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: bgColor,
            borderRadius: BorderRadius.circular(8),
          ),
          child: Icon(
            Icons.qr_code_2_outlined,
            size: 20,
            color: iconColor,
          ),
        ),
      ),
    );
  }
}

/// 侧边栏底部「主题切换」按钮。
///
/// - 当前为 [AppThemeVariant.warm] 时显示「太阳」图标，点击切回深色；
/// - 当前为 [AppThemeVariant.dark]  时显示「月亮」图标，点击切到暖色。
class _ThemeToggleSidebarFooter extends StatefulWidget {
  const _ThemeToggleSidebarFooter({
    required this.isWarm,
    required this.onTap,
  });

  final bool isWarm;
  final VoidCallback onTap;

  @override
  State<_ThemeToggleSidebarFooter> createState() =>
      _ThemeToggleSidebarFooterState();
}

class _ThemeToggleSidebarFooterState extends State<_ThemeToggleSidebarFooter> {
  bool _hovering = false;

  @override
  Widget build(BuildContext context) {
    final AppThemeVariant variant = AppThemeController.instance.value;
    final ColorScheme cs = Theme.of(context).colorScheme;
    final Color bgColor = _hovering
        ? cs.surfaceContainer.withValues(alpha: 0.6)
        : Colors.transparent;
    final Color iconColor = _hovering
        ? AppPalette.resolveSidebarIconHover(variant)
        : AppPalette.resolveSidebarIconDefault(variant);

    return MouseRegion(
      onEnter: (_) => _deferSidebarHover(() {
        if (mounted) setState(() => _hovering = true);
      }),
      onExit: (_) => _deferSidebarHover(() {
        if (mounted) setState(() => _hovering = false);
      }),
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: widget.onTap,
        behavior: HitTestBehavior.opaque,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOutCubic,
          width: 40,
          height: 40,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: bgColor,
            borderRadius: BorderRadius.circular(8),
          ),
          child: Icon(
            // 当前是暖色 → 显示「太阳」预告下一次点击会切回「深色」；
            // 当前是深色 → 显示「月亮」预告下一次点击会切到「暖色」。
            widget.isWarm
                ? Icons.light_mode_outlined
                : Icons.dark_mode_outlined,
            size: 20,
            color: iconColor,
          ),
        ),
      ),
    );
  }
}
