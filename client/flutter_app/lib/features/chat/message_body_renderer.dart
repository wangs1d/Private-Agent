import "package:flutter/material.dart";

import "../../core/models/chat_models.dart";
import "../../core/utils/agent_result_parser.dart";
import "../../core/utils/content_summary_parser.dart";
import "../../core/utils/markdown_strip.dart";
import "agent_action_choice_card.dart";
import "agent_result_card.dart";
import "assistant_brief_message.dart";
import "content_summary_card.dart";
import "content_summary_detail_formatter.dart";
import "content_summary_detail_modal.dart";
import "data_brief_message.dart";
import "image_result_message.dart";
import "inline_video_player.dart";
import "structured_assistant_message_body.dart";

/// 桌面端与手机端共用的「消息正文渲染器」。
///
/// 桌面端 [chat_page.dart] 与手机端 [mobile_chat_page.dart] 都调用同一实现，
/// 保证两端的结构化渲染效果完全一致：
/// - 智能体结果卡片 `[AGENT_RESULT_CARD_START]` 标记解析
/// - `renderBlocks` 交错渲染块（一段文字 → 一组照片 → 再一段文字）
/// - `mediaCards` 结构化媒体卡片
/// - `[RENDER_AS:xxx]` 显式展示形式路由（brief / structured / image_result /
///   data_brief / video）
/// - 内容摘要卡与 markdown 内联文本
Widget buildMessageBody(
  BuildContext context,
  ColorScheme cs,
  ChatMessage message, {
  required bool isUser,
  ContentSummaryParseResult? contentSummary,
  void Function(AgentResultAction action, {required AgentResultData cardData})?
      onUserAction,

  /// 打字机「已 reveal」的原文前缀；null 时显示完整原文。
  /// 仅作用于纯文本分支（卡片/摘要仍用完整原文解析）。
  String? typewriterRawText,

  /// 是否在文本末尾显示闪烁光标（打字机进行中）
  bool typewriterCursor = false,
}) {
  if (isUser) {
    return Text(
      message.text,
      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
            color: cs.onPrimaryContainer,
          ),
    );
  }

  // 智能体结果卡片（任务总结 / 工具调用结果）优先级最高，
  // 命中后剥离标记，剩余文本以小字附在卡片下方。
  //
  // actions 非空时,渲染为带按钮的"选择型卡片"——专门给用户做快速决策
  // (如「周六去 / 忽略」「订阅 / 稍后再说」),点击会触发 onUserAction。
  // actions 为空时,保持原有"纯汇报"卡片样式不变。
  final AgentResultParseResult agentResult = AgentResultParser.parse(message.text);
  if (agentResult.data != null) {
    final AgentResultData data = agentResult.data!;
    final String remaining = _visibleAgentResultRemaining(data, agentResult.cleanedText);
    final Widget card = data.actions.isNotEmpty
        ? AgentActionChoiceCard(
            data: data,
            onAction: onUserAction == null
                ? null
                : (AgentResultAction a) => onUserAction(a, cardData: data),
          )
        : AgentResultCard(data: data);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        card,
        if (remaining.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: buildInlineMarkdownText(
              remaining,
              Theme.of(context).textTheme.bodyMedium!.copyWith(
                    color: cs.onSurface.withValues(alpha: 0.85),
                    height: 1.4,
                  ),
              cs: cs,
            ),
          ),
      ],
    );
  }

  // 交错渲染块（renderBlocks）：服务端已按「分组关键词在正文中的出现位置」
  // 把最终正文切成有序的「文字段 + 媒体组」，前端按块顺序渲染即可得到
  // 「一段文字介绍 → 一组照片 → 再一段文字 → 再一组照片」的自然阅读节奏，
  // 替代旧行为「全部照片一次性铺在最前面」。由代码层确定性完成，不依赖 prompt。
  final List<Map<String, dynamic>>? renderBlocks = message.renderBlocks;
  if (renderBlocks != null && renderBlocks.isNotEmpty) {
    final List<Widget> blockWidgets = <Widget>[];
    final TextStyle bodyStyle = Theme.of(context).textTheme.bodyMedium!.copyWith(
          color: cs.onSurface.withValues(alpha: 0.85),
          height: 1.4,
        );
    for (final Map<String, dynamic> block in renderBlocks) {
      final String type = block["type"]?.toString() ?? "text";
      if (type == "media") {
        final List<Map<String, dynamic>> cards =
            (block["cards"] as List<dynamic>? ?? const <dynamic>[])
                .whereType<Map<String, dynamic>>()
                .toList();
        if (cards.isEmpty) continue;
        final List<AgentResultItem> items = cards.map(_cardToItem).toList();
        final String groupTitle = (block["groupTitle"] ?? "").toString().trim();
        final String sideA = (block["sideA"] ?? "").toString().trim();
        final String sideB = (block["sideB"] ?? "").toString().trim();
        // 小簇判断：无维度标题/无 A/B 对比 → 走轻量内联行（紧贴文字，不套大卡框）。
        // 这是「一段介绍文字后挨着放一两张图」的关键视觉决策。
        final bool isSmallCluster =
            groupTitle.isEmpty && sideA.isEmpty && sideB.isEmpty;
        if (isSmallCluster) {
          blockWidgets.add(
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: MediaInlineRow(items: items, cs: cs),
            ),
          );
        } else {
          blockWidgets.add(
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: AgentResultCard(
                data: AgentResultData(
                  cardType: "media",
                  title: "",
                  items: items,
                  footer: "",
                  groupTitle: groupTitle.isEmpty ? null : groupTitle,
                  sideA: sideA.isEmpty ? null : sideA,
                  sideB: sideB.isEmpty ? null : sideB,
                ),
              ),
            ),
          );
        }
      } else {
        final String text = block["text"]?.toString() ?? "";
        if (text.trim().isEmpty) continue;
        blockWidgets.add(buildInlineMarkdownText(text, bodyStyle, cs: cs));
      }
    }
    if (blockWidgets.isNotEmpty) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: blockWidgets,
      );
    }
  }

  // 结构化媒体卡片（Coze 式架构）：独立于 LLM 文本渲染。
  //
  // 来自服务端 `chat.assistant_done` 的 `mediaCards` 字段，与 LLM 的文本回复
  // 完全解耦。前端直接构造 `AgentResultData` 卡片，不再依赖文本中
  // `[AGENT_RESULT_CARD_START]` 标记。
  //
  // 与 `AgentResultParser.parse` 不同：这里读取的是 `ChatMessage.mediaCards`
  // 字段（结构化数据），而非从消息文本中解析标记。
  final List<Map<String, dynamic>>? mediaCards = message.mediaCards;
  // 旧数据恢复：mediaCards 持久化之前的历史消息，照片是以「文本内嵌图片链接」存进
  // text 的（markdown 图 / /agent/images/ 代理路径 / http 图片扩展名）。重启后这些
  // 消息 mediaCards 为空，这里从正文把图片链接重新恢复成纯图廊，避免旧照片消失。
  final List<String> recoveredImageUrls =
      (mediaCards == null || mediaCards.isEmpty)
          ? _extractLegacyImageUrls(message.text)
          : const <String>[];
  if ((mediaCards != null && mediaCards.isNotEmpty) ||
      recoveredImageUrls.isNotEmpty) {
    final List<AgentResultItem> items = recoveredImageUrls.isNotEmpty
        ? recoveredImageUrls
            .map(
              (String url) => AgentResultItem(
                type: "image",
                text: "图片",
                mediaType: "image",
                thumbnailUrl: url,
                mediaUrl: url,
              ),
            )
            .toList()
        : mediaCards!.map(_cardToItem).toList();
    final AgentResultData mediaData = AgentResultData(
      cardType: "media",
      title: "",
      items: items,
      footer: "",
    );
    // 旧数据正文里可能残留图片链接行，展示前剥掉，避免与图廊重复。
    final String displayText = recoveredImageUrls.isNotEmpty
        ? _stripLegacyImageLines(message.text)
        : message.text;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        AgentResultCard(data: mediaData),
        if (displayText.trim().isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: buildInlineMarkdownText(
              displayText,
              Theme.of(context).textTheme.bodyMedium!.copyWith(
                    color: cs.onSurface.withValues(alpha: 0.85),
                    height: 1.4,
                  ),
              cs: cs,
            ),
          ),
      ],
    );
  }

  // [RENDER_AS:xxx] 标记路由：后端注入的显式展示形式声明
  {
    final String raw = typewriterRawText ?? message.text;
    final String? renderAs = _extractRenderAsMarker(raw);
    if (renderAs != null) {
      final String cleanText = _stripRenderAsMarker(raw);
      switch (renderAs) {
        case "brief":
          return AssistantBriefMessage(
            text: cleanText,
            colorScheme: cs,
          );
        case "structured":
          return StructuredAssistantMessageBody(
            text: cleanText,
            cs: cs,
            textTheme: Theme.of(context).textTheme,
            showCursor: typewriterCursor,
          );
        case "image_result":
          return ImageResultMessage(
            text: cleanText,
            cs: cs,
            textTheme: Theme.of(context).textTheme,
            showCursor: typewriterCursor,
          );
        case "data_brief": {
          final DataBriefPayload? payload = DataBriefMessage.tryParse(cleanText);
          if (payload == null) {
            // payload 缺失/损坏：回退结构化正文（保留 DATA_BRIEF 块原文）
            return StructuredAssistantMessageBody(
              text: cleanText,
              cs: cs,
              textTheme: Theme.of(context).textTheme,
              showCursor: typewriterCursor,
            );
          }
          return DataBriefMessage(
            payload: payload,
            cs: cs,
            textTheme: Theme.of(context).textTheme,
            showCursor: typewriterCursor,
          );
        }
        case "video": {
          // 视频抓取：解析 [VIDEO_MEDIA_START] 媒体块，内联渲染可播放视频
          final ({VideoMediaData? media, String cleaned}) parsed =
              parseVideoMediaBlock(cleanText);
          if (parsed.media != null) {
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                AgentInlineVideoPlayer(data: parsed.media!),
                if (parsed.cleaned.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: buildInlineMarkdownText(
                      parsed.cleaned,
                      Theme.of(context).textTheme.bodyMedium!.copyWith(
                            color: cs.onSurface.withValues(alpha: 0.85),
                            height: 1.4,
                          ),
                      cs: cs,
                    ),
                  ),
              ],
            );
          }
          // 无媒体块：回退为普通正文（播放页链接仍可点击）
          return StructuredAssistantMessageBody(
            text: cleanText,
            cs: cs,
            textTheme: Theme.of(context).textTheme,
            showCursor: typewriterCursor,
          );
        }
        default:
          break;
      }
    }
  }

  if (contentSummary?.summary != null) {
    return ContentSummaryMessageBody(
      summary: contentSummary!.summary!,
      briefText: contentSummary.briefText,
      extraText: contentSummary.cleanedText,
      structuredItems: contentSummary.structuredItems,
      onCardTap: () => ContentSummaryDetailModal.show(
        context,
        contentSummary.summary!,
      ),
    );
  }

  return StructuredAssistantMessageBody(
    text: typewriterRawText ?? message.text,
    cs: cs,
    textTheme: Theme.of(context).textTheme,
    showCursor: typewriterCursor,
  );
}

/// 媒体卡 Map（renderBlocks / mediaCards / pendingMediaCards 三者同构）→ AgentResultItem。
/// 三处构建逻辑相同，提取共用，避免重复。
AgentResultItem _cardToItem(Map<String, dynamic> m) {
  return AgentResultItem(
    type: m["type"]?.toString() ?? "image",
    text: m["title"]?.toString() ?? "",
    mediaType: m["mediaType"]?.toString() ?? m["type"]?.toString() ?? "image",
    thumbnailUrl: m["thumbnailUrl"]?.toString(),
    mediaUrl: m["mediaUrl"]?.toString(),
    pageUrl: m["pageUrl"]?.toString(),
    source: m["source"]?.toString(),
    side: m["side"]?.toString(),
    sideLabel: m["sideLabel"]?.toString(),
    width: (m["width"] as num?)?.toInt(),
    height: (m["height"] as num?)?.toInt(),
  );
}

/// 边说边出图：把流式阶段 `chat.media_ready` 收到的临时照片渲染成媒体卡。
/// 仅流式阶段使用（pendingMediaCards 为瞬态）；`chat.assistant_done` 后
/// 该字段被清空，改由 renderBlocks 的最终顺序接管。
///
/// 用轻量 `MediaInlineRow` 渲染：边说边出图是「文字正在打、图已经查到」阶段，
/// 这里就该是「几行文字 + 几张图紧贴文字」的自然形态，不应套大 card 框。
Widget buildPendingMediaCards(
  List<Map<String, dynamic>> cards,
  ColorScheme cs,
) {
  return MediaInlineRow(
    items: cards.map(_cardToItem).toList(),
    cs: cs,
  );
}

/// 提取文本开头的 `[RENDER_AS:xxx]` 标记名，无标记返回 null。
String? _extractRenderAsMarker(String text) {
  final RegExpMatch? m = RegExp(r'^\[RENDER_AS:(\w+)\]\s*').firstMatch(text);
  return m?.group(1);
}

/// 剥离文本开头的 `[RENDER_AS:xxx]` 标记。
String _stripRenderAsMarker(String text) {
  return text.replaceFirst(RegExp(r'^\[RENDER_AS:\w+\]\s*'), '');
}

// 旧数据恢复用：识别正文里内嵌的图片链接（markdown 图 / /agent/images/ 路径 / http 图片）。
// 用显式允许字符集，避免特殊引号/闭合符在字符类里的转义问题。
final RegExp _legacyImgMarkdown = RegExp(r'!\[[^\]]*\]\(([^)\s]+)\)');
final RegExp _legacyImgPath = RegExp(r'(/agent/images/[A-Za-z0-9_\-.%/]+)');
final RegExp _legacyImgHttp = RegExp(
  r'(https?://[A-Za-z0-9_\-./:%?&=@#~+]+\.(?:png|jpe?g|gif|webp|avif)(?:[?&][A-Za-z0-9_\-./:%?&=@#~+]+)?)',
  caseSensitive: false,
);

/// 从消息正文提取旧数据内嵌的图片链接（去重，最多 6 张）。
List<String> _extractLegacyImageUrls(String text) {
  if (text.isEmpty) return const <String>[];
  final List<String> out = <String>[];
  void add(String? url) {
    final String u = (url ?? '').trim();
    if (u.isEmpty || out.contains(u)) return;
    out.add(u);
  }

  for (final Match m in _legacyImgMarkdown.allMatches(text)) {
    add(m.group(1));
  }
  for (final Match m in _legacyImgPath.allMatches(text)) {
    add(m.group(1));
  }
  for (final Match m in _legacyImgHttp.allMatches(text)) {
    add(m.group(1));
  }
  return out.take(6).toList(growable: false);
}

/// 剥掉正文里含图片链接的行（避免与恢复出的图廊重复展示）。
String _stripLegacyImageLines(String text) {
  if (text.isEmpty) return text;
  return text
      .split('\n')
      .map((String line) => line.trim())
      .where((String line) {
        if (line.isEmpty) return false;
        if (_legacyImgMarkdown.hasMatch(line)) return false;
        if (_legacyImgPath.hasMatch(line)) return false;
        if (_legacyImgHttp.hasMatch(line)) return false;
        return true;
      })
      .join('\n')
      .replaceAll(RegExp(r'\n{3,}'), '\n\n')
      .trim();
}

String _visibleAgentResultRemaining(
  AgentResultData data,
  String rawText,
) {
  final List<String> lines = rawText
      .split(RegExp(r'\n+'))
      .map((String line) => line.trim())
      .where((String line) => line.isNotEmpty)
      .toList(growable: false);
  if (lines.isEmpty) return "";

  final Set<String> cardTexts = <String>{
    _normalizeAgentResultText(data.title),
    for (final AgentResultItem item in data.items)
      _normalizeAgentResultText(item.text),
    _normalizeAgentResultText(data.footer),
  }..removeWhere((String text) => text.length < 6);

  if (cardTexts.isEmpty) return rawText.trim();

  final List<String> kept = <String>[];
  for (final String line in lines) {
    final String normalizedLine = _normalizeAgentResultText(line);
    if (normalizedLine.isEmpty) continue;
    final bool repeatsCardText = cardTexts.any((String cardText) {
      final int lengthDelta = (normalizedLine.length - cardText.length).abs();
      return normalizedLine == cardText ||
          (cardText.contains(normalizedLine) && lengthDelta <= 8) ||
          (normalizedLine.contains(cardText) && lengthDelta <= 8);
    });
    if (!repeatsCardText) kept.add(line);
  }

  return kept.join("\n\n").trim();
}

String _normalizeAgentResultText(String text) {
  return stripMarkdown(text)
      .toLowerCase()
      .replaceAll(RegExp(r'\s+'), '')
      .replaceAll(RegExp(r'''[，。！？、；：,.!?;:()\[\]{}"'`~\-_*#>]+'''), '');
}
