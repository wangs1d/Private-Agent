import "dart:core";

/// 清理 AI 回复中的 Markdown 标记符，返回纯文本
/// 仅用于普通聊天消息展示，不进行富文本渲染
///
/// 处理的标记：
/// - **bold** → bold
/// - ~~strikethrough~~ → strikethrough
/// - *italic* / _italic_ → italic
/// - `code` → code
/// - [text](url) → text
String stripMarkdown(String text) {
  if (text.isEmpty) return text;

  var result = text;

  // 移除删除线 ~~text~~ → text
  result = result.replaceAllMapped(
    RegExp(r"~~(.+?)~~"),
    (m) => m.group(1)!,
  );

  // 移除加粗 **text** → text
  result = result.replaceAllMapped(
    RegExp(r"\*\*(.+?)\*\*"),
    (m) => m.group(1)!,
  );

  // 移除斜体 *text* 或 _text_（排除已处理的加粗）
  result = result.replaceAllMapped(
    RegExp(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)"),
    (m) => m.group(1)!,
  );
  result = result.replaceAllMapped(
    RegExp(r"(?<!\w)_(.+?)_(?!\w)"),
    (m) => m.group(1)!,
  );

  // 移除行内代码 `code` → code
  result = result.replaceAllMapped(
    RegExp(r"`([^`]+)`"),
    (m) => m.group(1)!,
  );

  // 移除链接 [text](url) → text
  result = result.replaceAllMapped(
    RegExp(r"\[([^\]]+)\]\([^)]+\)"),
    (m) => m.group(1)!,
  );

  // 移除标题标记 # ## ### 等（保留文字）
  result = result.replaceAllMapped(
    RegExp(r"^(#{1,6})\s+(.*)$", multiLine: true),
    (m) => m.group(2)!,
  );

  return _fixBrokenSurrogates(result);
}

/// 修复断裂的 Unicode 代理对（surrogate pair）
/// 某些 Emoji（如 🍎🎉）由一对代理码元组成，如果字符串被从中间截断
/// 会产生孤立的代理字符，显示为 � 或 ? 等异常符号
/// 此函数通过 rune 遍历过滤掉无效的孤立代理码元
String _fixBrokenSurrogates(String text) {
  if (text.isEmpty) return text;

  final buffer = StringBuffer();
  for (final rune in text.runes) {
    // 跳过孤立的代理码元（U+D800 ~ U+DFFF）
    // 合法的 Emoji 代理对会被 Dart 的 runes 正确合并为一个 code point
    if (rune >= 0xD800 && rune <= 0xDFFF) {
      continue;
    }
    buffer.writeCharCode(rune);
  }
  return buffer.toString();
}
