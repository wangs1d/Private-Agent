/// 单个时间戳帧单元：`[ts...]]`（容忍残缺——`[ts` 与 `]` 之间可为任意非 `]` 字符，
/// 含换行，如模型复述出的 `[ts\n2026-09-03 21:35:07]`），后接可选的星期与
/// `[now]`/`[3m ago]` 相对时间记号。与服务端 utils/timestamp-frame.ts 保持同构。
final RegExp _frameUnitRe = RegExp(
  r"\[ts[^\]]{0,160}\][ \t]*(?:周[日一二三四五六]?[ \t]*)?(?:\[[^\]]{0,48}\][ \t]*)*",
);
final RegExp _leadingFrameRe = RegExp("^\\s*${_frameUnitRe.pattern}");
/// 整行恰为一个或多个帧 → 连行删除（多行，含行尾换行）。
final RegExp _frameLineRe = RegExp(
  "^[ \t]*${_frameUnitRe.pattern}(?:[ \t]*${_frameUnitRe.pattern})*[ \t]*(?:\n|\$)",
  multiLine: true,
);
/// 行首帧（多行）：帧后即使跟同行正文也剥帧留正文（对齐服务端行为）。
final RegExp _lineStartFrameRe = RegExp(
  "^[ \t]*${_frameUnitRe.pattern}",
  multiLine: true,
);

final RegExp _dsmlToolCallsBlockRe = RegExp(
  r"<\s*/?\s*\|\s*\|\s*DSML\s*\|\s*\|\s*tool_calls\s*>[\s\S]*?<\s*/?\s*\|\s*\|\s*DSML\s*\|\s*\|\s*tool_calls\s*>",
  caseSensitive: false,
);
final RegExp _dsmlOpenToolCallsBlockRe = RegExp(
  r"<\s*/?\s*\|\s*\|\s*DSML\s*\|\s*\|\s*tool_calls\s*>[\s\S]*$",
  caseSensitive: false,
);
final RegExp _dsmlInvokeOrParameterBlockRe = RegExp(
  r"<\s*/?\s*\|\s*\|\s*DSML\s*\|\s*\|\s*(?:invoke|parameter)\b[^>]*>[\s\S]*?<\s*/?\s*\|\s*\|\s*DSML\s*\|\s*\|\s*(?:invoke|parameter)\s*>",
  caseSensitive: false,
);
final RegExp _dsmlAnyTagRe = RegExp(
  r"<\s*/?\s*\|\s*\|\s*DSML\s*\|\s*\|\s*[^>]*>",
  caseSensitive: false,
);

/// 剥掉文本开头连续的时间戳帧（含残缺帧）及剥离后的首部空白。
/// 流式安全：逐 chunk / 逐消息调用都只动开头，不碰正文。
String stripAssistantTimestampFrames(String text) {
  if (text.isEmpty || !text.contains("[ts")) return text;
  String out = text;
  for (var i = 0; i < 4; i++) {
    final Match? m = _leadingFrameRe.firstMatch(out);
    if (m == null) break;
    out = out.substring(m.end);
  }
  return out.replaceFirst(RegExp(r"^\s+"), "");
}

/// 删除文本中的时间戳帧：先整行删除「纯帧行」（含残缺帧），再剥剩余行首的帧，
/// 最后收敛空行。用于 done finalText / 历史加载的兜底清洗。
String stripAllTimestampFrameLines(String text) {
  if (text.isEmpty || !text.contains("[ts")) return text;
  return text
      .replaceAll(_frameLineRe, "")
      .replaceAll(_lineStartFrameRe, "")
      .replaceAll(RegExp(r"\n{3,}"), "\n\n")
      .replaceAll(RegExp(r"[ \t]+\n"), "\n");
}

String stripDsmlToolCallMarkup(String text) {
  if (text.isEmpty || !text.toLowerCase().contains("dsml")) return text;
  return text
      .replaceAll(_dsmlToolCallsBlockRe, "")
      .replaceAll(_dsmlOpenToolCallsBlockRe, "")
      .replaceAll(_dsmlInvokeOrParameterBlockRe, "")
      .replaceAll(_dsmlAnyTagRe, "")
      .replaceAll(RegExp(r"\n{3,}"), "\n\n")
      .replaceAll(RegExp(r"[ \t]+\n"), "\n")
      .trim();
}

String stripAssistantProtocolFrames(String text) {
  // 先剥行首帧（兼容帧与正文同行的旧格式），再删整行帧（清夹在中间的复述帧），
  // 最后剥 DSML 工具调用标记。
  return stripDsmlToolCallMarkup(
    stripAllTimestampFrameLines(stripAssistantTimestampFrames(text)),
  );
}

class AssistantTextSanitizer {
  AssistantTextSanitizer({this.maxPendingLength = 128});

  final int maxPendingLength;

  StringBuffer _pending = StringBuffer();
  bool _resolvedLeadingFrame = false;

  String ingest(String chunk) {
    if (chunk.isEmpty) return "";
    if (_resolvedLeadingFrame) {
      return stripAssistantProtocolFrames(chunk);
    }

    _pending.write(chunk);
    final String buffered = _pending.toString();
    final String trimmed = buffered.trimLeft();

    if (trimmed.isEmpty) return "";

    // 容忍残缺帧：`[ts` 后可能断行/丢冒号（如 "[ts\n2026-09-03 ...]"），
    // 因此只要开头是 "[ts" 就先按住缓冲，等帧闭合（出现 "]"）再一次性剥。
    if (trimmed.startsWith("[ts")) {
      if (!trimmed.contains("]")) {
        if (buffered.length < maxPendingLength) return "";
        _resolvedLeadingFrame = true;
        final String fallback = buffered;
        _pending = StringBuffer();
        return stripAssistantProtocolFrames(fallback);
      }

      _resolvedLeadingFrame = true;
      final String cleaned = stripAssistantProtocolFrames(buffered);
      _pending = StringBuffer();
      return cleaned;
    }

    if (trimmed.startsWith("[")) {
      if (trimmed.length < 4) return "";
      _resolvedLeadingFrame = true;
      final String cleaned = stripAssistantProtocolFrames(buffered);
      _pending = StringBuffer();
      return cleaned;
    }

    _resolvedLeadingFrame = true;
    final String cleaned = stripAssistantProtocolFrames(buffered);
    _pending = StringBuffer();
    return cleaned;
  }

  String drainPending() {
    final String buffered = _pending.toString();
    _pending = StringBuffer();
    _resolvedLeadingFrame = true;
    if (buffered.trimLeft().startsWith("[ts")) return "";
    return stripAssistantProtocolFrames(buffered);
  }

  void reset() {
    _pending = StringBuffer();
    _resolvedLeadingFrame = false;
  }
}
