import "dart:async";

import "package:flutter/foundation.dart";
import "package:permission_handler/permission_handler.dart";
import "package:speech_to_text/speech_to_text.dart" as stt;

/// 语音唤醒 — 持续监听唤醒词，命中后触发回调
class VoiceWakeService {
  VoiceWakeService._();

  static final VoiceWakeService instance = VoiceWakeService._();

  final stt.SpeechToText _speech = stt.SpeechToText();

  bool _enabled = false;
  bool _initialized = false;
  void Function()? _onWake;
  void Function(String partial)? _onPartial;

  /// 默认可说「小助手」「嘿助手」等
  static const List<String> defaultWakePhrases = <String>[
    "小助手",
    "嘿助手",
    "你好助手",
    "助手你好",
    "嘿 agent",
    "hi agent",
  ];

  List<String> wakePhrases = List<String>.from(defaultWakePhrases);

  bool get isEnabled => _enabled;

  /// 展示用唤醒词（取第一个中文词）
  static String get displayWakePhrase => defaultWakePhrases.first;

  bool matchesWakePhrase(String text) {
    final String normalized = text
        .replaceAll(RegExp(r"\s+"), "")
        .toLowerCase();
    if (normalized.isEmpty) return false;
    for (final String phrase in wakePhrases) {
      final String p = phrase.replaceAll(RegExp(r"\s+"), "").toLowerCase();
      if (p.isNotEmpty && normalized.contains(p)) return true;
    }
    return false;
  }

  Future<bool> start({
    required void Function() onWake,
    void Function(String partial)? onPartial,
  }) async {
    if (_enabled) return true;

    final PermissionStatus mic = await Permission.microphone.request();
    if (mic != PermissionStatus.granted) {
      debugPrint("[VoiceWake] 麦克风权限被拒绝");
      return false;
    }

    if (!_initialized) {
      _initialized = await _speech.initialize(
        onStatus: _onSpeechStatus,
        onError: (Object error) {
          debugPrint("[VoiceWake] $error");
        },
      );
      if (!_initialized) return false;
    }

    _onWake = onWake;
    _onPartial = onPartial;
    _enabled = true;
    await _startListenSession();
    return true;
  }

  Future<void> stop() async {
    _enabled = false;
    _onWake = null;
    _onPartial = null;
    if (_speech.isListening) {
      await _speech.cancel();
    }
  }

  void _onSpeechStatus(String status) {
    if (!_enabled) return;
    if (status == "done" || status == "notListening") {
      Future<void>.delayed(const Duration(milliseconds: 350), () {
        if (_enabled) unawaited(_startListenSession());
      });
    }
  }

  Future<void> _startListenSession() async {
    if (!_enabled || _speech.isListening) return;

    await _speech.listen(
      onResult: (dynamic result) {
        final String text = (result.recognizedWords as String?)?.trim() ?? "";
        if (text.isEmpty) return;
        _onPartial?.call(text);
        if (matchesWakePhrase(text)) {
          _enabled = false;
          unawaited(_speech.stop());
          _onWake?.call();
        }
      },
      partialResults: true,
      listenFor: const Duration(seconds: 45),
      pauseFor: const Duration(seconds: 2),
      localeId: "zh_CN",
      cancelOnError: false,
      listenMode: stt.ListenMode.search,
    );
  }
}
