import "package:flutter/foundation.dart";
import "package:flutter/services.dart";

/// 短信代发的原生确认窗封装：拉起 SmsSendConfirmActivity，用户确认后
/// SmsManager 真发。异常统一归一化为 {ok:false,...}，不向上抛。
class PhoneSmsInvoker {
  static const MethodChannel _channel = MethodChannel("pai/phone_bridge");

  static Future<Map<String, dynamic>> sendSms({
    required String number,
    required String text,
    String contactName = "",
    String reason = "",
    int confirmTimeoutSec = 25,
  }) async {
    try {
      final dynamic result = await _channel.invokeMethod<dynamic>("sendSms", <String, dynamic>{
        "number": number,
        "text": text,
        "contactName": contactName,
        "reason": reason,
        "confirmTimeoutSec": confirmTimeoutSec,
      });
      if (result is Map) {
        return result.cast<String, dynamic>();
      }
      return <String, dynamic>{"ok": false, "error": "bad_native_result"};
    } catch (e) {
      debugPrint("[PhoneSmsInvoker] sendSms failed: $e");
      return <String, dynamic>{"ok": false, "error": "sms_invoke_exception"};
    }
  }
}
