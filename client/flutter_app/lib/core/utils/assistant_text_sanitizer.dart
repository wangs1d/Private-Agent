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

// 竖线字符类兼容半角 `|` (U+007C) 与全角 `｜` (U+FF5C)：不同 tokenizer 下模型
// 两种形式都会输出（2026-09-11 对齐服务端 DSML_PIPE 的字符类，此前客户端只匹配
// 半角，全角变体整块漏网直透气泡）。第二组竖线可选——服务端实测存在
// `<| | DSML|tool_calls>` 这类无尾竖线的开标签变体。
final RegExp _dsmlToolCallsBlockRe = RegExp(
  r"<\s*/?\s*[|｜]\s*[|｜]?\s*DSML\s*[|｜]\s*[|｜]?\s*tool_calls\s*>[\s\S]*?<\s*/?\s*[|｜]\s*[|｜]?\s*DSML\s*[|｜]\s*[|｜]?\s*tool_calls\s*>",
  caseSensitive: false,
);
final RegExp _dsmlOpenToolCallsBlockRe = RegExp(
  r"<\s*/?\s*[|｜]\s*[|｜]?\s*DSML\s*[|｜]\s*[|｜]?\s*tool_calls\s*>[\s\S]*$",
  caseSensitive: false,
);
final RegExp _dsmlInvokeOrParameterBlockRe = RegExp(
  r"<\s*/?\s*[|｜]\s*[|｜]?\s*DSML\s*[|｜]\s*[|｜]?\s*(?:invoke|parameter)\b[^>]*>[\s\S]*?<\s*/?\s*[|｜]\s*[|｜]?\s*DSML\s*[|｜]\s*[|｜]?\s*(?:invoke|parameter)\s*>",
  caseSensitive: false,
);
final RegExp _dsmlAnyTagRe = RegExp(
  r"<\s*/?\s*[|｜]\s*[|｜]?\s*DSML\s*[|｜]\s*[|｜]?\s*[^>]*>",
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

/// 线程内部帧标签清单（2026-10-08）。
///
/// 与服务端 `server/src/external-model/internal-frames.ts` 的 `INTERNAL_FRAME_TAGS`
/// **逐项对齐**——两边各写一份名单正是此前 [不可信内容围栏] 漏网的根源。
/// 这些帧是写给 LLM 看的线程上下文（回复中断占位 / 摘要区 / 后台任务记录 /
/// 工具结果围栏 / 临时系统指令），被模型原样复读出来时不该出现在气泡里。
const List<String> kInternalFrameTags = <String>[
  "上一轮回复中断",
  "上一轮工具调用已完成但未生成可见回复",
  "session-recap",
  "unsummarized",
  "关键钉",
  "后台任务记录",
  "不可信内容围栏",
  "系统提示",
  "世界状态转移",
  "主动话术",
  "对话时间线",
  "节律提醒",
  "日志固化",
  "多模态消息",
  "已压缩·",
  "本轮用户明确要求不联网",
  "话题切换",
  "话题已切换",
];

final String _internalFrameAlt =
    kInternalFrameTags.map((String t) => RegExp.escape(t)).join("|");

/// XML 形态的上游 harness 注入提醒（2026-10-08 事故根源，与服务端
/// `internal-frames.ts` 的 stripSystemReminderBlocks 同构——两边名单对齐的
/// 教训同 [不可信内容围栏]：只改一边就会漏）。模型把上游 provider 包给它的
/// `<system-reminder>` 原样复读时在此剥掉：闭合块整块删；未闭合块吞无 CJK
/// 的英文提醒行、保留首个含 CJK 的正文行起的内容。
final RegExp _systemReminderBlockRe = RegExp(
  r"<system-reminder>[\s\S]*?</system-reminder>",
  caseSensitive: false,
);
final RegExp _systemReminderOpenRe = RegExp(
  r"<system-reminder>",
  caseSensitive: false,
);
final RegExp _systemReminderOrphanCloseLineRe = RegExp(
  r"^[ \t]*</system-reminder>[ \t]*(?:\n|$)",
  multiLine: true,
  caseSensitive: false,
);
final RegExp _systemReminderAnyTagRe = RegExp(
  r"</?system-reminder>",
  caseSensitive: false,
);
final RegExp _cjkCharRe = RegExp(r"[\u3400-\u4dbf\u4e00-\u9fff]");

String _stripOneUnclosedSystemReminder(String text) {
  final Match? m = _systemReminderOpenRe.firstMatch(text);
  if (m == null) return text;
  final List<String> lines = text.substring(m.end).split("\n");
  int consumed = 0;
  for (; consumed < lines.length; consumed++) {
    if (_cjkCharRe.hasMatch(lines[consumed])) break;
  }
  // 全部行都无 CJK → opener 到 EOF 是纯英文泄漏，全删。
  if (consumed >= lines.length) return text.substring(0, m.start);
  return text.substring(0, m.start) + lines.sublist(consumed).join("\n");
}

String stripSystemReminderBlocks(String text) {
  if (text.isEmpty ||
      !text.toLowerCase().contains("system-reminder")) {
    return text;
  }
  String out = text.replaceAll(_systemReminderBlockRe, "");
  for (var i = 0; i < 8; i++) {
    final String next = _stripOneUnclosedSystemReminder(out);
    if (next == out) break;
    out = next;
  }
  return out
      .replaceAll(_systemReminderOrphanCloseLineRe, "")
      .replaceAll(_systemReminderAnyTagRe, "");
}

/// 闭口的 `[不可信内容围栏]…[/不可信内容围栏]` 整块（块内是工具原始数据）。
final RegExp _fenceBlockRe =
    RegExp(r"\[不可信内容围栏[^\]]*\][\s\S]*?\[\/不可信内容围栏\]");

/// 孤立的围栏开/闭标签行（模型只复读了一半时兜底）。
final RegExp _fenceTagLineRe = RegExp(
  r"^[ \t]*\[\/?不可信内容围栏[^\]]*\][ \t]*(?:\n|$)",
  multiLine: true,
);

/// 整行就是一个内部帧（帧后即使跟同行内容也整行删）。
final RegExp _internalFrameLineRe = RegExp(
  "^[ \\t]*\\[(?:${_internalFrameAlt})[^\\]]*\\][^\\n]*(?:\\n|\$)",
  multiLine: true,
  caseSensitive: false,
);

/// 文本开头的连续内部帧（可能连着多个），剥帧留正文。
final RegExp _internalFrameLeadingRe = RegExp(
  "^[ \\t]*(?:\\[(?:${_internalFrameAlt})[^\\]]*\\][ \\t:：—–-]*)+",
  caseSensitive: false,
);

/// 剥离文本中的线程内部帧，返回可以展示的正文；剥完为空返回空串
/// （调用方据此判断本条不该落气泡）。与服务端 `stripInternalFrames` 同构。
String stripInternalFrames(String text) {
  if (text.isEmpty) return text;
  String out = stripSystemReminderBlocks(text)
      .replaceAll(_fenceBlockRe, "")
      .replaceAll(_fenceTagLineRe, "")
      .replaceAll(_internalFrameLineRe, "");
  // 开头连续帧：循环剥，只动开头不碰正文。
  for (var i = 0; i < 8; i++) {
    final String next = out.replaceFirst(_internalFrameLeadingRe, "");
    if (next == out) break;
    out = next;
  }
  out = out.replaceAll(RegExp(r"\n{3,}"), "\n\n");
  if (out.trim().isEmpty) return "";
  return out;
}

/// 文本（去空白后）是否以内部帧标签开头——整条就是内部帧。
bool isInternalFrameText(String text) {
  final String trimmed = text.trim();
  if (!trimmed.startsWith("[")) return false;
  return _internalFrameLeadingRe.hasMatch(trimmed);
}

String stripAssistantProtocolFrames(String text) {
  // 先剥线程内部帧（整块围栏 / 帧整行 / 开头连续帧），再剥行首时间戳帧、
  // 删整行时间戳帧，最后剥 DSML 工具调用标记。
  return stripDsmlToolCallMarkup(
    stripAllTimestampFrameLines(
      stripAssistantTimestampFrames(stripInternalFrames(text)),
    ),
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
