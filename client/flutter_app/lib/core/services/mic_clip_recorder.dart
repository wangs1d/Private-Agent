import "dart:async";
import "dart:math" as math;
import "dart:typed_data";

import "package:flutter/foundation.dart";
import "package:record/record.dart";

/// 定长麦克风录音片段采集器（声纹注册/验证共用）。
///
/// 16kHz PCM16 单声道流式采集（与电话通话 startMic 同配置），
/// 录制期间通过 [level] 暴露实时音量（0-1，RMS 口径）驱动 UI 脉冲。
/// 纯语音模式下麦克风归本地唤醒/声纹独占——使用前应确保唤醒监听已停。
class MicClipRecorder {
  final AudioRecorder _recorder = AudioRecorder();
  final ValueNotifier<double> level = ValueNotifier<double>(0);

  StreamSubscription<Uint8List>? _sub;
  final List<Uint8List> _chunks = <Uint8List>[];
  bool _recording = false;

  bool get isRecording => _recording;

  Future<bool> start() async {
    if (_recording) return true;
    try {
      if (!await _recorder.hasPermission()) return false;
      _chunks.clear();
      final Stream<Uint8List> stream = await _recorder.startStream(
        const RecordConfig(
          encoder: AudioEncoder.pcm16bits,
          sampleRate: 16000,
          numChannels: 1,
        ),
      );
      _recording = true;
      _sub = stream.listen((Uint8List data) {
        _chunks.add(data);
        _updateLevel(data);
      });
      return true;
    } catch (e) {
      debugPrint("[MicClipRecorder] start failed: $e");
      _recording = false;
      return false;
    }
  }

  /// 结束并取回整段 PCM16 字节；未在录音返回空。
  Future<Uint8List> stop() async {
    await _sub?.cancel();
    _sub = null;
    try {
      await _recorder.stop();
    } catch (_) {/* 已停 */}
    _recording = false;
    level.value = 0;
    final BytesBuilder builder = BytesBuilder(copy: false);
    for (final Uint8List chunk in _chunks) {
      builder.add(chunk);
    }
    return builder.takeBytes();
  }

  void _updateLevel(Uint8List chunk) {
    if (chunk.length < 2) return;
    final ByteData view = ByteData.sublistView(chunk);
    final int sampleCount = chunk.length ~/ 2;
    // 抽样计算 RMS（每 16 个样本取 1 个，够 UI 用）
    double sum = 0;
    int n = 0;
    for (int i = 0; i < sampleCount; i += 16) {
      final double v = view.getInt16(i * 2, Endian.little) / 32768;
      sum += v * v;
      n++;
    }
    if (n == 0) return;
    final double rms = math.sqrt(sum / n);
    // 对数映射 + 平滑，让脉冲观感自然
    final double target = (rms * 6).clamp(0.0, 1.0).toDouble();
    level.value = level.value * 0.5 + target * 0.5;
  }

  void dispose() {
    unawaited(_sub?.cancel());
    _sub = null;
    try {
      unawaited(_recorder.dispose());
    } catch (_) {/* ignore */}
  }
}
