import "dart:async";
import "dart:convert";

import "package:http/http.dart" as http;

import "../config/api_config.dart";

class WechatClawApiResult<T> {
  const WechatClawApiResult._({
    required this.ok,
    this.value,
    this.error,
    this.networkError = false,
  });

  final bool ok;
  final T? value;
  final String? error;
  final bool networkError;

  factory WechatClawApiResult.success(T value) =>
      WechatClawApiResult._(ok: true, value: value);

  factory WechatClawApiResult.failure(String error, {bool networkError = false}) =>
      WechatClawApiResult._(ok: false, error: error, networkError: networkError);
}

class WechatClawStatus {
  const WechatClawStatus({
    required this.enabled,
    required this.gatewayReachable,
    required this.bound,
    required this.channelConnected,
    required this.boundAt,
    required this.channel,
    required this.actorId,
    this.message,
    this.weixinAccountId,
  });

  factory WechatClawStatus.fromJson(Map<String, dynamic> json) {
    return WechatClawStatus(
      enabled: json["enabled"] == true,
      gatewayReachable: json["gatewayReachable"] == true,
      bound: json["bound"] == true,
      channelConnected: json["channelConnected"] == true,
      boundAt: json["boundAt"] as String?,
      channel: json["channel"] as String? ?? "openclaw-weixin",
      actorId: json["actorId"] as String? ?? ApiConfig.effectiveActorId,
      message: json["message"] as String?,
      weixinAccountId: json["weixinAccountId"] as String?,
    );
  }

  final bool enabled;
  final bool gatewayReachable;
  final bool bound;
  final bool channelConnected;
  final String? boundAt;
  final String channel;
  final String actorId;
  final String? message;
  final String? weixinAccountId;
}

class WechatClawLoginResult {
  const WechatClawLoginResult({
    required this.ok,
    this.qrLink,
    this.qrDataUrl,
    this.connected = false,
    this.message,
  });

  factory WechatClawLoginResult.fromJson(Map<String, dynamic> json) {
    return WechatClawLoginResult(
      ok: json["ok"] == true,
      qrLink: json["qrLink"] as String?,
      qrDataUrl: json["qrDataUrl"] as String?,
      connected: json["connected"] == true,
      message: json["message"] as String?,
    );
  }

  final bool ok;
  final String? qrLink;
  final String? qrDataUrl;
  final bool connected;
  final String? message;
}

/// 微信 Claw 绑定 API（OpenClaw Gateway 代理）。
class WechatClawApiClient {
  WechatClawApiClient({required this.baseUrl, http.Client? client})
      : _client = client ?? http.Client();

  final String baseUrl;
  final http.Client _client;

  static const Duration _waitTimeout = Duration(seconds: 95);

  static bool _isTransientNetworkError(Object e) {
    if (e is TimeoutException) return true;
    if (e is http.ClientException) return true;
    return false;
  }

  Uri _uri(String path, [Map<String, String>? query]) {
    final Uri root = Uri.parse(baseUrl);
    final String rel = path.startsWith("/") ? path.substring(1) : path;
    final Uri u = root.resolve(rel);
    return query == null ? u : u.replace(queryParameters: query);
  }

  Map<String, String> _actorQuery() {
    final String u = ApiConfig.userId.trim();
    if (u.isNotEmpty) {
      return <String, String>{"userId": u};
    }
    return <String, String>{"sessionId": ApiConfig.sessionId};
  }

  Map<String, dynamic> _actorBody([Map<String, dynamic>? extra]) {
    final Map<String, dynamic> body = <String, dynamic>{..._actorQuery()};
    if (extra != null) body.addAll(extra);
    return body;
  }

  Map<String, dynamic>? _tryDecode(http.Response r) {
    try {
      return jsonDecode(r.body) as Map<String, dynamic>;
    } catch (_) {
      return null;
    }
  }

  String _err(Map<String, dynamic>? body, int code, String fallback) {
    final dynamic m = body?["message"] ?? body?["error"];
    if (m is String && m.trim().isNotEmpty) return m;
    return "$fallback (HTTP $code)";
  }

  Future<WechatClawApiResult<WechatClawStatus>> fetchStatus() async {
    try {
      final http.Response r = await _client
          .get(_uri("/integrations/wechat-claw/status", _actorQuery()))
          .timeout(const Duration(seconds: 20));
      final Map<String, dynamic>? body = _tryDecode(r);
      if (r.statusCode < 200 || r.statusCode >= 300 || body?["ok"] != true) {
        return WechatClawApiResult.failure(
          _err(body, r.statusCode, "拉取绑定状态失败"),
        );
      }
      return WechatClawApiResult.success(WechatClawStatus.fromJson(body!));
    } on Object catch (e) {
      return WechatClawApiResult.failure(
        "无法连接服务端",
        networkError: _isTransientNetworkError(e),
      );
    }
  }

  Future<WechatClawApiResult<WechatClawLoginResult>> startLogin({bool force = false}) async {
    try {
      final http.Response r = await _client
          .post(
            _uri("/integrations/wechat-claw/login/start"),
            headers: const <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(_actorBody(<String, dynamic>{"force": force})),
          )
          .timeout(const Duration(seconds: 30));
      final Map<String, dynamic>? body = _tryDecode(r);
      if (r.statusCode < 200 || r.statusCode >= 300 || body?["ok"] != true) {
        return WechatClawApiResult.failure(
          _err(body, r.statusCode, "启动扫码失败"),
        );
      }
      return WechatClawApiResult.success(WechatClawLoginResult.fromJson(body!));
    } on Object catch (e) {
      return WechatClawApiResult.failure(
        "无法连接服务端",
        networkError: _isTransientNetworkError(e),
      );
    }
  }

  Future<WechatClawApiResult<WechatClawLoginResult>> waitLogin({
    bool qrKnown = false,
    String? currentQrDataUrl,
    int timeoutMs = 25000,
  }) async {
    try {
      final http.Response r = await _client
          .post(
            _uri("/integrations/wechat-claw/login/wait"),
            headers: const <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(_actorBody(<String, dynamic>{
              if (qrKnown) "qrKnown": true,
              if (currentQrDataUrl != null && currentQrDataUrl.isNotEmpty)
                "currentQrDataUrl": currentQrDataUrl,
              "timeoutMs": timeoutMs,
            })),
          )
          .timeout(_waitTimeout);
      final Map<String, dynamic>? body = _tryDecode(r);
      if (r.statusCode < 200 || r.statusCode >= 300 || body?["ok"] != true) {
        return WechatClawApiResult.failure(
          _err(body, r.statusCode, "等待扫码失败"),
        );
      }
      return WechatClawApiResult.success(WechatClawLoginResult.fromJson(body!));
    } on TimeoutException {
      return WechatClawApiResult.failure("等待扫码超时，请继续扫码或重试", networkError: false);
    } on Object catch (e) {
      final bool net = _isTransientNetworkError(e);
      return WechatClawApiResult.failure(
        net ? "无法连接服务端，请确认后端已启动" : "等待扫码失败",
        networkError: net,
      );
    }
  }

  Future<WechatClawApiResult<void>> unbind() async {
    try {
      final http.Response r = await _client
          .post(
            _uri("/integrations/wechat-claw/unbind"),
            headers: const <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(_actorBody()),
          )
          .timeout(const Duration(seconds: 30));
      final Map<String, dynamic>? body = _tryDecode(r);
      if (r.statusCode < 200 || r.statusCode >= 300 || body?["ok"] != true) {
        return WechatClawApiResult.failure(
          _err(body, r.statusCode, "解除绑定失败"),
        );
      }
      return WechatClawApiResult.success(null);
    } on Object catch (e) {
      return WechatClawApiResult.failure(
        "无法连接服务端",
        networkError: _isTransientNetworkError(e),
      );
    }
  }
}

List<int>? decodeQrDataUrl(String? dataUrl) {
  if (dataUrl == null || dataUrl.isEmpty) return null;
  final RegExpMatch? m = RegExp(r"^data:image/[^;]+;base64,(.+)$").firstMatch(dataUrl.trim());
  if (m == null) return null;
  try {
    return base64Decode(m.group(1)!);
  } catch (_) {
    return null;
  }
}
