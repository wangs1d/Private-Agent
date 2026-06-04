import "dart:async";
import "dart:convert";
import "dart:io";
import "dart:typed_data";

import "package:audioplayers/audioplayers.dart";
import "package:flutter/material.dart";
import "package:path_provider/path_provider.dart";

import "virtual_phone_ui_labels.dart";

typedef PhoneReplyCallback = void Function(String replyText);

Future<void> showVirtualPhoneIncomingDialog({
  required BuildContext context,
  required Map<String, dynamic> payload,
  PhoneReplyCallback? onReply,
}) {
  return showDialog<void>(
    context: context,
    barrierDismissible: true,
    builder: (BuildContext ctx) => _VirtualPhoneIncomingBody(
      payload: payload,
      onReply: onReply,
    ),
  );
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

/// 简化版网络电话悬浮按钮（用于通话中显示）
class PhoneCallFloatingButton extends StatefulWidget {
  const PhoneCallFloatingButton({
    super.key,
    required this.status,
    required this.onHangUp,
    this.toActorId,
  });

  /// 通话状态: ringing, connected, ended
  final String status;
  final VoidCallback onHangUp;
  final String? toActorId;

  @override
  State<PhoneCallFloatingButton> createState() => _PhoneCallFloatingButtonState();
}

class _PhoneCallFloatingButtonState extends State<PhoneCallFloatingButton> {
  bool _isSpeakerOn = false;

  String get _statusText {
    switch (widget.status) {
      case "incoming":
        return VirtualPhoneUiLabels.floatingIncoming(widget.toActorId);
      case "ringing":
        return widget.toActorId != null && widget.toActorId!.isNotEmpty
            ? "${VirtualPhoneUiLabels.callStatusLabel("ringing")} · ${widget.toActorId}"
            : VirtualPhoneUiLabels.callStatusLabel("ringing");
      case "connected":
        return VirtualPhoneUiLabels.callStatusLabel("connected");
      case "ended":
        return VirtualPhoneUiLabels.callStatusLabel("ended");
      default:
        return "通话中";
    }
  }

  IconData get _statusIcon {
    switch (widget.status) {
      case "incoming":
        return Icons.phone_callback;
      case "ringing":
        return Icons.phone_in_talk;
      case "connected":
        return Icons.phone;
      case "ended":
        return Icons.phone_disabled;
      default:
        return Icons.phone;
    }
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final bool isRinging = widget.status == "ringing" || widget.status == "incoming";

    return Positioned(
      right: 16,
      bottom: 100,
      child: Material(
        elevation: 8,
        borderRadius: BorderRadius.circular(28),
        color: cs.primaryContainer,
        child: InkWell(
          onTap: () {
            // 点击悬浮按钮可以显示更多信息或操作
          },
          borderRadius: BorderRadius.circular(28),
          child: Container(
            constraints: const BoxConstraints(
              minWidth: 56,
              maxWidth: 200,
            ),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                // 状态图标
                Container(
                  width: 36,
                  height: 36,
                  decoration: BoxDecoration(
                    color: isRinging ? cs.primary : Colors.green,
                    shape: BoxShape.circle,
                  ),
                  child: Icon(
                    _statusIcon,
                    color: Colors.white,
                    size: 20,
                  ),
                ),
                const SizedBox(width: 10),
                // 状态文字
                Expanded(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        _statusText,
                        style: TextStyle(
                          color: cs.onPrimaryContainer,
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      if (widget.status == "connected")
                        Text(
                          "00:00",
                          style: TextStyle(
                            color: cs.onPrimaryContainer.withOpacity(0.7),
                            fontSize: 11,
                          ),
                        ),
                    ],
                  ),
                ),
                // 扬声器按钮
                IconButton(
                  icon: Icon(
                    _isSpeakerOn ? Icons.volume_up : Icons.volume_down,
                    color: _isSpeakerOn ? cs.primary : cs.onPrimaryContainer,
                    size: 20,
                  ),
                  onPressed: () {
                    setState(() {
                      _isSpeakerOn = !_isSpeakerOn;
                    });
                    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
                      SnackBar(
                        content: Text(_isSpeakerOn ? "已开启扬声器" : "已关闭扬声器"),
                        duration: const Duration(seconds: 1),
                      ),
                    );
                  },
                  tooltip: _isSpeakerOn ? "关闭扬声器" : "开启扬声器",
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(
                    minWidth: 36,
                    minHeight: 36,
                  ),
                ),
                // 挂断按钮
                IconButton(
                  icon: const Icon(
                    Icons.call_end,
                    color: Colors.white,
                    size: 20,
                  ),
                  onPressed: widget.onHangUp,
                  tooltip: "挂断",
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(
                    minWidth: 36,
                    minHeight: 36,
                  ),
                  style: IconButton.styleFrom(
                    backgroundColor: Colors.red,
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
  bool _isPlaying = false;
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
      if (mounted) setState(() => _isPlaying = true);
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
                    .withOpacity(0.5),
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

class _VirtualPhoneIncomingBody extends StatefulWidget {
  const _VirtualPhoneIncomingBody({required this.payload, this.onReply});

  final Map<String, dynamic> payload;
  final PhoneReplyCallback? onReply;

  @override
  State<_VirtualPhoneIncomingBody> createState() =>
      _VirtualPhoneIncomingBodyState();
}

class _VirtualPhoneIncomingBodyState extends State<_VirtualPhoneIncomingBody> {
  AudioPlayer? _player;
  File? _tempFile;
  String? _audioError;
  final TextEditingController _replyController = TextEditingController();
  bool _isPlaying = false;

  @override
  void initState() {
    super.initState();
    _startPlayback();
  }

  Future<void> _startPlayback() async {
    final Uint8List? bytes = _decodeMp3FromPayload(widget.payload);
    if (bytes == null || !mounted) return;
    final AudioPlayer player = AudioPlayer();
    if (!mounted) return;
    _player = player;
    try {
      await player.play(
        BytesSource(bytes, mimeType: "audio/mpeg"),
      );
      if (mounted) setState(() => _isPlaying = true);
    } catch (e) {
      try {
        final Directory dir = await getTemporaryDirectory();
        final File f = File(
          "${dir.path}/virtual_phone_${DateTime.now().millisecondsSinceEpoch}.mp3",
        );
        await f.writeAsBytes(bytes, flush: true);
        _tempFile = f;
        await player.play(DeviceFileSource(f.path));
        if (mounted) setState(() => _isPlaying = true);
      } catch (e2) {
        await player.dispose();
        final File? tmp = _tempFile;
        _tempFile = null;
        if (tmp != null) {
          try {
            if (await tmp.exists()) await tmp.delete();
          } catch (_) {}
        }
        if (mounted) {
          setState(() {
            _player = null;
            _audioError = e2.toString();
          });
        }
      }
    }
  }

  @override
  void dispose() {
    unawaited(_disposePlayer());
    _replyController.dispose();
    super.dispose();
  }

  Future<void> _disposePlayer() async {
    try {
      await _player?.stop();
    } catch (_) {}
    await _player?.dispose();
    _player = null;
    final File? f = _tempFile;
    _tempFile = null;
    if (f != null) {
      try {
        if (await f.exists()) await f.delete();
      } catch (_) {}
    }
  }

  Future<void> _hangUp() async {
    await _disposePlayer();
    if (mounted) Navigator.of(context).pop();
  }

  void _sendReply() {
    final text = _replyController.text.trim();
    if (text.isNotEmpty && widget.onReply != null) {
      widget.onReply!(text);
    }
    _hangUp();
  }

  @override
  Widget build(BuildContext context) {
    final Map<String, dynamic> p = widget.payload;
    final String direction = p["direction"]?.toString() ?? "agent_to_agent";
    final bool isAgentToUser = direction == "agent_to_user";
    final bool replyEnabled = p["replyEnabled"] == true;

    final String fromPhone = p["fromPhone"]?.toString() ?? "";
    final String toPhone = p["toPhone"]?.toString() ?? p["toUserId"]?.toString() ?? "—";
    final String transcript = p["transcript"]?.toString() ?? "";
    final String ring = p["ringStyle"]?.toString() ?? "peer";
    final String ringLabel = ring == "reminder" ? "语音提醒" : "Agent 来电";
    final String calleeLine = VirtualPhoneUiLabels.calleeAgentLine(toPhone);

    final String callerLabel = VirtualPhoneUiLabels.incomingCallerLabel(
      direction: direction,
      fromPhone: fromPhone,
    );

    final Object? tts = p["tts"];
    String? skipReason;
    if (tts is Map && tts["skippedReason"] != null) {
      skipReason = tts["skippedReason"]?.toString();
    }
    final bool hasAudio = _player != null && _audioError == null;

    return AlertDialog(
      icon: Icon(
        isAgentToUser ? Icons.smart_toy : Icons.phone_in_talk,
        size: 36,
        color: isAgentToUser ? Colors.blueAccent : null,
      ),
      title: Text(isAgentToUser ? "📞 你的 Agent 来电" : "📞 $ringLabel"),
      content: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Row(
              children: <Widget>[
                const Icon(Icons.person, size: 16),
                const SizedBox(width: 4),
                Expanded(
                  child: Text(
                    callerLabel,
                    style: TextStyle(
                      color: isAgentToUser
                          ? Colors.blueAccent
                          : Theme.of(context).colorScheme.primary,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
            if (!isAgentToUser && calleeLine.isNotEmpty) ...<Widget>[
              const SizedBox(height: 2),
              Text(calleeLine, style: Theme.of(context).textTheme.bodySmall),
            ],
            if (ring == "reminder") ...<Widget>[
              const SizedBox(height: 2),
              Text("类型：$ringLabel", style: Theme.of(context).textTheme.bodySmall),
            ],
            const SizedBox(height: 14),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.surfaceContainerHighest.withOpacity(0.5),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Text(
                transcript.isEmpty ? "（无语音内容）" : transcript,
                style: Theme.of(context).textTheme.bodyLarge,
              ),
            ),
            if (skipReason != null && skipReason.isNotEmpty) ...<Widget>[
              const SizedBox(height: 10),
              Text(
                "未附带 TTS 音频：$skipReason",
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: Theme.of(context).colorScheme.outline,
                    ),
              ),
            ],
            if (_audioError != null) ...<Widget>[
              const SizedBox(height: 8),
              Text(
                "播放失败：$_audioError",
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: Theme.of(context).colorScheme.error,
                    ),
              ),
            ],
            if (replyEnabled) ...<Widget>[
              const SizedBox(height: 14),
              TextField(
                controller: _replyController,
                maxLines: 2,
                minLines: 1,
                decoration: InputDecoration(
                  hintText: "输入回复内容（可选）…",
                  border: const OutlineInputBorder(),
                  isDense: true,
                  contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                ),
              ),
            ],
          ],
        ),
      ),
      actions: <Widget>[
        TextButton(
          onPressed: _hangUp,
          child: const Text("挂断"),
        ),
        if (hasAudio)
          FilledButton.icon(
            onPressed: _isPlaying ? null : _startPlayback,
            icon: Icon(_isPlaying ? Icons.volume_up : Icons.play_arrow),
            label: Text(_isPlaying ? "播放中…" : "接听播放"),
          )
        else
          TextButton(
            onPressed: _hangUp,
            child: const Text("确认已读"),
          ),
        if (replyEnabled)
          FilledButton.icon(
            onPressed: _sendReply,
            icon: const Icon(Icons.reply),
            label: const Text("回复"),
          ),
      ],
    );
  }
}
