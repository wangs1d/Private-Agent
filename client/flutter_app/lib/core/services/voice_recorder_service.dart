import "dart:async";
import "dart:io";

import "package:flutter/foundation.dart";
import "package:record/record.dart";

/// 语音录音服务：封装 `record` 包，提供开始/停止/取消录音 + 音量采样。
///
/// 设计要点：
///   - 单例：任何时候只有一个录音在进行
///   - 输出 mp3 格式（与服务端 TTS 同源，便于 ASR 处理）
///   - 实时音量采样：用于 UI 渲染「按住说话」时的声波动画
///   - 上限 60 秒：超时自动停止，避免过长占用磁盘 / 带宽
///   - 失败降级：录音失败时返回 null，调用方提示用户改用文字
///
/// 依赖：
///   - `record: ^5.x`（跨平台录音）
///   - `permission_handler: ^11.x`（麦克风权限，由 UI 层负责申请）
class VoiceRecorderService {
  VoiceRecorderService._();
  static final VoiceRecorderService instance = VoiceRecorderService._();

  AudioRecorder? _recorder;

  /// 录音状态变更回调。
  final List<VoidCallback> _stateListeners = <VoidCallback>[];
  void addStateListener(VoidCallback listener) => _stateListeners.add(listener);
  void removeStateListener(VoidCallback listener) => _stateListeners.remove(listener);

  /// 音量变更回调（0.0-1.0），用于 UI 声波动画。
  final List<ValueChanged<double>> _amplitudeListeners = <ValueChanged<double>>[];
  void addAmplitudeListener(ValueChanged<double> listener) =>
      _amplitudeListeners.add(listener);
  void removeAmplitudeListener(ValueChanged<double> listener) =>
      _amplitudeListeners.remove(listener);

  bool _isRecording = false;
  String? _currentPath;
  Timer? _amplitudeTimer;
  DateTime? _startedAt;
  Timer? _autoStopTimer;

  /// 当前是否正在录音。
  bool get isRecording => _isRecording;

  /// 已录制时长（毫秒）。
  int get elapsedMs {
    if (_startedAt == null) return 0;
    return DateTime.now().difference(_startedAt!).inMilliseconds;
  }

  /// 最大录音时长（毫秒），默认 60 秒。
  static const int maxDurationMs = 60 * 1000;

  AudioRecorder _ensureRecorder() {
    _recorder ??= AudioRecorder();
    return _recorder!;
  }

  /// 开始录音。
  ///
  /// 调用方应先通过 `permission_handler` 申请麦克风权限。
  /// 返回 true 表示已开始录音；false 表示失败（权限被拒 / 设备不可用）。
  Future<bool> start() async {
    if (_isRecording) return true;
    try {
      final recorder = _ensureRecorder();

      final hasPermission = await recorder.hasPermission();
      if (!hasPermission) {
        debugPrint("[VoiceRecorder] 麦克风权限被拒");
        return false;
      }

      final isEncoderSupported = await recorder.isEncoderSupported(AudioEncoder.aacLc);
      if (!isEncoderSupported) {
        debugPrint("[VoiceRecorder] AAC LC 编码器不支持");
        return false;
      }

      final dir = await Directory.systemTemp.createTemp("voice_msg");
      // 用 .m4a（AAC 编码）；上传时服务端会按 audio/mpeg 兜底处理
      // 注意：纯 mp3 编码在多数平台不支持，AAC 是 Flutter record 包的通用默认
      _currentPath = "${dir.path}/rec.m4a";

      await recorder.start(
        RecordConfig(
          encoder: AudioEncoder.aacLc,
          bitRate: 32000, // 32kbps，语音足够
          sampleRate: 16000, // 16kHz 足够语音识别
          numChannels: 1, // 单声道
        ),
        path: _currentPath!,
      );

      _isRecording = true;
      _startedAt = DateTime.now();
      _notifyStateListeners();

      // 启动音量采样定时器（每 100ms）
      _amplitudeTimer = Timer.periodic(const Duration(milliseconds: 100), (_) async {
        if (!_isRecording) return;
        try {
          final amp = await recorder.getAmplitude();
          // amp.current 在 record_platform_interface 中是 non-nullable double，
          // 但部分平台实现会返回 -Inf / -60 表示静音，统一按 -60 处理
          final current = amp.current.isFinite ? amp.current : -60.0;
          final normalized = (current + 60.0) / 60.0;
          final clamped = normalized.clamp(0.0, 1.0);
          for (final l in List<ValueChanged<double>>.from(_amplitudeListeners)) {
            l(clamped);
          }
        } catch (_) {
          // 静默失败，避免 UI 抖动
        }
      });

      // 60 秒自动停止
      _autoStopTimer?.cancel();
      _autoStopTimer = Timer(const Duration(milliseconds: maxDurationMs), () {
        if (_isRecording) {
          debugPrint("[VoiceRecorder] 达到 60s 上限自动停止");
          stop();
        }
      });

      return true;
    } catch (e) {
      debugPrint("[VoiceRecorder] start failed: $e");
      return false;
    }
  }

  /// 停止录音并返回文件路径；调用方读取后应自行 `delete` 文件。
  /// 失败 / 未在录音时返回 null。
  Future<String?> stop() async {
    if (!_isRecording) return null;
    try {
      final recorder = _ensureRecorder();
      final path = await recorder.stop();
      _amplitudeTimer?.cancel();
      _amplitudeTimer = null;
      _autoStopTimer?.cancel();
      _autoStopTimer = null;
      _isRecording = false;
      _startedAt = null;
      final finalPath = path ?? _currentPath;
      _currentPath = null;
      _notifyStateListeners();
      return finalPath;
    } catch (e) {
      debugPrint("[VoiceRecorder] stop failed: $e");
      _amplitudeTimer?.cancel();
      _amplitudeTimer = null;
      _autoStopTimer?.cancel();
      _autoStopTimer = null;
      _isRecording = false;
      _startedAt = null;
      _currentPath = null;
      _notifyStateListeners();
      return null;
    }
  }

  /// 取消录音：丢弃当前文件并清理。
  Future<void> cancel() async {
    if (!_isRecording) return;
    try {
      final recorder = _ensureRecorder();
      await recorder.cancel();
    } catch (_) {
      // 静默失败
    }
    _amplitudeTimer?.cancel();
    _amplitudeTimer = null;
    _autoStopTimer?.cancel();
    _autoStopTimer = null;
    _isRecording = false;
    _startedAt = null;
    if (_currentPath != null) {
      try {
        final f = File(_currentPath!);
        if (await f.exists()) await f.delete();
      } catch (_) {
        // ignore
      }
    }
    _currentPath = null;
    _notifyStateListeners();
  }

  /// 释放资源（页面 dispose 时调用）。
  void dispose() {
    _amplitudeTimer?.cancel();
    _autoStopTimer?.cancel();
    _recorder?.dispose();
    _recorder = null;
  }

  void _notifyStateListeners() {
    for (final l in List<VoidCallback>.from(_stateListeners)) {
      l();
    }
  }
}
