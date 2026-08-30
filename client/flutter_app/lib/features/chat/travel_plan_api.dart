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

  /// 全部行程摘要。
  Future<List<Map<String, dynamic>>> listPlans() async {
    final http.Response res =
        await http.get(_uri("/travel/plans")).timeout(const Duration(seconds: 10));
    if (res.statusCode != 200) {
      throw Exception("获取行程列表失败: ${res.statusCode}");
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
      throw Exception("获取行程失败: ${res.statusCode}");
    }
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// 替换指定条目（body 传 item 字段子集）。
  Future<Map<String, dynamic>> replaceItem(
    String planId,
    int dayIndex,
    int itemIndex,
    Map<String, dynamic> item,
  ) async {
    final http.Response res = await http
        .patch(_uri("/travel/plans/$planId/days/$dayIndex/items/$itemIndex"),
            headers: const <String, String>{"content-type": "application/json"},
            body: jsonEncode(item))
        .timeout(const Duration(seconds: 30));
    if (res.statusCode != 200) {
      throw Exception("替换条目失败: ${res.statusCode}");
    }
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// 删除指定条目。
  Future<Map<String, dynamic>> removeItem(
    String planId,
    int dayIndex,
    int itemIndex,
  ) async {
    final http.Response res = await http
        .delete(_uri("/travel/plans/$planId/days/$dayIndex/items/$itemIndex"))
        .timeout(const Duration(seconds: 30));
    if (res.statusCode != 200) {
      throw Exception("删除条目失败: ${res.statusCode}");
    }
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// 对条目「提意见换一个」：服务端按同类找替代并重计价。
  Future<Map<String, dynamic>> commentItem(
    String planId,
    int dayIndex,
    int itemIndex,
    String comment,
  ) async {
    final http.Response res = await http
        .post(_uri("/travel/plans/$planId/days/$dayIndex/items/$itemIndex/comment"),
            headers: const <String, String>{"content-type": "application/json"},
            body: jsonEncode(<String, dynamic>{"comment": comment}))
        .timeout(const Duration(seconds: 60));
    if (res.statusCode != 200) {
      throw Exception("重新推荐失败: ${res.statusCode}");
    }
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
      throw Exception("搜索备选失败: ${res.statusCode}");
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
      throw Exception("计价失败: ${res.statusCode}");
    }
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// 生成分享码。
  Future<String> createShareCode(String planId) async {
    final http.Response res = await http
        .post(_uri("/travel/plans/$planId/share"))
        .timeout(const Duration(seconds: 10));
    if (res.statusCode != 200) {
      throw Exception("生成分享码失败: ${res.statusCode}");
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
      throw Exception("分享码无效: ${res.statusCode}");
    }
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// 服务端行程 JSON → 面板渲染数据（编辑/重推荐后刷新用）。
  static TravelPlanData toPlanData(Map<String, dynamic> plan) {
    return TravelPlanData.fromPlanJson(plan);
  }
}
