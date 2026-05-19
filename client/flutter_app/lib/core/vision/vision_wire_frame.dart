import "dart:convert";

/// 与后端 `visionFrameWireSchema` 对齐，经 WebSocket `chat.user_message` 发送。
class VisionWireFrame {
  VisionWireFrame({
    required this.sourceKind,
    this.sourceId,
    required this.mimeType,
    required this.bytes,
    this.capturedAt,
  });

  /// `device_camera` | `external_stream` | `agent_attachment`
  final String sourceKind;
  final String? sourceId;
  final String mimeType;
  final List<int> bytes;
  final String? capturedAt;

  Map<String, dynamic> toJson() {
    final Map<String, dynamic> m = <String, dynamic>{
      "sourceKind": sourceKind,
      "mimeType": mimeType,
      "dataBase64": base64Encode(bytes),
    };
    final String? sid = sourceId?.trim();
    if (sid != null && sid.isNotEmpty) {
      m["sourceId"] = sid;
    }
    final String? cap = capturedAt?.trim();
    if (cap != null && cap.isNotEmpty) {
      m["capturedAt"] = cap;
    }
    return m;
  }
}

/// 从文件路径或魔数推断 MIME（仅支持服务端允许的 jpeg/png/webp）。
String sniffImageMimeType(List<int> bytes, {String pathHint = ""}) {
  if (bytes.length >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 8 &&
      bytes[0] == 0x89 &&
      bytes[1] == 0x50 &&
      bytes[2] == 0x4e &&
      bytes[3] == 0x47) {
    return "image/png";
  }
  if (bytes.length >= 12 &&
      bytes[0] == 0x52 &&
      bytes[1] == 0x49 &&
      bytes[2] == 0x46 &&
      bytes[3] == 0x46) {
    final String s = String.fromCharCodes(bytes.sublist(0, bytes.length.clamp(0, 16)));
    if (s.contains("WEBP")) {
      return "image/webp";
    }
  }
  final String lower = pathHint.toLowerCase();
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  if (lower.endsWith(".webp")) {
    return "image/webp";
  }
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  return "image/jpeg";
}
