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
  const AgentResultItem({
    required this.type,
    required this.text,
    this.url,
    this.mediaType,
    this.mediaUrl,
    this.thumbnailUrl,
    this.pageUrl,
    this.source,
    this.side,
    this.sideLabel,
  });

  /// "check"（✓ 已完成） / "num"（• 序号） / "warn"（! 警告）
  final String type;
  final String text;

  /// 可选的链接 URL（搜索/资讯类卡片使用）
  final String? url;

  /// 可选媒体元数据（图片/视频搜索结果卡片使用）。
  final String? mediaType;
  final String? mediaUrl;
  final String? thumbnailUrl;
  final String? pageUrl;
  final String? source;

  /// 对比侧：A=左侧 / B=右侧（用于媒体卡片 A/B 分栏）。
  final String? side;

  /// 侧标签（如「A 品牌」「B 品牌」），用于分栏表头。
  final String? sideLabel;

  factory AgentResultItem.fromJson(Map<String, dynamic> json) {
    return AgentResultItem(
      type: json["type"]?.toString() ?? "check",
      text: json["text"]?.toString() ?? "",
      url: json["url"]?.toString(),
      mediaType: json["mediaType"]?.toString() ?? json["kind"]?.toString(),
      mediaUrl: json["mediaUrl"]?.toString() ?? json["imageUrl"]?.toString(),
      thumbnailUrl: json["thumbnailUrl"]?.toString() ?? json["thumbUrl"]?.toString(),
      pageUrl: json["pageUrl"]?.toString() ?? json["sourceUrl"]?.toString(),
      source: json["source"]?.toString(),
      side: json["side"]?.toString(),
      sideLabel: json["sideLabel"]?.toString(),
    );
  }
}

/// 单个可选的"抉择按钮"定义。
///
/// 用于 [AgentResultData.actions] 列表,渲染在卡片底部供用户一键选择。
/// 与 [AgentResultItem] 不同:它不是文本条目,而是带点击动作的 UI 控件。
class AgentResultAction {
  const AgentResultAction({
    required this.id,
    required this.label,
    this.variant = "primary",
    this.payload = const <String, dynamic>{},
  });

  /// 唯一动作 ID(用于后端路由/审计;前端不依赖此字段做去重)。
  final String id;

  /// 按钮显示文案(同时作为回退的 user message 文本)。
  final String label;

  /// 视觉变体:`primary` 主按钮(实心) / `secondary` 次按钮(描边)。
  /// 默认 `primary`,渲染时第一个为 `primary`,其余按 schema 显式指定。
  final String variant;

  /// 透传给后端的附加负载(后端可按需解析;前端不强约束 schema)。
  final Map<String, dynamic> payload;

  factory AgentResultAction.fromJson(Map<String, dynamic> json) {
    final Map<String, dynamic>? rawPayload =
        json["payload"] as Map<String, dynamic>?;
    return AgentResultAction(
      id: json["id"]?.toString() ?? "",
      label: json["label"]?.toString() ?? "",
      variant: json["variant"]?.toString() ?? "primary",
      payload: rawPayload ?? const <String, dynamic>{},
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
    this.actions = const <AgentResultAction>[],
    this.cardId = "",
    this.cardType = "",
    this.speak = "",
    this.groupTitle,
    this.sideA,
    this.sideB,
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

  /// 底部抉择按钮列表(可选;非空时由 [AgentActionChoiceCard] 渲染)。
  /// 与 [items]/[footer] 解耦:即便后两者为空,仅靠 actions 也能撑起整张卡。
  final List<AgentResultAction> actions;

  /// 卡片唯一 ID(用于后端关联原始上下文;前端主要用于点击事件回传)。
  /// 由服务端注入,前端不强校验。
  final String cardId;

  /// 工具专用卡片类型(服务端按 toolName 推断注入):
  /// weather / schedule / wallet / order / file / carousel / compare / timeline / media;
  /// 空串=通用列表卡。
  final String cardType;

  /// 语音播报优先级:`high`(优先朗读结论) / `low`(可跳过) / 空串(默认)。
  /// 供语音输出端决定取舍。
  final String speak;

  /// 对比媒体分组维度标题（如「颜色持久度」），非空时媒体卡片按分组渲染。
  final String? groupTitle;

  /// 对比左/右两侧的标签（如「A 品牌」「B 品牌」），配合侧标分栏展示。
  final String? sideA;
  final String? sideB;

  factory AgentResultData.fromJson(Map<String, dynamic> json) {
    final List<dynamic>? rawItems = json["items"] as List<dynamic>?;
    final List<dynamic>? rawActions = json["actions"] as List<dynamic>?;
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
      actions: rawActions
              ?.whereType<Map<String, dynamic>>()
              .map(AgentResultAction.fromJson)
              .where((AgentResultAction a) => a.label.isNotEmpty)
              .toList() ??
          const <AgentResultAction>[],
      cardId: json["cardId"]?.toString() ?? "",
      cardType: json["cardType"]?.toString() ?? "",
      speak: json["speak"]?.toString() ?? "",
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
