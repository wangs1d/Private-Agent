import "package:camera/camera.dart";
import "package:flutter/material.dart";

import "../vision_frame_source.dart";
import "../vision_wire_frame.dart";

/// 使用系统摄像头拍照（Windows / Android / iOS 等由 `camera` 插件支持的平台）。
class DeviceCameraVisionSource implements VisionFrameSource {
  const DeviceCameraVisionSource();

  @override
  String get id => "device_camera";

  @override
  String get displayLabel => "摄像头拍照";

  @override
  Future<VisionWireFrame?> capture(BuildContext context) async {
    final List<CameraDescription> cams = await availableCameras();
    if (cams.isEmpty) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text("未检测到可用摄像头")),
        );
      }
      return null;
    }
    if (!context.mounted) {
      return null;
    }
    final VisionWireFrame? shot = await showDialog<VisionWireFrame>(
      context: context,
      barrierDismissible: false,
      builder: (BuildContext ctx) => _CameraSnapDialog(cameras: cams),
    );
    return shot;
  }
}

class _CameraSnapDialog extends StatefulWidget {
  const _CameraSnapDialog({required this.cameras});

  final List<CameraDescription> cameras;

  @override
  State<_CameraSnapDialog> createState() => _CameraSnapDialogState();
}

class _CameraSnapDialogState extends State<_CameraSnapDialog> {
  CameraController? _controller;
  bool _ready = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _openCamera();
  }

  Future<void> _openCamera() async {
    try {
      final CameraDescription cam = widget.cameras.first;
      final CameraController c = CameraController(
        cam,
        ResolutionPreset.medium,
        enableAudio: false,
        imageFormatGroup: ImageFormatGroup.jpeg,
      );
      await c.initialize();
      if (!mounted) {
        await c.dispose();
        return;
      }
      setState(() {
        _controller = c;
        _ready = true;
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
        });
      }
    }
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  Future<void> _take() async {
    final CameraController? c = _controller;
    if (c == null || !c.value.isInitialized) {
      return;
    }
    try {
      final XFile file = await c.takePicture();
      final List<int> bytes = await file.readAsBytes();
      if (!mounted) {
        return;
      }
      final String mime = sniffImageMimeType(bytes, pathHint: file.path);
      Navigator.of(context).pop(
        VisionWireFrame(
          sourceKind: "device_camera",
          sourceId: c.description.name,
          mimeType: mime,
          bytes: bytes,
          capturedAt: DateTime.now().toUtc().toIso8601String(),
        ),
      );
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("拍照失败：$e")),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text("摄像头"),
      content: SizedBox(
        width: 400,
        height: 320,
        child: _error != null
            ? Center(child: Text(_error!, textAlign: TextAlign.center))
            : !_ready || _controller == null
                ? const Center(child: CircularProgressIndicator())
                : ClipRRect(
                    borderRadius: BorderRadius.circular(8),
                    child: CameraPreview(_controller!),
                  ),
      ),
      actions: <Widget>[
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text("取消"),
        ),
        FilledButton(
          onPressed: _ready ? _take : null,
          child: const Text("拍照并发送"),
        ),
      ],
    );
  }
}
