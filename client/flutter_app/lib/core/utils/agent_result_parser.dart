import "dart:convert";

/// 智能体结果卡片的数据模型。
///
/// 服务端（或前端脚本）按以下格式把结构化数据注入到消息文本里，
/// 解析器会把它从普通文本中剥离并渲染为 [AgentResultCard]。
///
/// 协议（参考）：
/// ```
/// [AGENT_RESULT_CARD_START]
/// {"avatar":"NB","avatarStyle":"default","title":"...","items":[...],"footer":"..."}
/// [AGENT_RESULT_CARD_END]
/// ```
class AgentResultItem {
  const AgentResultItem({required this.type, required this.text});

  /// "check"（✓ 已完成） / "num"（• 序号） / "warn"（! 警告）
  final String type;
  final String text;

  factory AgentResultItem.fromJson(Map<String, dynamic> json) {
    return AgentResultItem(
      type: json["type"]?.toString() ?? "check",
      text: json["text"]?.toString() ?? "",
    );
  }
}

class AgentResultData {
  const AgentResultData({
    this.avatar = "NB",
    this.avatarStyle = "default",
    this.title = "",
    this.items = const <AgentResultItem>[],
    this.footer = "",
  });

  /// 智能体头像缩写（默认 "NB"）。
  final String avatar;

  /// 头像配色：default | gradient | accent | success
  final String avatarStyle;

  /// 卡片标题（第一行）。
  final String title;

  /// 条目列表。
  final List<AgentResultItem> items;

  /// 底部附加文案（可选，可包含简单 inline 标签）。
  final String footer;

  factory AgentResultData.fromJson(Map<String, dynamic> json) {
    final List<dynamic>? rawItems = json["items"] as List<dynamic>?;
    return AgentResultData(
      avatar: json["avatar"]?.toString() ?? "NB",
      avatarStyle: json["avatarStyle"]?.toString() ?? "default",
      title: json["title"]?.toString() ?? "",
      items: rawItems
              ?.whereType<Map<String, dynamic>>()
              .map(AgentResultItem.fromJson)
              .toList() ??
          const <AgentResultItem>[],
      footer: json["footer"]?.toString() ?? "",
    );
  }
}

class AgentResultParseResult {
  const AgentResultParseResult({
    required this.data,
    required this.cleanedText,
  });

  final AgentResultData? data;
  final String cleanedText;
}

class AgentResultParser {
  AgentResultParser._();

  static const String startMarker = "[AGENT_RESULT_CARD_START]";
  static const String endMarker = "[AGENT_RESULT_CARD_END]";

  static final RegExp _blockPattern = RegExp(
    r'\[AGENT_RESULT_CARD_START\]([\s\S]*?)\[AGENT_RESULT_CARD_END\]',
  );

  /// 解析一段消息文本：若包含结果卡片标记则返回 [data] 与剥离后的 cleanedText；
  /// 否则 [data] 为 null，cleanedText 与原文本相同。
  static AgentResultParseResult parse(String text) {
    if (text.isEmpty) {
      return AgentResultParseResult(data: null, cleanedText: text);
    }
    final RegExpMatch? match = _blockPattern.firstMatch(text);
    if (match == null) {
      return AgentResultParseResult(data: null, cleanedText: text);
    }
    final String rawJson = match.group(1)?.trim() ?? "";
    AgentResultData? data;
    if (rawJson.isNotEmpty) {
      try {
        final dynamic decoded = jsonDecode(rawJson);
        if (decoded is Map<String, dynamic>) {
          data = AgentResultData.fromJson(decoded);
        }
      } catch (_) {
        // JSON 损坏 → 静默回退为普通文本
        data = null;
      }
    }
    final String cleaned = text.replaceRange(match.start, match.end, "").trim();
    return AgentResultParseResult(data: data, cleanedText: cleaned);
  }
}
