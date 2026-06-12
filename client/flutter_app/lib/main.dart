import "dart:async";

import "package:flutter/foundation.dart";
import "package:flutter/material.dart";
import "package:flutter/scheduler.dart";

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
import "core/services/desk_pet_session.dart";
import "core/services/sphere_entity_controller.dart";
import "core/services/windows_webview_bootstrap.dart";
import "core/services/ws_chat_service.dart";
import "core/utils/play_url_utils.dart";
import "features/mailbox/mailbox_page.dart";
import "features/chat/background_tasks_sheet.dart";
import "features/chat/chat_page.dart";
import "features/chat/floating_agent_sphere.dart";
import "features/chat/voice_mode_page.dart";
import "features/chat/voiceprint_registration_page.dart";
import "core/services/agent_sphere_voice_controller.dart";
import "core/services/connected_call_launcher.dart";
import "core/services/desktop_notification_launcher.dart";
import "core/services/incoming_call_launcher.dart";
import "core/services/multi_agent_api_client.dart";
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
  final ValueNotifier<int> _scheduleReloadSignal = ValueNotifier<int>(0);

  /// 缓存日程 Future，避免每次 build 重建导致 FutureBuilder 反复重置为 waiting（卡片闪烁/震动）
  Future<List<ScheduleEvent>>? _cachedScheduleFuture;
  DateTime? _cachedScheduleDayStart;
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

  /// 是否显示右上角日历面板
  bool _showCalendarPanel = false;

  /// 日历面板重新加载信号
  final ValueNotifier<int> _calendarReloadSignal = ValueNotifier<int>(0);

  /// 与 userId 对齐的电脑桥接在线状态（由服务端 `desktop.bridge.sync` 推送）
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

  /// 与 Agent 同步委派进行中：屏蔽内部工具对进度条的覆盖
  bool _subAgentDelegationActive = false;

  /// 后台与 Agent 任务角标（对话框右上角按钮）
  int _backgroundTasksBadgeCount = 0;
  Timer? _assistantChunkFlushTimer;
  Timer? _agentReplyWatchdog;
  String? _pendingAssistantChunkMessageId;
  String? _pendingAgentUserMessageId;
  final StringBuffer _pendingAssistantChunkText = StringBuffer();

  /// 记录被打断的回复内容，用于后续整)
  final List<String> _interruptedResponses = <String>[];
  static const Duration _agentReplyTimeout = Duration(minutes: 3);

  /// 网络电话悬浮按钮状态 null=无通话, ringing=正在呼叫, connected=已接通 ended=通话结束
  String? _phoneCallStatus;
  String? _phoneCallToActorId;

  /// 已弹窗处理的「其与 Agent 来电」callId，避免重复弹)
  String? _peerIncomingDialogCallId;

  /// 通话中是否静音（与 ConnectedCallWindow 同步）
  bool _phoneMuted = false;

  /// 通话中是否免提（与 ConnectedCallWindow 同步）
  bool _phoneSpeakerOn = true;
  bool _desktopNotificationNeedsFeedback = false;
  String _desktopNotificationFeedbackChannel = "websocket";

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
    OutgoingCallLauncher.bindHandlers(onHangUp: _handleOutgoingCallHangup);
    _bootstrap();
  }

  @override
  void dispose() {
    DesktopBridgeService.instance.stop();
    unawaited(AgentSphereVoiceController.instance.dispose());
    unawaited(TtsPlayer.instance.dispose());
    IncomingCallLauncher.unbind();
    ConnectedCallLauncher.unbind();
    DesktopNotificationLauncher.unbind();
    OutgoingCallLauncher.unbind();
    _inputFocusNode.dispose();
    _inputController.dispose();
    _scheduleReloadSignal.dispose();
    _calendarReloadSignal.dispose();
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
      _showEntranceAnimation = false;
    });

    unawaited(_flushScheduleOfflineDeletes());

    _ws.onConnected = () {
      SphereEmbodimentMotionBridge.instance.setMainAgentLinked(true);
      _sendSessionInit();
      unawaited(_flushScheduleOfflineDeletes());
      if (!kIsWeb && defaultTargetPlatform == TargetPlatform.windows) {
        DesktopBridgeService.instance.start();
      }
    };
    ClientLocationService.bindPreferences(
      read: _store.getPreference,
      write: _store.savePreference,
    );
    _ws.connect();

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
          if (toolName.contains("invoke_sub_agent") ||
              toolName.contains("master.invoke")) {
            unawaited(_syncBackgroundTasksBadge());
          }
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
        if (type == "chat.assistant_chunk") {
          _resetAgentReplyWatchdog();
          // 丢弃「已结束轮次」的迟到 chunk：避免在 chat.assistant_done 之后
          // 网络重排 / 子 Agent 回调把 _isAgentProcessing 重新点亮。
          final String? chunkAssistantMessageId =
              payload["messageId"]?.toString();
          final String? activeTraceId = _pendingAgentUserMessageId;
          if (activeTraceId == null ||
              chunkAssistantMessageId == null ||
              !chunkAssistantMessageId.endsWith(activeTraceId)) {
            return;
          }
          if (!_isAgentProcessing) {
            setState(() => _isAgentProcessing = true);
            _notifyAgentProcessingUi(true);
          }
          final String messageId = chunkAssistantMessageId;
          final String chunk = payload["chunk"]?.toString() ?? "";
          // 关键：流式期间 chunk 只进缓冲（_flushAssistantChunks 现在不入列表），
          // **绝对不要**用「chunked 末行」去覆盖 agentStatusLine——那会把回复正文
          // 顶到思考气泡里。思考气泡只能由 chat.agent_status / tool.call / tool.result
          // 这些"agent 在干的事"来更新。
          _enqueueAssistantChunk(messageId, chunk);
        }
        if (type == "chat.assistant_done") {
          // 关键：先在 traceId 上打「本轮已结束」标记，再做后续副作用。
          // 否则清状态与清 traceId 之间存在竞态：迟到的 chunk/agent_status
          // 会看到 _pendingAgentUserMessageId 还有值，重新点亮思考气泡。
          _pendingAgentUserMessageId = null;
          _disarmAgentReplyWatchdog();
          _flushAssistantChunks();
          _clearAgentProcessingState();
          final String messageId =
              payload["messageId"]?.toString() ?? "assistant-final";
          final String finalText = payload["finalText"]?.toString() ?? "";
          final String fallbackText = "抱歉，我暂时无法生成回复，请稍后重试";
          final String? traceKey = messageId.startsWith("assistant-")
              ? messageId.substring("assistant-".length)
              : null;
          final String? playUrl = (traceKey != null
                  ? _pendingPlayUrlByTraceId.remove(traceKey)
                  : null) ??
              _playUrlForAssistantMessageId(messageId) ??
              PlayUrlUtils.fromAssistantText(
                finalText.trim().isNotEmpty ? finalText : fallbackText,
              );
          final int? idx = _assistantMessageIndexById[messageId];
          if (idx != null) {
            setState(() {
              final ChatMessage previous = _messages[idx];
              final String nextText = finalText.trim().isNotEmpty
                  ? finalText
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
              text: finalText.trim().isNotEmpty ? finalText : fallbackText,
              timestamp: DateTime.now(),
              playUrl: playUrl,
            );
            setState(() {
              _messages.add(finalMessage);
              _assistantMessageIndexById[messageId] = _messages.length - 1;
            });
            await _store.saveMessage(finalMessage);
          }
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
    _pendingAssistantChunkText.clear();
  }

  void _clearAgentProcessingState() {
    if (!_isAgentProcessing &&
        _agentStatusLine == null &&
        !_subAgentDelegationActive) {
      return;
    }
    setState(() {
      _isAgentProcessing = false;
      _agentStatusLine = null;
      _subAgentDelegationActive = false;
    });
    _notifyAgentProcessingUi(false);
    unawaited(_syncBackgroundTasksBadge());
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
      final String buffered = _pendingAssistantChunkText.toString().trim();
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

  String? get _activeChatUserMessageId {
    final String? pending = _pendingAgentUserMessageId;
    if (pending != null && pending.isNotEmpty) return pending;
    for (int i = _messages.length - 1; i >= 0; i--) {
      if (_messages[i].role == "user") return _messages[i].messageId;
    }
    return null;
  }

  Future<void> _syncBackgroundTasksBadge() async {
    try {
      final Map<String, dynamic> snap =
          await _multiAgentApi.fetchBackgroundTasks(
        ApiConfig.effectiveActorId,
        messageId: _activeChatUserMessageId,
      );
      if (!mounted) return;
      final List<dynamic> running =
          snap["running"] as List<dynamic>? ?? <dynamic>[];
      final int inFlight = snap["inFlightInTurn"] as int? ?? 0;
      final int count =
          running.isNotEmpty ? running.length : (inFlight > 0 ? inFlight : 0);
      if (count != _backgroundTasksBadgeCount) {
        setState(() => _backgroundTasksBadgeCount = count);
      }
    } catch (_) {
      // 忽略：委派未启用或网络不可达时不显示角标
    }
  }

  Future<void> _openBackgroundTasksPanel(BuildContext context) async {
    Map<String, dynamic> snap;
    try {
      snap = await _multiAgentApi.fetchBackgroundTasks(
        ApiConfig.effectiveActorId,
        messageId: _activeChatUserMessageId,
      );
    } catch (e) {
      snap = <String, dynamic>{"ok": false, "error": e.toString()};
    }
    if (!context.mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (BuildContext ctx) => BackgroundTasksSheet(
        initialSnapshot: snap,
        onRefresh: () => _multiAgentApi.fetchBackgroundTasks(
          ApiConfig.effectiveActorId,
          messageId: _activeChatUserMessageId,
        ),
      ),
    );
    await _syncBackgroundTasksBadge();
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
    unawaited(_syncBackgroundTasksBadge());
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
    "Agent Link",
    "钱包",
    "技能商城",
    "游戏",
  ];

  void _selectTab(int index) {
    setState(() => _tabIndex = index);
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

  /// 清空当前会话的所有聊天历史记录
  Future<void> _clearChatHistory() async {
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext ctx) => AlertDialog(
        title: const Text("清空聊天记录"),
        content: const Text("确定要删除所有聊天历史吗？此操作不可恢复。"),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text("取消"),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            style: FilledButton.styleFrom(backgroundColor: Colors.red),
            child: const Text("确认删除"),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    await _store.deleteMessagesForSession(ApiConfig.effectiveActorId);
    // 通知服务端同步清除 ChatThreadStore（内存 + 磁盘持久化）
    _ws.sendEvent("chat.clear_history", <String, dynamic>{
      "sessionId": ApiConfig.sessionId,
    });
    setState(() {
      _messages.clear();
      _assistantMessageIndexById.clear();
    });
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("聊天记录已清空")),
      );
    }
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
  }

  void _handleDesktopNotificationTimeout() {
    _desktopNotificationNeedsFeedback = false;
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
          variant == AppThemeVariant.dark,
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
                                  title: _buildAppBarTitle(),
                                  actions: <Widget>[
                                    if (DeskPetSession.isSupported)
                                      ListenableBuilder(
                                        listenable: DeskPetSession.instance,
                                        builder:
                                            (BuildContext context, Widget? _) {
                                          final bool summoned = DeskPetSession
                                              .instance.isSummoned;
                                          final bool bootstrapping =
                                              DeskPetSession
                                                  .instance.isBootstrapping;
                                          return IconButton(
                                            tooltip: summoned ? "收起桌宠" : "召唤桌宠",
                                            icon: bootstrapping
                                                ? SizedBox(
                                                    width: 20,
                                                    height: 20,
                                                    child:
                                                        CircularProgressIndicator(
                                                      strokeWidth: 2,
                                                      color: Theme.of(context)
                                                          .colorScheme
                                                          .primary,
                                                    ),
                                                  )
                                                : Icon(
                                                    Icons.smart_toy_outlined,
                                                    color: summoned
                                                        ? Theme.of(context)
                                                            .colorScheme
                                                            .primary
                                                        : null,
                                                  ),
                                            onPressed: bootstrapping
                                                ? null
                                                : () async {
                                                    if (summoned) {
                                                      await DeskPetSession
                                                          .instance
                                                          .dismiss();
                                                      return;
                                                    }
                                                    final bool ok =
                                                        await DeskPetSession
                                                            .instance
                                                            .summon();
                                                    if (!context.mounted)
                                                      return;
                                                    if (!ok) {
                                                      ScaffoldMessenger.of(
                                                              context)
                                                          .showSnackBar(
                                                        SnackBar(
                                                          content: Text(
                                                            DeskPetSession
                                                                    .instance
                                                                    .error ??
                                                                "桌宠召唤失败",
                                                          ),
                                                        ),
                                                      );
                                                    }
                                                  },
                                          );
                                        },
                                      ),
                                    if (_tabIndex == 0)
                                      PopupMenuButton<String>(
                                        tooltip: "更多",
                                        icon: Icon(Icons.more_vert),
                                        offset: const Offset(0, 48),
                                        onSelected: (String value) {
                                          if (value == 'calendar') {
                                            setState(() => _showCalendarPanel =
                                                !_showCalendarPanel);
                                          } else if (value == 'wallet') {
                                            WalletDialog.show(context,
                                                balance: _balance);
                                          } else if (value == 'clear_history') {
                                            _clearChatHistory();
                                          }
                                        },
                                        itemBuilder: (BuildContext context) =>
                                            <PopupMenuEntry<String>>[
                                          PopupMenuItem<String>(
                                            value: 'calendar',
                                            child: Row(
                                              children: <Widget>[
                                                Icon(
                                                  _showCalendarPanel
                                                      ? Icons.calendar_month
                                                      : Icons
                                                          .calendar_today_outlined,
                                                  size: 20,
                                                  color: _showCalendarPanel
                                                      ? Theme.of(context)
                                                          .colorScheme
                                                          .primary
                                                      : null,
                                                ),
                                                const SizedBox(width: 12),
                                                const Text('日程'),
                                              ],
                                            ),
                                          ),
                                          PopupMenuItem<String>(
                                            value: 'wallet',
                                            child: Row(
                                              children: <Widget>[
                                                const Icon(
                                                  Icons
                                                      .account_balance_wallet_outlined,
                                                  size: 20,
                                                ),
                                                const SizedBox(width: 12),
                                                const Text('钱包'),
                                              ],
                                            ),
                                          ),
                                          const PopupMenuDivider(),
                                          PopupMenuItem<String>(
                                            value: 'clear_history',
                                            child: Row(
                                              children: <Widget>[
                                                Icon(
                                                  Icons.delete_outline,
                                                  size: 20,
                                                  color: Colors.red
                                                      .withValues(alpha: 0.8),
                                                ),
                                                const SizedBox(width: 12),
                                                const Text(
                                                  '清空聊天记录',
                                                  style: TextStyle(
                                                      color: Colors.red),
                                                ),
                                              ],
                                            ),
                                          ),
                                        ],
                                      ),
                                  ],
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

  Widget _buildGameCenterPage() {
    return GameCenterPage(
      actorId: ApiConfig.effectiveActorId,
      api: _worldApi,
      ws: _ws,
    );
  }

  /// 工作台面板：合并今日聚焦 + 待你确认，统一交互式展示
  Widget _buildCompanionRightPanel() {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 18, 18, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          // 工作台标题行
          Row(
            children: <Widget>[
              const Icon(Icons.dashboard_outlined, size: 18),
              const SizedBox(width: 8),
              Text(
                "工作台",
                style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700),
              ),
              const Spacer(),
              // 动态角标：日程未完成数 + 后台任务数 + 通话状态
              ValueListenableBuilder<int>(
                valueListenable: _scheduleReloadSignal,
                builder: (BuildContext context, int _, __) {
                  final int totalBadge = _calcWorkspaceBadge();
                  if (totalBadge <= 0) return const SizedBox.shrink();
                  return Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                    decoration: BoxDecoration(
                      color: cs.primary.withValues(alpha: 0.18),
                      borderRadius: BorderRadius.circular(999),
                      border:
                          Border.all(color: cs.primary.withValues(alpha: 0.38)),
                    ),
                    child: Text(
                      totalBadge > 9 ? "9+" : "$totalBadge",
                      style: TextStyle(
                          fontSize: 11,
                          color: cs.primary,
                          fontWeight: FontWeight.w600),
                    ),
                  );
                },
              ),
            ],
          ),
          const SizedBox(height: 12),
          // 可滚动内容区
          Expanded(
            child: ListView(
              padding: EdgeInsets.zero,
              children: <Widget>[
                // ── 日程卡片（可点击打开日历）──
                _buildWorkspaceScheduleCard(cs),
                const SizedBox(height: 14),
                // ── Agent 任务卡片（可点击打开任务面板）──
                _buildWorkspaceTasksCard(cs),
                const SizedBox(height: 10),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// 计算工作台总角标数
  int _calcWorkspaceBadge() {
    int badge = 0;
    if (_backgroundTasksBadgeCount > 0) badge += _backgroundTasksBadgeCount;
    if (_phoneCallStatus != null && _phoneCallStatus != "ended") badge += 1;
    if (_desktopBridgeOnline == false) badge += 1;
    // 日程数需要异步获取，此处通过 scheduleReloadSignal 触发重建时重新计算
    return badge;
  }

  /// 工作台 - 日程卡片
  Widget _buildWorkspaceScheduleCard(ColorScheme cs) {
    final DateTime now = DateTime.now();
    final DateTime dayStart = DateTime(now.year, now.month, now.day);
    final DateTime dayEnd = dayStart.add(const Duration(days: 1));
    // 缓存 Future：仅在日期变化或首次时创建新实例，避免每次 build 重建导致 FutureBuilder 闪烁
    if (_cachedScheduleDayStart != dayStart || _cachedScheduleFuture == null) {
      _cachedScheduleDayStart = dayStart;
      _cachedScheduleFuture =
          _store.listScheduleEventsInRange(dayStart, dayEnd);
    }
    return FutureBuilder<List<ScheduleEvent>>(
      future: _cachedScheduleFuture!,
      builder:
          (BuildContext context, AsyncSnapshot<List<ScheduleEvent>> snapshot) {
        final List<ScheduleEvent> items = (snapshot.data ?? <ScheduleEvent>[])
            .where((ScheduleEvent e) => (e.notes ?? "") != "已完成")
            .toList()
          ..sort((a, b) => a.startAt.compareTo(b.startAt));

        return _WorkspaceCard(
          icon: Icons.today_outlined,
          iconColor: const Color(0xFF7A5C86),
          title: items.isEmpty ? "今日日程" : "今日日程 (${items.length})",
          onTap: items.isNotEmpty
              ? () => setState(() => _showCalendarPanel = true)
              : null,
          child: snapshot.connectionState == ConnectionState.waiting
              ? const Padding(
                  padding: EdgeInsets.symmetric(vertical: 8),
                  child: Center(
                      child: SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2))),
                )
              : items.isEmpty
                  ? _WorkspaceHintRow(
                      icon: Icons.add_circle_outline,
                      text: "和我说一声就能添加日程",
                      onTap: null)
                  : Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: items.take(3).map((ScheduleEvent e) {
                        final Duration diff = e.startAt.difference(now);
                        final String timeStr =
                            "${e.startAt.hour.toString().padLeft(2, '0')}:${e.startAt.minute.toString().padLeft(2, '0')}";
                        String? hint;
                        if (diff.isNegative) {
                          hint = "已开始";
                        } else if (diff.inMinutes < 60) {
                          hint = "${diff.inMinutes} 分钟后";
                        } else if (diff.inHours < 24) {
                          hint = "${diff.inHours} 小时后";
                        }
                        return _WorkspaceScheduleRow(
                            time: timeStr, title: e.title, hint: hint);
                      }).toList(),
                    ),
        );
      },
    );
  }

  /// 工作台 - Agent 任务卡片
  Widget _buildWorkspaceTasksCard(ColorScheme cs) {
    return _WorkspaceCard(
      icon: Icons.smart_toy_outlined,
      iconColor: const Color(0xFF5E56A8),
      title: "Agent 任务",
      trailing: _backgroundTasksBadgeCount > 0
          ? Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(
                color: cs.primary.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text("$_backgroundTasksBadgeCount 项进行中",
                  style: TextStyle(
                      fontSize: 11,
                      color: cs.primary,
                      fontWeight: FontWeight.w600)),
            )
          : null,
      onTap: _backgroundTasksBadgeCount > 0
          ? () => _openBackgroundTasksPanel(context)
          : null,
      child: _backgroundTasksBadgeCount > 0
          ? _WorkspaceHintRow(
              icon: Icons.open_in_new,
              text: "点击查看任务详情与进度",
              onTap: () => _openBackgroundTasksPanel(context))
          : _WorkspaceHintRow(
              icon: Icons.check_circle_outline,
              text: "当前没有运行中的后台任务",
              onTap: null),
    );
  }

  /// 工作台 - 系统状态卡片（桥接 + 电话）
  Widget _buildWorkspaceSystemCard(ColorScheme cs) {
    return _WorkspaceCard(
      icon: Icons.settings_suggest_outlined,
      iconColor: cs.outline,
      title: "系统状态",
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          // 桥接状态
          _WorkspaceStatusRow(
            icon: _desktopBridgeOnline == true
                ? Icons.lan
                : (_desktopBridgeOnline == false
                    ? Icons.portable_wifi_off
                    : Icons.help_outline),
            label: "电脑桥接",
            value: _desktopBridgeOnline == null
                ? "暂不可用"
                : (_desktopBridgeOnline! ? "在线" : "离线"),
            statusColor: _desktopBridgeOnline == true
                ? Colors.green
                : (_desktopBridgeOnline == false ? Colors.red : cs.outline),
          ),
          const SizedBox(height: 8),
          // 电话状态 —— 通话中时整行可点击触发挂断
          // 通话中若静音/关免提，value 后追加提示
          Builder(builder: (context) {
            final bool inCall =
                _phoneCallStatus != null && _phoneCallStatus != "ended";
            String value = inCall
                ? VirtualPhoneUiLabels.callStatusLabel(_phoneCallStatus)
                : "空闲";
            if (inCall) {
              final List<String> tags = <String>[];
              if (_phoneMuted) tags.add("静音");
              if (!_phoneSpeakerOn) tags.add("听筒");
              if (tags.isNotEmpty) value = "$value · ${tags.join('·')}";
            }
            return _WorkspaceStatusRow(
              icon: inCall ? Icons.phone_in_talk : Icons.phone_outlined,
              label: "虚拟电话",
              value: value,
              statusColor: inCall ? cs.primary : cs.onSurfaceVariant,
              onTap: inCall ? _hangupFromPhoneButton : null,
              actionHint: inCall ? "· 点击挂断" : null,
            );
          }),
        ],
      ),
    );
  }

  // ═══════════════════════════════════════════════════════════
  // 工作台面板 - 私有组件
  // ═══════════════════════════════════════════════════════════

  /// 工作台卡片容器：统一的圆角边框 + 标题行 + 内容区
  Widget _WorkspaceCard({
    required IconData icon,
    required Color iconColor,
    required String title,
    required Widget child,
    VoidCallback? onTap,
    Widget? trailing,
  }) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final AppThemeVariant variant = AppThemeController.instance.value;
    final bool interactive = onTap != null;
    final Widget cardContent = Container(
      decoration: AppTheme.borderedPanel(
        cs,
        radius: 16,
        fill: AppPalette.resolveCardBackground(variant),
        borderAlpha: 0.6,
      ),
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Icon(icon, size: 18, color: iconColor),
              const SizedBox(width: 8),
              Expanded(
                child: Text(title,
                    style: const TextStyle(
                        fontSize: 14, fontWeight: FontWeight.w700)),
              ),
              if (trailing != null) trailing,
              if (interactive)
                Padding(
                  padding: const EdgeInsets.only(left: 4),
                  child: Icon(Icons.chevron_right,
                      size: 16,
                      color: cs.onSurfaceVariant.withValues(alpha: 0.5)),
                ),
            ],
          ),
          const SizedBox(height: 10),
          DefaultTextStyle(
            style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
            child: child,
          ),
        ],
      ),
    );
    return interactive
        ? GestureDetector(
            onTap: onTap,
            behavior: HitTestBehavior.opaque,
            child: cardContent,
          )
        : cardContent;
  }

  /// 日程行：时间 + 标题 + 倒计时提示
  Widget _WorkspaceScheduleRow(
      {required String time, required String title, String? hint}) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 7),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          // 时间列
          SizedBox(
            width: 42,
            child: Text(time,
                style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: const Color(0xFF5B4B91),
                    fontFeatures: [const FontFeature.tabularFigures()])),
          ),
          // 标题
          Expanded(
              child: Text(title, maxLines: 2, overflow: TextOverflow.ellipsis)),
          // 倒计时提示
          if (hint != null)
            Container(
              margin: const EdgeInsets.only(left: 4),
              padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
              decoration: BoxDecoration(
                color: cs.tertiaryContainer.withValues(alpha: 0.5),
                borderRadius: BorderRadius.circular(4),
              ),
              child: Text(hint,
                  style:
                      TextStyle(fontSize: 10, color: cs.onTertiaryContainer)),
            ),
        ],
      ),
    );
  }

  /// 提示行：图标 + 文字（可点击）
  Widget _WorkspaceHintRow(
      {required IconData icon, required String text, VoidCallback? onTap}) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final bool interactive = onTap != null;
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Row(
        children: <Widget>[
          Icon(icon,
              size: 14, color: cs.onSurfaceVariant.withValues(alpha: 0.6)),
          const SizedBox(width: 6),
          Expanded(
            child: Text(text,
                style: TextStyle(
                    fontSize: 12,
                    color: interactive
                        ? cs.primary
                        : cs.onSurfaceVariant.withValues(alpha: 0.8))),
          ),
          if (interactive)
            Icon(Icons.arrow_forward_ios,
                size: 10, color: const Color(0xFF5B4B91).withValues(alpha: 0.5)),
        ],
      ),
    );
  }

  /// 状态行：图标 + 标签 + 值（带状态色指示点）
  Widget _WorkspaceStatusRow({
    required IconData icon,
    required String label,
    required String value,
    required Color statusColor,
    VoidCallback? onTap,
    String? actionHint,
  }) {
    final Widget row = Row(
      children: <Widget>[
        Icon(icon, size: 14, color: statusColor),
        const SizedBox(width: 6),
        Text(label, style: const TextStyle(fontSize: 12)),
        const Spacer(),
        Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Container(
                width: 6,
                height: 6,
                decoration:
                    BoxDecoration(color: statusColor, shape: BoxShape.circle)),
            const SizedBox(width: 5),
            Text(value,
                style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                    color: statusColor)),
            if (actionHint != null) ...[
              const SizedBox(width: 6),
              Text(actionHint,
                  style: const TextStyle(fontSize: 10, color: Colors.red)),
            ],
          ],
        ),
      ],
    );
    if (onTap == null) return row;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 4),
        child: row,
      ),
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
      ],
    );
  }

  Widget _buildScheduleSidebar() {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Column(
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
    );
  }

  Widget _buildMainContent() {
    final double screenWidth = MediaQuery.sizeOf(context).width;

    if (_tabIndex != 0 || screenWidth < 820) {
      return _buildTabStack();
    }
    final double rightWidth = screenWidth < 980 ? 240 : 300;
    return Row(
      children: <Widget>[
        Expanded(child: _buildTabStack()),
        VerticalDivider(
          width: 1,
          thickness: 1,
          color: AppPalette.resolveSidebarSeparator(
              AppThemeController.instance.value),
        ),
        SizedBox(
          width: rightWidth,
          child: _buildCompanionRightPanel(),
        ),
      ],
    );
  }

  /// 根级 Tab 栈：Windows 桌面球形 Agent 为单一原生实体（槽位锚定+ 桌面漫游）)
  Widget _buildTabStack() {
    return Builder(
      builder: (BuildContext context) {
        return IndexedStack(
          index: _tabIndex,
          children: <Widget>[
            ChatPage(
              messages: _messages,
              controller: _inputController,
              inputFocusNode: _inputFocusNode,
              onSend: _sendMessage,
              agentName: _agentName,
              galleryPendingCount: _pendingGalleryFrames.length,
              onPickGalleryImage: _pickGalleryImage,
              onClearGalleryImages: _clearPendingGalleryFrames,
              isAgentProcessing: _isAgentProcessing,
              agentStatusLine: _agentStatusLine,
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
            ),
            MailboxPage(api: _worldApi, ws: _ws),
            // 钱包已改为弹窗形式 (WalletDialog)，此处保留占位
            const SizedBox.shrink(),
            SkillStorePage(api: _worldApi),
            _buildGameCenterPage(),
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
    ),
    _SidebarItemSpec(
      iconOutlined: Icons.link_outlined,
      iconFilled: Icons.link,
      label: 'Agent Link',
    ),
    _SidebarItemSpec(
      iconOutlined: Icons.account_balance_wallet_outlined,
      iconFilled: Icons.account_balance_wallet,
      label: '钱包',
    ),
    _SidebarItemSpec(
      iconOutlined: Icons.store_outlined,
      iconFilled: Icons.store,
      label: '技能商城',
    ),
    _SidebarItemSpec(
      iconOutlined: Icons.sports_esports_outlined,
      iconFilled: Icons.sports_esports,
      label: '游戏',
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
                          if (i != 2) // 钱包tab已移至AppBar加号菜单中
                            _SidebarNavItem(
                              key: ValueKey<String>(_kItems[i].label),
                              spec: _kItems[i],
                              selected: widget.tabIndex == i,
                              onTap: () => widget.onTabSelected(i),
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
  });

  final IconData iconOutlined;
  final IconData iconFilled;
  final String label;
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
