import "dart:convert";
import "dart:io";

import "package:flutter/foundation.dart" show debugPrint;
import "package:path_provider/path_provider.dart";

import "../config/api_config.dart";

/// 本机账号会话（控制面邮箱账号的登录态落盘）。
///
/// 注册成功（registerAccountToControlPlane）后把邮箱写进应用支持目录的
/// 单个 JSON 文件；启动时读它决定「直接进主界面」还是「先过注册页」，
/// 退出登录=清文件回到注册页。明文落盘与 AccessCredentialStore 同一
/// 取舍：桌面个人设备场景下，泄露面等同本机用户账户。
///
/// 存取边界统一做身份归一化（trim + 邮箱小写）：登录邮箱是全链身份的
/// 唯一来源（[ApiConfig.runtimeUserId]），大小写不同不得裂成两个账号。
class AccountSessionStore {
  AccountSessionStore._();

  static final AccountSessionStore instance = AccountSessionStore._();

  static const String _fileName = "account_session.json";

  String? _email;
  bool _loaded = false;

  /// 当前登录邮箱（已归一化）；null = 未注册/已退出登录。
  String? get email => _email;

  /// 启动时加载一次；文件缺失/损坏均视为未登录。
  Future<void> load() async {
    if (_loaded) return;
    _loaded = true;
    try {
      final Directory dir = await getApplicationSupportDirectory();
      final File file = File("${dir.path}/$_fileName");
      if (!await file.exists()) return;
      final Map<String, dynamic> json =
          jsonDecode(await file.readAsString()) as Map<String, dynamic>;
      final String? email = json["email"] as String?;
      // 旧落盘可能是大小写混写的邮箱：读出时统一归一
      final String normalized = ApiConfig.normalizeIdentity(email);
      if (normalized.isNotEmpty) _email = normalized;
    } catch (e) {
      debugPrint("[AccountSession] 读取账号会话失败（视为未登录）: $e");
      _email = null;
    }
  }

  /// 注册成功后保存登录态。
  Future<void> save(String email) async {
    _email = ApiConfig.normalizeIdentity(email);
    await _write();
  }

  /// 退出登录：清空内存态并删除落盘文件。
  Future<void> clear() async {
    _email = null;
    try {
      final Directory dir = await getApplicationSupportDirectory();
      final File file = File("${dir.path}/$_fileName");
      if (await file.exists()) {
        await file.delete();
      }
    } catch (e) {
      debugPrint("[AccountSession] 清除账号会话失败: $e");
    }
  }

  Future<void> _write() async {
    try {
      final Directory dir = await getApplicationSupportDirectory();
      final File file = File("${dir.path}/$_fileName");
      if (_email == null) {
        if (await file.exists()) {
          await file.delete();
        }
        return;
      }
      await file.writeAsString(jsonEncode(<String, dynamic>{
        "email": _email,
        "loggedInAt": DateTime.now().toIso8601String(),
      }));
    } catch (e) {
      debugPrint("[AccountSession] 写入账号会话失败: $e");
    }
  }
}
