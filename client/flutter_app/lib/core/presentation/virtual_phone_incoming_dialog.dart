import "dart:async";
import "dart:convert";
import "dart:io";
import "dart:typed_data";

import "package:audioplayers/audioplayers.dart";
import "package:flutter/material.dart";
import "package:path_provider/path_provider.dart";

import "virtual_phone_ui_labels.dart";

typedef PhoneReplyCallback = void Function(String reply);

// ============================================================================
// 1. 振铃前摇阶段弹窗（ringing_start 事件触发）
// ============================================================================

/// 显示振铃前摇阶段弹窗。
///
/// 收到 [ServerEventType.VirtualPhoneRingingStart] 时调用。
/// 弹窗展示：来电者信息 + 振铃动画 + 倒计时 + 渐入效果。
/// 倒计时结束后自动过渡到接通界面（或由外部通过 [onConnect] 回调触发）。
///
/// [transcript] 和 [callerName] 用于用户挂断时展示"未接来电留言"文字卡片。
Future<void> showRingingPhaseDialog({
  required BuildContext context,
  required Map<String, dynamic> ringingPayload,
  required VoidCallback onConnect,
  VoidCallback? onHangUp,
  String? transcript, // 提醒正文（用于挂断后的文字卡片）
}) {
  return showDialog<void>(
    context: context,
    barrierDismissible: false, // 振铃阶段不允许点外部关闭
    barrierColor: Colors.black87,
    builder: (BuildContext ctx) => _RingingPhaseBody(
      payload: ringingPayload,
      onConnect: onConnect,
      onHangUp: onHangUp ?? () => Navigator.of(context).pop(),
      transcript: transcript,
    ),
  );
}

class _RingingPhaseBody extends StatefulWidget {
  const _RingingPhaseBody({
    required this.payload,
    required this.onConnect,
    required this.onHangUp,
    this.transcript,
  });

  final Map<String, dynamic> payload;
  final VoidCallback onConnect;
  final VoidCallback onHangUp;
  final String? transcript; // 挂断后用于展示文字留言

  @override
  State<_RingingPhaseBody> createState() => _RingingPhaseBodyState();
}

class _RingingPhaseBodyState extends State<_RingingPhaseBody>
    with TickerProviderStateMixin {
  late AnimationController _fadeController;
  late AnimationController _scaleController;
  late AnimationController _pulseController;
  Animation<double>? _fadeAnim;
  Animation<double>? _scaleAnim;
  Animation<double>? _pulseAnim;

  Timer? _countdownTimer;
  int _remainingSec = 0;
  bool _isConnecting = false;

  AudioPlayer? _ringtonePlayer;

  @override
  void initState() {
    super.initState();

    // ---- 渐入动画（500ms） ----
    _fadeController = AnimationController(
      duration: const Duration(milliseconds: 600),
      vsync: this,
    );
    _fadeAnim = CurvedAnimation(parent: _fadeController, curve: Curves.easeOut);
    _fadeController.forward();

    // ---- 缩放弹入动画（400ms，从 0.85 → 1.0） ----
    _scaleController = AnimationController(
      duration: const Duration(milliseconds: 500),
      vsync: this,
    );
    _scaleAnim = Tween<double>(begin: 0.85, end: 1.0).animate(
      CurvedAnimation(parent: _scaleController, curve: Curves.elasticOut),
    );
    _scaleController.forward();

    // ---- 图标脉冲动画（模拟振铃） ----
    _pulseController = AnimationController(
      duration: const Duration(milliseconds: 800),
      vsync: this,
    );
    _pulseAnim = Tween<double>(begin: 1.0, end: 1.15).animate(
      CurvedAnimation(parent: _pulseController, curve: Curves.easeInOut),
    );
    _pulseController.repeat(reverse: true);

    // ---- 启动倒计时 ----
    _startCountdown();

    // ---- 播放振铃音 ----
    _playRingtone();
  }

  void _startCountdown() {
    final int totalMs =
        (widget.payload["ringDurationMs"] as num?)?.toInt() ?? 8000;
    _remainingSec = (totalMs / 1000).ceil();

    _countdownTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) {
        timer.cancel();
        return;
      }
      setState(() {
        _remainingSec--;
      });
      if (_remainingSec <= 0) {
        timer.cancel();
        _transitionToConnected();
      }
    });
  }

  Future<void> _playRingtone() async {
    try {
      final player = AudioPlayer();
      _ringtonePlayer = player;
      // 使用系统振铃音或内置提示音（循环播放）
      await player.setSource(AssetSource("sounds/ringtone.mp3"));
      await player.setReleaseMode(ReleaseMode.loop);
      await player.resume();
    } catch (_) {
      // 资源文件不存在时静默失败，UI 照常运行
    }
  }

  void _stopRingtone() {
    _ringtonePlayer?.stop().catchError((_) {});
    _ringtonePlayer?.dispose().catchError((_) {});
    _ringtonePlayer = null;
  }

  void _transitionToConnected() {
    if (_isConnecting) return;
    _isConnecting = true;
    _stopRingtone();
    _countdownTimer?.cancel();
    _pulseController.stop();
    // 标记连接中状态后关闭自身，让调用方展示接通界面
    if (mounted) {
      Navigator.of(context).pop();
      widget.onConnect();
    }
  }

  void _hangUp() {
    _stopRingtone();
    _countdownTimer?.cancel();
    // 关闭振铃弹窗
    if (mounted) Navigator.of(context).pop();
    widget.onHangUp();

    // 弹出"未接来电留言"文字卡片（让用户不接电话也能看到提醒内容）
    if (widget.transcript != null && widget.transcript!.isNotEmpty && mounted) {
      _showMissedCallMessageCard();
    }
  }

  /// 显示未接来电留言文字卡片 —— 模仿微信的"未接来电 + 留言"通知
  void _showMissedCallMessageCard() {
    final String direction =
        widget.payload["direction"]?.toString() ?? "agent_to_user";
    final String fromPhone = widget.payload["fromPhone"]?.toString() ?? "";
    final String ringStyle = widget.payload["ringStyle"]?.toString() ?? "";

    final callerLabel = VirtualPhoneUiLabels.ringingCallerLabel(
      direction: direction,
      fromPhone: fromPhone,
    );
    final isReminder = ringStyle == "reminder";

    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(
          bottom: MediaQuery.of(ctx).viewInsets.bottom,
        ),
        child: Container(
          margin: const EdgeInsets.fromLTRB(20, 0, 20, 40),
          decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.surface,
            borderRadius: BorderRadius.circular(20),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withValues(alpha: 0.12),
                blurRadius: 20,
                offset: const Offset(0, 8),
              ),
            ],
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              // 顶部拖拽指示条
              Container(
                margin: const EdgeInsets.only(top: 12, bottom: 4),
                width: 36,
                height: 4,
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.outline.withValues(alpha: 0.3),
                  borderRadius: BorderRadius.circular(2),
                ),
              ),

              // 未接来电标题栏
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 16, 24, 8),
                child: Row(
                  children: [
                    Icon(
                      Icons.phone_missed_rounded,
                      color: isReminder ? Colors.orange : Colors.red[400],
                      size: 22,
                    ),
                    const SizedBox(width: 10),
                    Text(
                      isReminder ? "未接提醒" : "未接来电",
                      style: TextStyle(
                        fontSize: 17,
                        fontWeight: FontWeight.w600,
                        color: isReminder ? Colors.orange[700] : Colors.red[400],
                      ),
                    ),
                    const Spacer(),
                    Text(
                      _formatTimeNow(),
                      style: TextStyle(
                        fontSize: 13,
                        color: Theme.of(context).colorScheme.outline,
                      ),
                    ),
                  ],
                ),
              ),

              Divider(height: 1, color: Theme.of(context).colorScheme.outlineVariant),

              // 来电者信息
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 14, 24, 4),
                child: Row(
                  children: [
                    CircleAvatar(
                      radius: 18,
                      backgroundColor: (isReminder ? Colors.blueAccent : Theme.of(context).colorScheme.primary)
                          .withValues(alpha: 0.1),
                      child: Icon(
                        isReminder ? Icons.smart_toy : Icons.phone_in_talk,
                        size: 18,
                        color: isReminder ? Colors.blueAccent : Theme.of(context).colorScheme.primary,
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        callerLabel,
                        style: TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                          color: Theme.of(context).colorScheme.onSurface,
                        ),
                      ),
                    ),
                  ],
                ),
              ),

              // 留言/提醒正文 —— 核心内容区域
              Container(
                margin: const EdgeInsets.fromLTRB(20, 10, 20, 0),
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: isReminder
                      ? Colors.orange.withValues(alpha: 0.06)
                      : Theme.of(context).colorScheme.primaryContainer.withValues(alpha: 0.4),
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(
                    color: isReminder
                        ? Colors.orange.withValues(alpha: 0.15)
                        : Theme.of(context).colorScheme.primary.withValues(alpha: 0.1),
                  ),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (isReminder) ...[
                      Row(
                        children: [
                          Icon(Icons.notification_important_outlined, size: 14, color: Colors.orange[700]),
                          const SizedBox(width: 4),
                          Text(
                            "语音提醒内容",
                            style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: Colors.orange[700]),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                    ],
                    Text(
                      widget.transcript!,
                      style: TextStyle(
                        fontSize: 15,
                        height: 1.6,
                        color: Theme.of(context).colorScheme.onSurface,
                      ),
                    ),
                  ],
                ),
              ),

              const SizedBox(height: 20),

              // 底部操作按钮
              Padding(
                padding: const EdgeInsets.only(bottom: 20),
                child: Row(
                  children: [
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: () => Navigator.of(ctx).pop(),
                        icon: const Icon(Icons.close, size: 18),
                        label: const Text("关闭"),
                        style: OutlinedButton.styleFrom(
                          padding: const EdgeInsets.symmetric(vertical: 10),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                        ),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: () {
                          Navigator.of(ctx).pop();
                          // TODO: 可选：回拨或查看详情
                        },
                        icon: const Icon(Icons.call, size: 18),
                        label: const Text("回拨"),
                        style: FilledButton.styleFrom(
                          padding: const EdgeInsets.symmetric(vertical: 10),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                        ),
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

  String _formatTimeNow() {
    final now = DateTime.now();
    return "${now.hour.toString().padLeft(2, '0')}:${now.minute.toString().padLeft(2, '0')}";
  }

  @override
  void dispose() {
    _stopRingtone();
    _countdownTimer?.cancel();
    _fadeController.dispose();
    _scaleController.dispose();
    _pulseController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final String direction =
        widget.payload["direction"]?.toString() ?? "agent_to_user";
    final String fromPhone =
        widget.payload["fromPhone"]?.toString() ?? "";
    final String ringStyle =
        widget.payload["ringStyle"]?.toString() ?? "reminder";

    final callerLabel = VirtualPhoneUiLabels.ringingCallerLabel(
      direction: direction,
      fromPhone: fromPhone,
    );

    final ColorScheme cs = Theme.of(context).colorScheme;
    final bool isReminder = ringStyle == "reminder";

    return FadeTransition(
      opacity: _fadeAnim!,
      child: ScaleTransition(
        scale: _scaleAnim!,
        child: PopScope(
          canPop: false,
          child: Dialog(
            insetPadding: const EdgeInsets.symmetric(
              horizontal: 40,
              vertical: 24,
            ),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(24),
            ),
            elevation: 16,
            child: Container(
              width: double.infinity,
              padding: const EdgeInsets.fromLTRB(28, 32, 28, 24),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(24),
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [
                    cs.primaryContainer.withValues(alpha: 0.95),
                    cs.surfaceContainerHighest.withValues(alpha: 0.9),
                  ],
                ),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // ---- 来电者头像/图标（脉冲动画） ----
                  AnimatedBuilder(
                    animation: _pulseAnim!,
                    builder: (context, child) => Transform.scale(
                      scale: _pulseAnim!.value,
                      child: Container(
                        width: 80,
                        height: 80,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: isReminder
                              ? Colors.blueAccent.withValues(alpha: 0.15)
                              : cs.primary.withValues(alpha: 0.12),
                          border: Border.all(
                            color: isReminder
                                ? Colors.blueAccent.withValues(alpha: 0.4)
                                : cs.primary.withValues(alpha: 0.3),
                            width: 2,
                          ),
                          boxShadow: [
                            BoxShadow(
                              color: (isReminder ? Colors.blueAccent : cs.primary)
                                  .withValues(alpha: 0.2),
                              blurRadius: 16,
                              spreadRadius: 2,
                            ),
                          ],
                        ),
                        child: Icon(
                          isReminder ? Icons.smart_toy : Icons.phone_in_talk,
                          size: 38,
                          color: isReminder ? Colors.blueAccent : cs.primary,
                        ),
                      ),
                    ),
                  ),

                  const SizedBox(height: 20),

                  // ---- 来电标题 ----
                  Text(
                    VirtualPhoneUiLabels.ringingPhaseTitle,
                    style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                          fontWeight: FontWeight.bold,
                          color: cs.onSurface,
                        ),
                  ),

                  const SizedBox(height: 6),

                  // ---- 来电者信息 ----
                  Text(
                    callerLabel,
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                          color: isReminder
                              ? Colors.blueAccent
                              : cs.primary,
                          fontWeight: FontWeight.w600,
                        ),
                  ),

                  if (isReminder) ...[
                    const SizedBox(height: 2),
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 3,
                      ),
                      decoration: BoxDecoration(
                        color: Colors.orange.withValues(alpha: 0.12),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Text(
                        "语音提醒",
                        style: TextStyle(
                          fontSize: 11,
                          color: Colors.orange[700],
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                    ),
                  ],

                  const SizedBox(height: 20),

                  // ---- 倒计时 ----
                  AnimatedSwitcher(
                    duration: const Duration(milliseconds: 300),
                    transitionBuilder: (child, anim) =>
                        FadeTransition(opacity: anim, child: child),
                    child: Text(
                      "${VirtualPhoneUiLabels.ringingPhaseAutoAnswerHint} ${_remainingSec}s",
                      key: ValueKey<int>(_remainingSec),
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                            color: cs.onSurfaceVariant,
                            letterSpacing: 0.5,
                          ),
                    ),
                  ),

                  const SizedBox(height: 24),

                  // ---- 操作按钮：接听 / 挂断 ----
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      // 挂断按钮
                      _buildActionButton(
                        icon: Icons.call_end,
                        label: "挂断",
                        bgColor: Colors.red,
                        iconColor: Colors.white,
                        onTap: _hangUp,
                      ),

                      const SizedBox(width: 36),

                      // 接听按钮（提前接听）
                      _buildActionButton(
                        icon: Icons.call,
                        label: "接听",
                        bgColor: Colors.green,
                        iconColor: Colors.white,
                        onTap: _transitionToConnected,
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildActionButton({
    required IconData icon,
    required String label,
    required Color bgColor,
    required Color iconColor,
    required VoidCallback onTap,
  }) {
    return GestureDetector(
      onTap: onTap,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 60,
            height: 60,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: bgColor,
              boxShadow: [
                BoxShadow(
                  color: bgColor.withValues(alpha: 0.35),
                  blurRadius: 10,
                  offset: const Offset(0, 4),
                ),
              ],
            ),
            child: Icon(icon, color: iconColor, size: 28),
          ),
          const SizedBox(height: 6),
          Text(
            label,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w500,
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}

// ============================================================================
// 2. 统一通话弹窗（来电/通话中复用同一窗口，模仿 PC 微信电话）
// ============================================================================

/// 统一通话弹窗 —— 来电和接通后使用同一个 Dialog，类似 PC 微信电话。
///
/// 支持两种状态：
/// - [PhoneCallState.ringing]：来电中（头像脉冲动画 + 接听/挂断按钮）
/// - [PhoneCallState.connected]：通话中（计时器 + 语音气泡 + 静音/免提/挂断）
enum PhoneCallState { ringing, connected }

Future<void> showVirtualPhoneIncomingDialog({
  required BuildContext context,
  required Map<String, dynamic> payload,
  PhoneReplyCallback? onReply,
  PhoneCallState initialState = PhoneCallState.ringing,
  VoidCallback? onHangUp,
}) {
  return showDialog<void>(
    context: context,
    barrierDismissible: false,
    barrierColor: Colors.black54,
    builder: (BuildContext ctx) => _UnifiedPhoneCallDialog(
      payload: payload,
      onReply: onReply,
      initialState: initialState,
      onHangUp: onHangUp,
    ),
  );
}

/// 用户主动呼叫 Agent 时显示的振铃前摇弹窗（拨号中状态）。
///
/// 点击"呼叫我的 Agent"后立即弹出，显示脉冲头像 + "正在呼叫…" + 挂断按钮。
/// 服务端返回 call_connecting 后由外部关闭此弹窗并重新打开 connected 状态。
Future<void> showOutgoingCallDialog({
  required BuildContext context,
  required String toPhone,
  String? userMessage,
  VoidCallback? onHangUp,
}) {
  final payload = <String, dynamic>{
    "direction": "user_to_agent",
    "fromPhone": "",
    "toPhone": toPhone,
    "transcript": userMessage ?? "",
    "ringStyle": "outgoing",
  };

  return showDialog<void>(
    context: context,
    barrierDismissible: false,
    barrierColor: Colors.black54,
    builder: (BuildContext ctx) => _UnifiedPhoneCallDialog(
      payload: payload,
      initialState: PhoneCallState.ringing,
      onHangUp: onHangUp ?? () => Navigator.of(ctx).pop(),
    ),
  );
}

class _UnifiedPhoneCallDialog extends StatefulWidget {
  const _UnifiedPhoneCallDialog({
    required this.payload,
    this.onReply,
    this.initialState = PhoneCallState.ringing,
    this.onHangUp,
  });

  final Map<String, dynamic> payload;
  final PhoneReplyCallback? onReply;
  final PhoneCallState initialState;
  final VoidCallback? onHangUp;

  @override
  State<_UnifiedPhoneCallDialog> createState() => _UnifiedPhoneCallDialogState();
}

class _UnifiedPhoneCallDialogState extends State<_UnifiedPhoneCallDialog>
    with TickerProviderStateMixin {
  // ---- 状态 ----
  PhoneCallState _callState = PhoneCallState.ringing;

  // ---- 音频播放 ----
  AudioPlayer? _player;
  File? _tempFile;

  // ---- 振铃动画 ----
  late AnimationController _pulseController;
  Animation<double>? _pulseAnim;

  // ---- 通话计时 ----
  int _elapsedSeconds = 0;
  Timer? _callTimer;

  // ---- 通话操作状态 ----
  bool _isMuted = false;
  bool _isSpeakerOn = true;

  // ---- 回复 ----
  final TextEditingController _replyController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _callState = widget.initialState;

    // 脉冲动画（振铃时用）
    _pulseController = AnimationController(
      duration: const Duration(milliseconds: 800),
      vsync: this,
    );
    _pulseAnim = Tween<double>(begin: 1.0, end: 1.12).animate(
      CurvedAnimation(parent: _pulseController, curve: Curves.easeInOut),
    );

    if (_callState == PhoneCallState.ringing) {
      _pulseController.repeat(reverse: true);
      _startPlayback();
    } else {
      _startCallTimer();
    }
  }

  void _startPlayback() async {
    final Uint8List? bytes = _decodeMp3FromPayload(widget.payload);
    if (bytes == null || !mounted) return;
    final AudioPlayer player = AudioPlayer();
    if (!mounted) return;
    _player = player;
    try {
      await player.play(BytesSource(bytes, mimeType: "audio/mpeg"));
    } catch (_) {
      try {
        final Directory dir = await getTemporaryDirectory();
        final File f = File(
          "${dir.path}/vp_${DateTime.now().millisecondsSinceEpoch}.mp3",
        );
        await f.writeAsBytes(bytes, flush: true);
        _tempFile = f;
        await player.play(DeviceFileSource(f.path));
      } catch (_) {
        await player.dispose();
        if (mounted) setState(() => _player = null);
      }
    }
  }

  void _startCallTimer() {
    _elapsedSeconds = 0;
    _callTimer?.cancel();
    _callTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (mounted) setState(() => _elapsedSeconds++);
    });
  }

  String get _formattedDuration {
    final min = _elapsedSeconds ~/ 60;
    final sec = _elapsedSeconds % 60;
    return "$min:${sec.toString().padLeft(2, '0')}";
  }

  @override
  void dispose() {
    _pulseController.dispose();
    _callTimer?.cancel();
    _stopPlayer();
    _replyController.dispose();
    super.dispose();
  }

  Future<void> _stopPlayer() async {
    try { await _player?.stop(); } catch (_) {}
    await _player?.dispose();
    _player = null;
    final File? f = _tempFile;
    _tempFile = null;
    if (f != null) { try { if (await f.exists()) await f.delete(); } catch (_) {} }
  }

  // ---- 操作：接听（切换到 connected 状态）----
  void _answerCall() {
    _stopPlayer();
    _pulseController.stop();
    _startCallTimer();
    setState(() => _callState = PhoneCallState.connected);
  }

  // ---- 操作：挂断 ----
  void _hangUp() async {
    await _stopPlayer();
    _callTimer?.cancel();
    if (!mounted) return;

    // 调用外部传入的 onHangUp 回调（用于通知父组件清理状态）
    widget.onHangUp?.call();

    Navigator.of(context).pop();

    // 有留言内容时弹出未接卡片（仅在未接通时）
    final String transcript = widget.payload["transcript"]?.toString() ?? "";
    if (_callState == PhoneCallState.ringing && transcript.isNotEmpty && mounted) {
      _showMissedCallCard(transcript);
    }
  }

  // ---- 操作：回复 ----
  void _sendReply() {
    final text = _replyController.text.trim();
    if (text.isNotEmpty && widget.onReply != null) widget.onReply!(text);
    _hangUp();
  }

  void _showMissedCallCard(String transcript) {
    final p = widget.payload;
    final direction = p["direction"]?.toString() ?? "agent_to_user";
    final fromPhone = p["fromPhone"]?.toString() ?? "";
    final ringStyle = p["ringStyle"]?.toString() ?? "";
    final isReminder = ringStyle == "reminder";
    final isAgentToUser = direction == "agent_to_user";
    final callerLabel = VirtualPhoneUiLabels.incomingCallerLabel(direction: direction, fromPhone: fromPhone);

    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom),
        child: Container(
          margin: const EdgeInsets.fromLTRB(20, 0, 20, 40),
          decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.surface,
            borderRadius: BorderRadius.circular(20),
            boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.12), blurRadius: 20, offset: const Offset(0, 8))],
          ),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Container(margin: const EdgeInsets.only(top: 12, bottom: 4), width: 36, height: 4,
              decoration: BoxDecoration(color: Theme.of(context).colorScheme.outline.withValues(alpha: 0.3), borderRadius: BorderRadius.circular(2))),
            Padding(padding: const EdgeInsets.fromLTRB(24, 16, 24, 8), child: Row(children: [
              Icon(Icons.phone_missed_rounded, color: isReminder ? Colors.orange : Colors.red[400], size: 22),
              const SizedBox(width: 10),
              Text(isReminder ? "未接提醒" : "未接来电", style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600, color: isReminder ? Colors.orange[700] : Colors.red[400])),
              const Spacer(),
              Text("${DateTime.now().hour.toString().padLeft(2,'0')}:${DateTime.now().minute.toString().padLeft(2,'0')}", style: TextStyle(fontSize: 13, color: Theme.of(context).colorScheme.outline)),
            ])),
            Divider(height: 1, color: Theme.of(context).colorScheme.outlineVariant),
            Padding(padding: const EdgeInsets.fromLTRB(24, 14, 24, 8), child: Row(children: [
              CircleAvatar(radius: 18, backgroundColor: (isAgentToUser ? Colors.blueAccent : Theme.of(context).colorScheme.primary).withValues(alpha: 0.1),
                child: Icon(isAgentToUser ? Icons.smart_toy : Icons.phone_in_talk, size: 18, color: isAgentToUser ? Colors.blueAccent : Theme.of(context).colorScheme.primary)),
              const SizedBox(width: 10),
              Expanded(child: Text(callerLabel, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600))),
            ])),
            Container(margin: const EdgeInsets.fromLTRB(20, 10, 20, 0), padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(color: isReminder ? Colors.orange.withValues(alpha: 0.06) : Theme.of(context).colorScheme.primaryContainer.withValues(alpha: 0.4), borderRadius: BorderRadius.circular(14),
                border: Border.all(color: isReminder ? Colors.orange.withValues(alpha: 0.15) : Theme.of(context).colorScheme.primary.withValues(alpha: 0.1))),
              child: Text(transcript, style: const TextStyle(fontSize: 15, height: 1.6))),
            const SizedBox(height: 20),
            Padding(padding: const EdgeInsets.only(bottom: 20), child: Row(children: [
              Expanded(child: OutlinedButton.icon(onPressed: () => Navigator.of(ctx).pop(), icon: const Icon(Icons.close, size: 18), label: const Text("关闭"),
                style: OutlinedButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 10), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10))))),
              const SizedBox(width: 12),
              Expanded(child: FilledButton.icon(onPressed: () => Navigator.of(ctx).pop(), icon: const Icon(Icons.check, size: 18), label: const Text("已读"),
                style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 10), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10))))),
            ])),
          ]),
        ),
      ),
    );
  }

  // ==================== 构建 UI ====================

  @override
  Widget build(BuildContext context) {
    final Map<String, dynamic> p = widget.payload;
    final String direction = p["direction"]?.toString() ?? "agent_to_user";
    final bool isOutgoing = direction == "user_to_agent" || p["ringStyle"]?.toString() == "outgoing";
    final bool replyEnabled = p["replyEnabled"] == true;
    final String fromPhone = p["fromPhone"]?.toString() ?? "";
    final String toPhone = p["toPhone"]?.toString() ?? "";
    final String transcript = p["transcript"]?.toString() ?? "";

    // 拨号中显示被叫方名称，来电显示主叫方名称
    final displayName = isOutgoing
        ? (toPhone.isNotEmpty ? "你的 Agent ($toPhone)" : "你的 Agent")
        : VirtualPhoneUiLabels.incomingCallerLabel(direction: direction, fromPhone: fromPhone);

    final ColorScheme cs = Theme.of(context).colorScheme;

    return Dialog(
      insetPadding: const EdgeInsets.symmetric(horizontal: 36, vertical: 24),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      elevation: 24,
      child: Container(
        width: 300,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(20),
          gradient: const LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [Color(0xFF1A1C29), Color(0xFF12141F)],
          ),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // ====== 头部：头像 + 名称 + 状态 ======
            _buildHeader(displayName, isOutgoing),

            // ====== 内容区（根据状态切换）=====
            if (_callState == PhoneCallState.ringing)
              _buildRingingContent(transcript, replyEnabled, cs, isOutgoing)
            else
              _buildConnectedContent(transcript, cs),

            // ====== 底部操作栏 ======
            if (_callState == PhoneCallState.ringing)
              _buildRingingActions(replyEnabled, cs, isOutgoing)
            else
              _buildConnectedActions(cs),
          ],
        ),
      ),
    );
  }

  /// 头部区域：头像 + 名称 + 状态文字（两种状态共用）
  Widget _buildHeader(String displayName, bool isOutgoing) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 28, 24, 12),
      child: Column(
        children: [
          // 头像（振铃时带脉冲动画）
          AnimatedBuilder(
            animation: _pulseController,
            builder: (_, child) => Transform.scale(
              scale: _callState == PhoneCallState.ringing ? (_pulseAnim!.value) : 1.0,
              child: Container(
                width: 64,
                height: 64,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  gradient: RadialGradient(colors: [
                    Colors.greenAccent.withValues(alpha: 0.25),
                    Colors.greenAccent.withValues(alpha: 0.05),
                  ]),
                ),
                child: Container(
                  margin: const EdgeInsets.all(3),
                  decoration: BoxDecoration(shape: BoxShape.circle,
                    border: Border.all(color: Colors.white.withValues(alpha: 0.15), width: 1.5)),
                  child: Icon(Icons.smart_toy_rounded,
                    size: 30, color: Colors.greenAccent[200]),
                ),
              ),
            ),
          ),

          const SizedBox(height: 14),

          // 名称
          Text(displayName, style: const TextStyle(color: Colors.white, fontSize: 17, fontWeight: FontWeight.w600)),

          // 状态文字（拨号中不显示，保持简洁）
          if (!isOutgoing) ...[
            const SizedBox(height: 4),
            AnimatedSwitcher(
              duration: const Duration(milliseconds: 250),
              child: Text(
                _callState == PhoneCallState.ringing
                    ? "来电中"
                    : (_isMuted ? "已静音" : "通话中  $_formattedDuration"),
                key: ValueKey<PhoneCallState>(_callState),
                style: TextStyle(color: Colors.white.withValues(alpha: 0.55), fontSize: 13),
              ),
            ),
          ],
        ],
      ),
    );
  }

  /// 振铃阶段内容：语音预览 + 可选回复输入框
  Widget _buildRingingContent(String transcript, bool replyEnabled, ColorScheme cs, bool isOutgoing) {
    // 拨号中不显示额外内容
    if (isOutgoing) {
      return const SizedBox(height: 12);
    }

    return Flexible(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (transcript.isNotEmpty) ...[
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Colors.white.withValues(alpha: 0.07),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: Colors.white.withValues(alpha: 0.08)),
                ),
                child: Text(transcript, textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.white.withValues(alpha: 0.85), fontSize: 14, height: 1.5),
                  maxLines: 3, overflow: TextOverflow.ellipsis),
              ),
              const SizedBox(height: 12),
            ],
            if (replyEnabled) ...[
              TextField(
                controller: _replyController,
                maxLines: 1,
                style: const TextStyle(fontSize: 13, color: Colors.white70),
                decoration: InputDecoration(
                  hintText: "输入回复内容（可选）…",
                  hintStyle: TextStyle(color: Colors.white.withValues(alpha: 0.3), fontSize: 13),
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(10),
                    borderSide: BorderSide(color: Colors.white.withValues(alpha: 0.15))),
                  enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(10),
                    borderSide: BorderSide(color: Colors.white.withValues(alpha: 0.15))),
                  focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(10),
                    borderSide: BorderSide(color: Colors.white.withValues(alpha: 0.35))),
                  isDense: true,
                  contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
                ),
              ),
              const SizedBox(height: 8),
            ],
          ],
        ),
      ),
    );
  }

  /// 通话中内容：实时语音气泡
  Widget _buildConnectedContent(String transcript, ColorScheme cs) {
    return Flexible(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (transcript.isNotEmpty) ...[
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                decoration: BoxDecoration(
                  color: Colors.white.withValues(alpha: 0.07),
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(color: Colors.white.withValues(alpha: 0.06)),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    SizedBox(width: 18, height: 18, child: _AudioWaveIndicator()),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(transcript, style: TextStyle(color: Colors.white.withValues(alpha: 0.88), fontSize: 14, height: 1.4)),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
            ],
          ],
        ),
      ),
    );
  }

  /// 振铃阶段底部操作：挂断 / 接听 [回复]（拨号中只显示挂断）
  Widget _buildRingingActions(bool replyEnabled, ColorScheme cs, bool isOutgoing) {
    // 拨号中只显示挂断按钮
    if (isOutgoing) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            _buildActionButton(icon: Icons.call_end, label: "挂断", bgColor: Colors.red[500]!, onTap: _hangUp, isRed: true),
          ],
        ),
      );
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          // 挂断
          _buildActionButton(icon: Icons.call_end, label: "挂断", bgColor: Colors.red[500]!, onTap: _hangUp, isRed: true),
          const SizedBox(width: 28),
          // 接听
          _buildActionButton(icon: Icons.call, label: "接听", bgColor: Colors.green[500]!, onTap: _answerCall),
          if (replyEnabled) ...[
            const SizedBox(width: 28),
            // 回复
            _buildActionButton(icon: Icons.reply, label: "回复", bgColor: cs.primary, onTap: _sendReply),
          ],
        ],
      ),
    );
  }

  /// 通话中底部操作：静音 / 免提 / 挂断
  Widget _buildConnectedActions(ColorScheme cs) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          _buildActionButton(icon: _isMuted ? Icons.mic_off : Icons.mic,
            label: _isMuted ? "取消静音" : "静音", bgColor: Colors.white.withValues(alpha: 0.12),
            onTap: () => setState(() => _isMuted = !_isMuted)),
          const SizedBox(width: 24),
          _buildActionButton(icon: _isSpeakerOn ? Icons.volume_up : Icons.volume_off,
            label: _isSpeakerOn ? "免提" : "听筒", bgColor: Colors.white.withValues(alpha: 0.12),
            onTap: () => setState(() => _isSpeakerOn = !_isSpeakerOn)),
          const SizedBox(width: 24),
          _buildActionButton(icon: Icons.call_end, label: "挂断", bgColor: Colors.red[500]!, onTap: _hangUp, isRed: true),
        ],
      ),
    );
  }

  /// 统一的圆形操作按钮
  Widget _buildActionButton({
    required IconData icon,
    required String label,
    required Color bgColor,
    required VoidCallback onTap,
    bool isRed = false,
  }) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 50, height: 50,
            decoration: BoxDecoration(
              shape: BoxShape.circle, color: bgColor,
              boxShadow: isRed ? [BoxShadow(color: Colors.red.withValues(alpha: 0.3), blurRadius: 10, spreadRadius: 1)] : null,
            ),
            child: Icon(icon, color: isRed ? Colors.white : Colors.white70, size: 23),
          ),
          const SizedBox(height: 5),
          Text(label, style: TextStyle(color: Colors.white.withValues(alpha: 0.55), fontSize: 11)),
        ],
      ),
    );
  }
}

/// 其他 Agent 拨打本 Agent 虚拟号：先让用户选择接听或代接。
Future<void> showPeerAgentIncomingCallDialog({
  required BuildContext context,
  required Map<String, dynamic> payload,
  required void Function(String action) onRespond,
}) {
  return showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (BuildContext ctx) => _PeerAgentIncomingBody(
      payload: payload,
      onRespond: onRespond,
    ),
  );
}

// ============================================================================
// 3. 微信风格全屏语音通话界面（接通后使用）
// ============================================================================

/// 微信风格的语音通话全屏界面。
///
/// 模仿微信语音通话 UI 设计：
/// - 深色渐变背景（沉浸式）
/// - 顶部：对方名称 + 通话状态 + 计时
/// - 中央：大圆形头像 + 光晕效果
/// - 头像下方：当前说话内容气泡（可选）
/// - 底部操作栏：静音 | 免提 | 挂断（红色大按钮）
class WeChatVoiceCallScreen extends StatefulWidget {
  const WeChatVoiceCallScreen({
    super.key,
    required this.callerName,
    required this.onHangUp,
    this.callerAvatar,
    this.initialElapsedSeconds = 0,
    this.currentTranscript,
    this.isIncoming = false,
    this.onMuteToggle,
    this.onSpeakerToggle,
    this.onReply,
  });

  /// 对方显示名称
  final String callerName;
  /// 对方头像 Widget（可选，默认用 Agent 图标）
  final Widget? callerAvatar;
  /// 初始已通话秒数
  final int initialElapsedSeconds;
  /// 当前 Agent 正在说的文字内容（实时更新）
  final String? currentTranscript;
  /// 是否为来电方向（影响顶部文案）
  final bool isIncoming;
  /// 挂断回调
  final VoidCallback onHangUp;
  /// 静音切换回调（可选，不传则不显示静音按钮）
  final VoidCallback? onMuteToggle;
  /// 免提切换回调
  final VoidCallback? onSpeakerToggle;
  /// 回复/发消息回调（可选）
  final void Function(String reply)? onReply;

  @override
  State<WeChatVoiceCallScreen> createState() => _WeChatVoiceCallScreenState();
}

class _WeChatVoiceCallScreenState extends State<WeChatVoiceCallScreen> {
  int _elapsedSeconds = 0;
  Timer? _callTimer;
  bool _isMuted = false;
  bool _isSpeakerOn = true;
  bool _showActions = true; // 点击头像区域可切换底部操作栏显隐

  @override
  void initState() {
    super.initState();
    _elapsedSeconds = widget.initialElapsedSeconds;
    _startCallTimer();
  }

  void _startCallTimer() {
    _callTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (mounted) {
        setState(() => _elapsedSeconds++);
      }
    });
  }

  String get _formattedDuration {
    final min = _elapsedSeconds ~/ 60;
    final sec = _elapsedSeconds % 60;
    return "$min:${sec.toString().padLeft(2, '0')}";
  }

  @override
  void dispose() {
    _callTimer?.cancel();
    super.dispose();
  }

  void _toggleMute() {
    setState(() => _isMuted = !_isMuted);
    widget.onMuteToggle?.call();
  }

  void _toggleSpeaker() {
    setState(() => _isSpeakerOn = !_isSpeakerOn);
    widget.onSpeakerToggle?.call();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      // 微信风格的深色渐变背景
      body: Container(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [
              Color(0xFF1A1A2E), // 深蓝黑
              Color(0xFF16213E), // 暗蓝
              Color(0xFF0F3460), // 中蓝
            ],
          ),
        ),
        child: SafeArea(
          child: Column(
            children: [
              // ====== 顶部：名称 + 状态 + 计时 ======
              _buildTopBar(),

              const Spacer(flex: 2),

              // ====== 中央：大头像 + 光晕 ======
              _buildAvatarSection(),

              const Spacer(flex: 2),

              // ====== 当前对话内容气泡（Agent 正在说） ======
              if (widget.currentTranscript != null &&
                  widget.currentTranscript!.isNotEmpty)
                _buildSpeechBubble(),

              if (widget.currentTranscript != null &&
                  widget.currentTranscript!.isNotEmpty)
                const SizedBox(height: 20),

              // ====== 底部操作栏 ======
              _buildBottomActionBar(),
            ],
          ),
        ),
      ),
    );
  }

  /// 顶部栏：返回/最小化 + 名称 + 通话状态计时
  Widget _buildTopBar() {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Row(
        children: [
          // 最小化/返回按钮
          GestureDetector(
            onTap: () {}, // TODO: 最小化到悬浮窗
            child: Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: Colors.white.withValues(alpha: 0.1),
              ),
              child: const Icon(
                Icons.keyboard_arrow_down,
                color: Colors.white,
                size: 24,
              ),
            ),
          ),
          const Spacer(),
          // 名称 + 状态
          Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                widget.callerName,
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 18,
                  fontWeight: FontWeight.w500,
                ),
              ),
              Text(
                _isMuted
                    ? VirtualPhoneUiLabels.wechatCallStatusMuted
                    : "${VirtualPhoneUiLabels.wechatCallStatusConnected} $_formattedDuration",
                style: TextStyle(
                  color: Colors.white.withValues(alpha: 0.7),
                  fontSize: 13,
                ),
              ),
            ],
          ),
          const Spacer(),
          // 占位保持对称
          const SizedBox(width: 40),
        ],
      ),
    );
  }

  /// 中央大头像区域 —— 模仿微信的大圆形头像 + 外圈光晕
  Widget _buildAvatarSection() {
    return GestureDetector(
      onTap: () {
        setState(() => _showActions = !_showActions);
      },
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // 外层光晕
          Container(
            width: 140,
            height: 140,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: RadialGradient(
                colors: [
                  Colors.blueAccent.withValues(alpha: 0.25),
                  Colors.blueAccent.withValues(alpha: 0.05),
                ],
              ),
            ),
            child: Container(
              margin: const EdgeInsets.all(4),
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(
                  color: Colors.white.withValues(alpha: 0.15),
                  width: 2,
                ),
              ),
              // 头像内容
              child: widget.callerAvatar ??
                  Icon(
                    Icons.smart_toy_rounded,
                    size: 64,
                    color: Colors.blueAccent[200],
                  ),
            ),
          ),
          const SizedBox(height: 24),
          // 网络质量/加密提示（微信风格小字）
          Text(
            "端到端加密通话",
            style: TextStyle(
              color: Colors.white.withValues(alpha: 0.35),
              fontSize: 11,
              letterSpacing: 0.5,
            ),
          ),
        ],
      ),
    );
  }

  /// Agent 当前正在说的内容 —— 类似微信语音转文字气泡
  Widget _buildSpeechBubble() {
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 32),
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: Colors.white.withValues(alpha: 0.06),
        ),
      ),
      constraints: const BoxConstraints(maxWidth: 320),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          // 声波动画图标
          SizedBox(
            width: 20,
            height: 20,
            child: _AudioWaveIndicator(),
          ),
          const SizedBox(width: 10),
          // 文字内容
          Flexible(
            child: Text(
              widget.currentTranscript ?? "",
              style: TextStyle(
                color: Colors.white.withValues(alpha: 0.9),
                fontSize: 15,
                height: 1.4,
              ),
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }

  /// 底部操作栏 —— 静免 | 免提 | 挂断（模仿微信布局）
  Widget _buildBottomActionBar() {
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 250),
      child: _showActions
          ? Padding(
              key: const ValueKey("actions_visible"),
              padding: const EdgeInsets.only(left: 24, right: 24, bottom: 36, top: 8),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                children: [
                  // ---- 静音按钮 ----
                  _buildCallActionButton(
                    icon: _isMuted ? Icons.mic_off : Icons.mic,
                    label: _isMuted ? "取消静音" : "静音",
                    isActive: !_isMuted,
                    isHighlight: false,
                    onTap: widget.onMuteToggle != null ? _toggleMute : null,
                  ),

                  // ---- 免提/扬声器按钮 ----
                  _buildCallActionButton(
                    icon: _isSpeakerOn ? Icons.volume_up : Icons.phone_android,
                    label: _isSpeakerOn
                        ? VirtualPhoneUiLabels.wechatCallSpeakerOn
                        : VirtualPhoneUiLabels.wechatCallSpeakerOff,
                    isActive: _isSpeakerOn,
                    isHighlight: false,
                    onTap: _toggleSpeaker,
                  ),

                  // ---- 挂断按钮（红色突出） -----
                  _buildCallActionButton(
                    icon: Icons.call_end,
                    label: VirtualPhoneUiLabels.wechatCallHangUp,
                    isActive: true,
                    isHighlight: true,
                    onTap: widget.onHangUp,
                    highlightSize: 64,
                  ),
                ],
              ),
            )
          : Padding(
              key: const ValueKey("actions_hidden"),
              padding: const EdgeInsets.only(bottom: 48),
              child: Opacity(
                opacity: 0.4,
                child: Text(
                  "点击头像显示操作",
                  style: TextStyle(color: Colors.white.withValues(alpha: 0.5), fontSize: 12),
                ),
              ),
            ),
    );
  }

  /// 单个圆形操作按钮
  Widget _buildCallActionButton({
    required IconData icon,
    required String label,
    required bool isActive,
    required bool isHighlight,
    VoidCallback? onTap,
    double highlightSize = 56,
  }) {
    final bgColor = isHighlight
        ? Colors.red[500]
        : (isActive
            ? Colors.white.withValues(alpha: 0.15)
            : Colors.white.withValues(alpha: 0.06));
    final iconColor =
        isHighlight ? Colors.white : (isActive ? Colors.white : Colors.white38);

    final double size = isHighlight ? highlightSize : 56;

    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: size,
            height: size,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: bgColor,
              boxShadow: isHighlight
                  ? [
                      BoxShadow(
                        color: Colors.red.withValues(alpha: 0.3),
                        blurRadius: 14,
                        spreadRadius: 2,
                      ),
                    ]
                  : null,
            ),
            child: Icon(icon, color: iconColor, size: isHighlight ? 28 : 24),
          ),
          const SizedBox(height: 8),
          Text(
            label,
            style: TextStyle(
              color: isActive ? Colors.white70 : Colors.white38,
              fontSize: 12,
            ),
          ),
        ],
      ),
    );
  }
}

/// 声波动画指示器 —— 模仿语音输入时的波形跳动
class _AudioWaveIndicator extends StatefulWidget {
  @override
  State<_AudioWaveIndicator> createState() => _AudioWaveIndicatorState();
}

class _AudioWaveIndicatorState extends State<_AudioWaveIndicator>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1000),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) => Row(
        mainAxisAlignment: MainAxisAlignment.center,
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: List.generate(4, (i) {
          final delay = i * 0.15;
          final value = ((_controller.value - delay).clamp(0.0, 1.0) * 2 - 1).abs();
          return Container(
            width: 3,
            height: 6 + value * 10,
            margin: const EdgeInsets.symmetric(horizontal: 1.5),
            decoration: BoxDecoration(
              color: Colors.blueAccent[200],
              borderRadius: BorderRadius.circular(2),
            ),
          );
        }),
      ),
    );
  }
}

// ============================================================================
// 4. 用户呼叫 Agent 的通话过程全屏页面（振铃→连接中→微信风格通话）
// ============================================================================

/// 用户主动呼叫 Agent 后的通话过程页面。
/// 振铃/连接中使用原有 UI，接通后自动切换为 [WeChatVoiceCallScreen] 微信风格。
class UserCallAgentScreen extends StatefulWidget {
  const UserCallAgentScreen({
    super.key,
    required this.initialStatus,
    required this.toActorId,
    this.toPhone,
    this.userMessage,
    required this.onHangUp,
  });

  /// 初始状态："ringing" | "connecting" | "connected"
  final String initialStatus;
  final String toActorId;
  final String? toPhone;
  final String? userMessage;
  final VoidCallback onHangUp;

  @override
  State<UserCallAgentScreen> createState() => _UserCallAgentScreenState();
}

class _UserCallAgentScreenState extends State<UserCallAgentScreen>
    with TickerProviderStateMixin {
  String _currentStatus = "";
  Timer? _callTimer;
  int _elapsedSeconds = 0;
  late AnimationController _pulseController;
  AudioPlayer? _ringtonePlayer;

  @override
  void initState() {
    super.initState();
    _currentStatus = widget.initialStatus;

    // 振铃脉冲动画
    _pulseController = AnimationController(
      duration: const Duration(milliseconds: 800),
      vsync: this,
    );

    if (_currentStatus == "ringing") {
      _pulseController.repeat(reverse: true);
      _playRingtone();
    }

    // 监听状态变化
    _setupStatusListener();
  }

  void _setupStatusListener() {
    // TODO: 通过 WebSocket 监听服务端推送的状态变更事件
    // 当收到 status: "connecting" 时更新 UI
    // 当收到 status: "connected" 时开始计时、停止振铃
  }

  Future<void> _playRingtone() async {
    try {
      final player = AudioPlayer();
      _ringtonePlayer = player;
      await player.setSource(AssetSource("sounds/ringtone.mp3"));
      await player.setReleaseMode(ReleaseMode.loop);
      await player.resume();
    } catch (_) {}
  }

  void _stopRingtone() {
    _ringtonePlayer?.stop().catchError((_) {});
    _ringtonePlayer?.dispose().catchError((_) {});
    _ringtonePlayer = null;
  }

  /// 外部调用此方法更新状态（由 WS 消息驱动）
  void updateStatus(String newStatus) {
    if (!mounted || newStatus == _currentStatus) return;
    setState(() {
      _currentStatus = newStatus;
    });

    if (newStatus == "connecting") {
      _stopRingtone();
      _pulseController.stop();
    } else if (newStatus == "connected") {
      _stopRingtone();
      _pulseController.stop();
      _startCallTimer();
    } else if (newStatus == "ended") {
      _stopRingtone();
      _pulseController.stop();
      _callTimer?.cancel();
    }
  }

  void _startCallTimer() {
    _elapsedSeconds = 0;
    _callTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) {
        timer.cancel();
        return;
      }
      setState(() => _elapsedSeconds++);
    });
  }

  String get _formattedDuration {
    final min = _elapsedSeconds ~/ 60;
    final sec = _elapsedSeconds % 60;
    return "${min.toString().padLeft(2, '0')}:${sec.toString().padLeft(2, '0')}";
  }

  @override
  void dispose() {
    _stopRingtone();
    _callTimer?.cancel();
    _pulseController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;

    return PopScope(
      canPop: false,
      child: Scaffold(
        backgroundColor: cs.surface,
        body: SafeArea(
          child: Column(
            children: [
              // ---- 顶部状态栏 ----
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 16),
                child: Text(
                  VirtualPhoneUiLabels.callStatusLabel(_currentStatus),
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        color: cs.onSurfaceVariant,
                        letterSpacing: 0.5,
                      ),
                ),
              ),

              const Spacer(),

              // ---- 中央区域根据状态不同而变化 ----
              _buildCentralArea(),

              const Spacer(),

              // ---- 底部操作区 ----
              Padding(
                padding: const EdgeInsets.only(bottom: 48),
                child: _buildBottomActions(),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildCentralArea() {
    switch (_currentStatus) {
      case "ringing":
        return _buildRingingView();
      case "connecting":
        return _buildConnectingView();
      case "connected":
        return _buildConnectedView();
      default:
        return _buildEndedView();
    }
  }

  /// 振铃中视图：大图标 + 脉冲动画 + "正在呼叫 Agent..."
  Widget _buildRingingView() {
    final cs = Theme.of(context).colorScheme;
    return AnimatedBuilder(
      animation: _pulseController,
      builder: (context, child) => Transform.scale(
        scale: 1.0 + (_pulseController.value - 0.5) * 0.15,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // Avatar circle
            Container(
              width: 120,
              height: 120,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: cs.primaryContainer.withValues(alpha: 0.6),
                border: Border.all(
                  color: cs.primary.withValues(alpha: 0.3),
                  width: 2,
                ),
                boxShadow: [
                  BoxShadow(
                    color: cs.primary.withValues(alpha: 0.15),
                    blurRadius: 24,
                    spreadRadius: 4,
                  ),
                ],
              ),
              child: Icon(
                Icons.smart_toy,
                size: 56,
                color: cs.primary,
              ),
            ),
            const SizedBox(height: 24),
            Text(
              widget.toPhone != null && widget.toPhone!.isNotEmpty
                  ? "Agent (${widget.toPhone})"
                  : "你的 Agent",
              style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
            ),
            const SizedBox(height: 8),
            Text(
              "正在呼叫…",
              style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                    color: cs.onSurfaceVariant,
                  ),
            ),
          ],
        ),
      ),
    );
  }

  /// 连接中视图：转圈加载
  Widget _buildConnectingView() {
    final cs = Theme.of(context).colorScheme;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox(
          width: 100,
          height: 100,
          child: CircularProgressIndicator(
            strokeWidth: 3,
            color: cs.primary,
          ),
        ),
        const SizedBox(height: 24),
        Text(
          VirtualPhoneUiLabels.ringingPhaseConnecting,
          style: Theme.of(context).textTheme.titleMedium?.copyWith(
                color: cs.onSurfaceVariant,
              ),
        ),
        const SizedBox(height: 8),
        Text(
          "Agent 正在接听，请稍候",
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: cs.outline,
              ),
        ),
      ],
    );
  }

  /// 通话中视图：使用微信风格全屏语音通话界面
  Widget _buildConnectedView() {
    final callerName = widget.toPhone != null && widget.toPhone!.isNotEmpty
        ? "你的 Agent (${widget.toPhone})"
        : "你的 Agent";

    return WeChatVoiceCallScreen(
      callerName: callerName,
      onHangUp: () {
        _stopRingtone();
        _callTimer?.cancel();
        widget.onHangUp();
      },
      initialElapsedSeconds: _elapsedSeconds,
      currentTranscript: widget.userMessage,
      onSpeakerToggle: () {},
      onMuteToggle: () {},
    );
  }

  /// 已结束视图
  Widget _buildEndedView() {
    final cs = Theme.of(context).colorScheme;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(Icons.call_end, size: 56, color: cs.outline),
        const SizedBox(height: 16),
        Text(
          VirtualPhoneUiLabels.callStatusLabel("ended"),
          style: Theme.of(context).textTheme.titleLarge,
        ),
        if (_elapsedSeconds > 0) ...[
          const SizedBox(height: 8),
          Text(
            "通话时长 $_formattedDuration",
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: cs.outline,
                ),
          ),
        ],
      ],
    );
  }

  Widget _buildBottomActions() {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        // 挂断按钮
        GestureDetector(
          onTap: () {
            _stopRingtone();
            _callTimer?.cancel();
            widget.onHangUp();
          },
          child: Container(
            width: 68,
            height: 68,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: Colors.red,
              boxShadow: [
                BoxShadow(
                  color: Colors.red.withValues(alpha: 0.35),
                  blurRadius: 12,
                  offset: const Offset(0, 4),
                ),
              ],
            ),
            child: const Icon(Icons.call_end, color: Colors.white, size: 30),
          ),
        ),
      ],
    );
  }
}

// ============================================================================
// 4. 内部工具函数（原有逻辑保留）
// ============================================================================

Uint8List? _decodeMp3FromPayload(Map<String, dynamic> payload) {
  final Object? tts = payload["tts"];
  if (tts is! Map) return null;
  final Map<dynamic, dynamic> m = tts;
  final String fmt = m["format"]?.toString() ?? "";
  final String? b64 = m["base64"]?.toString();
  if (b64 == null || b64.isEmpty || fmt != "mp3") return null;
  try {
    return base64Decode(b64);
  } catch (_) {
    return null;
  }
}

class _PeerAgentIncomingBody extends StatefulWidget {
  const _PeerAgentIncomingBody({
    required this.payload,
    required this.onRespond,
  });

  final Map<String, dynamic> payload;
  final void Function(String action) onRespond;

  @override
  State<_PeerAgentIncomingBody> createState() => _PeerAgentIncomingBodyState();
}

class _PeerAgentIncomingBodyState extends State<_PeerAgentIncomingBody> {
  AudioPlayer? _player;
  String? _audioError;
  bool _responded = false;

  @override
  void initState() {
    super.initState();
    _startPlayback();
  }

  Future<void> _startPlayback() async {
    final Uint8List? bytes = _decodeMp3FromPayload(widget.payload);
    if (bytes == null || !mounted) return;
    final AudioPlayer player = AudioPlayer();
    _player = player;
    try {
      await player.play(BytesSource(bytes, mimeType: "audio/mpeg"));
    } catch (e) {
      await player.dispose();
      if (mounted) {
        setState(() {
          _player = null;
          _audioError = e.toString();
        });
      }
    }
  }

  @override
  void dispose() {
    unawaited(_player?.dispose());
    super.dispose();
  }

  void _pick(String action) {
    if (_responded) return;
    _responded = true;
    widget.onRespond(action);
    if (mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final Map<String, dynamic> p = widget.payload;
    final String fromPhone = p["fromPhone"]?.toString() ?? "";
    final String transcript = p["transcript"]?.toString() ?? "";
    final int ringSec = (p["ringTimeoutSec"] as num?)?.toInt() ?? 50;
    final String callerLabel = VirtualPhoneUiLabels.incomingCallerLabel(
      direction: "agent_to_agent",
      fromPhone: fromPhone,
    );

    return AlertDialog(
      icon: const Icon(Icons.phone_in_talk, size: 36),
      title: Text(VirtualPhoneUiLabels.peerIncomingTitle),
      content: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(
              VirtualPhoneUiLabels.peerIncomingHint,
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: 10),
            Text(
              callerLabel,
              style: TextStyle(
                color: Theme.of(context).colorScheme.primary,
                fontWeight: FontWeight.w600,
              ),
            ),
            if (ringSec > 0) ...<Widget>[
              const SizedBox(height: 4),
              Text(
                "约 ${ringSec}s 未操作将由 Agent 自动代接",
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: Theme.of(context).colorScheme.outline,
                    ),
              ),
            ],
            const SizedBox(height: 12),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Theme.of(context)
                    .colorScheme
                    .surfaceContainerHighest
                    .withValues(alpha: 0.5),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Text(
                transcript.isEmpty ? "（无语音文字稿）" : transcript,
                style: Theme.of(context).textTheme.bodyLarge,
              ),
            ),
            if (_audioError != null) ...<Widget>[
              const SizedBox(height: 8),
              Text(
                "播放失败：$_audioError",
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: Theme.of(context).colorScheme.error,
                    ),
              ),
            ],
          ],
        ),
      ),
      actions: <Widget>[
        TextButton(
          onPressed: () => _pick("decline"),
          child: Text(VirtualPhoneUiLabels.peerDecline),
        ),
        FilledButton.tonal(
          onPressed: () => _pick("agent_takeover"),
          child: Text(VirtualPhoneUiLabels.peerDelegate),
        ),
        FilledButton(
          onPressed: () => _pick("accept"),
          child: Text(VirtualPhoneUiLabels.peerAccept),
        ),
      ],
    );
  }
}


// ============================================================================
// 工具函数
// ============================================================================
