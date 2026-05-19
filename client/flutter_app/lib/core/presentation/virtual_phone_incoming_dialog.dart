import "dart:async";
import "dart:convert";
import "dart:io";
import "dart:typed_data";

import "package:audioplayers/audioplayers.dart";
import "package:flutter/material.dart";
import "package:path_provider/path_provider.dart";

/// 处理 WebSocket `agent.phone.incoming`：展示来电信息并尝试播放服务端 TTS（mp3 base64）。
Future<void> showVirtualPhoneIncomingDialog({
  required BuildContext context,
  required Map<String, dynamic> payload,
}) {
  return showDialog<void>(
    context: context,
    barrierDismissible: true,
    builder: (BuildContext ctx) => _VirtualPhoneIncomingBody(payload: payload),
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
  const _VirtualPhoneIncomingBody({required this.payload});

  final Map<String, dynamic> payload;

  @override
  State<_VirtualPhoneIncomingBody> createState() =>
      _VirtualPhoneIncomingBodyState();
}

class _VirtualPhoneIncomingBodyState extends State<_VirtualPhoneIncomingBody> {
  AudioPlayer? _player;
  File? _tempFile;
  String? _audioError;

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
    } catch (e) {
      try {
        final Directory dir = await getTemporaryDirectory();
        final File f = File(
          "${dir.path}/virtual_phone_${DateTime.now().millisecondsSinceEpoch}.mp3",
        );
        await f.writeAsBytes(bytes, flush: true);
        _tempFile = f;
        await player.play(DeviceFileSource(f.path));
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

  @override
  Widget build(BuildContext context) {
    final Map<String, dynamic> p = widget.payload;
    final String fromPhone = p["fromPhone"]?.toString() ?? "—";
    final String toPhone = p["toPhone"]?.toString() ?? "—";
    final String transcript = p["transcript"]?.toString() ?? "";
    final String ring = p["ringStyle"]?.toString() ?? "peer";
    final String ringLabel = ring == "reminder" ? "提醒" : "联络";
    final Object? tts = p["tts"];
    String? skipReason;
    if (tts is Map && tts["skippedReason"] != null) {
      skipReason = tts["skippedReason"]?.toString();
    }

    return AlertDialog(
      icon: const Icon(Icons.phone_in_talk, size: 36),
      title: const Text("虚拟来电"),
      content: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text("主叫线路 $fromPhone", style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 4),
            Text("本机号码 $toPhone"),
            Text("类型：$ringLabel"),
            const SizedBox(height: 12),
            Text(
              transcript.isEmpty ? "（无播报正文）" : transcript,
              style: Theme.of(context).textTheme.bodyLarge,
            ),
            if (skipReason != null && skipReason.isNotEmpty) ...<Widget>[
              const SizedBox(height: 12),
              Text(
                "未附带 TTS：$skipReason",
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
          ],
        ),
      ),
      actions: <Widget>[
        TextButton(
          onPressed: _hangUp,
          child: const Text("挂断"),
        ),
      ],
    );
  }
}
