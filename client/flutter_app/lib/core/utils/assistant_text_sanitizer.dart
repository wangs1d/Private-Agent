final RegExp _timestampFrameRe = RegExp(r"^\s*\[ts:[^\]]*\]\s*");
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

String stripAssistantTimestampFrames(String text) {
  if (text.isEmpty) return text;
  return text.replaceFirst(_timestampFrameRe, "");
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
  return stripDsmlToolCallMarkup(stripAssistantTimestampFrames(text));
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

    if (trimmed.startsWith("[ts:")) {
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
    if (buffered.trimLeft().startsWith("[ts:")) return "";
    return stripAssistantProtocolFrames(buffered);
  }

  void reset() {
    _pending = StringBuffer();
    _resolvedLeadingFrame = false;
  }
}
