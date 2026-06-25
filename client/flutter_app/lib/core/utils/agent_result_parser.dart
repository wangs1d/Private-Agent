import "dart:convert";

/// 智能体结果卡片的数据模型。
///
/// 服务端（或前端脚本）按以下格式把结构化数据注入到消息文本里，
/// 解析器会把它从普通文本中剥离并渲染为 `AgentResultCard`。
///
/// 协议（参考）：
/// ```
/// [AGENT_RESULT_CARD_START]
/// {"title":"...","items":[...],"footer":"..."}
/// [AGENT_RESULT_CARD_END]
/// ```
///
/// ─────────────────────────────────────────────────────────────
/// 与 `ContentSummaryDataV2`（可折叠长内容卡片）的选择边界：
/// ─────────────────────────────────────────────────────────────
/// 用「结果卡片」如果:
///   ✅ 内容是**短而固定**的结构(3~7 条 ✓/• 项, 一行 footer 追问)
///   ✅ 单条文案 ≤ 30 字, 不需要正文段落
///   ✅ 一次性展示完毕, **不需要**「查看详情」入口
///   ✅ 典型场景:
///       - 任务执行结果汇报("已完成 X / 已修复 Y / 失败 Z")
///       - 工具调用的简短回执("搜索到 5 个文件, 用时 128ms")
///       - 行程/清单/选项/检查项(用户能一眼扫完)
///       - 部署/构建结果("主分支已合并, CI 通过")
///
/// 用「内容摘要卡」如果:
///   📄 内容是**长且多样**(多板块/多段/含表格/含代码块)
///   📄 单板块正文可能 > 200 字
///   📄 需要「折叠成 brief + 点开查看详情」的交互
///   📄 典型场景:
///       - 长篇研究/分析报告、调研结论
///       - 文章总结、邮件草稿
///       - 包含多 section 的结构化长文
///
/// 决策口诀: **一眼能扫完 → 结果卡片;  需要"展开/查看更多" → 内容摘要卡**。
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
