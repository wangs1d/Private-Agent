import "dart:async";
import "dart:convert";
import "dart:io";

import "package:audioplayers/audioplayers.dart";
import "package:flutter/foundation.dart";
import "package:path_provider/path_provider.dart";

/// Windows 上 audioplayers_windows_plugin 的 BytesSource 会触发 native
/// 层 0xc0000005 access violation，Dart try-catch 无法捕获。
/// 统一走临时文件 + DeviceFileSource 绕过。
const bool _kWindowsSkipBytesSource = true;

/// 后台 TTS 音频播放器。
///
/// 用法：
///   1. Agent 推送 call_connecting 时调用 [TtsPlayer.playFromBase64]
///   2. 通话结束 / 用户挂断时调用 [TtsPlayer.stop] 或 [TtsPlayer.dispose]
///   3. 监听 [TtsPlayer.onCompleted] 处理播放完成事件
///
/// 设计要点：
///   - 任何时候只有一个 TTS 在播放（单例 AudioPlayer）
///   - 启动新 TTS 时会自动停掉旧的
///   - 播放完自动释放临时文件
///   - 不依赖任何 UI 组件（不弹窗、不 toast、不通知）
class TtsPlayer {
  TtsPlayer._();

  static final TtsPlayer instance = TtsPlayer._();

  AudioPlayer? _player;
  File? _tempFile;
  Completer<void>? _completionCompleter;

  /// 当前是否有 TTS 正在播放
  bool get isPlaying => _player != null;

  /// TTS 播放完成回调（正常播完 / 被 stop 都触发）
  final List<VoidCallback> _completionListeners = <VoidCallback>[];

  /// 注册播放完成监听
  void addOnCompleted(VoidCallback listener) {
    _completionListeners.add(listener);
  }

  /// 取消播放完成监听
  void removeOnCompleted(VoidCallback listener) {
    _completionListeners.remove(listener);
  }

  /// 从 base64 字符串播放 TTS
  ///
  /// [base64Str] MP3 的 base64 编码
  Future<bool> playFromBase64(String base64Str) async {
    if (base64Str.isEmpty) return false;
    try {
      final Uint8List bytes = base64Decode(base64Str);
      return await playFromBytes(bytes);
    } catch (e) {
      debugPrint("[TtsPlayer] base64 decode failed: $e");
      _fireCompletion();
      return false;
    }
  }

  /// 从字节数组播放 TTS
  Future<bool> playFromBytes(Uint8List bytes) async {
    if (bytes.isEmpty) {
      _fireCompletion();
      return false;
    }
    // 停掉旧播放
    await _disposeCurrent(silent: true);

    final AudioPlayer player = AudioPlayer();
    _player = player;
    _completionCompleter = Completer<void>();

    player.onPlayerComplete.listen((_) {
      _fireCompletion();
    });
    player.onPlayerStateChanged.listen((state) {
      if (state == PlayerState.stopped && !(_completionCompleter?.isCompleted ?? true)) {
        _fireCompletion();
      }
    });

    // Windows 上 BytesSource 会触发 native 层 0xc0000005 access violation
    // 直接走临时文件 + DeviceFileSource 绕过
    if (_kWindowsSkipBytesSource) {
      try {
        final Directory dir = await getTemporaryDirectory();
        final File f = File(
          "${dir.path}/tts_${DateTime.now().millisecondsSinceEpoch}.mp3",
        );
        await f.writeAsBytes(bytes, flush: true);
        _tempFile = f;
        await player.play(DeviceFileSource(f.path));
        return true;
      } catch (e) {
        debugPrint("[TtsPlayer] play failed: $e");
        await _disposeCurrent(silent: true);
        return false;
      }
    }

    try {
      // 非 Windows 平台优先 BytesSource
      await player.play(BytesSource(bytes, mimeType: "audio/mpeg"));
      return true;
    } catch (e) {
      try {
        final Directory dir = await getTemporaryDirectory();
        final File f = File(
          "${dir.path}/tts_${DateTime.now().millisecondsSinceEpoch}.mp3",
        );
        await f.writeAsBytes(bytes, flush: true);
        _tempFile = f;
        await player.play(DeviceFileSource(f.path));
        return true;
      } catch (e2) {
        debugPrint("[TtsPlayer] play failed: $e2");
        await _disposeCurrent(silent: true);
        return false;
      }
    }
  }

  /// 主动停止当前播放
  Future<void> stop() async {
    await _disposeCurrent(silent: false);
  }

  /// 从 URL 拉流播放（用于语音消息气泡点击重播）。
  ///
  /// [baseUrl] 服务端基础 URL（如 `http://127.0.0.1:3000`）；
  /// [mediaUrl] 服务端返回的可访问路径（如 `/agent/voice/messages/.../xxx.mp3`）。
  /// 拼接为完整 URL 后用 audioplayers 的 UrlSource 播放。
  Future<bool> playFromUrl(String fullUrl) async {
    if (fullUrl.isEmpty) {
      _fireCompletion();
      return false;
    }
    // 停掉旧播放
    await _disposeCurrent(silent: true);

    final AudioPlayer player = AudioPlayer();
    _player = player;
    _completionCompleter = Completer<void>();

    player.onPlayerComplete.listen((_) {
      _fireCompletion();
    });
    player.onPlayerStateChanged.listen((state) {
      if (state == PlayerState.stopped && !(_completionCompleter?.isCompleted ?? true)) {
        _fireCompletion();
      }
    });

    try {
      await player.play(UrlSource(fullUrl));
      return true;
    } catch (e) {
      debugPrint("[TtsPlayer] playFromUrl failed: $e");
      await _disposeCurrent(silent: true);
      return false;
    }
  }

  /// 释放资源（应用退出时调用）
  Future<void> dispose() async {
    await _disposeCurrent(silent: true);
    _completionListeners.clear();
  }

  Future<void> _disposeCurrent({required bool silent}) async {
    if (_player != null) {
      try { await _player!.stop(); } catch (_) {}
      try { await _player!.dispose(); } catch (_) {}
      _player = null;
    }
    final File? f = _tempFile;
    _tempFile = null;
    if (f != null) {
      try { if (await f.exists()) await f.delete(); } catch (_) {}
    }
    if (silent) {
      // 内部清理，不触发完成回调
      if (!(_completionCompleter?.isCompleted ?? true)) {
        _completionCompleter?.complete();
        _completionCompleter = null;
      }
    } else {
      _fireCompletion();
    }
  }

  void _fireCompletion() {
    if (!(_completionCompleter?.isCompleted ?? true)) {
      _completionCompleter?.complete();
      _completionCompleter = null;
    }
    final List<VoidCallback> snapshot = List<VoidCallback>.of(_completionListeners);
    for (final VoidCallback l in snapshot) {
      try { l(); } catch (_) {}
    }
  }
}
