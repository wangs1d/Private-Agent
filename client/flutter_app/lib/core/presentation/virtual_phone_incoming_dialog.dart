import "dart:async";
import "dart:convert";
import "dart:io";
import "dart:typed_data";

import "package:audioplayers/audioplayers.dart";
import "package:flutter/material.dart";
import "package:path_provider/path_provider.dart";

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
    final String ringLabel = ring == "reminder" ? "语音提醒" : "来电";

    final String callerLabel = isAgentToUser
        ? (fromPhone.isNotEmpty ? "Agent $fromPhone" : "你的 Agent")
        : (fromPhone.isNotEmpty ? fromPhone : "未知号码");

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
      title: Text(isAgentToUser ? "📞 Agent 来电" : ringLabel),
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
            if (!isAgentToUser && toPhone != "—") ...<Widget>[
              const SizedBox(height: 2),
              Text("本机：$toPhone", style: Theme.of(context).textTheme.bodySmall),
            ],
            if (ringLabel != "来电") ...<Widget>[
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
