import "dart:async";
import "dart:convert";

import "package:flutter/foundation.dart" show debugPrint;
import "package:http/http.dart" as http;
import "package:package_info_plus/package_info_plus.dart";

import "../config/api_config.dart";

/// 服务端 `GET /api/client/manifest` 下发的客户端版本清单。
///
/// [channel] 是后期收回 runtime 的总开关：`byok` = 内测期 runtime 随安装包装到
/// 用户机器本地跑（自带 key）；服务器改 `platform` 后客户端下次启动读到即切
/// 统一 API 服务，必要时配合 minVersion 抬升强制淘汰旧版。
class ClientManifest {
  const ClientManifest({
    required this.latest,
    required this.minVersion,
    required this.url,
    required this.notes,
    required this.channel,
  });

  final String latest;
  final String minVersion;
  final String url;
  final String notes;
  final String channel;

  factory ClientManifest.fromJson(Map<String, dynamic> json) => ClientManifest(
        latest: json["latest"]?.toString() ?? "",
        minVersion: json["minVersion"]?.toString() ?? "",
        url: json["url"]?.toString() ?? "",
        notes: json["notes"]?.toString() ?? "",
        channel: json["channel"]?.toString() ?? "byok",
      );
}

enum ClientUpdateStatus { upToDate, optionalUpdate, forcedUpdate }

class ClientUpdateCheckResult {
  const ClientUpdateCheckResult({
    required this.status,
    required this.manifest,
    required this.localVersion,
  });

  final ClientUpdateStatus status;
  final ClientManifest manifest;
  final String localVersion;
}

/// 启动版本检查：拉 manifest 并与本地版本（exe 版本资源，源自 pubspec）比对。
///
/// 任何失败（网络/超时/解析/读版本）都返回 null —— fail-open，绝不因服务器
/// 不可达把用户锁在门外；强锁只在「明确拿到清单 && 低于 minVersion && 下载地址
/// 可用」时触发（url 为空时没有升级出口，一律按可继续使用处理）。
/// 复用持久连接：首次 `http.get` 顶层用法每次新建客户端，Windows debug 下
/// 首调含 ~180ms 初始化开销；保活后手动检查稳定在 ~10ms。
final http.Client _updateHttpClient = http.Client();

Future<ClientUpdateCheckResult?> checkClientUpdate() async {
  try {
    final http.Response res = await _updateHttpClient
        .get(Uri.parse("${ApiConfig.updateManifestUrl}/api/client/manifest"))
        .timeout(const Duration(seconds: 5));
    if (res.statusCode != 200) return null;
    final dynamic body = jsonDecode(utf8.decode(res.bodyBytes));
    if (body is! Map<String, dynamic>) return null;
    final ClientManifest manifest = ClientManifest.fromJson(body);
    if (manifest.latest.isEmpty || manifest.minVersion.isEmpty) return null;

    final PackageInfo info = await PackageInfo.fromPlatform();
    final String local = info.version;

    ClientUpdateStatus status = ClientUpdateStatus.upToDate;
    if (compareVersions(local, manifest.minVersion) < 0) {
      status = manifest.url.isEmpty
          ? ClientUpdateStatus.upToDate
          : ClientUpdateStatus.forcedUpdate;
    } else if (compareVersions(local, manifest.latest) < 0) {
      status = manifest.url.isEmpty
          ? ClientUpdateStatus.upToDate
          : ClientUpdateStatus.optionalUpdate;
    }
    return ClientUpdateCheckResult(
      status: status,
      manifest: manifest,
      localVersion: local,
    );
  } catch (e) {
    debugPrint("[update-check] failed (fail-open): $e");
    return null;
  }
}

List<int> _parseVersionSegments(String v) => v
    .trim()
    .split("+")
    .first
    .split(".")
    .map((String s) => int.tryParse(s.trim()) ?? 0)
    .toList();

/// 点分数字版本比较（负数/0/正数），忽略 `+build` 尾缀。
/// 例：`0.1.15` > `0.1.9`（字符串直接比较会得到相反结果）。
int compareVersions(String a, String b) {
  final List<int> pa = _parseVersionSegments(a);
  final List<int> pb = _parseVersionSegments(b);
  final int len = pa.length > pb.length ? pa.length : pb.length;
  for (int i = 0; i < len; i++) {
    final int x = i < pa.length ? pa[i] : 0;
    final int y = i < pb.length ? pb[i] : 0;
    if (x != y) return x.compareTo(y);
  }
  return 0;
}
