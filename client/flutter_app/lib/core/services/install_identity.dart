import "dart:convert";
import "dart:io";

import "package:flutter/foundation.dart" show debugPrint;
import "package:path_provider/path_provider.dart";

import "../config/api_config.dart";

/// 控制面身份：反馈、站内信等运营数据以此 actor 身份落库到管理后台。
///
/// 优先级：`USER_ID`（部署配置，显式指定）> 持久化安装 ID。
/// 安装 ID 首次使用时生成并写入应用支持目录，卸载重装后变化——
/// 在运行时账号体系接入前，先保证「每台机器一个稳定身份」，
/// 让管理后台能区分不同用户，而不是全员撞在同一个烤死的 sessionId 上。
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

  /// 控制面 actor 身份（稳定、按安装隔离）。
  Future<String> actorId() async {
    final String u = ApiConfig.userId.trim();
    if (u.isNotEmpty) return u;
    await _ensureLoaded();
    return _installId ?? "local-device";
  }
}
