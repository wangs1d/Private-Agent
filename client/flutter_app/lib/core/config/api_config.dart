import "package:flutter/foundation.dart" show kIsWeb;

/// 与 WebSocket 网关同机时使用；Android 模拟器可 `--dart-define=HTTP_BASE=http://10.0.2.2:3000`。
/// Web（Chrome）请用 `http://localhost:3000`，勿用 127.0.0.1，否则 PATCH/DELETE 会被浏览器以 Failed to fetch 拦截。
/// 双实例联调时可 `--dart-define=SESSION_ID=session-b`；WebSocket 地址可 `--dart-define=WS_URL=ws://10.0.2.2:3000/ws`。
/// 与后端 UAP/世界/记忆对齐的稳定用户 id：`--dart-define=USER_ID=your-login-id`（可选；未设置时 [effectiveActorId] 与 [sessionId] 相同）。
class ApiConfig {
  ApiConfig._();

  static const String _httpBaseFromEnv = String.fromEnvironment("HTTP_BASE");

  /// 主服务 HTTP 根地址。Web 未配置时与当前页面同源主机（:3000），避免 localhost ↔ 127.0.0.1 跨域。
  static String get httpBase {
    if (_httpBaseFromEnv.isNotEmpty) {
      return _normalizeLoopbackForWeb(_httpBaseFromEnv);
    }
    if (kIsWeb) {
      final Uri page = Uri.base;
      if (page.host.isNotEmpty) {
        return "${page.scheme}://${page.host}:3000";
      }
      return "http://localhost:3000";
    }
    return "http://127.0.0.1:3000";
  }

  /// Web 上把 127.0.0.1 换成页面主机，减少 Failed to fetch。
  static String _normalizeLoopbackForWeb(String url) {
    if (!kIsWeb) return url;
    final Uri? parsed = Uri.tryParse(url);
    if (parsed == null || parsed.host != "127.0.0.1") return url;
    final Uri page = Uri.base;
    final String host = page.host.isNotEmpty ? page.host : "localhost";
    return parsed.replace(host: host).toString();
  }

  /// 连接级会话 id（设备/实例）；`session.init` 会原样上报，与 [userId] 并存时后端以 [userId] 为 actor。
  static const String sessionId = String.fromEnvironment(
    "SESSION_ID",
    defaultValue: "session-mvp-001",
  );

  /// 稳定用户 id（登录账号等）；非空时后端 `boundActorId`、世界/记忆/配额均优先用此值。
  static const String userId = String.fromEnvironment(
    "USER_ID",
    defaultValue: "",
  );

  /// 与后端 `boundActorId` 一致：优先 `trim(userId)`，否则 [sessionId]。HTTP `?sessionId=`、本地存储桶、钱包等应使用本值。
  static String get effectiveActorId {
    final String u = userId.trim();
    return u.isNotEmpty ? u : sessionId;
  }

  /// `GET /accounts/me` 等查询参数：配置了 USER_ID 时只传 `userId`，否则传 `sessionId`。
  static Map<String, String> get accountAuthQuery {
    final String u = userId.trim();
    if (u.isNotEmpty) {
      return <String, String>{"userId": u};
    }
    return <String, String>{"sessionId": sessionId};
  }

  /// `POST /accounts/register` 请求体（与 [accountAuthQuery] 规则一致）。
  static Map<String, String> accountRegisterBody(String displayName) {
    final String name = displayName.trim();
    final String u = userId.trim();
    final Map<String, String> m = <String, String>{"displayName": name};
    if (u.isNotEmpty) {
      m["userId"] = u;
    } else {
      m["sessionId"] = sessionId;
    }
    return m;
  }

  /// `POST /accounts/register/email/verify` 请求体（6 位数字码 + 与 [accountAuthQuery] 一致的登录主体）。
  static Map<String, String> accountEmailVerifyBody(String code) {
    final String u = userId.trim();
    final Map<String, String> m = <String, String>{"code": code.trim()};
    if (u.isNotEmpty) {
      m["userId"] = u;
    } else {
      m["sessionId"] = sessionId;
    }
    return m;
  }

  static const String _wsUrlFromEnv = String.fromEnvironment("WS_URL");

  /// WebSocket 地址；未配置时由 [httpBase] 推导。
  static String get wsUrl {
    if (_wsUrlFromEnv.isNotEmpty) {
      return _normalizeLoopbackForWeb(_wsUrlFromEnv);
    }
    final Uri api = Uri.parse(httpBase);
    final String wsScheme = api.scheme == "https" ? "wss" : "ws";
    final int port = api.hasPort ? api.port : 3000;
    return "$wsScheme://${api.host}:$port/ws";
  }

  /// 首次安装时的默认本地加密 PIN（可用 `--dart-define=LOCAL_PIN=` 覆盖）。
  static const String localPin = String.fromEnvironment(
    "LOCAL_PIN",
    defaultValue: "123456",
  );

  /// Agent World 独立站 Web（观战 / 世界 UI；与 `npm run dev:all` 中 :3333 一致）。
  static const String agentWorldUrl = String.fromEnvironment(
    "AGENT_WORLD_URL",
    defaultValue: "http://127.0.0.1:3333",
  );

  static const String _defaultSocialFeedUrl = "http://127.0.0.1:3001";

  /// 社交推文站（用户与 Agent 发帖、评论、点赞；social-platform，默认 :3001）。
  static const String socialFeedUrl = String.fromEnvironment(
    "SOCIAL_FEED_URL",
    defaultValue: _defaultSocialFeedUrl,
  );

  /// @deprecated 使用 [socialFeedUrl]；保留别名兼容旧 dart-define。
  static const String agentLinkUrl = String.fromEnvironment(
    "AGENT_LINK_URL",
    defaultValue: _defaultSocialFeedUrl,
  );
}
