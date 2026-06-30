import "dart:async";
import "dart:convert";

import "package:http/http.dart" as http;

import "../config/api_config.dart";

/// 屏幕翻译托盘的极简 API 客户端（只走主服务 HTTP 转发，不直连 Python 进程）。
///
/// 端点：
///   GET  /api/translate/tray-status
///   POST /api/translate/show-window       唤起主面板（用户再点 ✚ 框选）
///   POST /api/translate/enter-select      直接触发框选（隐藏面板 → Live 蒙版）
///   POST /api/translate/enter-live        兼容旧名，等价于 enter-select
class TranslateTrayClient {
  TranslateTrayClient({http.Client? client}) : _client = client ?? http.Client();

  final http.Client _client;
  static const Duration _timeout = Duration(seconds: 3);

  Uri _u(String path) => Uri.parse("${ApiConfig.httpBase}$path");

  /// 探活：返回 (alive, hotkeys, error)。
  Future<TranslateTrayStatus> trayStatus() async {
    try {
      final r = await _client
          .get(_u("/api/translate/tray-status"), headers: const {"Accept": "application/json"})
          .timeout(_timeout);
      if (r.statusCode != 200) {
        return TranslateTrayStatus(alive: false, error: "HTTP ${r.statusCode}");
      }
      final Map<String, dynamic> body = jsonDecode(utf8.decode(r.bodyBytes)) as Map<String, dynamic>;
      return TranslateTrayStatus.fromJson(body);
    } on TimeoutException {
      return const TranslateTrayStatus(alive: false, error: "主服务响应超时");
    } catch (e) {
      return TranslateTrayStatus(alive: false, error: "无法连接主服务: $e");
    }
  }

  /// 唤起翻译主面板（用户再点面板上的 ✚ 按钮去框选）。
  Future<({bool ok, String? error})> showWindow({String? hint}) async {
    return _postJson("/api/translate/show-window", {if (hint != null) "hint": hint});
  }

  /// 直接触发框选翻译（等价于点击主面板的 ✚ 按钮）。
  Future<({bool ok, String? error})> enterSelect() async {
    return _postJson("/api/translate/enter-select", const {});
  }

  Future<({bool ok, String? error})> _postJson(String path, Map<String, dynamic> body) async {
    try {
      final r = await _client
          .post(
            _u(path),
            headers: const {"Content-Type": "application/json", "Accept": "application/json"},
            body: jsonEncode(body),
          )
          .timeout(_timeout);
      final Map<String, dynamic> respBody = jsonDecode(utf8.decode(r.bodyBytes)) as Map<String, dynamic>;
      final bool ok = r.statusCode == 200 && (respBody["ok"] == true);
      return (ok: ok, error: ok ? null : (respBody["error"]?.toString() ?? "HTTP ${r.statusCode}"));
    } on TimeoutException {
      return (ok: false, error: "主服务响应超时");
    } catch (e) {
      return (ok: false, error: "无法连接主服务: $e");
    }
  }

  void dispose() => _client.close();
}

class TranslateTrayStatus {
  const TranslateTrayStatus({
    required this.alive,
    this.hotkeys = const {},
    this.controlUrl,
    this.error,
  });

  factory TranslateTrayStatus.fromJson(Map<String, dynamic> json) {
    final Map<String, dynamic> tray = (json["tray"] as Map?)?.cast<String, dynamic>() ?? const {};
    final Map<String, dynamic> hotkeys =
        (tray["hotkeys"] as Map?)?.cast<String, dynamic>() ?? const <String, dynamic>{};
    return TranslateTrayStatus(
      alive: json["ok"] == true,
      hotkeys: hotkeys.map((k, v) => MapEntry(k, v?.toString() ?? "")),
      controlUrl: json["controlUrl"]?.toString(),
      error: json["error"]?.toString(),
    );
  }

  final bool alive;
  final Map<String, String> hotkeys;
  final String? controlUrl;
  final String? error;
}
