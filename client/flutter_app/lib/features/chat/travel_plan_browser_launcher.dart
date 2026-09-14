import "dart:async";
import "dart:convert";
import "dart:io";

import "package:url_launcher/url_launcher.dart";

import "../../core/config/api_config.dart";
import "../../core/theme/app_theme.dart";
import "../../core/utils/agent_result_parser.dart";
import "travel_plan_models.dart";
import "travel_web_panel_controller.dart" show TravelWebPanelPayload;

/// 行程卡 → 本机 server 页面 + 系统浏览器打开（首选路径）。
///
/// 流程：本地把 [AgentResultData] 转成 panel.html 的 loadPlan 载荷 →
/// `POST /travel-plans` 存进本机 server 内存（24h TTL）→ 用系统浏览器打开
/// `/travel-map?id=xxx`，页面同源取回载荷自行渲染。
///
/// 为什么优先于独立子进程窗口：零额外进程、零 WebView2 纹理中间窗
/// （曾产生透明"幽灵窗"拦截其他应用点击），窗口管理交给系统。
/// server 不可达 / 超时 / 打开失败一律返回 false，调用方降级到
/// [TravelPlanWindowLauncher]（独立子进程窗口）→ 应用内全屏页。
class TravelPlanBrowserLauncher {
  TravelPlanBrowserLauncher._();

  static const Duration _timeout = Duration(seconds: 4);

  /// 尝试经本机 server 用系统浏览器打开行程；失败返回 false。
  static Future<bool> open(AgentResultData data) async {
    HttpClient? client;
    try {
      final TravelPlanData plan = TravelPlanData.from(data);
      final Map<String, dynamic> payload = TravelWebPanelPayload.build(
        plan,
        // 浏览器自带全屏/关闭，页面内按钮语义不同：
        // fullscreen:false 保留页内全屏按钮；closable:false 隐藏页内关闭按钮
        fullscreen: false,
        closable: false,
      );
      // 页面主题令牌组：App 暗色变体 → 深色霓虹；暖色变体 → 浅色
      payload["theme"] =
          AppThemeController.instance.value == AppThemeVariant.dark ? "dark" : "light";

      final Uri base = Uri.parse(ApiConfig.httpBase);
      final Uri storeUri = base.replace(
        path: "${base.path}/travel-plans".replaceAll("//", "/"),
      );

      client = HttpClient()..connectionTimeout = _timeout;
      final HttpClientRequest request = await client
          .postUrl(storeUri)
          .timeout(_timeout);
      request.headers.contentType = ContentType.json;
      request.write(jsonEncode(payload));
      final HttpClientResponse response =
          await request.close().timeout(_timeout);
      if (response.statusCode != 200) return false;
      final String body =
          await response.transform(utf8.decoder).join().timeout(_timeout);
      final Object? decoded = jsonDecode(body);
      final Object? rawId = decoded is Map ? decoded["id"] : null;
      final String id = rawId?.toString() ?? "";
      if (id.isEmpty) return false;

      final Uri pageUri = base.replace(
        path: "${base.path}/travel-map".replaceAll("//", "/"),
        queryParameters: <String, String>{"id": id},
      );
      return launchUrl(pageUri, mode: LaunchMode.externalApplication);
    } catch (_) {
      // server 未启动 / 超时 / 浏览器打开失败：交给调用方降级
      return false;
    } finally {
      client?.close();
    }
  }
}
