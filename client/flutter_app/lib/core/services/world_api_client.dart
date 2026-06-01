import "dart:convert";

import "package:http/http.dart" as http;

import "../config/api_config.dart";

/// Agent 世界 HTTP API（与 [ApiConfig.httpBase] 搭配使用）。
class WorldApiClient {
  WorldApiClient({required this.baseUrl});

  final String baseUrl;

  Uri _uri(String path, [Map<String, String>? query]) {
    final Uri root = Uri.parse(baseUrl);
    final String rel = path.startsWith("/") ? path.substring(1) : path;
    final Uri u = root.resolve(rel);
    return query == null ? u : u.replace(queryParameters: query);
  }

  Future<Map<String, dynamic>> getState(String sessionId) async {
    final http.Response r = await http.get(_uri("/world/state", <String, String>{"sessionId": sessionId}));
    return _decode(r);
  }

  Future<Map<String, dynamic>> getShop(String sessionId) async {
    final http.Response r = await http.get(_uri("/world/shop", <String, String>{"sessionId": sessionId}));
    return _decode(r);
  }

  /// 观战端：拉取商店目录（不改变 Agent 当前场景；对应 `GET /world/shop/catalog`）。
  Future<Map<String, dynamic>> getShopCatalog(String sessionId) async {
    final http.Response r =
        await http.get(_uri("/world/shop/catalog", <String, String>{"sessionId": sessionId}));
    return _decode(r);
  }

  /// 自由市场总览（切换场景为 `free_market`，含技能与 A2A 分支元数据）。
  Future<Map<String, dynamic>> getFreeMarket(String sessionId) async {
    final http.Response r =
        await http.get(_uri("/world/market", <String, String>{"sessionId": sessionId}));
    return _decode(r);
  }

  /// 自由市场 — 技能分支目录（不改变场景）。
  Future<Map<String, dynamic>> getFreeMarketSkillsCatalog(String sessionId) async {
    final http.Response r = await http
        .get(_uri("/world/market/skills/catalog", <String, String>{"sessionId": sessionId}));
    return _decode(r);
  }

  /// A2A 外包单列表；[filter]：`open`（挂单大厅）或 `mine`（与我相关）。
  Future<Map<String, dynamic>> getFreeMarketContracts(
    String sessionId, {
    String filter = "open",
  }) async {
    final http.Response r = await http.get(
      _uri("/world/market/contracts", <String, String>{
        "sessionId": sessionId,
        "filter": filter,
      }),
    );
    return _decode(r);
  }

  Future<Map<String, dynamic>> purchase(String sessionId, String skillId) async {
    final http.Response r = await http.post(
      _uri("/world/shop/purchase"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(<String, String>{"sessionId": sessionId, "skillId": skillId}),
    );
    return _decode(r);
  }

  Future<Map<String, dynamic>> leisure(String sessionId, {String actionId = "stroll"}) async {
    final http.Response r = await http.post(
      _uri("/world/leisure"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(<String, dynamic>{"sessionId": sessionId, "actionId": actionId}),
    );
    return _decode(r);
  }

  // --- 五子棋（用户与 Agent 对战，非 Agent World 观战）---

  Future<Map<String, dynamic>> gomokuJoin(String sessionId, String tableId, String role) async {
    final http.Response r = await http.post(
      _uri("/world/gomoku/join"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(<String, dynamic>{
        "sessionId": sessionId,
        "tableId": tableId,
        "role": role,
      }),
    );
    return _decode(r);
  }

  Future<Map<String, dynamic>> gomokuPlay(
    String sessionId,
    String tableId,
    int row,
    int col,
  ) async {
    final http.Response r = await http.post(
      _uri("/world/gomoku/play"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(<String, dynamic>{
        "sessionId": sessionId,
        "tableId": tableId,
        "row": row,
        "col": col,
      }),
    );
    return _decode(r);
  }

  Future<Map<String, dynamic>> gomokuLeave(String sessionId, String tableId) async {
    final http.Response r = await http.post(
      _uri("/world/gomoku/leave"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(<String, dynamic>{"sessionId": sessionId, "tableId": tableId}),
    );
    return _decode(r);
  }

  Future<Map<String, dynamic>> gomokuSnapshot(String sessionId, String tableId) async {
    final http.Response r = await http.get(
      _uri("/world/gomoku/table/$tableId", <String, String>{"sessionId": sessionId}),
    );
    return _decode(r);
  }

  Future<Map<String, dynamic>> gomokuCreateTable(
    String sessionId, {
    String userColor = "random",
  }) async {
    final http.Response r = await http.post(
      _uri("/world/gomoku/tables"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(<String, dynamic>{
        "sessionId": sessionId,
        "userColor": userColor,
      }),
    );
    return _decode(r);
  }

  // --- 游戏（用户 vs Agent，与 Agent World 观战分离）---

  Future<Map<String, dynamic>> gameCenterStartGomoku(
    String agentSessionId, {
    String userColor = "random",
  }) async {
    final http.Response r = await http.post(
      _uri("/game-center/gomoku/start"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(<String, dynamic>{
        "agentSessionId": agentSessionId,
        "userColor": userColor,
      }),
    );
    return _decode(r);
  }

  Future<Map<String, dynamic>> gameCenterStartZhajinhua(
    String agentSessionId, {
    int stake = 50,
  }) async {
    final http.Response r = await http.post(
      _uri("/game-center/zhajinhua/start"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(<String, dynamic>{"agentSessionId": agentSessionId, "stake": stake}),
    );
    return _decode(r);
  }

  Future<Map<String, dynamic>> gameCenterZhajinhuaAct(
    String tableId,
    String sessionId,
    String action,
  ) async {
    final http.Response r = await http.post(
      _uri("/game-center/zhajinhua/table/$tableId/act"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(<String, dynamic>{"sessionId": sessionId, "action": action}),
    );
    return _decode(r);
  }

  Future<Map<String, dynamic>> gameCenterZhajinhuaSnapshot(
    String tableId,
    String sessionId,
  ) async {
    final http.Response r = await http.get(
      _uri("/game-center/zhajinhua/table/$tableId", <String, String>{"sessionId": sessionId}),
    );
    return _decode(r);
  }

  Future<Map<String, dynamic>> gameCenterStartDoudizhu(
    String agentSessionId, {
    int stake = 50,
  }) async {
    final http.Response r = await http.post(
      _uri("/game-center/doudizhu/start"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(<String, dynamic>{"agentSessionId": agentSessionId, "stake": stake}),
    );
    return _decode(r);
  }

  Future<Map<String, dynamic>> gameCenterDoudizhuPlay(
    String tableId,
    String sessionId, {
    required String action,
    List<String>? cards,
  }) async {
    final http.Response r = await http.post(
      _uri("/game-center/doudizhu/table/$tableId/play"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(<String, dynamic>{
        "sessionId": sessionId,
        "action": action,
        if (cards != null) "cards": cards,
      }),
    );
    return _decode(r);
  }

  Future<Map<String, dynamic>> gameCenterDoudizhuSnapshot(
    String tableId,
    String sessionId,
  ) async {
    final http.Response r = await http.get(
      _uri("/game-center/doudizhu/table/$tableId", <String, String>{"sessionId": sessionId}),
    );
    return _decode(r);
  }

  Future<Map<String, dynamic>> gameCenterStartBlackjack(
    String agentSessionId, {
    int stake = 50,
  }) async {
    final http.Response r = await http.post(
      _uri("/game-center/blackjack/start"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(<String, dynamic>{"agentSessionId": agentSessionId, "stake": stake}),
    );
    return _decode(r);
  }

  Future<Map<String, dynamic>> gameCenterBlackjackHit(String tableId, String sessionId) async {
    final http.Response r = await http.post(
      _uri("/game-center/blackjack/table/$tableId/hit"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(<String, dynamic>{"sessionId": sessionId}),
    );
    return _decode(r);
  }

  Future<Map<String, dynamic>> gameCenterBlackjackStand(String tableId, String sessionId) async {
    final http.Response r = await http.post(
      _uri("/game-center/blackjack/table/$tableId/stand"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(<String, dynamic>{"sessionId": sessionId}),
    );
    return _decode(r);
  }

  Future<Map<String, dynamic>> gameCenterBlackjackSnapshot(
    String tableId,
    String sessionId,
  ) async {
    final http.Response r = await http.get(
      _uri("/game-center/blackjack/table/$tableId", <String, String>{"sessionId": sessionId}),
    );
    return _decode(r);
  }

  Future<Map<String, dynamic>> zhajinhuaListTables() async {
    final http.Response r = await http.get(_uri("/world/zhajinhua/tables"));
    return _normalizeGameListResponse(_decode(r));
  }

  Future<Map<String, dynamic>> zhajinhuaSnapshot(String sessionId, String tableId) async {
    final http.Response r = await http.get(
      _uri("/world/zhajinhua/table/$tableId", <String, String>{"sessionId": sessionId}),
    );
    return _normalizeGameSnapshotResponse(_decode(r));
  }

  Future<Map<String, dynamic>> doudizhuListTables() async {
    final http.Response r = await http.get(_uri("/world/doudizhu/tables"));
    return _normalizeGameListResponse(_decode(r));
  }

  Future<Map<String, dynamic>> doudizhuSnapshot(String sessionId, String tableId) async {
    final http.Response r = await http.get(
      _uri("/world/doudizhu/table/$tableId", <String, String>{"sessionId": sessionId}),
    );
    return _normalizeGameSnapshotResponse(_decode(r));
  }

  Map<String, dynamic> _normalizeGameListResponse(Map<String, dynamic> data) {
    if (data["ok"] == true) return data;
    return <String, dynamic>{
      "ok": true,
      "tables": data["tables"] ?? <dynamic>[],
    };
  }

  Map<String, dynamic> _normalizeGameSnapshotResponse(Map<String, dynamic> data) {
    if (data["ok"] == true) return data;
    if (data.containsKey("snapshot")) {
      return <String, dynamic>{"ok": true, "snapshot": data["snapshot"]};
    }
    return <String, dynamic>{"ok": true, "snapshot": data};
  }

  /// Agent 互动动态时间线（`GET /world/social/feed`）；带 sessionId 时自家 Agent 帖子优先排序。
  Future<Map<String, dynamic>> socialFeed(String sessionId, {int? limit}) async {
    final Map<String, String> q = <String, String>{"sessionId": sessionId};
    if (limit != null) q["limit"] = limit.toString();
    final http.Response r = await http.get(_uri("/world/social/feed", q));
    return _decode(r);
  }

  /// 上传媒体（Base64 JSON），返回 `mediaUrl`（`/world/social/media/...`）。
  Future<Map<String, dynamic>> socialUploadMedia({
    required String sessionId,
    required String mimeType,
    required String dataBase64,
  }) async {
    final http.Response r = await http.post(
      _uri("/world/social/media"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(<String, String>{
        "sessionId": sessionId,
        "mimeType": mimeType,
        "dataBase64": dataBase64,
      }),
    );
    return _decode(r);
  }

  /// `multipart/form-data`：字段 `sessionId` + 文件字段 `file`（优先于 Base64，体积更省）。
  Future<Map<String, dynamic>> socialUploadMediaForm({
    required String sessionId,
    required List<int> fileBytes,
    required String fileName,
  }) async {
    final Uri uri = _uri("/world/social/media/form");
    final http.MultipartRequest req = http.MultipartRequest("POST", uri);
    req.fields["sessionId"] = sessionId;
    req.files.add(http.MultipartFile.fromBytes("file", fileBytes, filename: fileName));
    final http.StreamedResponse streamed = await req.send();
    final http.Response r = await http.Response.fromStream(streamed);
    return _decode(r);
  }

  Future<Map<String, dynamic>> socialDeletePost(String sessionId, String postId) async {
    final http.Response r = await http.delete(
      _uri("/world/social/post/$postId", <String, String>{"sessionId": sessionId}),
    );
    return _decode(r);
  }

  Future<Map<String, dynamic>> socialReport(String sessionId, String postId, {String? reason}) async {
    final Map<String, dynamic> body = <String, dynamic>{"sessionId": sessionId, "postId": postId};
    if (reason != null && reason.trim().isNotEmpty) {
      body["reason"] = reason.trim();
    }
    final http.Response r = await http.post(
      _uri("/world/social/report"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(body),
    );
    return _decode(r);
  }

  /// Agent 中继入站列表（与 WebSocket 推送同源，便于离线补拉）。
  Future<Map<String, dynamic>> getAgentInbox(String sessionId, {int? limit}) async {
    final Map<String, String> q = <String, String>{"sessionId": sessionId};
    if (limit != null) q["limit"] = limit.toString();
    final http.Response r = await http.get(_uri("/agent/inbox", q));
    return _decode(r);
  }

  Future<Map<String, dynamic>> getAgentRelayConfig() async {
    final http.Response r = await http.get(_uri("/agent/relay/config"));
    return _decode(r);
  }

  Future<Map<String, dynamic>> getAgentPairStatus(String sessionId) async {
    final http.Response r =
        await http.get(_uri("/agent/pair/status", <String, String>{"sessionId": sessionId}));
    return _decode(r);
  }

  Future<Map<String, dynamic>> agentPair(String sessionId, String code) async {
    final http.Response r = await http.post(
      _uri("/agent/pair"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(<String, String>{"sessionId": sessionId, "code": code}),
    );
    return _decode(r);
  }

  Future<Map<String, dynamic>> agentUnpair(String sessionId) async {
    final http.Response r = await http.post(
      _uri("/agent/unpair"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(<String, String>{"sessionId": sessionId}),
    );
    return _decode(r);
  }

  /// 未注册时服务端返回 404，此处转为 `registered: false` 而不抛错。
  /// 使用 [ApiConfig.accountAuthQuery]（`USER_ID` 优先于 `SESSION_ID`）。
  Future<Map<String, dynamic>> getAccountMe() async {
    final http.Response r = await http.get(
      _uri("/accounts/me", ApiConfig.accountAuthQuery),
    );
    if (r.statusCode == 404) {
      return <String, dynamic>{"ok": false, "registered": false};
    }
    return _decode(r);
  }

  Future<Map<String, dynamic>> registerAccount(String displayName) async {
    final http.Response r = await http.post(
      _uri("/accounts/register"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(ApiConfig.accountRegisterBody(displayName)),
    );
    return _decode(r);
  }

  /// 邮箱注册步骤 1：分配占位邮箱（请求体与 [registerAccount] 相同字段）。
  Future<Map<String, dynamic>> startEmailRegistration(String displayName) async {
    final http.Response r = await http.post(
      _uri("/accounts/register/email/start"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(ApiConfig.accountRegisterBody(displayName)),
    );
    return _decode(r);
  }

  /// 邮箱注册步骤 2：拉取待验证信息（含服务端验证码与网关解析的 inboundCodes）。
  Future<Map<String, dynamic>> getEmailRegistrationPending() async {
    final http.Response r = await http.get(
      _uri("/accounts/register/email/pending", ApiConfig.accountAuthQuery),
    );
    return _decode(r);
  }

  /// 邮箱注册步骤 3：提交 6 位验证码并创建账号。
  Future<Map<String, dynamic>> verifyEmailRegistration(String code) async {
    final http.Response r = await http.post(
      _uri("/accounts/register/email/verify"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(ApiConfig.accountEmailVerifyBody(code)),
    );
    return _decode(r);
  }

  /// 当前 Actor 可见的 Skill 清单（含已禁用）；查询参数与 [ApiConfig.accountAuthQuery] 一致。
  Future<Map<String, dynamic>> getChatSkillsLibrary() async {
    final http.Response r = await http.get(
      _uri("/chat/skills", ApiConfig.accountAuthQuery),
    );
    return _decode(r);
  }

  /// 启用或禁用某 Skill（内置与已拥有的社区技能）；请求体附带 Actor 字段。
  Future<Map<String, dynamic>> patchChatSkillEnabled(String skillName, bool enabled) async {
    final Map<String, dynamic> body = <String, dynamic>{
      "skillName": skillName,
      "enabled": enabled,
    };
    for (final MapEntry<String, String> e in ApiConfig.accountAuthQuery.entries) {
      body[e.key] = e.value;
    }
    final http.Response r = await http.patch(
      _uri("/chat/skills/enabled"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(body),
    );
    return _decode(r);
  }

  // ==================== 好友系统 API ====================

  /// 发送好友请求
  Future<Map<String, dynamic>> sendFriendRequest(String toActorId, {String? message}) async {
    final Map<String, dynamic> body = <String, dynamic>{
      "toActorId": toActorId,
      if (message != null && message.isNotEmpty) "message": message,
    };
    for (final MapEntry<String, String> e in ApiConfig.accountAuthQuery.entries) {
      body[e.key] = e.value;
    }
    final http.Response r = await http.post(
      _uri("/friends/request"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(body),
    );
    return _decode(r);
  }

  /// 响应好友请求（接受/拒绝）
  Future<Map<String, dynamic>> respondToFriendRequest(String requestId, bool accept) async {
    final Map<String, dynamic> body = <String, dynamic>{
      "requestId": requestId,
      "accept": accept,
    };
    for (final MapEntry<String, String> e in ApiConfig.accountAuthQuery.entries) {
      body[e.key] = e.value;
    }
    final http.Response r = await http.post(
      _uri("/friends/request/respond"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(body),
    );
    return _decode(r);
  }

  /// 取消好友请求
  Future<Map<String, dynamic>> cancelFriendRequest(String requestId) async {
    final Map<String, dynamic> body = <String, dynamic>{
      "requestId": requestId,
    };
    for (final MapEntry<String, String> e in ApiConfig.accountAuthQuery.entries) {
      body[e.key] = e.value;
    }
    final http.Response r = await http.post(
      _uri("/friends/request/cancel"),
      headers: <String, String>{"Content-Type": "application/json"},
      body: jsonEncode(body),
    );
    return _decode(r);
  }

  /// 获取 incoming 好友请求（别人发给我的）
  Future<Map<String, dynamic>> getIncomingFriendRequests() async {
    final http.Response r = await http.get(
      _uri("/friends/requests/incoming", ApiConfig.accountAuthQuery),
    );
    return _decode(r);
  }

  /// 获取 outgoing 好友请求（我发给别人的）
  Future<Map<String, dynamic>> getOutgoingFriendRequests() async {
    final http.Response r = await http.get(
      _uri("/friends/requests/outgoing", ApiConfig.accountAuthQuery),
    );
    return _decode(r);
  }

  /// 获取所有好友请求历史
  Future<Map<String, dynamic>> getAllFriendRequests() async {
    final http.Response r = await http.get(
      _uri("/friends/requests/all", ApiConfig.accountAuthQuery),
    );
    return _decode(r);
  }

  /// 获取好友列表
  Future<Map<String, dynamic>> getFriendsList() async {
    final http.Response r = await http.get(
      _uri("/friends/list", ApiConfig.accountAuthQuery),
    );
    return _decode(r);
  }

  /// 检查好友关系
  Future<Map<String, dynamic>> checkFriendship(String targetActorId) async {
    final Map<String, String> query = Map<String, String>.from(ApiConfig.accountAuthQuery);
    query["targetActorId"] = targetActorId;
    final http.Response r = await http.get(
      _uri("/friends/check", query),
    );
    return _decode(r);
  }

  Map<String, dynamic> _decode(http.Response r) {
    final Object? data = jsonDecode(utf8.decode(r.bodyBytes));
    if (data is Map<String, dynamic>) return data;
    if (data is Map) return data.cast<String, dynamic>();
    throw FormatException("Invalid JSON: ${r.body}");
  }
}
