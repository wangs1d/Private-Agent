import "dart:convert";

import "package:flutter/foundation.dart" show debugPrint;
import "package:http/http.dart" as http;

import "../config/api_config.dart";

/// 邮箱登录两步式的通用结果。
class EmailLoginResult {
  const EmailLoginResult({
    required this.ok,
    this.error,
    this.otpChannelDisabled = false,
    this.retryAfterSeconds,
  });

  final bool ok;

  /// 失败文案（直接可展示给用户）。
  final String? error;

  /// 服务端 OTP 闸未开启（SMTP 未配置/显式关闭）：可跳过验证码直接登录。
  final bool otpChannelDisabled;

  /// 发码限频：多少秒后可重试。
  final int? retryAfterSeconds;
}

/// 手机端邮箱登录 API 客户端（服务端实现：server/src/routes/http/accounts.ts）。
///
/// 与桌面端网页登录（/accounts/web 两步式）完全同协议：
///  1. POST /accounts/email/otp/start {email} → 向邮箱发 6 位验证码
///     （OTP 闸关闭时 503，调用方视 [EmailLoginResult.otpChannelDisabled]
///     允许免码直登）
///  2. POST /accounts/register {userId: email, displayName, email, otpCode?}
///     → 新邮箱即注册、已注册即登录（幂等）；白名单拦截 403 原样透传文案
///
/// 登录主体恒为邮箱本身（userId=email）：与桌面端「登录邮箱=运行时身份
/// 覆盖」同源，聊天/记忆/画像等全部数据按该 userId 落库，两端自动共享。
///
/// 基址默认取 [ApiConfig.controlPlaneBase]（账号/OTP/登录页所在的控制面，
/// 与反馈、站内信、桌面端 /accounts/web 同源）；单机/开发形态下它回落
/// [ApiConfig.httpBase]，行为不变。**手机端打包必须烤 CONTROL_PLANE_URL**
/// （见 build_apk.ps1），否则回落 127.0.0.1:3000 —— 真机上那是手机自己，
/// 发验证码必然落进「网络错误」兜底。
class EmailLoginApi {
  EmailLoginApi({String? baseUrl, http.Client? client})
      : _baseUrl = baseUrl ?? ApiConfig.controlPlaneBase,
        _client = client ?? http.Client();

  final String _baseUrl;
  final http.Client _client;

  static const Duration _timeout = Duration(seconds: 15);

  static final RegExp emailRe = RegExp(r"^[^\s@]+@[^\s@]+\.[^\s@]+$");

  static bool isValidEmail(String email) => emailRe.hasMatch(email.trim());

  /// 步骤 1：向邮箱发送登录验证码。
  Future<EmailLoginResult> startOtp(String email) async {
    final String mail = email.trim().toLowerCase();
    try {
      final http.Response res = await _client
          .post(
            Uri.parse("$_baseUrl/accounts/email/otp/start"),
            headers: const <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, String>{"email": mail}),
          )
          .timeout(_timeout);
      final Map<String, dynamic> data =
          jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
      if (res.statusCode == 200 && data["ok"] == true) {
        return EmailLoginResult(
          ok: true,
          retryAfterSeconds: data["resendAfterSeconds"] as int?,
        );
      }
      return EmailLoginResult(
        ok: false,
        error: data["message"]?.toString() ?? "验证码发送失败，请稍后重试",
        otpChannelDisabled: res.statusCode == 503,
        retryAfterSeconds: data["retryAfterSeconds"] as int?,
      );
    } catch (e) {
      debugPrint("[EmailLoginApi] startOtp failed: $e");
      return const EmailLoginResult(ok: false, error: "网络错误，请检查网络后重试");
    }
  }

  /// 步骤 2：注册或登录（幂等）。[code] 为 null/空时按免码直登处理
  /// （仅当服务端 OTP 闸关闭时才会成功）。
  Future<EmailLoginResult> registerOrLogin(String email, {String? code}) async {
    final String mail = email.trim().toLowerCase();
    final String otp = code?.trim() ?? "";
    try {
      final http.Response res = await _client
          .post(
            Uri.parse("$_baseUrl/accounts/register"),
            headers: const <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, dynamic>{
              "userId": mail,
              "displayName": mail.split("@").first,
              "email": mail,
              if (otp.isNotEmpty) "otpCode": otp,
            }),
          )
          .timeout(_timeout);
      final Map<String, dynamic> data =
          jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
      if (res.statusCode == 200 && data["ok"] == true) {
        return const EmailLoginResult(ok: true);
      }
      // 幂等：已存在账号视为登录成功（与桌面端 /accounts/web 同语义）
      final String message = data["message"]?.toString() ?? "";
      if (message.contains("已存在")) {
        return const EmailLoginResult(ok: true);
      }
      return EmailLoginResult(
        ok: false,
        error: message.isNotEmpty ? message : "登录失败，请稍后重试",
      );
    } catch (e) {
      debugPrint("[EmailLoginApi] registerOrLogin failed: $e");
      return const EmailLoginResult(ok: false, error: "网络错误，请检查网络后重试");
    }
  }
}
