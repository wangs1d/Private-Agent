import "dart:async";

import "package:flutter/services.dart";

class MobileBriefingLauncher {
  MobileBriefingLauncher._();

  static const MethodChannel _channel = MethodChannel("pai/mobile_briefing");

  static final StreamController<String> _payloadController =
      StreamController<String>.broadcast();

  static bool _bound = false;

  static Stream<String> get payloads => _payloadController.stream;

  static void bind() {
    if (_bound) return;
    _bound = true;
    _channel.setMethodCallHandler(_handleNativeCall);
  }

  static Future<void> unbind() async {
    _bound = false;
    _channel.setMethodCallHandler(null);
  }

  static Future<bool> showBriefingNotification({
    required String title,
    required String message,
    required String payload,
  }) async {
    try {
      return await _channel.invokeMethod<bool>(
            "showBriefingNotification",
            <String, dynamic>{
              "title": title,
              "message": message,
              "payload": payload,
            },
          ) ??
          false;
    } on MissingPluginException {
      return false;
    } on PlatformException {
      return false;
    }
  }

  static Future<String?> consumeLaunchPayload() async {
    try {
      return await _channel.invokeMethod<String>("consumeLaunchPayload");
    } on MissingPluginException {
      return null;
    } on PlatformException {
      return null;
    }
  }

  static Future<dynamic> _handleNativeCall(MethodCall call) async {
    if (call.method != "onBriefingTap") return null;
    final Object? raw = call.arguments;
    if (raw is String && raw.isNotEmpty && !_payloadController.isClosed) {
      _payloadController.add(raw);
    }
    return null;
  }
}
