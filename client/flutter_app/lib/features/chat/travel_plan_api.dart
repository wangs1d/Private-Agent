import "dart:convert";

import "package:http/http.dart" as http;

import "../../core/config/api_config.dart";
import "travel_plan_models.dart";

/// 行程 HTTP 客户端：对接 /travel/plans 路由域（编辑/搜索/预订/分享）。
class TravelPlanApi {
  TravelPlanApi({String? baseUrl}) : base = baseUrl ?? ApiConfig.httpBase;

  final String base;

  Uri _uri(String path, [Map<String, String>? query]) =>
      Uri.parse("$base$path").replace(queryParameters: query);

  /// 乐观锁头（A6）：携带当前行程版本，服务端不一致时返回 409。
  Map<String, String> _ifMatch(int? version) => <String, String>{
        if (version != null) "if-match": "$version",
      };

  /// 解析 409 冲突响应中的当前版本（服务端 currentVersion 字段）。
  static int? conflictVersion(dynamic errorBody) {
    if (errorBody is Map<String, dynamic>) {
      return (errorBody["currentVersion"] as num?)?.toInt();
    }
    return null;
  }

  /// 统一状态码检查：非 2xx 抛 [TravelApiException]（409 携带服务端当前版本）。
  static void throwForStatus(http.Response res, String actionLabel) {
    if (res.statusCode >= 200 && res.statusCode < 300) return;
    Map<String, dynamic>? body;
    try {
      final dynamic decoded = jsonDecode(res.body);
      if (decoded is Map<String, dynamic>) body = decoded;
    } catch (_) {
      // 非 JSON 错误体：body 保持 null
    }
    throw TravelApiException(
      actionLabel,
      res.statusCode,
      body: body,
    );
  }

  /// 全部行程摘要。
  Future<List<Map<String, dynamic>>> listPlans() async {
    final http.Response res =
        await http.get(_uri("/travel/plans")).timeout(const Duration(seconds: 10));
    if (res.statusCode != 200) {
      throwForStatus(res, "获取行程列表失败");
    }
    final dynamic data = jsonDecode(res.body);
    return <Map<String, dynamic>>[
      if (data is Map<String, dynamic>)
        for (final dynamic p in (data["plans"] as List<dynamic>? ?? const <dynamic>[]))
          if (p is Map<String, dynamic>) p,
    ];
  }

  /// 读取完整行程。
  Future<Map<String, dynamic>> getPlan(String planId) async {
    final http.Response res = await http
        .get(_uri("/travel/plans/$planId"))
        .timeout(const Duration(seconds: 10));
    if (res.statusCode != 200) {
      throwForStatus(res, "获取行程失败");
    }
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// 替换指定条目（body 传 item 字段子集）。
  ///
  /// [version] 传入时启用乐观锁：行程已被其他操作修改会抛
  /// [TravelPlanConflictException]（携带服务端当前版本，刷新后重试即可）。
  Future<Map<String, dynamic>> replaceItem(
    String planId,
    int dayIndex,
    int itemIndex,
    Map<String, dynamic> item, {
    int? version,
  }) async {
    final http.Response res = await http
        .patch(_uri("/travel/plans/$planId/days/$dayIndex/items/$itemIndex"),
            headers: <String, String>{
              "content-type": "application/json",
              ..._ifMatch(version),
            },
            body: jsonEncode(item))
        .timeout(const Duration(seconds: 30));
    throwForStatus(res, "替换条目失败");
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// 删除指定条目。
  Future<Map<String, dynamic>> removeItem(
    String planId,
    int dayIndex,
    int itemIndex, {
    int? version,
  }) async {
    final http.Response res = await http
        .delete(_uri("/travel/plans/$planId/days/$dayIndex/items/$itemIndex"),
            headers: _ifMatch(version))
        .timeout(const Duration(seconds: 30));
    throwForStatus(res, "删除条目失败");
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// 对条目「提意见换一个」：服务端按同类找替代并重计价。
  Future<Map<String, dynamic>> commentItem(
    String planId,
    int dayIndex,
    int itemIndex,
    String comment, {
    int? version,
  }) async {
    final http.Response res = await http
        .post(_uri("/travel/plans/$planId/days/$dayIndex/items/$itemIndex/comment"),
            headers: <String, String>{
              "content-type": "application/json",
              ..._ifMatch(version),
            },
            body: jsonEncode(<String, dynamic>{"comment": comment}))
        .timeout(const Duration(seconds: 60));
    throwForStatus(res, "重新推荐失败");
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// 单项编辑器备选搜索。
  Future<List<Map<String, dynamic>>> searchPois(
    String destination, {
    String type = "",
    String keyword = "",
  }) async {
    final http.Response res = await http
        .get(_uri("/travel/poi-search", <String, String>{
          "destination": destination,
          if (type.isNotEmpty) "type": type,
          if (keyword.isNotEmpty) "keyword": keyword,
        }))
        .timeout(const Duration(seconds: 15));
    if (res.statusCode != 200) {
      throwForStatus(res, "搜索备选失败");
    }
    final dynamic data = jsonDecode(res.body);
    return <Map<String, dynamic>>[
      if (data is Map<String, dynamic>)
        for (final dynamic p in (data["pois"] as List<dynamic>? ?? const <dynamic>[]))
          if (p is Map<String, dynamic>) p,
    ];
  }

  /// 预订清单计价（会员等级 + 绑定平台折扣）。
  Future<Map<String, dynamic>> computeBooking(
    String planId, {
    String memberTier = "normal",
    List<Map<String, String>> boundPlatforms = const <Map<String, String>>[],
  }) async {
    final http.Response res = await http
        .post(_uri("/travel/plans/$planId/booking"),
            headers: const <String, String>{"content-type": "application/json"},
            body: jsonEncode(<String, dynamic>{
              "memberTier": memberTier,
              "boundPlatforms": boundPlatforms,
            }))
        .timeout(const Duration(seconds: 15));
    if (res.statusCode != 200) {
      throwForStatus(res, "计价失败");
    }
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// 生成分享码。
  Future<String> createShareCode(String planId) async {
    final http.Response res = await http
        .post(_uri("/travel/plans/$planId/share"))
        .timeout(const Duration(seconds: 10));
    if (res.statusCode != 200) {
      throwForStatus(res, "生成分享码失败");
    }
    final dynamic data = jsonDecode(res.body);
    return data is Map<String, dynamic> ? data["shareCode"]?.toString() ?? "" : "";
  }

  /// 按分享码读行程。
  Future<Map<String, dynamic>> getPlanByShareCode(String code) async {
    final http.Response res = await http
        .get(_uri("/travel/share/$code"))
        .timeout(const Duration(seconds: 10));
    if (res.statusCode != 200) {
      throwForStatus(res, "分享码无效");
    }
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// 服务端行程 JSON → 面板渲染数据（编辑/重推荐后刷新用）。
  static TravelPlanData toPlanData(Map<String, dynamic> plan) {
    return TravelPlanData.fromPlanJson(plan);
  }
}

/// 行程接口类型化异常（C4）：UI 可按 statusCode / conflict 区分空态与提示文案，
/// 不再拿着裸 `Exception("xx失败: 500")` 无从下手。
class TravelApiException implements Exception {
  TravelApiException(this.message, this.statusCode, {this.body});

  /// 用户可读的失败描述
  final String message;

  /// HTTP 状态码（0 = 网络/超时等请求未达服务端）
  final int statusCode;

  /// 服务端错误响应体（ok:false, error:"…"）
  final Map<String, dynamic>? body;

  /// 409 乐观锁冲突：行程已被其他操作修改，应刷新后重试
  bool get isConflict => statusCode == 409;

  /// 404：行程不存在或已被清理
  bool get isNotFound => statusCode == 404;

  /// 503：服务端规划服务未装配
  bool get isUnavailable => statusCode == 503;

  /// 服务端返回的错误文案（优先于 [message]）
  String? get serverMessage => body?["error"]?.toString();

  @override
  String toString() => serverMessage ?? message;
}
