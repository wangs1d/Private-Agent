import "dart:convert";
import "dart:io";

import "package:flutter/foundation.dart" show debugPrint;
import "package:path_provider/path_provider.dart";

import "../config/api_config.dart";
import "account_session_store.dart";

/// 控制面身份：反馈、站内信等运营数据以此 actor 身份落库到管理后台。
///
/// 优先级：登录邮箱（账号会话，已归一化，按账号隔离）>
/// `USER_ID`（部署配置，显式指定）> 持久化安装 ID。
/// 安装 ID 首次使用时生成并写入应用支持目录，卸载重装后变化——
/// 仅作未登录时的兜底，保证管理后台能区分不同设备，
/// 而不是全员撞在同一个烤死的 sessionId 上。
class InstallIdentity {
  InstallIdentity._();

  static final InstallIdentity instance = InstallIdentity._();

  static const String _fileName = "install_identity.json";

  String? _installId;
  bool _loaded = false;

  Future<void> _ensureLoaded() async {
    if (_loaded) return;
    _loaded = true;
    try {
      final Directory dir = await getApplicationSupportDirectory();
      final File file = File("${dir.path}/$_fileName");
      if (await file.exists()) {
        final Map<String, dynamic> json =
            jsonDecode(await file.readAsString()) as Map<String, dynamic>;
        final String id = json["installId"]?.toString() ?? "";
        if (id.isNotEmpty) {
          _installId = id;
          return;
        }
      }
      // 首次生成：inst_ + 毫秒时间戳(36进制) + 微秒尾数(36进制)，避免并发撞号
      final String id =
          "inst_${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}_${(DateTime.now().microsecondsSinceEpoch % 1679616).toRadixString(36)}";
      _installId = id;
      await file.writeAsString(jsonEncode(<String, String>{"installId": id}));
    } catch (e) {
      debugPrint("[InstallIdentity] 读写安装身份失败（用临时 id）: $e");
      _installId ??=
          "inst_tmp_${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}";
    }
  }

  /// 控制面 actor 身份：登录邮箱优先（同一台机器换账号登录，运营数据
  /// 跟着账号走而不是跟着机器走），其次部署配置，最后安装身份。
  Future<String> actorId() async {
    // 自带 load（幂等）：不依赖调用方先初始化账号会话，避免启动竞态
    await AccountSessionStore.instance.load();
    final String? email = AccountSessionStore.instance.email;
    if (email != null && email.isNotEmpty) return email;
    final String u = ApiConfig.userId.trim();
    if (u.isNotEmpty) return u;
    await _ensureLoaded();
    return _installId ?? "local-device";
  }
}
