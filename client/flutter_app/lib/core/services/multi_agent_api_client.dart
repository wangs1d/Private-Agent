import "dart:convert";

import "package:http/http.dart" as http;

/// 子 Agent 后台任务查询（`GET /api/multi-agent/background-tasks`）。
class MultiAgentApiClient {
  MultiAgentApiClient({required this.baseUrl, http.Client? client})
      : _client = client ?? http.Client();

  final String baseUrl;
  final http.Client _client;

  static const Duration _timeout = Duration(seconds: 12);

  Uri _uri(String path, [Map<String, String>? query]) {
    final Uri root = Uri.parse(baseUrl);
    final String rel = path.startsWith("/") ? path.substring(1) : path;
    final Uri u = root.resolve(rel);
    return query == null ? u : u.replace(queryParameters: query);
  }

  Future<Map<String, dynamic>> fetchBackgroundTasks(
    String sessionId, {
    String? messageId,
  }) async {
    final Map<String, String> query = <String, String>{"sessionId": sessionId};
    if (messageId != null && messageId.isNotEmpty) {
      query["messageId"] = messageId;
    }
    final http.Response r = await _client
        .get(_uri("/api/multi-agent/background-tasks", query))
        .timeout(_timeout);
    final Object? decoded = jsonDecode(r.body);
    if (decoded is! Map<String, dynamic>) {
      return <String, dynamic>{"ok": false, "error": "响应格式无效"};
    }
    return decoded;
  }
}
