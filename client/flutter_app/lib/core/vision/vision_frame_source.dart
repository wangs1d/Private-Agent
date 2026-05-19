import "package:flutter/material.dart";

import "vision_wire_frame.dart";

/// 抽象「外部视觉源」：本机摄像头、文件、后续 Agent 自接 RTSP/USB 等均可实现此接口并注册到 {@link VisionSourceRegistry}。
abstract class VisionFrameSource {
  /// 稳定 id，用于 telemetry / 源切换
  String get id;

  String get displayLabel;

  /// 采集一帧（或失败返回 `null`）；可弹出全屏相机 UI。
  Future<VisionWireFrame?> capture(BuildContext context);
}

/// 运行时维护可用视觉源，便于后续动态注册（例如插件注入 `external_stream`）。
class VisionSourceRegistry {
  VisionSourceRegistry(List<VisionFrameSource> sources) : _sources = List<VisionFrameSource>.from(sources);

  final List<VisionFrameSource> _sources;

  List<VisionFrameSource> get sources => List<VisionFrameSource>.unmodifiable(_sources);

  void register(VisionFrameSource source) {
    _sources.removeWhere((VisionFrameSource s) => s.id == source.id);
    _sources.add(source);
  }
}
