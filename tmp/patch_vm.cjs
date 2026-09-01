const fs = require('fs');
const p = 'E:/ws-project/Private-Agent/client/flutter_app/lib/features/chat/chat_message_view_model.dart';
let c = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
let n = 0;

// 1. 导入 ApiConfig
c = c.replace(
  'import "../../core/utils/agent_result_parser.dart";',
  'import "../../core/utils/agent_result_parser.dart";\nimport "../../core/config/api_config.dart";'
); n++;

// 2. audio url 补全
c = c.replace('"url": audio.url,', '"url": _abs(audio.url),'); n++;

// 3. _resultItemToJson 中补全
c = c.replace(
  `"url": it.url,
      "mediaType": it.mediaType,
      "mediaUrl": it.mediaUrl,
      "thumbUrl": it.thumbnailUrl,
      "pageUrl": it.pageUrl,`,
  `"url": _abs(it.url),
      "mediaType": it.mediaType,
      "mediaUrl": _abs(it.mediaUrl),
      "thumbUrl": _abs(it.thumbnailUrl),
      "pageUrl": _abs(it.pageUrl),`
); n++;

// 4. _itemToJson 中补全（pick 返回相对路径，统一补全）
c = c.replace(
  `    return <String, dynamic>{
      "type": m["type"]?.toString() ?? "image",
      "text": m["title"]?.toString() ?? "",
      "depth": (m["depth"] as num?)?.toInt() ?? 0,
      "url": pick(const <String>["url"]),
      "mediaType":
          pick(const <String>["mediaType", "type"]) ?? "image",
      "mediaUrl": pick(const <String>["mediaUrl", "imageUrl"]),
      "thumbUrl": pick(const <String>["thumbnailUrl", "thumbUrl"]),
      "pageUrl": pick(const <String>["pageUrl", "sourceUrl"]),`,
  `    return <String, dynamic>{
      "type": m["type"]?.toString() ?? "image",
      "text": m["title"]?.toString() ?? "",
      "depth": (m["depth"] as num?)?.toInt() ?? 0,
      "url": _abs(pick(const <String>["url"])),
      "mediaType":
          pick(const <String>["mediaType", "type"]) ?? "image",
      "mediaUrl": _abs(pick(const <String>["mediaUrl", "imageUrl"])),
      "thumbUrl": _abs(pick(const <String>["thumbnailUrl", "thumbUrl"])),
      "pageUrl": _abs(pick(const <String>["pageUrl", "sourceUrl"])),`
); n++;

// 5. 添加 _abs 工具方法（放在 _formatTime 前）
c = c.replace(
  '  static String _formatTime(DateTime t) {',
  `  /// 相对媒体路径补全为绝对地址（WebView 文档为虚拟源，必须用绝对 URL）。
  static String? _abs(String? url) {
    final String u = (url ?? "").trim();
    if (u.isEmpty) return null;
    if (u.startsWith("http://") || u.startsWith("https://")) return u;
    final String base = ApiConfig.httpBase;
    return u.startsWith("/") ? "$base$u" : "$base/$u";
  }

  static String _formatTime(DateTime t) {`
); n++;

c = c.replace(/\n/g, '\r\n');
fs.writeFileSync(p, c);
console.log('patched', n, '/5; has _abs:', c.includes('_abs(String?'));
