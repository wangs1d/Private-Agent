import "dart:async";
import "dart:convert";

import "package:http/http.dart" as http;

import "../config/api_config.dart";

/// 笔记 API 通用结果包装。
class NotesApiResult<T> {
  const NotesApiResult._({
    required this.ok,
    this.value,
    this.error,
    this.networkError = false,
  });

  final bool ok;
  final T? value;
  final String? error;
  final bool networkError;

  factory NotesApiResult.success(T value) =>
      NotesApiResult._(ok: true, value: value);
  factory NotesApiResult.failure(String error, {bool networkError = false}) =>
      NotesApiResult._(ok: false, error: error, networkError: networkError);
}

/// 服务端 /notes 端点封装（与 server/src/routes/http/notes.ts 对齐）。
class NotesApiClient {
  NotesApiClient({
    String? baseUrl,
    String? sessionId,
    http.Client? client,
  })  : baseUrl = baseUrl ?? ApiConfig.httpBase,
        sessionId = sessionId ?? ApiConfig.effectiveActorId,
        _client = client ?? http.Client();

  final String baseUrl;
  final String sessionId;
  final http.Client _client;

  static const Duration _timeout = Duration(seconds: 20);

  Uri _uri(String path, [Map<String, String>? query]) {
    final Uri root = Uri.parse(baseUrl);
    final String rel = path.startsWith("/") ? path.substring(1) : path;
    final Uri u = root.resolve(rel);
    return query == null ? u : u.replace(queryParameters: query);
  }

  Map<String, String> _sessionQuery([Map<String, String>? extra]) {
    return <String, String>{
      "sessionId": sessionId,
      if (extra != null) ...extra,
    };
  }

  static Map<String, dynamic>? _tryDecodeBody(http.Response r) {
    if (r.body.isEmpty) return null;
    try {
      final dynamic decoded = jsonDecode(r.body);
      return decoded is Map<String, dynamic> ? decoded : null;
    } catch (_) {
      return null;
    }
  }

  static String _errorMessage(
    Map<String, dynamic>? body,
    int status,
    String fallback,
  ) {
    final dynamic m = body?["error"] ?? body?["message"];
    if (m is String && m.isNotEmpty) return m;
    return "$fallback (HTTP $status)";
  }

  Future<bool> isReachable() async {
    try {
      final http.Response r = await _client
          .get(_uri("/notes", _sessionQuery(<String, String>{"limit": "1"})))
          .timeout(_timeout);
      return r.statusCode >= 200 && r.statusCode < 300;
    } catch (_) {
      return false;
    }
  }

  Future<NotesApiResult<List<Map<String, dynamic>>>> listNotes({
    String? category,
    String? tag,
    int limit = 50,
  }) async {
    final Map<String, String> q = _sessionQuery(<String, String>{
      "limit": limit.toString(),
      if (category != null && category.isNotEmpty) "category": category,
      if (tag != null && tag.isNotEmpty) "tag": tag,
    });
    try {
      final http.Response r =
          await _client.get(_uri("/notes", q)).timeout(_timeout);
      final Map<String, dynamic>? body = _tryDecodeBody(r);
      if (r.statusCode < 200 || r.statusCode >= 300) {
        return NotesApiResult.failure(
          _errorMessage(body, r.statusCode, "拉取笔记失败"),
        );
      }
      final dynamic items = body?["notes"];
      if (items is List) {
        return NotesApiResult.success(
          items.whereType<Map<String, dynamic>>().toList(),
        );
      }
      return NotesApiResult.success(<Map<String, dynamic>>[]);
    } on TimeoutException {
      return NotesApiResult.failure("请求超时", networkError: true);
    } catch (e) {
      return NotesApiResult.failure(e.toString(), networkError: true);
    }
  }

  Future<NotesApiResult<Map<String, dynamic>>> getNote(String id) async {
    try {
      final http.Response r =
          await _client.get(_uri("/notes/$id")).timeout(_timeout);
      final Map<String, dynamic>? body = _tryDecodeBody(r);
      if (r.statusCode == 404) {
        return NotesApiResult.failure("笔记不存在");
      }
      if (r.statusCode < 200 || r.statusCode >= 300) {
        return NotesApiResult.failure(
          _errorMessage(body, r.statusCode, "读取笔记失败"),
        );
      }
      final dynamic n = body?["note"];
      if (n is Map<String, dynamic>) return NotesApiResult.success(n);
      return NotesApiResult.failure("返回数据格式异常");
    } on TimeoutException {
      return NotesApiResult.failure("请求超时", networkError: true);
    } catch (e) {
      return NotesApiResult.failure(e.toString(), networkError: true);
    }
  }

  Future<NotesApiResult<Map<String, dynamic>>> createNote({
    required String title,
    required String content,
    String category = "other",
    List<String> tags = const <String>[],
    String? source,
  }) async {
    try {
      final http.Response r = await _client
          .post(
            _uri("/notes"),
            headers: const <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, Object?>{
              "sessionId": sessionId,
              "title": title,
              "content": content,
              "category": category,
              "tags": tags,
              if (source != null) "source": source,
            }),
          )
          .timeout(_timeout);
      final Map<String, dynamic>? body = _tryDecodeBody(r);
      if (r.statusCode < 200 || r.statusCode >= 300) {
        return NotesApiResult.failure(
          _errorMessage(body, r.statusCode, "创建笔记失败"),
        );
      }
      final dynamic n = body?["note"];
      if (n is Map<String, dynamic>) return NotesApiResult.success(n);
      return NotesApiResult.failure("返回数据格式异常");
    } on TimeoutException {
      return NotesApiResult.failure("请求超时", networkError: true);
    } catch (e) {
      return NotesApiResult.failure(e.toString(), networkError: true);
    }
  }

  Future<NotesApiResult<Map<String, dynamic>>> updateNote(
    String id, {
    String? title,
    String? content,
    String? category,
    List<String>? tags,
    String? source,
  }) async {
    final Map<String, Object?> patch = <String, Object?>{};
    if (title != null) patch["title"] = title;
    if (content != null) patch["content"] = content;
    if (category != null) patch["category"] = category;
    if (tags != null) patch["tags"] = tags;
    if (source != null) patch["source"] = source;
    if (patch.isEmpty) {
      return NotesApiResult.failure("至少传入一个可更新字段");
    }
    try {
      final http.Response r = await _client
          .patch(
            _uri("/notes/$id"),
            headers: const <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(patch),
          )
          .timeout(_timeout);
      final Map<String, dynamic>? body = _tryDecodeBody(r);
      if (r.statusCode < 200 || r.statusCode >= 300) {
        return NotesApiResult.failure(
          _errorMessage(body, r.statusCode, "更新笔记失败"),
        );
      }
      final dynamic n = body?["note"];
      if (n is Map<String, dynamic>) return NotesApiResult.success(n);
      return NotesApiResult.failure("返回数据格式异常");
    } on TimeoutException {
      return NotesApiResult.failure("请求超时", networkError: true);
    } catch (e) {
      return NotesApiResult.failure(e.toString(), networkError: true);
    }
  }

  Future<NotesApiResult<bool>> deleteNote(String id) async {
    try {
      final http.Response r =
          await _client.delete(_uri("/notes/$id")).timeout(_timeout);
      if (r.statusCode == 404) {
        return NotesApiResult.failure("笔记不存在");
      }
      if (r.statusCode < 200 || r.statusCode >= 300) {
        final Map<String, dynamic>? body = _tryDecodeBody(r);
        return NotesApiResult.failure(
          _errorMessage(body, r.statusCode, "删除笔记失败"),
        );
      }
      return NotesApiResult.success(true);
    } on TimeoutException {
      return NotesApiResult.failure("请求超时", networkError: true);
    } catch (e) {
      return NotesApiResult.failure(e.toString(), networkError: true);
    }
  }

  Future<NotesApiResult<List<Map<String, dynamic>>>> searchNotes(
    String query, {
    int topK = 10,
    String? category,
  }) async {
    try {
      final http.Response r = await _client
          .post(
            _uri("/notes/search"),
            headers: const <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, Object?>{
              "sessionId": sessionId,
              "query": query,
              "topK": topK,
              if (category != null) "category": category,
            }),
          )
          .timeout(_timeout);
      final Map<String, dynamic>? body = _tryDecodeBody(r);
      if (r.statusCode < 200 || r.statusCode >= 300) {
        return NotesApiResult.failure(
          _errorMessage(body, r.statusCode, "搜索失败"),
        );
      }
      final dynamic items = body?["results"];
      if (items is List) {
        return NotesApiResult.success(
          items.whereType<Map<String, dynamic>>().toList(),
        );
      }
      return NotesApiResult.success(<Map<String, dynamic>>[]);
    } on TimeoutException {
      return NotesApiResult.failure("请求超时", networkError: true);
    } catch (e) {
      return NotesApiResult.failure(e.toString(), networkError: true);
    }
  }

  Future<NotesApiResult<String>> summarize(String id) async {
    try {
      final http.Response r = await _client
          .post(_uri("/notes/$id/summarize"))
          .timeout(const Duration(seconds: 60));
      final Map<String, dynamic>? body = _tryDecodeBody(r);
      if (r.statusCode < 200 || r.statusCode >= 300) {
        return NotesApiResult.failure(
          _errorMessage(body, r.statusCode, "生成摘要失败"),
        );
      }
      final dynamic s = body?["summary"];
      if (s is String) return NotesApiResult.success(s);
      return NotesApiResult.failure("返回数据格式异常");
    } on TimeoutException {
      return NotesApiResult.failure("请求超时", networkError: true);
    } catch (e) {
      return NotesApiResult.failure(e.toString(), networkError: true);
    }
  }

  Future<NotesApiResult<List<Map<String, dynamic>>>> flashcards(
    String id, {
    int count = 5,
  }) async {
    try {
      final http.Response r = await _client
          .post(
            _uri("/notes/$id/flashcards"),
            headers: const <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, Object?>{"count": count, "persist": true}),
          )
          .timeout(const Duration(seconds: 60));
      final Map<String, dynamic>? body = _tryDecodeBody(r);
      if (r.statusCode < 200 || r.statusCode >= 300) {
        return NotesApiResult.failure(
          _errorMessage(body, r.statusCode, "生成卡片失败"),
        );
      }
      final dynamic arr = body?["flashcards"];
      if (arr is List) {
        return NotesApiResult.success(
          arr.whereType<Map<String, dynamic>>().toList(),
        );
      }
      return NotesApiResult.success(<Map<String, dynamic>>[]);
    } on TimeoutException {
      return NotesApiResult.failure("请求超时", networkError: true);
    } catch (e) {
      return NotesApiResult.failure(e.toString(), networkError: true);
    }
  }

  Future<NotesApiResult<List<Map<String, dynamic>>>> quiz(
    String id, {
    int count = 3,
  }) async {
    try {
      final http.Response r = await _client
          .post(
            _uri("/notes/$id/quiz"),
            headers: const <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, Object?>{"count": count, "persist": true}),
          )
          .timeout(const Duration(seconds: 60));
      final Map<String, dynamic>? body = _tryDecodeBody(r);
      if (r.statusCode < 200 || r.statusCode >= 300) {
        return NotesApiResult.failure(
          _errorMessage(body, r.statusCode, "生成题目失败"),
        );
      }
      final dynamic arr = body?["quiz"];
      if (arr is List) {
        return NotesApiResult.success(
          arr.whereType<Map<String, dynamic>>().toList(),
        );
      }
      return NotesApiResult.success(<Map<String, dynamic>>[]);
    } on TimeoutException {
      return NotesApiResult.failure("请求超时", networkError: true);
    } catch (e) {
      return NotesApiResult.failure(e.toString(), networkError: true);
    }
  }

  Future<NotesApiResult<Map<String, dynamic>>> scheduleReview(
    String id, {
    required DateTime runAt,
    String timezone = "Asia/Shanghai",
    String recurrence = "none",
    String? reminderMessage,
  }) async {
    try {
      final http.Response r = await _client
          .post(
            _uri("/notes/$id/schedule-review"),
            headers: const <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, Object?>{
              "sessionId": sessionId,
              "runAt": runAt.toUtc().toIso8601String(),
              "timezone": timezone,
              "recurrence": recurrence,
              if (reminderMessage != null) "reminderMessage": reminderMessage,
            }),
          )
          .timeout(_timeout);
      final Map<String, dynamic>? body = _tryDecodeBody(r);
      if (r.statusCode < 200 || r.statusCode >= 300) {
        return NotesApiResult.failure(
          _errorMessage(body, r.statusCode, "创建复习提醒失败"),
        );
      }
      body?.remove("note");
      return NotesApiResult.success(body ?? <String, dynamic>{});
    } on TimeoutException {
      return NotesApiResult.failure("请求超时", networkError: true);
    } catch (e) {
      return NotesApiResult.failure(e.toString(), networkError: true);
    }
  }
}
