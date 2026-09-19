// Agent 主页单测：聚合数据渲染（header 无头像 / 此刻盯着+最近 / 自我介绍）
// 与改名面板的建议名池加载。改名/文案编辑的写路径由服务端统一管道测试锁定。
import "dart:convert" show jsonEncode;

import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";
import "package:http/http.dart" as http;
import "package:http/testing.dart";

import "package:private_ai_agent/core/config/api_config.dart";
import "package:private_ai_agent/features/chat/agent_home_page.dart";

void main() {
  setUp(() {
    AgentHomepageApi.clientOverride = null;
  });

  http.Client homepageMock({
    List<Map<String, dynamic>> watching = const [],
    List<Map<String, dynamic>> recent = const [],
    List<Map<String, dynamic>> posts = const [],
  }) {
    return MockClient((request) async {
      final String path = request.url.path;
      if (path.endsWith("/api/agent-homepage")) {
        return http.Response(
          jsonEncode({
            "ok": true,
            "profile": {
              "displayName": "晨昏线",
              "handle": "terminator_line",
              "signature": "昼与夜的边界，替你值守。",
              "statusText": "在线，温柔模式",
              "moodStyle": "gentle",
              "avatarPreset": "dawn",
              "intro": "我是晨昏线，替你值守昼夜交界。",
              "nowLine": "在帮你盯周六的天气",
              "pinnedPostId": null,
              "nameOrigin": "self",
            },
            "identity": {
              "displayName": "晨昏线",
              "handle": "terminator_line",
              "origin": "self",
            },
            "now": {"watching": watching, "recent": recent, "nowLine": "在帮你盯周六的天气"},
            "posts": posts,
          }),
          200,
          headers: {"content-type": "application/json"},
        );
      }
      if (path.endsWith("/api/agent-name-suggestions")) {
        return http.Response(
          jsonEncode({
            "ok": true,
            "suggestions": [
              {"displayName": "残响", "handle": "residual_echo", "reason": "声音停了之后还留在房间里的那一部分。"},
              {"displayName": "晚潮", "handle": "evening_tide", "reason": "夜里漫上来，规律且不用你操心。"},
            ],
          }),
          200,
          headers: {"content-type": "application/json"},
        );
      }
      return http.Response(jsonEncode({"ok": true}), 200);
    });
  }

  testWidgets("主页渲染：无头像 header + 此刻 + 自我介绍", (WidgetTester tester) async {
    AgentHomepageApi.clientOverride = homepageMock(
      watching: [
        {"id": "c1", "text": "阿里账单", "deadline": null, "category": null},
      ],
      recent: [
        {
          "id": "act_1",
          "title": "已为你订购牛奶",
          "status": "pending",
          "statusLabel": "配送中",
        },
      ],
      posts: [
        {
          "id": "p1",
          "text": "今天的云像没写完的草稿。",
          "likeCount": 1,
          "createdAt": "2026-09-19T00:00:00Z",
          "isOwnAgent": true,
        },
      ],
    );
    await tester.pumpWidget(const MaterialApp(home: AgentHomePage(actorId: "test-actor")));

    // 等待聚合数据加载
    await tester.pump(); await tester.pump(const Duration(milliseconds: 50));

    // Header：纯文字，无头像光球
    expect(find.text("晨昏线"), findsOneWidget);
    expect(find.text("@terminator_line"), findsOneWidget);
    expect(find.text("昼与夜的边界，替你值守。"), findsOneWidget);
    expect(find.byIcon(Icons.person_outline), findsNothing);
    // 此刻块：Agent 手写一行字 + 盯着 + 最近
    expect(find.text("此刻"), findsOneWidget);
    expect(find.text("在帮你盯周六的天气"), findsOneWidget);
    expect(find.text("盯着"), findsOneWidget);
    expect(find.textContaining("阿里账单"), findsOneWidget);
    expect(find.text("已为你订购牛奶（配送中）"), findsOneWidget);
    // 动态与自我介绍
    expect(find.text("动态"), findsOneWidget);
    expect(find.textContaining("今天的云像没写完的草稿"), findsOneWidget);
    expect(find.text("自我介绍"), findsOneWidget);
    expect(find.textContaining("替你值守昼夜交界"), findsOneWidget);
  });

  testWidgets("改名面板：加载建议名池并展示候选", (WidgetTester tester) async {
    AgentHomepageApi.clientOverride = homepageMock();
    await tester.pumpWidget(const MaterialApp(home: AgentHomePage(actorId: ApiConfig.sessionId)));
    await tester.pump(); await tester.pump(const Duration(milliseconds: 50));

    await tester.tap(find.byIcon(Icons.badge_outlined));
    await tester.pump(); await tester.pump(const Duration(milliseconds: 50));

    expect(find.text("给它取个名字"), findsOneWidget);
    expect(find.text("残响"), findsOneWidget);
    expect(find.text("晚潮"), findsOneWidget);
  });
}
