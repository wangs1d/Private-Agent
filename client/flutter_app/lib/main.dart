import "dart:async";

import "package:flutter/foundation.dart";
import "package:flutter/material.dart";
import "package:flutter/scheduler.dart";
import "package:url_launcher/url_launcher.dart";

import "core/config/api_config.dart";
import "core/theme/app_theme.dart";
import "core/presentation/location_permission_dialog.dart";
import "core/presentation/virtual_phone_incoming_dialog.dart";
import "core/presentation/virtual_phone_ui_labels.dart";
import "core/presentation/phone_dialer_page.dart";
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
import "features/mailbox/agent_mailbox_page.dart";
import "features/mailbox/mailbox_page.dart";
import "features/chat/background_tasks_sheet.dart";
import "features/chat/chat_page.dart";
import "features/chat/floating_agent_sphere.dart";
import "features/chat/voice_mode_page.dart";
import "features/chat/voiceprint_registration_page.dart";
import "core/services/agent_sphere_voice_controller.dart";
import "core/services/multi_agent_api_client.dart";
import "features/gomoku/gomoku_page.dart";
import "features/game_center/game_center_page.dart";
import "features/integrations/wechat_claw_binding_page.dart";
import "core/vision/pick_gallery_vision.dart";
import "core/vision/silent_camera_capture.dart";
import "core/vision/vision_wire_frame.dart";
import "features/schedule/schedule_page.dart";
import "features/skill_store/skill_store_page.dart";
import "features/wallet/wallet_page.dart";
import "features/world/world_page.dart";

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  unawaited(bootstrapWindowsWebView());
  runApp(const PrivateAiApp());
}

/// 侧栏 hover 延后到下一帧，避免 AnimatedCrossFade 切换时触发 mouse_tracker 断言。
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
  final TextEditingController _inputController = TextEditingController();
  final FocusNode _inputFocusNode = FocusNode();

  /// `null` 尚未询问；`true` 随消息静默抓拍；`false` 仅文字。
  bool? _visionCameraConsent;

  /// 用户从相册/文件选取、待发的图（可多张，优先于摄像头帧）。
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

  /// Agent是否正在处理中（用于显示响应状态指示器）
  bool _isAgentProcessing = false;

  /// 已上报服务端的「处理中 UI」状态，避免重复 WS 事件
  bool? _reportedAgentProcessingUiActive;

  /// 对话输入框：默认沙箱；开启后可授权桌面/钱包等高权限工具
  bool _fullComputerAccessEnabled = false;
  bool _todayPanelExpanded = true;
  bool _confirmPanelExpanded = false;

  /// 服务端 `chat.agent_status` 推送的口语化进度（替换固定「思考中」）
  String? _agentStatusLine;

  /// 子 Agent 同步委派进行中：屏蔽内部工具对进度条的覆盖
  bool _subAgentDelegationActive = false;

  /// 后台子 Agent 任务角标（对话框右上角按钮）
  int _backgroundTasksBadgeCount = 0;
  Timer? _assistantChunkFlushTimer;
  Timer? _agentReplyWatchdog;
  String? _pendingAssistantChunkMessageId;
  String? _pendingAgentUserMessageId;
  final StringBuffer _pendingAssistantChunkText = StringBuffer();

  /// 记录被打断的回复内容，用于后续整合
  final List<String> _interruptedResponses = <String>[];
  static const Duration _agentReplyTimeout = Duration(minutes: 3);

  /// 网络电话悬浮按钮状态: null=无通话, ringing=正在呼叫, connected=已接通, ended=通话结束
  String? _phoneCallStatus;
  String? _phoneCallToActorId;
  /// 已弹窗处理的「其他 Agent 来电」callId，避免重复弹窗
  String? _peerIncomingDialogCallId;

  @override
  void initState() {
    super.initState();
    _bootstrap();
  }

  @override
  void dispose() {
    DesktopBridgeService.instance.stop();
    unawaited(AgentSphereVoiceController.instance.dispose());
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
      rethrow;
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
      rethrow;
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
        // 与当前 chat 轮次无关的错误需立即解除「思考中」；CHAT_HANDLER_ERROR 仍会跟 assistant_done。
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
                result["error"]?.toString().trim() ?? "子 Agent 委派失败，请稍后重试";
            if (err.isNotEmpty) {
              _updateAgentStatusLine(err);
            }
          } else {
            final String? uiDoneLine = result["uiDoneLine"]?.toString().trim();
            if (uiDoneLine != null && uiDoneLine.isNotEmpty) {
              _subAgentDelegationActive = false;
              _updateAgentStatusLine(uiDoneLine);
            } else if (result["background"] == true) {
              _subAgentDelegationActive = false;
              final String bgLine =
                  result["message"]?.toString().trim() ?? "助手已在后台处理，稍后会汇总结果…";
              _updateAgentStatusLine(bgLine);
            }
          }
        }
        if (toolOk && result != null) {
          final String normalizedTool = toolName.replaceAll("_", ".");
          if (normalizedTool == "calendar.delete_task") {
            final String? deletedId = result["taskId"]?.toString();
            if (deletedId != null && deletedId.isNotEmpty) {
              await removeLocalScheduleForDeletedTask(_store, deletedId);
              _scheduleReloadSignal.value += 1;
            }
          } else {
            final bool synced = await upsertLocalScheduleFromToolResult(
              _store,
              toolName,
              result,
            );
            if (synced) {
              _scheduleReloadSignal.value += 1;
            }
          }
        }
      }
      if (type == "schedule.tasks_changed") {
        final String action = payload["action"]?.toString() ?? "created";
        final String? taskId = payload["taskId"]?.toString();
        if (action == "deleted" && taskId != null && taskId.isNotEmpty) {
          await removeLocalScheduleForDeletedTask(_store, taskId);
        } else {
          final String? nextRunAt = payload["nextRunAt"]?.toString();
          if (taskId != null &&
              taskId.isNotEmpty &&
              nextRunAt != null &&
              nextRunAt.isNotEmpty) {
            final DateTime? startAt = DateTime.tryParse(nextRunAt);
            if (startAt != null) {
              final String rawTitle =
                  payload["reminderMessage"]?.toString().trim() ??
                      payload["title"]?.toString().trim() ??
                      "";
              await _store.saveScheduleEvent(
                ScheduleEvent(
                  id: taskId,
                  startAt: startAt.toLocal(),
                  title: rawTitle.isNotEmpty && rawTitle != "AI 提醒任务"
                      ? rawTitle
                      : "定时提醒",
                ),
              );
            }
          }
        }
        _scheduleReloadSignal.value += 1;
      }
      if (type == "schedule.reminder_fired") {
        final String message = payload["message"]?.toString().trim() ?? "到点提醒";
        final String taskId = payload["taskId"]?.toString() ?? "";
        final String status = payload["status"]?.toString() ?? "";
        final String? nextRunAt = payload["nextRunAt"]?.toString();
        final String recurrence = payload["recurrence"]?.toString() ?? "none";
        setState(() {
          _messages.add(
            ChatMessage(
              messageId:
                  "reminder-${taskId.isNotEmpty ? taskId : DateTime.now().millisecondsSinceEpoch}",
              sessionId: ApiConfig.effectiveActorId,
              role: "assistant",
              text: "⏰ $message",
              timestamp: DateTime.now(),
            ),
          );
        });
        if (mounted) {
          ScaffoldMessenger.maybeOf(context)?.showSnackBar(
            SnackBar(content: Text("⏰ $message")),
          );
        }
        if (taskId.isNotEmpty) {
          if (status == "completed" || nextRunAt == null || nextRunAt.isEmpty) {
            await _store.saveScheduleEvent(
              ScheduleEvent(
                id: taskId,
                startAt: DateTime.now(),
                title: payload["title"]?.toString().trim().isNotEmpty == true
                    ? payload["title"]!.toString().trim()
                    : message,
                notes: "已完成",
              ),
            );
          } else if (nextRunAt.isNotEmpty) {
            final DateTime? startAt = DateTime.tryParse(nextRunAt);
            if (startAt != null) {
              await _store.saveScheduleEvent(
                ScheduleEvent(
                  id: taskId,
                  startAt: startAt.toLocal(),
                  title: payload["title"]?.toString().trim().isNotEmpty == true
                      ? payload["title"]!.toString().trim()
                      : message,
                  notes: recurrence == "daily"
                      ? "每天重复"
                      : recurrence == "weekly"
                          ? "每周重复"
                          : "单次提醒",
                ),
              );
            }
          }
        }
        _scheduleReloadSignal.value += 1;
      }
      if (type == "chat.agent_status") {
        final String line = payload["line"]?.toString().trim() ?? "";
        if (line.isEmpty) return;
        final String phase = payload["phase"]?.toString() ?? "";
        if (phase == "delegate_start") {
          _subAgentDelegationActive = true;
        } else if (phase == "delegate_done") {
          _subAgentDelegationActive = false;
        }
        _updateAgentStatusLine(line, ensureProcessing: true);
      }
      if (type == "chat.assistant_chunk") {
        _resetAgentReplyWatchdog();
        if (!_isAgentProcessing) {
          setState(() => _isAgentProcessing = true);
          _notifyAgentProcessingUi(true);
        }
        final String messageId =
            payload["messageId"]?.toString() ?? "assistant-chunk";
        final String chunk = payload["chunk"]?.toString() ?? "";
        _enqueueAssistantChunk(messageId, chunk);
        final String liveStatus =
            _shortLiveStatusLine(_pendingAssistantChunkText.toString());
        if (liveStatus.isNotEmpty) {
          _updateAgentStatusLine(liveStatus);
        }
      }
      if (type == "chat.assistant_done") {
        _disarmAgentReplyWatchdog();
        _flushAssistantChunks();
        _clearAgentProcessingState();
        final String messageId =
            payload["messageId"]?.toString() ?? "assistant-final";
        final String finalText = payload["finalText"]?.toString() ?? "";
        final String fallbackText = "抱歉，我暂时无法生成回复，请稍后重试。";
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
        _pendingAgentUserMessageId = null;
      }
      if (type == "agent.peer_message") {
        final String messageId =
            payload["messageId"]?.toString() ?? "relay-unknown";
        final String fromSessionId = payload["fromSessionId"]?.toString() ?? "";
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
        setState(() {
          _phoneCallStatus = "incoming";
          _phoneCallToActorId = callerLabel;
        });
        final BuildContext? navCtx = _rootNavigatorKey.currentContext;
        if (navCtx != null && navCtx.mounted && direction == "agent_to_user") {
          unawaited(
            showVirtualPhoneIncomingDialog(
              context: navCtx,
              payload: payload,
            ),
          );
        }
      }
      if (type == "agent.phone.call_status") {
        final String status = payload["status"]?.toString() ?? "unknown";
        final String toActorId = payload["toActorId"]?.toString() ?? "";
        final String? fromPhone = payload["fromPhone"]?.toString();
        final String message = payload["message"]?.toString() ?? "";
        final String? summary = payload["summary"]?.toString();
        setState(() {
          if (fromPhone != null && fromPhone.isNotEmpty) {
            _phoneCallToActorId = VirtualPhoneUiLabels.incomingCallerLabel(
              direction: payload["direction"]?.toString() ?? "agent_to_agent",
              fromPhone: fromPhone,
            );
          } else {
            _phoneCallToActorId = toActorId.isNotEmpty ? toActorId : _phoneCallToActorId;
          }
          if (status == "ended" || status == "answered_by_user" || status == "agent_handled") {
            Future.delayed(const Duration(seconds: 2), () {
              if (mounted) {
                setState(() {
                  _phoneCallStatus = null;
                  _phoneCallToActorId = null;
                  _peerIncomingDialogCallId = null;
                });
              }
            });
          }
          _phoneCallStatus = status;
        });
        if (status == "agent_handled" && mounted) {
          final String body = (summary != null && summary.isNotEmpty)
              ? summary
              : message;
          if (body.isNotEmpty) {
            ScaffoldMessenger.maybeOf(context)?.showSnackBar(
              SnackBar(
                content: Text("📞 ${VirtualPhoneUiLabels.callStatusLabel(status)}：$body"),
                duration: const Duration(seconds: 6),
              ),
            );
          }
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
            on == false ? "???????$nextSummary" : "???????$nextSummary",
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
    });
  }

  /// 主服务恢复后补删离线队列中的服务端日程。
  Future<void> _flushScheduleOfflineDeletes() async {
    final ScheduleOfflineDeleteFlushResult result =
        await flushScheduleOfflineDeleteQueue(_store, _scheduleApi);
    if (result.flushed > 0) {
      _scheduleReloadSignal.value += 1;
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
    _assistantChunkFlushTimer?.cancel();
    _assistantChunkFlushTimer = null;
    final String? messageId = _pendingAssistantChunkMessageId;
    final String chunk = _pendingAssistantChunkText.toString();
    _pendingAssistantChunkMessageId = null;
    _pendingAssistantChunkText.clear();
    if (messageId == null || chunk.isEmpty) return;

    final String? playUrl = _playUrlForAssistantMessageId(messageId) ??
        PlayUrlUtils.fromAssistantText(chunk);
    setState(() {
      final int? idx = _assistantMessageIndexById[messageId];
      if (idx == null) {
        _messages.add(
          ChatMessage(
            messageId: messageId,
            sessionId: ApiConfig.effectiveActorId,
            role: "assistant",
            text: chunk,
            timestamp: DateTime.now(),
            playUrl: playUrl,
          ),
        );
        _assistantMessageIndexById[messageId] = _messages.length - 1;
      } else {
        final ChatMessage previous = _messages[idx];
        _messages[idx] = ChatMessage(
          messageId: previous.messageId,
          sessionId: previous.sessionId,
          role: previous.role,
          text: "${previous.text}$chunk",
          timestamp: previous.timestamp,
          attachmentImageCount: previous.attachmentImageCount,
          playUrl: playUrl ?? previous.playUrl,
        );
      }
    });
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

  /// 与聊天页「处理中」气泡同步；active=false 时服务端锁定本轮不再合并消息。
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
    _flushAssistantChunks();
    final String? userMessageId = _pendingAgentUserMessageId;
    final String assistantMessageId = userMessageId != null
        ? "assistant-$userMessageId"
        : "assistant-timeout-${DateTime.now().microsecondsSinceEpoch}";
    const String fallbackText = "抱歉，等待回复超时，请稍后重试。";
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
      final ChatMessage timeoutMessage = ChatMessage(
        messageId: assistantMessageId,
        sessionId: ApiConfig.effectiveActorId,
        role: "assistant",
        text: fallbackText,
        timestamp: DateTime.now(),
      );
      setState(() {
        _messages.add(timeoutMessage);
        _assistantMessageIndexById[assistantMessageId] = _messages.length - 1;
      });
      unawaited(_store.saveMessage(timeoutMessage));
    }
    _clearAgentProcessingState();
    _pendingAgentUserMessageId = null;
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

  bool _isGenericAgentStatusLine(String? line) {
    if (line == null || line.trim().isEmpty) return true;
    final String trimmed = line.trim();
    return trimmed == "正在思考…" ||
        trimmed == "正在思考..." ||
        trimmed == "Agent 思考中..." ||
        trimmed == "…";
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

  /// 首次在「无相册附件」的发送路径上询问一次；结果写入本地，之后不再弹窗。
  Future<void> _promptVisionConsentIfNeeded() async {
    if (_visionCameraConsent != null) {
      return;
    }
    final BuildContext? ctx = _rootNavigatorKey.currentContext;
    if (ctx == null || !ctx.mounted) {
      return;
    }
    final bool? allow = await showDialog<bool>(
      context: ctx,
      barrierDismissible: false,
      builder: (BuildContext dCtx) {
        return AlertDialog(
          title: const Text("本机摄像头授权"),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.pop(dCtx, false),
              child: const Text("不允许"),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(dCtx, true),
              child: const Text("允许"),
            ),
          ],
        );
      },
    );
    final bool decided = allow ?? false;
    await _store.setVisionCameraConsent(decided);
    if (!mounted) {
      return;
    }
    setState(() => _visionCameraConsent = decided);
  }

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
      SnackBar(content: Text("已选择 ${frames.length} 张图片，发送时将一并传给 Agent")),
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
          const SnackBar(content: Text("正在连接服务器，请稍后再发送")),
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

    // 如果有被打断的回复，将其添加到消息上下文中（作为系统提示）
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

  void _sendUserMessage(String text) {
    if (!_ws.isConnected) {
      _ws.retryConnect();
      return;
    }
    final String trimmed = text.trim();
    if (trimmed.isEmpty) return;

    if (_isAgentProcessing) {
      if (_pendingAssistantChunkText.isNotEmpty) {
        _interruptedResponses.add(_pendingAssistantChunkText.toString());
        _pendingAssistantChunkText.clear();
      }
      _disarmAgentReplyWatchdog();
      _pendingAgentUserMessageId = null;
      setState(() {
        _isAgentProcessing = false;
        _agentStatusLine = null;
        _pendingAssistantChunkMessageId = null;
      });
      _assistantChunkFlushTimer?.cancel();
      _assistantChunkFlushTimer = null;
    }

    final ChatMessage userMessage = ChatMessage(
      messageId: "msg-${DateTime.now().microsecondsSinceEpoch}",
      sessionId: ApiConfig.effectiveActorId,
      role: "user",
      text: trimmed,
      timestamp: DateTime.now(),
    );
    setState(() {
      _messages.add(userMessage);
      _isAgentProcessing = true;
      _agentStatusLine = null;
    });
    _notifyAgentProcessingUi(true);
    _store.saveMessage(userMessage);

    final Map<String, dynamic> userMsg = <String, dynamic>{
      "sessionId": ApiConfig.sessionId,
      "messageId": userMessage.messageId,
      "text": trimmed,
      "timestamp": DateTime.now().toIso8601String(),
    };
    if (ApiConfig.userId.trim().isNotEmpty) {
      userMsg["userId"] = ApiConfig.userId.trim();
    }
    userMsg["agentAccessMode"] =
        _fullComputerAccessEnabled ? "full" : "sandbox";

    if (_interruptedResponses.isNotEmpty) {
      final String interruptedContext =
          _interruptedResponses.join("\n\n--- 用户打断 ---\n\n");
      userMsg["interruptedContext"] = interruptedContext;
      _interruptedResponses.clear();
    }

    _armAgentReplyWatchdog(userMessage.messageId);
    _ws.sendEvent("chat.user_message", userMsg);
  }

  static const List<String> _kTabTitles = <String>[
    "",
    "Agent Link",
    "钱包",
    "技能商店",
    "游戏",
    "Agent World",
    "社交推文",
  ];

  void _selectTab(int index) {
    // 社交推文（index 6）：在系统浏览器打开 social-platform，不切换内嵌页
    if (index == 6) {
      unawaited(_openSocialFeedWeb());
      return;
    }
    setState(() => _tabIndex = index);
  }

  /// 在系统浏览器打开社交推文站（`ApiConfig.socialFeedUrl`，默认 :3001）。
  Future<void> _openSocialFeedWeb() async {
    final Uri url = Uri.parse(ApiConfig.socialFeedUrl);
    try {
      final bool launched =
          await launchUrl(url, mode: LaunchMode.externalApplication);
      if (!launched && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: const Text("无法打开社交推文站，请先运行 npm run dev:all"),
            action: SnackBarAction(
              label: "复制 URL",
              onPressed: () => debugPrint("socialFeedUrl: $url"),
            ),
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("打开网页失败: $e")),
        );
      }
    }
  }

  Future<void> _openWechatClawBinding() async {
    final BuildContext? navCtx = _rootNavigatorKey.currentContext;
    if (navCtx == null || !navCtx.mounted) return;
    await openWechatClawBinding(navCtx);
  }

  /// 打开五子棋对局（从 playUrl 或 tableId 解析）。
  void _openGomokuGame(String playUrlOrTableId) {
    final String? tableId = PlayUrlUtils.parseTableId(playUrlOrTableId);
    if (tableId == null || tableId.isEmpty) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        SnackBar(content: Text("无法识别对局：$playUrlOrTableId")),
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

  void _callAgentViaPhone(String agentId, String? message) {
    if (!_ws.isConnected) {
      _ws.retryConnect();
      if (mounted) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          const SnackBar(content: Text("正在连接服务器，请稍后再试")),
        );
      }
      return;
    }
    final Map<String, dynamic> callPayload = <String, dynamic>{
      "toActorId": agentId,
    };
    if (message != null && message.isNotEmpty) {
      callPayload["userMessage"] = message;
    }
    _ws.sendEvent("phone.user_call_agent", callPayload);
    if (mounted) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        SnackBar(
          content: Text("📞 ${VirtualPhoneUiLabels.callStatusLabel("ringing")}（$agentId）"),
        ),
      );
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

  void _presentPeerAgentIncoming(Map<String, dynamic> payload) {
    final String callId = payload["callId"]?.toString() ?? "";
    if (callId.isEmpty) return;
    if (_peerIncomingDialogCallId == callId) return;

    final String fromPhone = payload["fromPhone"]?.toString() ?? "";
    final String callerLabel = VirtualPhoneUiLabels.incomingCallerLabel(
      direction: "agent_to_agent",
      fromPhone: fromPhone,
    );
    setState(() {
      _peerIncomingDialogCallId = callId;
      _phoneCallStatus = "incoming";
      _phoneCallToActorId = callerLabel;
    });

    final BuildContext? navCtx = _rootNavigatorKey.currentContext;
    if (navCtx == null || !navCtx.mounted) return;

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!navCtx.mounted) return;
      unawaited(
        showPeerAgentIncomingCallDialog(
          context: navCtx,
          payload: payload,
          onRespond: (String action) {
            _sendPeerIncomingResponse(callId, action);
            if (action == "accept") {
              if (mounted) {
                ScaffoldMessenger.maybeOf(context)?.showSnackBar(
                  const SnackBar(content: Text("已接听，可查看来电语音与文字稿")),
                );
              }
            } else if (mounted) {
              ScaffoldMessenger.maybeOf(context)?.showSnackBar(
                SnackBar(
                  content: Text(
                    action == "decline"
                        ? "已拒接，你的 Agent 正在转告来电内容…"
                        : "已委托 Agent 代接…",
                  ),
                ),
              );
            }
          },
        ).whenComplete(() {
          if (mounted && _peerIncomingDialogCallId == callId) {
            setState(() => _peerIncomingDialogCallId = null);
          }
        }),
      );
    });
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
    if (mounted) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        SnackBar(
          content: Text("📞 ${VirtualPhoneUiLabels.callStatusLabel("ringing")}…"),
        ),
      );
    }
  }

  /// 根据网络 IP 展示推测位置，并询问是否开启 GPS 定位权限（灰色弹窗，仅询问一次）。
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
      if (_desktopBridgeOnline != null) {
        final String? summary = _desktopBridgeLastSummary?.trim();
        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Tooltip(
              message: summary == null || summary.isEmpty
                  ? "??????"
                  : "???????$summary",
              child: Chip(
                label: Text(
                  _desktopBridgeOnline! ? "????" : "????",
                  style: const TextStyle(fontSize: 12),
                ),
                visualDensity: VisualDensity.compact,
                materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                padding: const EdgeInsets.symmetric(horizontal: 6),
              ),
            ),
            if (summary != null && summary.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(left: 2, top: 2),
                child: Text(
                  summary,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.labelSmall?.copyWith(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                ),
              ),
          ],
        );
      }
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
      return MaterialApp(
        navigatorKey: _rootNavigatorKey,
        title: "Private AI Agent",
        theme: AppTheme.material,
        home: Scaffold(
          backgroundColor: const Color(0xFF141414),
          body: Center(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const CircularProgressIndicator(
                  color: Colors.white,
                ),
                const SizedBox(height: 16),
                Text(
                  '正在初始化...',
                  style: TextStyle(
                    color: Colors.white.withOpacity(0.7),
                    fontSize: 14,
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    }

    return MaterialApp(
      navigatorKey: _rootNavigatorKey,
      title: "Private AI Agent",
      theme: AppTheme.material,
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
                    ),
                    const VerticalDivider(
                      width: 1,
                      thickness: 1,
                      color: AppPalette.sidebarSeparator,
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
                              if (_tabIndex == 0)
                                IconButton(
                                  tooltip: "查看日程",
                                  icon: Icon(
                                    _showCalendarPanel
                                        ? Icons.calendar_month
                                        : Icons.calendar_today_outlined,
                                    color: _showCalendarPanel
                                        ? Theme.of(context).colorScheme.primary
                                        : null,
                                  ),
                                  onPressed: () => setState(() =>
                                      _showCalendarPanel = !_showCalendarPanel),
                                ),
                              if (DeskPetSession.isSupported)
                                ListenableBuilder(
                                  listenable: DeskPetSession.instance,
                                  builder: (BuildContext context, Widget? _) {
                                    final bool summoned =
                                        DeskPetSession.instance.isSummoned;
                                    final bool bootstrapping =
                                        DeskPetSession.instance.isBootstrapping;
                                    return IconButton(
                                      tooltip: summoned ? "收起桌宠" : "召唤桌宠",
                                      icon: bootstrapping
                                          ? SizedBox(
                                              width: 20,
                                              height: 20,
                                              child: CircularProgressIndicator(
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
                                                await DeskPetSession.instance
                                                    .dismiss();
                                                return;
                                              }
                                              final bool ok =
                                                  await DeskPetSession.instance
                                                      .summon();
                                              if (!context.mounted) return;
                                              if (!ok) {
                                                ScaffoldMessenger.of(context)
                                                    .showSnackBar(
                                                  SnackBar(
                                                    content: Text(
                                                      DeskPetSession
                                                              .instance.error ??
                                                          "桌宠召唤失败",
                                                    ),
                                                  ),
                                                );
                                              }
                                            },
                                    );
                                  },
                                ),
                              IconButton(
                                tooltip: "查看后台任务",
                                icon: Badge(
                                  isLabelVisible:
                                      _backgroundTasksBadgeCount > 0,
                                  label: Text(
                                    _backgroundTasksBadgeCount > 9
                                        ? "9+"
                                        : "${_backgroundTasksBadgeCount}",
                                  ),
                                  child: const Icon(
                                      Icons.pending_actions_outlined),
                                ),
                                onPressed: () =>
                                    _openBackgroundTasksPanel(context),
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
                // 网络电话悬浮按钮
                if (_phoneCallStatus != null)
                  PhoneCallFloatingButton(
                    status: _phoneCallStatus!,
                    toActorId: _phoneCallToActorId,
                    onHangUp: () {
                      // 发送挂断消息
                      _ws.sendEvent("phone.hangup", {});
                      setState(() {
                        _phoneCallStatus = null;
                        _phoneCallToActorId = null;
                      });
                    },
                  ),
                // 进场动画层（覆盖在主界面上方，播完后自动消失）
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
  }

  Widget _buildGameCenterPage() {
    return GameCenterPage(
      actorId: ApiConfig.effectiveActorId,
      api: _worldApi,
      ws: _ws,
    );
  }

  Widget _buildFoldSection({
    required String title,
    required bool expanded,
    required VoidCallback onTap,
    required List<Widget> children,
    String? badge,
  }) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Container(
      decoration: AppTheme.borderedPanel(cs, radius: 10),
      child: Column(
        children: <Widget>[
          InkWell(
            onTap: onTap,
            borderRadius: BorderRadius.circular(10),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
              child: Row(
                children: <Widget>[
                  Expanded(
                    child: Row(
                      children: <Widget>[
                        Text(
                          title,
                          style: const TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        if (badge != null) ...<Widget>[
                          const SizedBox(width: 6),
                          Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 6,
                              vertical: 1,
                            ),
                            decoration: BoxDecoration(
                              color: cs.primary.withValues(alpha: 0.18),
                              borderRadius: BorderRadius.circular(999),
                              border: Border.all(
                                color: cs.primary.withValues(alpha: 0.38),
                              ),
                            ),
                            child: Text(
                              badge,
                              style: TextStyle(fontSize: 11, color: cs.primary),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                  Icon(
                    expanded ? Icons.expand_more : Icons.chevron_right,
                    size: 18,
                    color: cs.onSurfaceVariant,
                  ),
                ],
              ),
            ),
          ),
          if (expanded)
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
              child: DefaultTextStyle(
                style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: children,
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildCompanionRightPanel() {
    return Padding(
      padding: const EdgeInsets.all(12),
      child: Column(
        children: <Widget>[
          ValueListenableBuilder<int>(
            valueListenable: _scheduleReloadSignal,
            builder: (BuildContext context, int _, __) {
              final DateTime now = DateTime.now();
              final DateTime dayStart = DateTime(now.year, now.month, now.day);
              final DateTime dayEnd = dayStart.add(const Duration(days: 1));
              return FutureBuilder<List<ScheduleEvent>>(
                future: _store.listScheduleEventsInRange(dayStart, dayEnd),
                builder: (BuildContext context,
                    AsyncSnapshot<List<ScheduleEvent>> snapshot) {
                  final List<Widget> focusWidgets;
                  if (snapshot.connectionState == ConnectionState.waiting) {
                    focusWidgets = const <Widget>[Text("正在加载今日事项...")];
                  } else {
                    final List<ScheduleEvent> items = (snapshot.data ??
                            <ScheduleEvent>[])
                        .where((ScheduleEvent e) => (e.notes ?? "") != "已完成")
                        .take(3)
                        .toList();
                    if (items.isEmpty) {
                      focusWidgets = const <Widget>[Text("今天还没有安排，和我说一声就能添加。")];
                    } else {
                      focusWidgets = items
                          .map(
                            (ScheduleEvent e) => Padding(
                              padding: const EdgeInsets.only(bottom: 6),
                              child: Text(
                                "${e.startAt.hour.toString().padLeft(2, '0')}:${e.startAt.minute.toString().padLeft(2, '0')} ${e.title}",
                              ),
                            ),
                          )
                          .toList();
                    }
                  }
                  return _buildFoldSection(
                    title: "今日聚焦",
                    expanded: _todayPanelExpanded,
                    onTap: () => setState(
                        () => _todayPanelExpanded = !_todayPanelExpanded),
                    children: focusWidgets,
                  );
                },
              );
            },
          ),
          const SizedBox(height: 10),
          _buildFoldSection(
            title: "待你确认",
            badge: "2",
            expanded: _confirmPanelExpanded,
            onTap: () =>
                setState(() => _confirmPanelExpanded = !_confirmPanelExpanded),
            children: <Widget>[
              Text(
                _backgroundTasksBadgeCount > 0
                    ? "后台任务进行中：$_backgroundTasksBadgeCount 项"
                    : "当前没有待处理后台任务",
              ),
              const SizedBox(height: 6),
              Text(
                _desktopBridgeOnline == null
                    ? "电脑桥接状态暂不可用"
                    : (_desktopBridgeOnline!
                        ? "电脑桥接在线，可继续协同处理"
                        : "电脑桥接离线，建议重连"),
              ),
              const SizedBox(height: 6),
              Text(
                _phoneCallStatus == null
                    ? VirtualPhoneUiLabels.idleStatusHint
                    : "虚拟电话：${VirtualPhoneUiLabels.callStatusLabel(_phoneCallStatus)}",
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildMainContentWithCalendar() {
    return Stack(
      children: <Widget>[
        _buildMainContent(),
        if (_showCalendarPanel && _tabIndex == 0)
          GestureDetector(
            onTap: () => setState(() => _showCalendarPanel = false),
            child: Container(
              color: Colors.black.withOpacity(0.5),
              alignment: Alignment.center,
              child: GestureDetector(
                onTap: () {},
                child: Material(
                  elevation: 24,
                  borderRadius: BorderRadius.circular(16),
                  color: const Color(0xFF1E1E1E),
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
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 20, 16, 8),
          child: Row(
            children: <Widget>[
              const Text(
                "日程",
                style: TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.w600,
                  color: Colors.white,
                ),
              ),
              const Spacer(),
              IconButton(
                tooltip: "关闭",
                icon: const Icon(Icons.close, size: 22),
                onPressed: () =>
                    setState(() => _showCalendarPanel = false),
                visualDensity: VisualDensity.compact,
                padding: EdgeInsets.zero,
                constraints:
                    const BoxConstraints.tightFor(width: 32, height: 32),
                iconSize: 20,
                color: Colors.white54,
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
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        if (_tabIndex != 0 || constraints.maxWidth < 820) {
          return _buildTabStack();
        }
        final double rightWidth = constraints.maxWidth < 980 ? 240 : 300;
        return Row(
          children: <Widget>[
            Expanded(child: _buildTabStack()),
            const VerticalDivider(
              width: 1,
              thickness: 1,
              color: AppPalette.sidebarSeparator,
            ),
            SizedBox(
              width: rightWidth,
              child: _buildCompanionRightPanel(),
            ),
          ],
        );
      },
    );
  }

  /// 根级 Tab 栈：Windows 桌面球形 Agent 为单一原生实体（槽位锚定 + 桌面漫游）。
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
            ),
            MailboxPage(api: _worldApi),
            WalletPage(balance: _balance),
            SkillStorePage(api: _worldApi),
            _buildGameCenterPage(),
            WorldPage(
              sessionId: ApiConfig.effectiveActorId,
              api: _worldApi,
              ws: _ws,
            ),
            const SizedBox.shrink(),
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
  });

  final int tabIndex;
  final ValueChanged<int> onTabSelected;
  final VoidCallback onWechatClawTap;

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
      label: '技能商店',
    ),
    _SidebarItemSpec(
      iconOutlined: Icons.sports_esports_outlined,
      iconFilled: Icons.sports_esports,
      label: '游戏',
    ),
    _SidebarItemSpec(
      iconOutlined: Icons.public_outlined,
      iconFilled: Icons.public,
      label: 'Agent World',
    ),
    _SidebarItemSpec(
      iconOutlined: Icons.people_outline,
      iconFilled: Icons.people,
      label: '社交推文',
    ),
  ];

  bool _expanded = true;

  void _toggleExpanded() => setState(() => _expanded = !_expanded);

  @override
  Widget build(BuildContext context) {
    const Color toggleIdle = Color(0xFFA1A1AA);

    return AnimatedContainer(
      duration: const Duration(milliseconds: 240),
      curve: Curves.easeInOutCubic,
      width: _expanded ? 220.0 : 56.0,
      color: const Color(0xFF0F0F0F),
      clipBehavior: Clip.hardEdge,
      child: Material(
        color: const Color(0xFF0F0F0F),
        child: SafeArea(
          child: Padding(
            padding: EdgeInsets.symmetric(
              vertical: _expanded ? 12 : 8,
              horizontal: _expanded ? 12 : 8,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                SizedBox(
                  height: 40,
                  child: Align(
                    alignment:
                        _expanded ? Alignment.centerRight : Alignment.center,
                    child: IconButton(
                      tooltip: _expanded ? "收起侧边栏" : "展开侧边栏",
                      visualDensity: VisualDensity.compact,
                      padding: EdgeInsets.zero,
                      constraints: BoxConstraints.tightFor(
                        width: _expanded ? 32 : 36,
                        height: _expanded ? 32 : 36,
                      ),
                      icon: Icon(
                        _expanded
                            ? Icons.keyboard_double_arrow_left
                            : Icons.keyboard_double_arrow_right,
                        color: toggleIdle,
                        size: 20,
                      ),
                      onPressed: _toggleExpanded,
                    ),
                  ),
                ),
                const SizedBox(height: 4),
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
                            expanded: _expanded,
                            selected: widget.tabIndex == i,
                            onTap: () => widget.onTabSelected(i),
                          ),
                        if (!_expanded) const SizedBox(height: 20),
                      ],
                    ),
                  ),
                ),
                const Divider(height: 1, color: Color(0xFF27272A)),
                SizedBox(height: _expanded ? 8 : 4),
                if (_expanded)
                  _WechatClawSidebarFooter(onTap: widget.onWechatClawTap)
                else
                  Tooltip(
                    message: "绑定微信 Claw",
                    child: _WechatClawSidebarMiniButton(
                      onTap: widget.onWechatClawTap,
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
    this.badge,
  });

  final IconData iconOutlined;
  final IconData iconFilled;
  final String label;
  final String? badge;
}

class _SidebarNavItem extends StatefulWidget {
  const _SidebarNavItem({
    super.key,
    required this.spec,
    required this.expanded,
    required this.selected,
    required this.onTap,
  });

  final _SidebarItemSpec spec;
  final bool expanded;
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
    final bool expanded = widget.expanded;
    final _SidebarItemSpec spec = widget.spec;
    final ColorScheme cs = Theme.of(context).colorScheme;

    final Color bgColor = selected
        ? cs.surfaceContainerHigh.withOpacity(0.6)
        : (hovering
            ? cs.surfaceContainer.withOpacity(0.6)
            : Colors.transparent);

    final Color iconColor = selected
        ? const Color(0xFF60A5FA)
        : (hovering ? const Color(0xFFD4D4D8) : const Color(0xFF71717A));

    final Color textColor = selected
        ? const Color(0xFFF4F4F5)
        : (hovering ? const Color(0xFFE4E4E7) : const Color(0xFFA1A1AA));

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
          margin: const EdgeInsets.symmetric(vertical: 2),
          width: expanded ? null : 40,
          height: expanded ? null : 40,
          alignment: expanded ? null : Alignment.center,
          decoration: BoxDecoration(
            color: bgColor,
            borderRadius: BorderRadius.circular(8),
          ),
          child: expanded
              ? Stack(
                  children: <Widget>[
                    if (selected)
                      Positioned(
                        left: 0,
                        top: 0,
                        bottom: 0,
                        child: Container(
                          width: 4,
                          margin: const EdgeInsets.symmetric(vertical: 9),
                          decoration: BoxDecoration(
                            color: const Color(0xFF3B82F6),
                            borderRadius: BorderRadius.circular(999),
                          ),
                        ),
                      ),
                    Padding(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 12, vertical: 10),
                      child: Row(
                        children: <Widget>[
                          Icon(
                            selected ? spec.iconFilled : spec.iconOutlined,
                            size: 20,
                            color: iconColor,
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: AnimatedOpacity(
                              duration: const Duration(milliseconds: 160),
                              opacity: expanded ? 1 : 0,
                              child: Text(
                                spec.label,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  fontSize: 14,
                                  fontWeight: FontWeight.w500,
                                  color: textColor,
                                ),
                              ),
                            ),
                          ),
                          if (spec.badge != null && spec.badge!.isNotEmpty)
                            AnimatedOpacity(
                              duration: const Duration(milliseconds: 160),
                              opacity: expanded ? 1 : 0,
                              child: Container(
                                margin: const EdgeInsets.only(left: 8),
                                padding: const EdgeInsets.symmetric(
                                    horizontal: 6, vertical: 2),
                                decoration: BoxDecoration(
                                  color: spec.badge == 'NEW'
                                      ? const Color(0xA33B82F6)
                                      : cs.surfaceContainerHigh,
                                  borderRadius: BorderRadius.circular(999),
                                ),
                                child: Text(
                                  spec.badge!,
                                  style: TextStyle(
                                    fontSize: 9,
                                    fontWeight: FontWeight.w700,
                                    color: spec.badge == 'NEW'
                                        ? const Color(0xFFC084FC)
                                        : const Color(0xFFA1A1AA),
                                  ),
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                  ],
                )
              : Icon(
                  selected ? spec.iconFilled : spec.iconOutlined,
                  size: 20,
                  color: iconColor,
                ),
        ),
      ),
    );

    if (expanded) {
      return button;
    }
    return Tooltip(
      message: spec.label,
      child: button,
    );
  }
}

class _WechatClawSidebarFooter extends StatefulWidget {
  const _WechatClawSidebarFooter({required this.onTap});

  final VoidCallback onTap;

  @override
  State<_WechatClawSidebarFooter> createState() =>
      _WechatClawSidebarFooterState();
}

class _WechatClawSidebarFooterState extends State<_WechatClawSidebarFooter> {
  bool _hovering = false;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final Color bgColor = _hovering
        ? cs.surfaceContainer.withOpacity(0.6)
        : Colors.transparent;
    final Color textColor =
        _hovering ? const Color(0xFFE4E4E7) : const Color(0xFFA1A1AA);

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
          margin: const EdgeInsets.symmetric(vertical: 2),
          decoration: BoxDecoration(
            color: bgColor,
            borderRadius: BorderRadius.circular(8),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: Row(
              children: <Widget>[
                const _WechatClawGlyph(size: 20),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    "绑定微信 Claw",
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w500,
                      color: textColor,
                    ),
                  ),
                ),
                Icon(
                  Icons.qr_code_scanner_outlined,
                  size: 16,
                  color: textColor.withValues(alpha: 0.85),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _WechatClawSidebarMiniButton extends StatefulWidget {
  const _WechatClawSidebarMiniButton({required this.onTap});

  final VoidCallback onTap;

  @override
  State<_WechatClawSidebarMiniButton> createState() =>
      _WechatClawSidebarMiniButtonState();
}

class _WechatClawSidebarMiniButtonState
    extends State<_WechatClawSidebarMiniButton> {
  bool _hovering = false;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final Color bgColor = _hovering
        ? cs.surfaceContainer.withOpacity(0.6)
        : Colors.transparent;

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
          child: const _WechatClawGlyph(size: 20),
        ),
      ),
    );
  }
}

class _WechatClawGlyph extends StatelessWidget {
  const _WechatClawGlyph({required this.size});

  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size + 4,
      height: size + 4,
      decoration: BoxDecoration(
        color: const Color(0xFF07C160).withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(6),
      ),
      alignment: Alignment.center,
      child: Text(
        "微",
        style: TextStyle(
          color: const Color(0xFF07C160),
          fontSize: size * 0.72,
          fontWeight: FontWeight.w700,
          height: 1,
        ),
      ),
    );
  }
}
