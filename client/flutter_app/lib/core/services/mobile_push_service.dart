import "dart:async";
import "dart:convert";

import "package:flutter/foundation.dart";
import "package:flutter/services.dart";
import "package:http/http.dart" as http;

import "../config/api_config.dart";

/// 移动端推送通道注册：
/// 原生侧（Android/iOS）实现 MethodChannel "pai/mobile_push" 的 getPushToken，
/// 返回 `{"provider": "jpush", "token": "<registration_id>"}`（未接入厂商推送时返回 null/抛错，
/// 本类静默降级，不影响 App 其他功能）。拿到 token 后向服务端注册——此后两端都不在线时，
/// 日程/重要提醒经系统级推送送达手机（通知即弹窗）。
class MobilePushRegistrar {
  MobilePushRegistrar._();

  static const MethodChannel _channel = MethodChannel("pai/mobile_push");
  static bool _registered = false;

  static Future<void> registerIfNeeded() async {
    if (_registered) return;
    try {
      final Object? raw = await _channel.invokeMethod<Object>("getPushToken");
      if (raw is! Map) return;
      final String provider = raw["provider"]?.toString() ?? "jpush";
      final String token = raw["token"]?.toString() ?? "";
      if (token.isEmpty) return;
      final http.Response response = await http.post(
        Uri.parse("${ApiConfig.httpBase}/api/proactivity/push/register"),
        headers: const {"Content-Type": "application/json"},
        body: jsonEncode(<String, String>{
          "actorId": ApiConfig.effectiveActorId,
          "provider": provider,
          "token": token,
        }),
      );
      if (response.statusCode == 200) {
        _registered = true;
        debugPrint("[mobile-push] token registered (provider=$provider)");
      } else {
        debugPrint("[mobile-push] register failed: HTTP ${response.statusCode}");
      }
    } catch (e) {
      // 原生侧未接厂商推送 / 无网络：静默降级（WS 在线直推链路不受影响）
      debugPrint("[mobile-push] register unavailable: $e");
    }
  }
}
