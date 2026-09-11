import "package:flutter/services.dart" show rootBundle;

// ═══════════════════════════════════════════════════════════════════
// 旅游地图网页资产装载器。
//
// map.html / panel.html 依赖 MapLibre GL JS（原本走 CDN）。WebView 每次冷启动
// 都要等 CDN 脚本下载完才能渲染地图，弱网下是「每次进入都等」的主要来源之一。
// vendor/ 里随包内置了同版本（4.7.1）的 js+css，装载时直接内联进 HTML——
// 零网络依赖、离线可用、首屏显著提速。vendor 缺失时自动回退 CDN 标签。
// ═══════════════════════════════════════════════════════════════════

/// CDN 标记片段（与 html 内引用一字不差，命中才替换）。
const String _kMaplibreCssTag =
    '<link href="https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css" rel="stylesheet" />';
const String _kMaplibreJsTag =
    '<script src="https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>';

final Map<String, String> _htmlCache = <String, String>{};

/// 装载旅游地图相关 HTML（map.html / panel.html），并内联本地 MapLibre。
///
/// [asset] 为 HTML 资产路径；返回可直接交给 WebView `loadStringContent` 的字符串。
/// 资产内容不可变，结果按路径缓存。
Future<String> loadTravelMapHtml(String asset) async {
  final String? cached = _htmlCache[asset];
  if (cached != null) return cached;

  final String html = await rootBundle.loadString(asset);
  final String bundled = await _inlineMaplibre(html);
  _htmlCache[asset] = bundled;
  return bundled;
}

Future<String> _inlineMaplibre(String html) async {
  if (!html.contains(_kMaplibreJsTag) && !html.contains(_kMaplibreCssTag)) {
    return html;
  }
  String js;
  String css;
  try {
    js = await rootBundle.loadString(
      "assets/travel_map/vendor/maplibre-gl.js",
    );
    css = await rootBundle.loadString(
      "assets/travel_map/vendor/maplibre-gl.css",
    );
  } catch (_) {
    // vendor 缺失（旧构建产物等）：保持 CDN 引用不替换
    return html;
  }
  // 内联 script 的安全转义：内容里出现 "</script" 会提前终止脚本块。
  // 字符串字面量内 "<\/script" 与 "</script" 语义相同（\/ == /）。
  js = js.replaceAll("</script", "<\\/script");
  css = css.replaceAll("</style", "<\\/style");
  return html
      .replaceFirst(_kMaplibreCssTag, "<style>\n$css\n</style>")
      .replaceFirst(_kMaplibreJsTag, "<script>\n$js\n</script>");
}
