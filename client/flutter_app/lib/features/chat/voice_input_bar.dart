import "dart:async";
import "dart:io";

import "package:flutter/material.dart";
import "package:permission_handler/permission_handler.dart";

import "../../core/services/voice_recorder_service.dart";

/// 微信式「按住说话」按钮。
///
/// 设计要点：
///   - 长按开始录音，松开上传发送，上滑取消
///   - 录音中弹出浮动 hud：倒计时 + 音量条 + 提示文案
///   - 60s 上限由 [VoiceRecorderService] 自动停止；这里同步展示倒计时
///   - 上传/发送由父级在 [onSendVoice] 中处理（录音文件路径 + 时长）
///   - 取消时 [VoiceRecorderService.cancel] 自动清理文件
class VoiceInputBar extends StatefulWidget {
  const VoiceInputBar({
    super.key,
    required this.onSendVoice,
    this.onCancel,
    this.label = "按住说话",
  });

  /// 录音完成回调（[path] 临时文件路径，[durationMs] 录音时长）。
  /// 父级负责上传 + 发送 chat.user_message（contentType=audio）。
  final void Function(String path, int durationMs) onSendVoice;

  /// 用户主动取消录音回调（可选）。
  final VoidCallback? onCancel;

  /// 按钮默认文字。
  final String label;

  @override
  State<VoiceInputBar> createState() => _VoiceInputBarState();
}

class _VoiceInputBarState extends State<VoiceInputBar> {
  final VoiceRecorderService _recorder = VoiceRecorderService.instance;

  bool _isRecording = false;
  bool _isUploading = false;
  bool _willCancel = false;
  int _elapsedMs = 0;
  double _amplitude = 0.0;
  Timer? _tickTimer;
  OverlayEntry? _hudOverlay;

  @override
  void initState() {
    super.initState();
    _recorder.addStateListener(_onRecorderState);
    _recorder.addAmplitudeListener(_onAmplitude);
  }

  @override
  void dispose() {
    _recorder.removeStateListener(_onRecorderState);
    _recorder.removeAmplitudeListener(_onAmplitude);
    _tickTimer?.cancel();
    _hudOverlay?.remove();
    _hudOverlay = null;
    super.dispose();
  }

  void _onRecorderState() {
    if (!_recorder.isRecording && _isRecording) {
      // 录音已停止（可能因 60s 上限）；这里只刷新 UI，
      // 真正的「松开发送」逻辑在 _onLongPressEnd 里处理。
      if (mounted) setState(() => _isRecording = false);
    }
  }

  void _onAmplitude(double amp) {
    if (!mounted) return;
    setState(() => _amplitude = amp);
    _hudOverlay?.markNeedsBuild();
  }

  Future<void> _onLongPressStart(LongPressStartDetails details) async {
    if (_isRecording || _isUploading) return;

    // 申请麦克风权限（permission_handler）
    final status = await Permission.microphone.request();
    if (!status.isGranted) {
      if (mounted) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          const SnackBar(content: Text("需要麦克风权限才能录音")),
        );
      }
      return;
    }

    final ok = await _recorder.start();
    if (!ok) {
      if (mounted) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          const SnackBar(content: Text("录音启动失败，请改用文字")),
        );
      }
      return;
    }

    if (!mounted) return;
    setState(() {
      _isRecording = true;
      _willCancel = false;
      _elapsedMs = 0;
    });
    _tickTimer?.cancel();
    _tickTimer = Timer.periodic(const Duration(milliseconds: 100), (_) {
      if (!mounted || !_isRecording) return;
      setState(() => _elapsedMs = _recorder.elapsedMs);
      // 接近 60s 上限时不再依赖 service 自动停，直接结束录音
      if (_elapsedMs >= VoiceRecorderService.maxDurationMs - 200) {
        _finishRecording();
      }
    });
    _showHud();
  }

  void _onLongPressMoveUpdate(LongPressMoveUpdateDetails details) {
    if (!_isRecording) return;
    // 上滑一定距离进入取消态
    final dy = details.localPosition.dy;
    final willCancel = dy < -60;
    if (willCancel != _willCancel) {
      setState(() => _willCancel = willCancel);
      _hudOverlay?.markNeedsBuild();
    }
  }

  Future<void> _onLongPressEnd(LongPressEndDetails details) async {
    await _finishRecording();
  }

  Future<void> _finishRecording() async {
    if (!_isRecording) return;
    _tickTimer?.cancel();
    _tickTimer = null;
    _hideHud();

    final wasCancel = _willCancel;
    final elapsed = _recorder.elapsedMs;
    final path = await _recorder.stop();

    if (!mounted) return;
    setState(() {
      _isRecording = false;
      _willCancel = false;
    });

    if (wasCancel) {
      widget.onCancel?.call();
      // 删除临时文件
      if (path != null) {
        try {
          final f = File(path);
          if (await f.exists()) await f.delete();
        } catch (_) {
          // ignore
        }
      }
      return;
    }

    if (path == null) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        const SnackBar(content: Text("录音失败，请重试")),
      );
      return;
    }

    // 录音过短（< 1s）视为误触，直接丢弃
    if (elapsed < 800) {
      try {
        final f = File(path);
        if (await f.exists()) await f.delete();
      } catch (_) {
        // ignore
      }
      if (!mounted) return;
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        const SnackBar(content: Text("录音太短，未发送"), duration: Duration(seconds: 1)),
      );
      return;
    }

    setState(() => _isUploading = true);
    try {
      widget.onSendVoice(path, elapsed);
    } finally {
      if (mounted) setState(() => _isUploading = false);
    }
  }

  void _showHud() {
    _hudOverlay?.remove();
    _hudOverlay = OverlayEntry(builder: _buildHud);
    Overlay.of(context, rootOverlay: true).insert(_hudOverlay!);
  }

  void _hideHud() {
    _hudOverlay?.remove();
    _hudOverlay = null;
  }

  Widget _buildHud(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final remainSec = ((VoiceRecorderService.maxDurationMs - _elapsedMs) / 1000)
        .ceil()
        .clamp(1, 60);
    final sec = (_elapsedMs / 1000).ceil().clamp(0, 60);
    return Positioned(
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      child: Material(
        color: Colors.black54,
        type: MaterialType.canvas,
        child: Center(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
            decoration: BoxDecoration(
              color: cs.surface,
              borderRadius: BorderRadius.circular(16),
              boxShadow: const <BoxShadow>[
                BoxShadow(
                  color: Colors.black38,
                  blurRadius: 24,
                  offset: Offset(0, 8),
                ),
              ],
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Icon(
                  _willCancel ? Icons.delete_outline : Icons.mic,
                  size: 40,
                  color: _willCancel ? cs.error : cs.primary,
                ),
                const SizedBox(height: 8),
                Text(
                  _willCancel ? "松开手指取消发送" : "上滑取消，松开发送",
                  style: theme.textTheme.bodySmall?.copyWith(color: cs.onSurface),
                ),
                const SizedBox(height: 12),
                // 音量条
                SizedBox(
                  width: 160,
                  height: 8,
                  child: LinearProgressIndicator(
                    value: _amplitude,
                    backgroundColor: cs.surfaceContainerHighest,
                    color: _willCancel ? cs.error : cs.primary,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  "$sec″ / $remainSec″",
                  style: theme.textTheme.labelLarge?.copyWith(color: cs.onSurface),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    final Color bg = _isRecording
        ? cs.errorContainer.withValues(alpha: 0.6)
        : cs.surfaceContainerHighest;
    final Color fg = _isRecording ? cs.onErrorContainer : cs.onSurfaceVariant;

    return GestureDetector(
      onLongPressStart: _onLongPressStart,
      onLongPressMoveUpdate: _onLongPressMoveUpdate,
      onLongPressEnd: _onLongPressEnd,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(20),
          border: _isRecording
              ? Border.all(color: cs.error.withValues(alpha: 0.5))
              : null,
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(_isRecording ? Icons.stop_rounded : Icons.mic, size: 16, color: fg),
            const SizedBox(width: 6),
            Text(
              _isRecording
                  ? "松开发送"
                  : _isUploading
                      ? "发送中..."
                      : widget.label,
              style: theme.textTheme.labelMedium?.copyWith(color: fg),
            ),
          ],
        ),
      ),
    );
  }
}
