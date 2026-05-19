import "package:camera/camera.dart";

import "vision_wire_frame.dart";

/// 无预览 UI：初始化摄像头、拍照后释放，供用户授权后随消息静默附带画面。
Future<VisionWireFrame?> captureSilentCameraFrame() async {
  try {
    final List<CameraDescription> cams = await availableCameras();
    if (cams.isEmpty) {
      return null;
    }
    final CameraDescription cam = cams.first;
    final CameraController controller = CameraController(
      cam,
      ResolutionPreset.medium,
      enableAudio: false,
      imageFormatGroup: ImageFormatGroup.jpeg,
    );
    await controller.initialize();
    await Future<void>.delayed(const Duration(milliseconds: 350));
    final XFile file = await controller.takePicture();
    await controller.dispose();
    final List<int> bytes = await file.readAsBytes();
    if (bytes.isEmpty) {
      return null;
    }
    return VisionWireFrame(
      sourceKind: "device_camera",
      sourceId: cam.name,
      mimeType: sniffImageMimeType(bytes, pathHint: file.path),
      bytes: bytes,
      capturedAt: DateTime.now().toUtc().toIso8601String(),
    );
  } catch (_) {
    return null;
  }
}
