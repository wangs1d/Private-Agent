import "dart:io";

import "package:file_picker/file_picker.dart";

import "vision_user_limits.dart";
import "vision_wire_frame.dart";

Future<VisionWireFrame?> _frameFromPlatformFile(PlatformFile f) async {
  final List<int>? raw = f.bytes;
  if (raw != null && raw.isNotEmpty) {
    final String mime = sniffImageMimeType(raw, pathHint: f.name);
    return VisionWireFrame(
      sourceKind: "agent_attachment",
      sourceId: "gallery:${f.name}",
      mimeType: mime,
      bytes: raw,
      capturedAt: DateTime.now().toUtc().toIso8601String(),
    );
  }
  final String? path = f.path;
  if (path == null || path.isEmpty) {
    return null;
  }
  final File file = File(path);
  if (!await file.exists()) {
    return null;
  }
  final List<int> bytes = await file.readAsBytes();
  if (bytes.isEmpty) {
    return null;
  }
  final String mime = sniffImageMimeType(bytes, pathHint: path);
  return VisionWireFrame(
    sourceKind: "agent_attachment",
    sourceId: "gallery:$path",
    mimeType: mime,
    bytes: bytes,
    capturedAt: DateTime.now().toUtc().toIso8601String(),
  );
}

/// 从相册/文件选取一张图（供用户主动发给 Agent；与摄像头静默抓拍并行）。
Future<VisionWireFrame?> pickGalleryVisionWireFrame() async {
  final FilePickerResult? r = await FilePicker.platform.pickFiles(
    type: FileType.image,
    allowMultiple: false,
    withData: true,
  );
  if (r == null || r.files.isEmpty) {
    return null;
  }
  return _frameFromPlatformFile(r.files.first);
}

/// 多选相册/文件，最多 [kAgentUserVisionMaxFrames] 张，一次 `chat.user_message` 多帧。
Future<List<VisionWireFrame>> pickGalleryVisionWireFrames() async {
  final FilePickerResult? r = await FilePicker.platform.pickFiles(
    type: FileType.image,
    allowMultiple: true,
    withData: true,
  );
  if (r == null || r.files.isEmpty) {
    return <VisionWireFrame>[];
  }
  final List<VisionWireFrame> out = <VisionWireFrame>[];
  for (final PlatformFile f in r.files) {
    if (out.length >= kAgentUserVisionMaxFrames) {
      break;
    }
    final VisionWireFrame? one = await _frameFromPlatformFile(f);
    if (one != null) {
      out.add(one);
    }
  }
  return out;
}
