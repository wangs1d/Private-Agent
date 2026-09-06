import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:private_ai_agent/core/utils/agent_result_parser.dart";
import "package:private_ai_agent/features/chat/agent_result_card.dart";

AgentResultData _structuredPlanData() {
  return AgentResultData(
    cardType: "travel_itinerary",
    title: "马尔代夫5日游·海岛/休闲",
    items: <AgentResultItem>[
      const AgentResultItem(type: "bullet", text: "Day 1 · 2026-09-05: Embudu Village"),
      const AgentResultItem(type: "bullet", text: "Day 2 · 2026-09-06"),
      const AgentResultItem(type: "bullet", text: "Day 3 · 2026-09-07"),
    ],
    footer: "共 5 天 · 1 项安排",
    travelPlan: <String, dynamic>{
      "title": "马尔代夫5日游·海岛/休闲",
      "destination": "马尔代夫",
      "planId": "plan-1788076649218",
      "startDate": "2026-09-05",
      "endDate": "2026-09-09",
      "intro": "印度洋上的珊瑚岛国，一岛一酒店，以水上屋、浮潜与纯净泻湖闻名",
      "packing": <String>["防晒霜 SPF50+", "泳装与浮潜装备", "英标转换插头"],
      "days": <dynamic>[
        <String, dynamic>{
          "date": "2026-09-05",
          "items": <dynamic>[
            <String, dynamic>{
              "type": "attraction",
              "name": "Embudu Village",
              "images": <String>["/agent/images/poster.jpg"],
            },
          ],
        },
        <String, dynamic>{
          "date": "2026-09-06",
          "items": <dynamic>[
            <String, dynamic>{"type": "hotel", "name": "Embudu Village"},
          ],
        },
      ],
    },
  );
}

AgentResultData _textFallbackData() {
  return AgentResultData(
    cardType: "travel_itinerary",
    title: "马尔代夫5日游·海岛/休闲",
    items: <AgentResultItem>[
      const AgentResultItem(type: "bullet", text: "Day 1 · 2026-09-05: Embudu Village"),
      const AgentResultItem(type: "bullet", text: "Day 2 · 2026-09-06: 水上屋体验"),
    ],
    footer: "共 5 天 · 1 项安排",
  );
}

/// 结构化数据异常：days 非空但全为空天（条目丢失），应回退文本解析口径。
AgentResultData _degradedStructuredData() {
  return AgentResultData(
    cardType: "travel_itinerary",
    title: "马尔代夫5日游·海岛/休闲",
    items: const <AgentResultItem>[],
    footer: "共 5 天 · 1 项安排",
    travelPlan: <String, dynamic>{
      "title": "马尔代夫5日游·海岛/休闲",
      "destination": "马尔代夫",
      "days": <dynamic>[
        <String, dynamic>{"date": "2026-09-05", "items": <dynamic>[]},
        <String, dynamic>{"date": "2026-09-06", "items": <dynamic>[]},
      ],
    },
  );
}

void main() {
  Future<void> pumpCard(WidgetTester tester, AgentResultData data) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: AgentResultCard(data: data),
          ),
        ),
      ),
    );
    // 图片加载/错误回调走一帧，避免 pending timer 干扰
    await tester.pump(const Duration(milliseconds: 50));
  }

  testWidgets("海报卡：徽章/天数/日期区间/简介/记得带/按钮渲染，Day 摘要不再展示", (WidgetTester tester) async {
    await pumpCard(tester, _structuredPlanData());

    expect(find.text("马尔代夫"), findsOneWidget);
    expect(find.textContaining("天行程"), findsOneWidget);
    expect(find.text("09-05 ~ 09-09"), findsOneWidget);
    expect(find.text("印度洋上的珊瑚岛国，一岛一酒店，以水上屋、浮潜与纯净泻湖闻名"), findsOneWidget);
    expect(find.text("记得带"), findsOneWidget);
    expect(find.text("防晒霜 SPF50+"), findsOneWidget);
    expect(find.text("打开行程规划（双面板·可全屏）"), findsOneWidget);
    expect(find.text("共 5 天 · 1 项安排"), findsOneWidget);

    // 用户反馈核心：卡面不再罗列 Day 摘要（明细只在右侧双面板）
    expect(find.textContaining("Day 1"), findsNothing);
    expect(find.textContaining("Day 2"), findsNothing);
  });

  testWidgets("无结构化 travelPlan 的历史消息优雅降级：简介/叮嘱隐藏，按钮与海报骨架仍在", (WidgetTester tester) async {
    await pumpCard(tester, _textFallbackData());

    expect(find.text("打开行程规划（双面板·可全屏）"), findsOneWidget);
    expect(find.text("马尔代夫"), findsOneWidget);
    expect(find.text("记得带"), findsNothing);
    expect(find.text("印度洋上的珊瑚岛国，一岛一酒店，以水上屋、浮潜与纯净泻湖闻名"), findsNothing);
  });

  testWidgets("结构化 days 全空回退文本解析：「全程」空骨架天不计入天数徽章", (WidgetTester tester) async {
    await pumpCard(tester, _degradedStructuredData());

    // days 全空 → 文本也无行程行 → 无可打开的行程，且不显示「1 天行程」
    //（修复前：raw days 非空即按结构化口径取 days.length，把 fromCard
    // 补的「全程」空骨架天计入，徽章误报 1 天）。
    expect(find.textContaining("天行程"), findsNothing);
    expect(find.text("打开行程规划（双面板·可全屏）"), findsNothing);
    // 目的地徽章与海报兜底骨架仍在，布局不破损
    expect(find.text("马尔代夫"), findsOneWidget);
  });
}
