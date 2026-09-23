import "dart:convert";

import "package:http/http.dart" as http;

import "../config/api_config.dart";
import "install_identity.dart";

/// 控制面账号自注册。
///
/// 捆绑形态下账号/世界数据都在本地 runtime，控制面（管理后台所在服务器）
/// 的收件人列表里没有这个用户——后台「全体用户」群发站内信时会直接跳过，
/// 用户永远收不到。这里在启动时用安装身份（[InstallIdentity.actorId]，与
/// 反馈同源）向控制面补注册一行账号，幂等：已存在时视为成功。
class ControlPlaneAccount {
  ControlPlaneAccount._();

  static const Duration _timeout = Duration(seconds: 10);

  /// 确保本安装身份在控制面有账号行。返回是否就绪（新注册或已存在）。
  static Future<bool> ensureRegistered({http.Client? client}) async {
    final http.Client c = client ?? http.Client();
    try {
      final String actorId = await InstallIdentity.instance.actorId();
      final http.Response res = await c
          .post(
            Uri.parse("${ApiConfig.controlPlaneBase}/accounts/register"),
            headers: const <String, String>{
              "Content-Type": "application/json",
            },
            body: jsonEncode(<String, String>{
              "userId": actorId,
              "displayName": actorId,
            }),
          )
          .timeout(_timeout);
      final Map<String, dynamic> data =
          jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode == 200 && data["ok"] == true) return true;
      // 已注册过：服务端报「该用户已存在 Agent 账号」，同样视为就绪
      final String message = data["message"]?.toString() ?? "";
      if (message.contains("已存在")) return true;
      return false;
    } catch (_) {
      // 控制面不可达不打断启动；下次启动重试
      return false;
    } finally {
      if (client == null) c.close();
    }
  }
}
