import "../../../core/config/api_config.dart";
import "../../../core/utils/agent_result_parser.dart";

/// display_effects 模块自用的媒体地址工具。
///
/// 独立于 agent_result_card.dart 的同名实现（模块自包含，避免循环导入）：
///   - [extractUrlFromText]：从文本中提取第一个 http(s) URL；
///   - [resolveMediaUrl]：相对地址补全为完整代理地址；
///   - [resolveItemPreviewUrl]：按 thumbnail → mediaUrl → url → 文本内 URL
///     的优先级解析条目可用预览图。
String? extractUrlFromText(String text) {
  final RegExpMatch? m = RegExp(r'https?://\S+').firstMatch(text);
  if (m == null) return null;
  return m.group(0)!.replaceAll(RegExp(r'[),.;，。！？、]+$'), '');
}

String resolveMediaUrl(String url) {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  final String base = ApiConfig.httpBase;
  if (url.startsWith("/")) return "$base$url";
  return "$base/$url";
}

String? resolveItemPreviewUrl(AgentResultItem it) {
  final String? textUrl = extractUrlFromText(it.text);
  for (final String? v in <String?>[
    it.thumbnailUrl,
    it.mediaType == "video" ? null : it.mediaUrl,
    it.url,
    textUrl,
  ]) {
    final String t = (v ?? "").trim();
    if (t.isNotEmpty) return resolveMediaUrl(t);
  }
  return null;
}
