import "dart:async";

import "package:flutter/material.dart";
import "package:flutter/scheduler.dart";
import "package:url_launcher/url_launcher.dart";

import "core/config/api_config.dart";
import "core/theme/app_theme.dart";
import "core/presentation/virtual_phone_incoming_dialog.dart";
import "core/db/isar_local_history_store.dart";
import "core/models/agent_relay_models.dart";
import "core/models/chat_models.dart";
import "core/models/wallet_models.dart";
import "core/services/schedule_api_client.dart";
import "core/services/schedule_reminder_sync.dart";
import "core/services/world_api_client.dart";
import "core/services/ws_chat_service.dart";
import "core/utils/play_url_utils.dart";
import "features/mailbox/agent_mailbox_page.dart";
import "features/mailbox/mailbox_page.dart";
import "features/chat/chat_page.dart";
import "features/chat/voice_mode_page.dart";
import "features/auth/phone_registration_page.dart";
import "features/auth/biometric_registration_page.dart";
import "core/vision/pick_gallery_vision.dart";
import "core/vision/silent_camera_capture.dart";
import "core/vision/vision_wire_frame.dart";
import "features/schedule/schedule_page.dart";
import "features/skill_store/skill_store_page.dart";
import "features/wallet/wallet_page.dart";
import "features/world/world_page.dart";

void main() {
  runApp(const PrivateAiApp());
}

class PrivateAiApp extends StatefulWidget {
  const PrivateAiApp({super.key});

  @override
  State<PrivateAiApp> createState() => _PrivateAiAppState();
}

class _PrivateAiAppState extends State<PrivateAiApp> {
  final GlobalKey<NavigatorState> _rootNavigatorKey = GlobalKey<NavigatorState>();
  final IsarLocalHistoryStore _store =
      IsarLocalHistoryStore(userPin: ApiConfig.localPin);
  final WsChatService _ws = WsChatService(url: ApiConfig.wsUrl);
  final WorldApiClient _worldApi = WorldApiClient(baseUrl: ApiConfig.httpBase);
  final ScheduleApiClient _scheduleApi =
      ScheduleApiClient(baseUrl: ApiConfig.httpBase);
  final ValueNotifier<int> _scheduleReloadSignal = ValueNotifier<int>(0);
  final TextEditingController _inputController = TextEditingController();

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
  /// 左侧导航栏是否展开（显示文字标签）；收起时仅显示图标。
  bool _railExpanded = true;
  /// 用户给agent起的名字
  String? _agentName;
  /// 与 userId 对齐的电脑桥接在线状态（由服务端 `desktop.bridge.sync` 推送）
  bool? _desktopBridgeOnline;
  String? _desktopBridgeLastSummary;
  /// 是否已完成生物特征注册
  bool _isBiometricRegistered = false;
  /// 是否已初始化完成
  bool _isInitialized = false;
  /// 是否需要显示注册页面
  bool _showRegistration = false;
  /// Agent是否正在处理中（用于显示响应状态指示器）
  bool _isAgentProcessing = false;

  @override
  void initState() {
    super.initState();
    _bootstrap();
  }

  Future<void> _bootstrap() async {
    print('[Bootstrap] 开始初始化...');
    try {
      await _store.init();
      print('[Bootstrap] Store 初始化完成');
    } catch (e) {
      print('[Bootstrap] Store 初始化失败: $e');
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
      print('[Bootstrap] Session 保存完成');
    } catch (e) {
      print('[Bootstrap] Session 保存失败: $e');
      rethrow;
    }
    
    final List<ChatMessage> cachedMessages =
        await _store.listMessages(ApiConfig.effectiveActorId);
    print('[Bootstrap] 加载了 ${cachedMessages.length} 条消息');
    
    final List<AgentRelayMessage> cachedRelay =
        await _store.listRelayInbound(ApiConfig.effectiveActorId);
    print('[Bootstrap] 加载了 ${cachedRelay.length} 条中继消息');
    
    final bool? visionConsent = await _store.getVisionCameraConsent();
    print('[Bootstrap] Vision 同意状态: $visionConsent');
    
    // 检查是否已注册手机号
    final phoneNumber = await _store.getPreference('phoneNumber');
    final isPhoneRegistered = phoneNumber != null && phoneNumber.toString().isNotEmpty;
    print('[Bootstrap] 手机号注册状态: $isPhoneRegistered');
    
    // 检查是否已完成生物特征注册
    final biometricStatus = await _store.getBiometricRegistrationStatus();
    print('[Bootstrap] 生物特征注册状态: $biometricStatus');
    
    setState(() {
      _messages.addAll(cachedMessages);
      _relayInbound
        ..clear()
        ..addAll(cachedRelay);
      _visionCameraConsent = visionConsent;
      // 设置agent名字占位符
      _agentName = "AI助手";
      _isBiometricRegistered = biometricStatus;
      _isInitialized = true;
      // 如果未注册手机号，显示注册页面
      _showRegistration = !isPhoneRegistered;
      print('[Bootstrap] setState 完成, _isInitialized=$_isInitialized, _showRegistration=$_showRegistration');
    });
    
    // 如果已注册手机号但未注册生物特征，弹出小弹窗
    if (isPhoneRegistered && !biometricStatus) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _showBiometricDialog();
      });
    }
    
    _ws.connect();
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
    _ws.events.listen((Map<String, dynamic> event) async {
      final String type = event["type"] as String? ?? "";
      final Map<String, dynamic> payload =
          (event["payload"] as Map?)?.cast<String, dynamic>() ??
              <String, dynamic>{};
      if (type == "error.event") {
        if (_isAgentProcessing) {
          setState(() => _isAgentProcessing = false);
        }
        final String message =
            payload["message"]?.toString() ?? "服务器处理失败";
        if (mounted) {
          ScaffoldMessenger.maybeOf(context)?.showSnackBar(
            SnackBar(content: Text(message)),
          );
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
        if (toolOk && result != null) {
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
      if (type == "chat.assistant_chunk") {
        // 开始接收流式输出时，标记为处理中
        if (!_isAgentProcessing) {
          setState(() => _isAgentProcessing = true);
        }
        final String messageId =
            payload["messageId"]?.toString() ?? "assistant-chunk";
        final String chunk = payload["chunk"]?.toString() ?? "";
        final String? playUrl =
            _playUrlForAssistantMessageId(messageId) ??
                PlayUrlUtils.fromAssistantText(chunk);
        final ChatMessage assistantChunk = ChatMessage(
          messageId: messageId,
          sessionId: ApiConfig.effectiveActorId,
          role: "assistant",
          text: chunk,
          timestamp: DateTime.now(),
          playUrl: playUrl,
        );
        setState(() {
          final int? idx = _assistantMessageIndexById[messageId];
          if (idx == null) {
            _messages.add(assistantChunk);
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
      if (type == "chat.assistant_done") {
        // 处理完成，清除处理中状态
        if (_isAgentProcessing) {
          setState(() => _isAgentProcessing = false);
        }
        final String messageId =
            payload["messageId"]?.toString() ?? "assistant-final";
        final String finalText = payload["finalText"]?.toString() ?? "";
        final String? traceKey = messageId.startsWith("assistant-")
            ? messageId.substring("assistant-".length)
            : null;
        final String? playUrl =
            (traceKey != null ? _pendingPlayUrlByTraceId.remove(traceKey) : null) ??
                _playUrlForAssistantMessageId(messageId) ??
                PlayUrlUtils.fromAssistantText(finalText);
        final int? idx = _assistantMessageIndexById[messageId];
        if (idx != null) {
          setState(() {
            final ChatMessage previous = _messages[idx];
            _messages[idx] = ChatMessage(
              messageId: previous.messageId,
              sessionId: previous.sessionId,
              role: previous.role,
              text: finalText.isNotEmpty ? finalText : previous.text,
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
            text: finalText,
            timestamp: DateTime.now(),
            playUrl: playUrl,
          );
          await _store.saveMessage(finalMessage);
        }
        return;
      }
      if (type == "agent.peer_message") {
        final String messageId =
            payload["messageId"]?.toString() ?? "relay-unknown";
        final String fromSessionId =
            payload["fromSessionId"]?.toString() ?? "";
        final String toSessionId = payload["toSessionId"]?.toString() ?? "";
        final String body = payload["text"]?.toString() ?? "";
        final String? subject = payload["subject"]?.toString();
        final String receivedRaw =
            payload["receivedAt"]?.toString() ?? DateTime.now().toIso8601String();
        DateTime receivedAt = DateTime.now();
        try {
          receivedAt = DateTime.parse(receivedRaw);
        } catch (_) {}
        final AgentRelayMessage inbound = AgentRelayMessage(
          messageId: messageId,
          fromSessionId: fromSessionId,
          toSessionId: toSessionId,
          text: body,
          subject:
              (subject == null || subject.isEmpty) ? null : subject,
          receivedAt: receivedAt,
        );
        setState(() {
          final int dup =
              _relayInbound.indexWhere((AgentRelayMessage x) => x.messageId == messageId);
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
        SchedulerBinding.instance.addPostFrameCallback((Duration _) {
          final BuildContext? navCtx = _rootNavigatorKey.currentContext;
          if (navCtx != null && navCtx.mounted) {
            unawaited(
              showVirtualPhoneIncomingDialog(
                context: navCtx,
                payload: payload,
              ),
            );
          }
        });
      }
      if (type == "desktop.bridge.sync") {
        final bool? on = payload["bridgeOnline"] as bool?;
        final Map<String, dynamic>? lt =
            (payload["lastTask"] as Map?)?.cast<String, dynamic>();
        setState(() {
          _desktopBridgeOnline = on;
          _desktopBridgeLastSummary = lt == null
              ? null
              : (lt["summary"]?.toString() ?? lt["error"]?.toString());
        });
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

  Future<void> _sendMessage() async {
    final String text = _inputController.text.trim();

    List<VisionWireFrame>? attachmentFrames;
    if (_pendingGalleryFrames.isNotEmpty) {
      attachmentFrames = List<VisionWireFrame>.from(_pendingGalleryFrames);
      setState(_pendingGalleryFrames.clear);
    }

    if (text.isEmpty && attachmentFrames == null) {
      return;
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
    });
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
    _ws.sendEvent("chat.user_message", userMsg);
  }

  static const List<String> _kTabTitles = <String>[
    "",
    "Agent Link",
    "日程",
    "钱包",
    "技能商店",
    "Agent World",
    "", // 新的社交联系tab，名称待定
  ];

  void _selectTab(int index) {
    // 如果点击的是 Agent World (index 5)，则打开网页而不是切换页面
    if (index == 5) {
      _openAgentWorldWeb();
      return;
    }
    // 如果点击的是新的社交联系tab (index 6)，则打开网页而不是切换页面
    if (index == 6) {
      _openAgentLinkWeb();
      return;
    }
    setState(() => _tabIndex = index);
    if (index == 2) {
      _scheduleReloadSignal.value += 1;
    }
  }

  /// 打开 Agent World 网页
  Future<void> _openAgentWorldWeb() async {
    final Uri url = Uri.parse(ApiConfig.agentWorldUrl);
    print('尝试打开 Agent World 网页: $url'); // 调试信息
    
    try {
      final bool launched = await launchUrl(url, mode: LaunchMode.externalApplication);
      if (!launched) {
        print('无法打开 URL: $url'); // 调试信息
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text("无法打开 Agent World 网页"),
              action: SnackBarAction(
                label: '复制URL',
                onPressed: () {
                  // 可以在这里添加复制到剪贴板的逻辑
                  print('URL: $url');
                },
              ),
            ),
          );
        }
      }
    } catch (e) {
      print('打开 URL 时出错: $e'); // 调试信息
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("打开网页失败: $e")),
        );
      }
    }
  }

  /// 打开 Agent Link 社交网页
  Future<void> _openAgentLinkWeb() async {
    final Uri url = Uri.parse(ApiConfig.agentLinkUrl);
    print('尝试打开 Agent Link 社交网页: $url'); // 调试信息
    
    try {
      final bool launched = await launchUrl(url, mode: LaunchMode.externalApplication);
      if (!launched) {
        print('无法打开 URL: $url'); // 调试信息
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text("无法打开 Agent Link 社交网页"),
              action: SnackBarAction(
                label: '复制URL',
                onPressed: () {
                  // 可以在这里添加复制到剪贴板的逻辑
                  print('URL: $url');
                },
              ),
            ),
          );
        }
      }
    } catch (e) {
      print('打开 URL 时出错: $e'); // 调试信息
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("打开网页失败: $e")),
        );
      }
    }
  }

  /// 显示手机号注册页面
  void _showPhoneRegistration() {
    Navigator.of(_rootNavigatorKey.currentContext!).push(
      MaterialPageRoute(
        builder: (context) => PhoneRegistrationPage(
          onRegistrationComplete: () {
            // 注册成功后，跳转到生物特征页面
            Navigator.of(context).pop();
            _showBiometricRegistration();
          },
        ),
      ),
    );
  }

  /// 显示生物特征注册页面
  void _showBiometricRegistration() {
    Navigator.of(_rootNavigatorKey.currentContext!).push(
      MaterialPageRoute(
        builder: (context) => BiometricRegistrationPage(
          userId: ApiConfig.userId.isNotEmpty ? ApiConfig.userId : "user_001",
          onComplete: () {
            Navigator.of(context).pop();
            setState(() {
              _isBiometricRegistered = true;
            });
            // 保存注册状态
            _store.saveBiometricRegistrationStatus(true);
          },
        ),
      ),
    );
  }

  /// 显示生物特征注册对话框
  Future<void> _showBiometricDialog() async {
    final BuildContext? ctx = _rootNavigatorKey.currentContext;
    if (ctx == null || !ctx.mounted) {
      return;
    }
    
    await showDialog(
      context: ctx,
      barrierDismissible: false,
      builder: (BuildContext dialogContext) {
        return AlertDialog(
          title: const Text("生物特征注册"),
          content: const Text("为了增强账户安全，建议您注册生物特征（声纹或面部识别）。您可以现在注册，也可以稍后在设置中完成。"),
          actions: <Widget>[
            TextButton(
              onPressed: () {
                Navigator.pop(dialogContext);
                // 标记为已注册，避免再次弹出
                setState(() {
                  _isBiometricRegistered = true;
                });
                _store.saveBiometricRegistrationStatus(true);
              },
              child: const Text("稍后设置"),
            ),
            FilledButton(
              onPressed: () {
                Navigator.pop(dialogContext);
                _showBiometricRegistration();
              },
              child: const Text("立即注册"),
            ),
          ],
        );
      },
    );
  }

  /// 收起态侧栏图标悬停提示；首 Tab 无顶栏标题，此处用「对话」代替空字符串。
  String _tabTooltip(int index) {
    if (index == 0) {
      return "对话";
    }
    return _kTabTitles[index];
  }

  /// 收起态：深色窄条 + 分组线框小按钮（仅图标），风格接近 IDE 迷你侧栏。
  Widget _buildCollapsedMiniSidebar() {
    const Color iconIdle = Color(0xFFB0B0B8);
    const Color iconSelected = Color(0xFFFFFFFF);

    Widget miniTab(
      int index,
      IconData iconOutlined,
      IconData iconFilled,
    ) {
      final bool selected = _tabIndex == index;
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Tooltip(
          message: _tabTooltip(index),
          child: Material(
            color: Colors.transparent,
            child: InkWell(
              onTap: () => _selectTab(index),
              borderRadius: BorderRadius.circular(8),
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 160),
                curve: Curves.easeOutCubic,
                width: 40,
                height: 40,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: selected
                      ? Colors.white.withOpacity(0.12)
                      : Colors.transparent,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(
                    color: selected
                        ? Colors.white.withOpacity(0.22)
                        : Colors.white.withOpacity(0.08),
                  ),
                ),
                child: Icon(
                  selected ? iconFilled : iconOutlined,
                  size: 22,
                  color: selected ? iconSelected : iconIdle,
                ),
              ),
            ),
          ),
        ),
      );
    }

    return Material(
      color: AppPalette.sidebar,
      child: SizedBox(
        width: 56,
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Column(
              children: <Widget>[
                SizedBox(
                  width: 56,
                  child: Padding(
                    padding: const EdgeInsetsDirectional.only(top: 2, end: 6),
                    child: Align(
                      alignment: AlignmentDirectional.topEnd,
                      child: IconButton(
                        tooltip: "展开侧边栏",
                        visualDensity: VisualDensity.compact,
                        padding: EdgeInsets.zero,
                        constraints: const BoxConstraints.tightFor(
                          width: 40,
                          height: 40,
                        ),
                        icon: const Icon(
                          Icons.keyboard_double_arrow_right,
                          color: iconIdle,
                          size: 22,
                        ),
                        onPressed: () => setState(() => _railExpanded = true),
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 4),
                miniTab(0, Icons.chat_outlined, Icons.chat),
                miniTab(1, Icons.link_outlined, Icons.link),
                miniTab(2, Icons.calendar_today_outlined, Icons.calendar_today),
                miniTab(3, Icons.account_balance_wallet_outlined,
                    Icons.account_balance_wallet),
                miniTab(4, Icons.storefront_outlined, Icons.storefront),
                const SizedBox(height: 28),
                miniTab(5, Icons.public_outlined, Icons.public),
                miniTab(6, Icons.people_outline, Icons.people),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// 展开态：文字在左、图标靠右对齐（贴近与主区分隔的一侧），与收起态迷你栏视觉一致。
  Widget _buildExpandedSidebar() {
    const double kRailWidth = 208;
    const Color selectedIconColor = Colors.white;
    final Color unselectedIconColor = Colors.white.withOpacity(0.58);
    final TextStyle selectedLabelStyle = const TextStyle(
      color: Colors.white,
      fontSize: 12,
      fontWeight: FontWeight.w600,
    );
    final TextStyle unselectedLabelStyle = TextStyle(
      color: Colors.white.withOpacity(0.52),
      fontSize: 12,
    );

    const List<(IconData, IconData, String?)> kSpecs =
        <(IconData, IconData, String?)>[
      (Icons.chat_outlined, Icons.chat, "对话"),
      (Icons.link_outlined, Icons.link, "Agent Link"),
      (Icons.calendar_today_outlined, Icons.calendar_today, "日程"),
      (
        Icons.account_balance_wallet_outlined,
        Icons.account_balance_wallet,
        "钱包"
      ),
      (Icons.storefront_outlined, Icons.storefront, "技能商店"),
      (Icons.public_outlined, Icons.public, "Agent World"),
      (Icons.people_outline, Icons.people, ""), // 新的社交联系tab，名称待定
    ];

    return Material(
      color: AppPalette.sidebar,
      child: SizedBox(
        width: kRailWidth,
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsetsDirectional.only(start: 8, end: 6),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                SizedBox(
                  height: 48,
                  child: Padding(
                    padding: const EdgeInsetsDirectional.only(top: 4),
                    child: Align(
                      alignment: AlignmentDirectional.topEnd,
                      child: IconButton(
                        tooltip: "收起侧边栏",
                        visualDensity: VisualDensity.compact,
                        padding: EdgeInsets.zero,
                        constraints: const BoxConstraints.tightFor(
                          width: 40,
                          height: 40,
                        ),
                        icon: const Icon(
                          Icons.keyboard_double_arrow_left,
                          color: Colors.white70,
                          size: 22,
                        ),
                        onPressed: () =>
                            setState(() => _railExpanded = false),
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 2),
                for (int i = 0; i < kSpecs.length; i += 1)
                  _buildExpandedRailDestination(
                    index: i,
                    icon: kSpecs[i].$1,
                    selectedIcon: kSpecs[i].$2,
                    label: kSpecs[i].$3,
                    selected: _tabIndex == i,
                    selectedIconColor: selectedIconColor,
                    unselectedIconColor: unselectedIconColor,
                    selectedLabelStyle: selectedLabelStyle,
                    unselectedLabelStyle: unselectedLabelStyle,
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildExpandedRailDestination({
    required int index,
    required IconData icon,
    required IconData selectedIcon,
    required String? label,
    required bool selected,
    required Color selectedIconColor,
    required Color unselectedIconColor,
    required TextStyle selectedLabelStyle,
    required TextStyle unselectedLabelStyle,
  }) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: () => _selectTab(index),
          child: Ink(
            decoration: BoxDecoration(
              color: selected ? Colors.white.withOpacity(0.14) : null,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Padding(
              padding: const EdgeInsetsDirectional.only(
                start: 8,
                end: 4,
                top: 8,
                bottom: 8,
              ),
              child: Row(
                children: <Widget>[
                  Flexible(
                    child: Align(
                      alignment: AlignmentDirectional.centerStart,
                      child: label == null
                          ? const SizedBox.shrink()
                          : Text(
                              label,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: selected
                                  ? selectedLabelStyle
                                  : unselectedLabelStyle,
                            ),
                    ),
                  ),
                  Icon(
                    selected ? selectedIcon : icon,
                    size: 24,
                    color: selected ? selectedIconColor : unselectedIconColor,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget? _buildAppBarTitle() {
    if (_tabIndex == 0) {
    
      if (_desktopBridgeOnline != null) {
        return Tooltip(
          message: _desktopBridgeLastSummary == null || _desktopBridgeLastSummary!.isEmpty
              ? "电脑桥接状态"
              : "最近桌面任务：$_desktopBridgeLastSummary",
          child: Chip(
            label: Text(
              _desktopBridgeOnline! ? "电脑在线" : "电脑离线",
              style: const TextStyle(fontSize: 12),
            ),
            visualDensity: VisualDensity.compact,
            materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
            padding: const EdgeInsets.symmetric(horizontal: 6),
          ),
        );
      }
      return null;
    }
   
    return null;
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
          backgroundColor: const Color(0xFF2A2A2A),
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

    // 如果需要显示注册页面
    if (_showRegistration) {
      return MaterialApp(
        navigatorKey: _rootNavigatorKey,
        title: "Private AI Agent",
        theme: AppTheme.material,
        home: PhoneRegistrationPage(
          onRegistrationComplete: () {
            setState(() {
              _showRegistration = false;
            });
            // 注册完成后，检查是否需要显示生物特征注册
            if (!_isBiometricRegistered) {
              WidgetsBinding.instance.addPostFrameCallback((_) {
                _showBiometricDialog();
              });
            }
          },
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
            body: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Expanded(
                  flex: 0,
                  child: AnimatedCrossFade(
                    duration: const Duration(milliseconds: 240),
                    reverseDuration: const Duration(milliseconds: 240),
                    sizeCurve: Curves.easeInOutCubic,
                    firstCurve: Curves.easeInOutCubic,
                    secondCurve: Curves.easeInOutCubic,
                    alignment: Alignment.topLeft,
                    crossFadeState: _railExpanded
                        ? CrossFadeState.showSecond
                        : CrossFadeState.showFirst,
                    firstChild: KeyedSubtree(
                      key: const ValueKey<String>("rail_mini"),
                      child: _buildCollapsedMiniSidebar(),
                    ),
                    secondChild: KeyedSubtree(
                      key: const ValueKey<String>("rail_expanded"),
                      child: _buildExpandedSidebar(),
                    ),
                  ),
                ),
                const VerticalDivider(
                  width: 1,
                  thickness: 1,
                  color: AppPalette.sidebarSeparator,
                ),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      AppBar(
                        automaticallyImplyLeading: false,
                        title: _buildAppBarTitle(),
                      ),
                      Expanded(
                        child: MainPanel(
                          child: _buildTabStack(),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  /// 根级 Tab 栈：新增页请在 `_kTabTitles`（首项可为空以隐藏顶栏标题）、`IndexedStack`、`_buildExpandedSidebar` 内目的地元组与 `_buildCollapsedMiniSidebar` 的 `miniTab` 同步索引；
  /// 索引 1 为占位邮箱注册页 [AgentMailboxPage]；索引 2 为 [SchedulePage]。
  /// 新页面根布局用 [MainPanel] 包裹以贴合主区底色（见 `core/theme/app_theme.dart`）。
  Widget _buildTabStack() {
    return Builder(
      builder: (BuildContext context) {
        return IndexedStack(
          index: _tabIndex,
          children: <Widget>[
            ChatPage(
              messages: _messages,
              controller: _inputController,
              onSend: _sendMessage,
              agentName: _agentName,
              galleryPendingCount: _pendingGalleryFrames.length,
              onPickGalleryImage: _pickGalleryImage,
              onClearGalleryImages: _clearPendingGalleryFrames,
              isAgentProcessing: _isAgentProcessing,
              onEnterVoiceMode: () {
                // 在主页面上下文中执行导航
                Navigator.of(context).push(
                  MaterialPageRoute(
                    builder: (context) => VoiceModePage(
                      onExit: () {
                        Navigator.of(context).pop();
                      },
                    ),
                  ),
                );
              },
            ),
            MailboxPage(api: _worldApi),
            SchedulePage(
              store: _store,
              scheduleApi: _scheduleApi,
              sessionId: ApiConfig.effectiveActorId,
              reloadListenable: _scheduleReloadSignal,
            ),
            WalletPage(
              balance: _balance,
            ),
            SkillStorePage(api: _worldApi),
            WorldPage(
              sessionId: ApiConfig.effectiveActorId,
              api: _worldApi,
              ws: _ws,
            ),
            const Center( // 新的社交联系tab占位符，实际会跳转到网页
              child: Text("正在打开社交联系页面..."),
            ),
          ],
        );
      },
    );
  }
}
