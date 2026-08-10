final RegExp _timestampFrameRe = RegExp(r"^\s*\[ts:[^\]]*\]\s*");

String stripAssistantTimestampFrames(String text) {
  if (text.isEmpty) return text;
  return text.replaceFirst(_timestampFrameRe, "");
}

class AssistantTextSanitizer {
  AssistantTextSanitizer({this.maxPendingLength = 128});

  final int maxPendingLength;

  StringBuffer _pending = StringBuffer();
  bool _resolvedLeadingFrame = false;

  String ingest(String chunk) {
    if (chunk.isEmpty) return "";
    if (_resolvedLeadingFrame) {
      return chunk;
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
        return fallback;
      }

      _resolvedLeadingFrame = true;
      final String cleaned = stripAssistantTimestampFrames(buffered);
      _pending = StringBuffer();
      return cleaned;
    }

    if (trimmed.startsWith("[")) {
      if (trimmed.length < 4) return "";
      _resolvedLeadingFrame = true;
      final String cleaned = stripAssistantTimestampFrames(buffered);
      _pending = StringBuffer();
      return cleaned;
    }

    _resolvedLeadingFrame = true;
    final String cleaned = stripAssistantTimestampFrames(buffered);
    _pending = StringBuffer();
    return cleaned;
  }

  String drainPending() {
    final String buffered = _pending.toString();
    _pending = StringBuffer();
    _resolvedLeadingFrame = true;
    if (buffered.trimLeft().startsWith("[ts:")) return "";
    return stripAssistantTimestampFrames(buffered);
  }

  void reset() {
    _pending = StringBuffer();
    _resolvedLeadingFrame = false;
  }
}
