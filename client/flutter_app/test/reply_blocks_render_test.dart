import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:private_ai_agent/core/models/chat_models.dart";
import "package:private_ai_agent/features/chat/message_body_renderer.dart";

/// 回复信封块（reply blocks）渲染测试：
/// blocks 分支优先于正文标记解析；card 块直读 AgentResultPayload JSON 建卡；
/// 无 blocks 时回退既有正文解析（历史消息兼容），两端渲染等价。

ChatMessage messageWithBlocks(List<Map<String, dynamic>>? blocks) => ChatMessage(
      messageId: "m1",
      sessionId: "s1",
      role: "assistant",
      text: "（正文文本，仅在无 blocks 时作为解析来源）",
      timestamp: DateTime.now(),
      replyBlocks: blocks,
    );

Future<void> pumpBody(WidgetTester tester, ChatMessage message) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Builder(
        builder: (BuildContext context) => Scaffold(
          body: buildMessageBody(
            context,
            Theme.of(context).colorScheme,
            message,
            isUser: false,
          ),
        ),
      ),
    ),
  );
}

void main() {
  testWidgets("reply blocks: text+card+text 序列按块渲染", (tester) async {
    await pumpBody(
      tester,
      messageWithBlocks([
        {"type": "text", "text": "好的，耳机已下单，预计周六送达。"},
        {
          "type": "card",
          "card": {
            "title": "本周末行程已为你规划：",
            "items": [
              {"type": "num", "text": "周六上午：探店"},
              {"type": "num", "text": "周六下午：健身"},
            ],
            "footer": "需要调整吗？",
            "cardType": "",
          },
        },
        {"type": "text", "text": "需要调整吗？"},
      ]),
    );

    expect(find.text("好的，耳机已下单，预计周六送达。"), findsOneWidget);
    expect(find.text("本周末行程已为你规划："), findsOneWidget);
    expect(find.text("周六上午：探店"), findsOneWidget);
    // 出现两次：一次是追问文本块，一次是卡片 footer（RichText，需 findRichText）
    expect(find.textContaining("需要调整吗？", findRichText: true), findsNWidgets(2));
    // 正文文本不渲染（blocks 优先，text 仅为事实源备份）
    expect(find.text("（正文文本，仅在无 blocks 时作为解析来源）"), findsNothing);
  });

  testWidgets("reply blocks: 带 actions 的卡渲染为选择型卡片", (tester) async {
    await pumpBody(
      tester,
      messageWithBlocks([
        {
          "type": "card",
          "card": {
            "title": "要继续吗？",
            "items": [
              {"type": "num", "text": "条目"},
            ],
            "actions": [
              // 显式 <String, dynamic>：字面量 {} 在 dynamic 上下文会推断为
              // Map<dynamic,dynamic>；生产路径经 json.decode 天然是 String 键
              {"id": "keep", "label": "就这样", "variant": "primary", "payload": <String, dynamic>{}},
            ],
          },
        },
      ]),
    );

    expect(find.text("要继续吗？"), findsOneWidget);
    expect(find.text("就这样"), findsOneWidget);
  });

  testWidgets("无 blocks → 回退正文标记解析（历史消息兼容）", (tester) async {
    await pumpBody(
      tester,
      ChatMessage(
        messageId: "m2",
        sessionId: "s1",
        role: "assistant",
        text: "前导说明。\n[AGENT_RESULT_CARD_START]\n"
            '{"title":"已有卡片","items":[{"type":"check","text":"条目一"},'
            '{"type":"check","text":"条目二"},{"type":"check","text":"条目三"}],"footer":""}\n'
            "[AGENT_RESULT_CARD_END]",
        timestamp: DateTime.now(),
        replyBlocks: null,
      ),
    );

    expect(find.text("已有卡片"), findsOneWidget);
    expect(find.textContaining("前导说明"), findsOneWidget);
    expect(find.textContaining("AGENT_RESULT_CARD_START"), findsNothing);
  });
}
