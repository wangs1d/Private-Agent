import "package:flutter/material.dart";

import "../pick_gallery_vision.dart";
import "../vision_frame_source.dart";
import "../vision_wire_frame.dart";

/// 从本机文件选取一帧静态图（任意平台）。
class FileImageVisionSource implements VisionFrameSource {
  const FileImageVisionSource();

  @override
  String get id => "file_image";

  @override
  String get displayLabel => "从文件选择图片";

  @override
  Future<VisionWireFrame?> capture(BuildContext context) async {
    return pickGalleryVisionWireFrame();
  }
}
