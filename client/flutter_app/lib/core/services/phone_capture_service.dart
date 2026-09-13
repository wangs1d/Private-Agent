import "dart:async";

import "package:flutter/foundation.dart";
import "package:flutter/services.dart";

/// 一条被捕捉的通知消息（映射服务端 phone.msg.report 的消息条目结构）。
class CapturedPhoneMessage {
  CapturedPhoneMessage({
    required this.platform,
    required this.channelId,
    required this.text,
    required this.externalMessageId,
    this.title,
    this.senderName,
    this.capturedAt,
    this.packageName,
  });

  factory CapturedPhoneMessage.fromMap(Map<dynamic, dynamic> map) {
    return CapturedPhoneMessage(
      platform: map["platform"]?.toString() ?? "",
      channelId: map["channelId"]?.toString() ?? "",
      text: map["text"]?.toString() ?? "",
      externalMessageId: map["externalMessageId"]?.toString() ?? "",
      title: map["title"]?.toString(),
      senderName: map["senderName"]?.toString(),
      capturedAt: map["capturedAt"]?.toString(),
      packageName: map["packageName"]?.toString(),
    );
  }

  final String platform;
  final String channelId;
  final String text;
  final String externalMessageId;
  final String? title;
  final String? senderName;
  final String? capturedAt;
  final String? packageName;

  Map<String, dynamic> toReportPayload() {
    return <String, dynamic>{
      "platform": platform,
      "channelId": channelId,
      "text": text,
      "externalMessageId": externalMessageId,
      if (title != null && title!.isNotEmpty) "title": title,
      if (senderName != null && senderName!.isNotEmpty) "senderName": senderName,
      if (capturedAt != null && capturedAt!.isNotEmpty) "capturedAt": capturedAt,
    };
  }
}

/// 手机消息捕捉服务：封装 pai/phone_msg_events 原生通道。
///
///  - 原生通知监听服务（MessageCaptureListenerService）批量推
///    `onMessagesCaptured`，本服务校验后经 [onBatch] 交给 PhoneBridgeService 上报；
///  - [drainQueue] 在桥接上线时取走引擎未运行期间落盘积压的消息补报；
///  - [isListenerEnabled]/[openListenerSettings] 供设置页做通知使用权引导；
///  - [startBridgeService] 拉起常驻前台服务保活。
class PhoneCaptureService {
  PhoneCaptureService._();

  static final PhoneCaptureService instance = PhoneCaptureService._();

  static const MethodChannel _channel = MethodChannel("pai/phone_msg_events");

  bool _initialized = false;
  final StreamController<List<CapturedPhoneMessage>> _batchController =
      StreamController<List<CapturedPhoneMessage>>.broadcast();

  /// 捕获到的消息批次（原生批量合并后推送，约 1.5s 一批）
  Stream<List<CapturedPhoneMessage>> get onBatch => _batchController.stream;

  void ensureInitialized() {
    if (_initialized) return;
    _initialized = true;
    _channel.setMethodCallHandler((MethodCall call) async {
      if (call.method == "onMessagesCaptured") {
        final List<dynamic>? raw = call.arguments as List<dynamic>?;
        final batch = <CapturedPhoneMessage>[];
        for (final item in raw ?? const <dynamic>[]) {
          if (item is Map) {
            final msg = CapturedPhoneMessage.fromMap(item);
            if (msg.platform.isNotEmpty &&
                msg.text.isNotEmpty &&
                msg.externalMessageId.isNotEmpty) {
              batch.add(msg);
            }
          }
        }
        if (batch.isNotEmpty && _batchController.hasListener) {
          _batchController.add(batch);
        }
      }
      return null;
    });
  }

  /// 取走原生落盘队列积压的捕获消息（桥接上线时补报）。
  Future<List<CapturedPhoneMessage>> drainQueue() async {
    ensureInitialized();
    try {
      final List<dynamic>? raw = await _channel.invokeMethod<List<dynamic>>("drainQueue");
      final out = <CapturedPhoneMessage>[];
      for (final item in raw ?? const <dynamic>[]) {
        if (item is Map) out.add(CapturedPhoneMessage.fromMap(item));
      }
      return out;
    } catch (e) {
      debugPrint("[PhoneCapture] drainQueue failed: $e");
      return const <CapturedPhoneMessage>[];
    }
  }

  /// 落盘队列当前条数（设置页展示）。
  Future<int> queueSize() async {
    ensureInitialized();
    try {
      final int? size = await _channel.invokeMethod<int>("queueSize");
      return size ?? 0;
    } catch (_) {
      return 0;
    }
  }

  /// 通知使用权（notification listener access）是否已授予。
  Future<bool> isListenerEnabled() async {
    ensureInitialized();
    try {
      return await _channel.invokeMethod<bool>("isListenerEnabled") ?? false;
    } catch (_) {
      return false;
    }
  }

  /// 跳转系统「通知使用权」设置页。返回是否成功拉起。
  Future<bool> openListenerSettings() async {
    ensureInitialized();
    try {
      return await _channel.invokeMethod<bool>("openListenerSettings") ?? false;
    } catch (_) {
      return false;
    }
  }

  /// 拉起常驻前台服务（保活桥接与上报）。
  Future<bool> startBridgeService() async {
    ensureInitialized();
    try {
      return await _channel.invokeMethod<bool>("startBridgeService") ?? false;
    } catch (_) {
      return false;
    }
  }
}
