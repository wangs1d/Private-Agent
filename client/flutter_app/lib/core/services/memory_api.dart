import "dart:convert";

import "package:http/http.dart" as http;

import "../config/api_config.dart";
import "access_auth_api.dart";

/// 一条长期记忆（服务端 Mem0 记录的用户可见视图）。
class MemoryItem {
  const MemoryItem({
    required this.id,
    required this.content,
    this.createdAt,
    this.updatedAt,
    this.source,
    this.highSignal = false,
  });

  final String id;
  final String content;
  final String? createdAt;
  final String? updatedAt;

  /// 记忆来源（会话/笔记等，审计用）
  final String? source;
  final bool highSignal;

  static MemoryItem fromJson(Map<String, dynamic> json) => MemoryItem(
        id: json["id"]?.toString() ?? "",
        content: json["content"]?.toString() ?? "",
        createdAt: json["createdAt"]?.toString(),
        updatedAt: json["updatedAt"]?.toString(),
        source: json["source"]?.toString(),
        highSignal: json["highSignal"] as bool? ?? false,
      );
}

/// 记忆管理 API：让用户看见 Agent 记住了什么，并可直接纠正。
///
/// 服务端实现见 `server/src/routes/http/memory-crud.ts`。
class MemoryApi {
  MemoryApi({String? baseUrl, http.Client? client})
      : _baseUrl = baseUrl ?? ApiConfig.httpBase,
        _client = client ?? http.Client();

  final String _baseUrl;
  final http.Client _client;
  static const Duration _timeout = Duration(seconds: 15);
  Map<String, String> get _headers => <String, String>{
        "Content-Type": "application/json",
        ...AccessCredentialStore.instance.authHeaders,
      };

  /// 列出某身份的长期记忆（q 为可选关键词过滤）。
  Future<List<MemoryItem>> list(String actorId, {String? q, int limit = 200}) async {
    final Uri uri = Uri.parse("$_baseUrl/api/memory/items").replace(queryParameters: <String, String>{
      "actorId": actorId,
      if (q != null && q.trim().isNotEmpty) "q": q.trim(),
      "limit": "$limit",
    });
    final http.Response res = await _client.get(uri, headers: _headers).timeout(_timeout);
    if (res.statusCode != 200) {
      throw Exception("获取记忆失败: ${res.statusCode}");
    }
    final Map<String, dynamic> data = jsonDecode(res.body) as Map<String, dynamic>;
    final List<dynamic> items = data["items"] as List<dynamic>? ?? <dynamic>[];
    return items
        .map((e) => MemoryItem.fromJson(e as Map<String, dynamic>))
        .where((m) => m.id.isNotEmpty)
        .toList(growable: false);
  }

  /// 编辑一条记忆（服务端走 mem0 原生 update，向量同步重建）。
  Future<void> update(String actorId, String id, String content) async {
    final http.Response res = await _client
        .post(
          Uri.parse("$_baseUrl/api/memory/update"),
          headers: _headers,
          body: jsonEncode(<String, String>{"actorId": actorId, "id": id, "content": content}),
        )
        .timeout(_timeout);
    if (res.statusCode != 200) {
      throw Exception("更新记忆失败: ${res.statusCode}");
    }
  }

  /// 删除一条记忆（服务端级联清理向量/链接/强化侧表）。
  Future<void> delete(String actorId, String id) async {
    final http.Response res = await _client
        .post(
          Uri.parse("$_baseUrl/api/memory/delete"),
          headers: _headers,
          body: jsonEncode(<String, String>{"actorId": actorId, "id": id}),
        )
        .timeout(_timeout);
    if (res.statusCode != 200) {
      throw Exception("删除记忆失败: ${res.statusCode}");
    }
  }

  /// 读取"我对用户的理解"（USER_PROFILE.md 文本）。
  Future<String> profile(String actorId) async {
    final Uri uri = Uri.parse("$_baseUrl/api/memory/profile").replace(
      queryParameters: <String, String>{"actorId": actorId},
    );
    final http.Response res = await _client.get(uri, headers: _headers).timeout(_timeout);
    if (res.statusCode != 200) {
      throw Exception("获取用户画像失败: ${res.statusCode}");
    }
    final Map<String, dynamic> data = jsonDecode(res.body) as Map<String, dynamic>;
    return data["markdown"]?.toString() ?? "";
  }
}
