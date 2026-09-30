import "dart:convert";
import "dart:typed_data";

import "package:http/http.dart" as http;

import "../config/api_config.dart";

/// 模型接入连通测试：客户端直连 OpenAI 兼容端点的 `GET {base}/models`。
///
/// 桌面端无 CORS 限制（dart:io 直连）；key 不经自家服务端，不落任何日志。
/// DeepSeek / OpenAI / Kimi / MiniMax 的 OpenAI 兼容网关均支持 /models，
/// 一次请求同时验证「网络可达 + 密钥有效」。
class ModelApiTestResult {
  const ModelApiTestResult({
    required this.ok,
    required this.latencyMs,
    this.modelCount = 0,
    this.sampleModels = const <String>[],
    this.error,
  });

  final bool ok;
  final int latencyMs;
  final int modelCount;
  final List<String> sampleModels;
  final String? error;

  String get summary {
    if (ok) {
      final String models = sampleModels.isEmpty
          ? "$modelCount 个模型"
          : sampleModels.take(2).join("、") + (modelCount > 2 ? " 等 $modelCount 个模型" : "");
      return "已连接 · $models · ${latencyMs}ms";
    }
    return error ?? "连接失败";
  }
}

class ModelApiTester {
  static const int _timeoutMs = 8000;

  /// [baseUrl] 约定为「纯 base」（如 https://api.deepseek.com/v1）。
  static Future<ModelApiTestResult> test(String baseUrl, String apiKey) async {
    final String base = baseUrl.trim().replaceAll(RegExp(r"/+$"), "");
    if (base.isEmpty) {
      return const ModelApiTestResult(ok: false, latencyMs: 0, error: "请先填写 API Base URL");
    }
    if (apiKey.trim().length < 8) {
      return const ModelApiTestResult(ok: false, latencyMs: 0, error: "API Key 看起来不完整");
    }
    final String url = base.endsWith("/models") ? base : "$base/models";
    final Stopwatch sw = Stopwatch()..start();
    try {
      final http.Response res = await http
          .get(
            Uri.parse(url),
            headers: <String, String>{"Authorization": "Bearer ${apiKey.trim()}"},
          )
          .timeout(const Duration(milliseconds: _timeoutMs));
      sw.stop();
      if (res.statusCode == 401 || res.statusCode == 403) {
        return ModelApiTestResult(
          ok: false,
          latencyMs: sw.elapsedMilliseconds,
          error: "密钥无效（${res.statusCode}）：请核对 API Key",
        );
      }
      if (res.statusCode == 404) {
        return ModelApiTestResult(
          ok: false,
          latencyMs: sw.elapsedMilliseconds,
          error: "端点不支持 /models（404）：请核对 Base URL",
        );
      }
      if (res.statusCode != 200) {
        return ModelApiTestResult(
          ok: false,
          latencyMs: sw.elapsedMilliseconds,
          error: "HTTP ${res.statusCode}：${_shortBody(res.body)}",
        );
      }
      final dynamic parsed = jsonDecode(utf8.decode(res.bodyBytes));
      final List<dynamic> data = (parsed is Map ? parsed["data"] : null) as List<dynamic>? ?? <dynamic>[];
      final List<String> ids = data
          .map((dynamic m) => m is Map ? m["id"]?.toString() : null)
          .whereType<String>()
          .toList(growable: false);
      return ModelApiTestResult(
        ok: true,
        latencyMs: sw.elapsedMilliseconds,
        modelCount: ids.length,
        sampleModels: ids.take(3).toList(growable: false),
      );
    } catch (e) {
      sw.stop();
      String hint;
      final String msg = e.toString();
      if (msg.contains("TimeoutException") || msg.contains("timed out")) {
        hint = "连接超时：检查网络或 Base URL 是否可达";
      } else if (msg.contains("Failed host lookup") || msg.contains("SocketException")) {
        hint = "无法建立连接：检查 Base URL 拼写与网络";
      } else if (msg.contains("FormatException") || msg.contains("Invalid argument")) {
        hint = "URL 格式不正确：应形如 https://api.deepseek.com/v1";
      } else {
        hint = msg.replaceFirst(RegExp(r"^[A-Za-z:]+\s*"), "").split("\n").first;
      }
      return ModelApiTestResult(ok: false, latencyMs: sw.elapsedMilliseconds, error: hint);
    }
  }

  static String _shortBody(String body) {
    try {
      final dynamic parsed = jsonDecode(body);
      if (parsed is Map && parsed["error"] is Map) {
        final String? msg = parsed["error"]["message"]?.toString();
        if (msg != null && msg.isNotEmpty) return msg;
      }
    } catch (_) {/* 非 JSON */}
    final String flat = body.replaceAll(RegExp(r"\s+"), " ").trim();
    return flat.isEmpty ? "无响应体" : (flat.length > 80 ? "${flat.substring(0, 80)}…" : flat);
  }
}

/// 声纹 HTTP 客户端（首启向导注册 + 语音闸验证共用）。
class VoiceprintApi {
  static Map<String, String> get _headers => <String, String>{"Content-Type": "application/json"};

  static Uri _uri(String path) => Uri.parse("${ApiConfig.httpBase}$path");

  static String get _userId => ApiConfig.effectiveActorId;

  static Future<Map<String, dynamic>> status() async {
    try {
      final http.Response res = await http
          .get(
            _uri("/api/voice/voiceprint/status?userId=${Uri.encodeComponent(_userId)}"),
          )
          .timeout(const Duration(seconds: 5));
      return jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
    } catch (_) {
      return <String, dynamic>{"ok": false, "registered": false, "engineReady": false};
    }
  }

  /// [samples]：PCM16 单声道 16k 字节（每段 ≥0.5s，建议 3-4s）。
  static Future<Map<String, dynamic>> register(List<Uint8List> samples) async {
    final http.Response res = await http
        .post(
          _uri("/api/voice/voiceprint/register"),
          headers: _headers,
          body: jsonEncode(<String, dynamic>{
            "userId": _userId,
            "samples": samples.map((Uint8List s) => base64Encode(s)).toList(),
          }),
        )
        .timeout(const Duration(seconds: 30));
    return jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
  }

  /// 验证一段音频是否为已录入用户本人；命中返回 speakerToken。
  static Future<Map<String, dynamic>> verify(Uint8List audio) async {
    final http.Response res = await http
        .post(
          _uri("/api/voice/voiceprint/verify"),
          headers: _headers,
          body: jsonEncode(<String, dynamic>{
            "userId": _userId,
            "audioBase64": base64Encode(audio),
          }),
        )
        .timeout(const Duration(seconds: 15));
    return jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
  }

  static Future<bool> unregister() async {
    try {
      final http.Response res = await http
          .delete(
            _uri("/api/voice/voiceprint?userId=${Uri.encodeComponent(_userId)}"),
          )
          .timeout(const Duration(seconds: 5));
      final dynamic parsed = jsonDecode(utf8.decode(res.bodyBytes));
      return parsed is Map && parsed["ok"] == true;
    } catch (_) {
      return false;
    }
  }
}
