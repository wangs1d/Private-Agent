import "dart:convert";

import "package:http/http.dart" as http;

import "../config/api_config.dart";
import "access_auth_api.dart";

/// 站内信 API 通用结果包装。
class InboxApiResult<T> {
  const InboxApiResult._({required this.ok, this.value, this.error});

  final bool ok;
  final T? value;
  final String? error;

  factory InboxApiResult.success(T value) =>
      InboxApiResult._(ok: true, value: value);
  factory InboxApiResult.failure(String error) =>
      InboxApiResult._(ok: false, error: error);
}

/// 一条站内信（服务端 InboxService 透出）。
class InboxMessageItem {
  const InboxMessageItem({
    required this.messageId,
    required this.title,
    required this.body,
    required this.kind,
    required this.importance,
    required this.createdAt,
    required this.read,
    this.fromActorId,
  });

  final String messageId;
  final String title;
  final String body;

  /// 消息分类：system / announcement / friend / ...
  final String kind;

  /// low / normal / high / critical。
  final String importance;
  final String? fromActorId;
  final DateTime? createdAt;
  final bool read;

  factory InboxMessageItem.fromJson(Map<String, dynamic> json) {
    return InboxMessageItem(
      messageId: json["messageId"]?.toString() ?? "",
      title: json["title"]?.toString() ?? "",
      body: json["body"]?.toString() ?? "",
      kind: json["kind"]?.toString() ?? "system",
      importance: json["importance"]?.toString() ?? "normal",
      fromActorId: json["fromActorId"]?.toString(),
      createdAt: DateTime.tryParse(json["createdAt"]?.toString() ?? ""),
      read: json["readAt"] != null,
    );
  }
}

/// 站内信 API 客户端（服务端实现：server/src/routes/http/inbox.ts）。
///
/// 消息由平台/运营侧经 POST /api/inbox/send 推送；客户端只负责
/// 拉取（GET /api/inbox/messages）、已读（POST /api/inbox/read）与未读数。
class InboxApi {
  InboxApi({String? baseUrl, http.Client? client})
      : _baseUrl = baseUrl ?? ApiConfig.httpBase,
        _client = client ?? http.Client();

  final String _baseUrl;
  final http.Client _client;

  static const Duration _timeout = Duration(seconds: 10);

  Map<String, String> get _headers => <String, String>{
        "Content-Type": "application/json",
        ...AccessCredentialStore.instance.authHeaders,
      };

  /// 拉取收件箱（返回消息列表 + 未读数）。
  Future<InboxApiResult<InboxSnapshot>> list({int limit = 100}) async {
    try {
      final Uri uri = Uri.parse("$_baseUrl/api/inbox/messages").replace(
        queryParameters: <String, String>{
          "userId": ApiConfig.effectiveActorId,
          "limit": "$limit",
        },
      );
      final http.Response res =
          await _client.get(uri, headers: _headers).timeout(_timeout);
      if (res.statusCode != 200) {
        return InboxApiResult.failure("获取站内信失败: ${res.statusCode}");
      }
      final Map<String, dynamic> data =
          jsonDecode(res.body) as Map<String, dynamic>;
      if (data["ok"] != true) {
        return InboxApiResult.failure(
            data["error"]?.toString() ?? "获取站内信失败");
      }
      final List<dynamic> raw = data["messages"] as List<dynamic>? ?? const [];
      return InboxApiResult.success(InboxSnapshot(
        messages: raw
            .map((dynamic e) =>
                InboxMessageItem.fromJson((e as Map).cast<String, dynamic>()))
            .toList(),
        unreadCount: (data["unreadCount"] as num?)?.toInt() ?? 0,
      ));
    } catch (e) {
      return InboxApiResult.failure("网络错误: $e");
    }
  }

  /// 批量置已读；[ids] 缺省时标记全部未读。返回实际标记条数。
  Future<InboxApiResult<int>> markRead({List<String>? ids}) async {
    try {
      final http.Response res = await _client
          .post(
            Uri.parse("$_baseUrl/api/inbox/read"),
            headers: _headers,
            body: jsonEncode(<String, dynamic>{
              "userId": ApiConfig.effectiveActorId,
              if (ids != null) "ids": ids,
            }),
          )
          .timeout(_timeout);
      final Map<String, dynamic> data =
          jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode != 200 || data["ok"] != true) {
        return InboxApiResult.failure(
          data["error"]?.toString() ?? "操作失败: ${res.statusCode}",
        );
      }
      return InboxApiResult.success((data["marked"] as num?)?.toInt() ?? 0);
    } catch (e) {
      return InboxApiResult.failure("网络错误: $e");
    }
  }

  /// 未读数（角标轮询用）。
  Future<InboxApiResult<int>> unreadCount() async {
    try {
      final Uri uri = Uri.parse("$_baseUrl/api/inbox/unread-count").replace(
        queryParameters: <String, String>{
          "userId": ApiConfig.effectiveActorId,
        },
      );
      final http.Response res =
          await _client.get(uri, headers: _headers).timeout(_timeout);
      if (res.statusCode != 200) {
        return InboxApiResult.failure("获取未读数失败: ${res.statusCode}");
      }
      final Map<String, dynamic> data =
          jsonDecode(res.body) as Map<String, dynamic>;
      if (data["ok"] != true) {
        return InboxApiResult.failure(
            data["error"]?.toString() ?? "获取未读数失败");
      }
      return InboxApiResult.success((data["unreadCount"] as num?)?.toInt() ?? 0);
    } catch (e) {
      return InboxApiResult.failure("网络错误: $e");
    }
  }
}

/// 收件箱快照：消息列表 + 未读数。
class InboxSnapshot {
  const InboxSnapshot({
    this.messages = const <InboxMessageItem>[],
    this.unreadCount = 0,
  });

  final List<InboxMessageItem> messages;
  final int unreadCount;
}
