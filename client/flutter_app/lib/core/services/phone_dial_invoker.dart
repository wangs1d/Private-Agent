import "package:flutter/foundation.dart";
import "package:flutter/services.dart";

/// 手机桥接拨号的原生通道包装。
///
/// 与 Android 端 [PhoneBridgePlugin]（Kotlin）配套：
/// `dial` 拉起原生拨号确认窗，用户确认后 ACTION_CALL/ACTION_DIAL，
/// 返回 `{ok, state, ...}`；任何异常都归一化为 `{ok: false, error: ...}`，
/// 不会向调用方抛出——调用方（PhoneBridgeService）拿结果直接回执服务端。
class PhoneDialInvoker {
  PhoneDialInvoker._();

  static const MethodChannel _channel = MethodChannel("pai/phone_bridge");

  static Future<Map<String, dynamic>> dial({
    required String number,
    String contactName = "",
    String reason = "",
    String mode = "direct",
    int confirmTimeoutSec = 20,
  }) async {
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) {
      return <String, dynamic>{"ok": false, "error": "unsupported_platform"};
    }
    try {
      final dynamic raw = await _channel.invokeMethod<dynamic>("dial", <String, dynamic>{
        "number": number,
        "contactName": contactName,
        "reason": reason,
        "mode": mode,
        "confirmTimeoutSec": confirmTimeoutSec,
      });
      if (raw is Map) {
        return raw.map<String, dynamic>(
          (Object? k, Object? v) => MapEntry(k?.toString() ?? "", v),
        );
      }
      return <String, dynamic>{"ok": false, "error": "bad_native_result"};
    } on PlatformException catch (e) {
      return <String, dynamic>{
        "ok": false,
        "error": e.code,
        if (e.message != null) "message": e.message,
      };
    } on MissingPluginException {
      return <String, dynamic>{"ok": false, "error": "native_channel_missing"};
    } catch (e) {
      return <String, dynamic>{"ok": false, "error": "dial_exception:$e"};
    }
  }
}
