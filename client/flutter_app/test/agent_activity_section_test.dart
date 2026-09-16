// 代办足迹卡单测：服务端 JSON 解析（告知类/执行类）、状态 pill 语义、
// agent.activity_new 实时刷新总线、置已读请求体。
import "dart:convert" show jsonEncode;

import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";
import "package:http/http.dart" as http;
import "package:http/testing.dart";

import "package:private_ai_agent/features/chat/agent_activity_section.dart";

AgentActivity informedEntry() => AgentActivity.fromJson(const {
      "id": "act_informed_1",
      "kind": "action.schedule_change",
      "category": "schedule",
      "title": "发现日程变动",
      "summary": "王工：评审会延迟到4点",
      "status": "changed",
      "statusLabel": "已告知",
      "detail": {"发件人": "王工", "来源": "微信"},
      "createdAt": 1758000000000,
      "readAt": null,
    });

AgentActivity executedEntry() => AgentActivity.fromJson(const {
      "id": "act_done_1",
      "kind": "action.purchase",
      "category": "purchase",
      "title": "已为你订购牛奶",
      "summary": "光明每日鲜语 950ml ×1",
      "status": "pending",
      "statusLabel": "配送中",
      "createdAt": 1758000000000,
      "readAt": 1758000060000,
    });

void main() {
  setUp(() {
    AgentActivityApi.clientOverride = null;
    AgentActivityBus.version.value = 0;
  });

  test("fromJson：告知类条目解析（statusLabel=已告知，未读）", () {
    final a = informedEntry();
    expect(a.id, "act_informed_1");
    expect(a.category, "schedule");
    expect(a.status, "changed");
    expect(a.statusLabel, "已告知");
    expect(a.isRead, isFalse);
    expect(a.detail?["发件人"], "王工");
  });

  test("fromJson：执行类条目解析 + asRead 置已读", () {
    final a = executedEntry();
    expect(a.status, "pending");
    expect(a.statusLabel, "配送中");
    expect(a.isRead, isTrue);
    expect(a.asRead().isRead, isTrue);
  });

  testWidgets("面板渲染：未读告知类显示「已告知」pill 与「N 条新」徽标",
      (WidgetTester tester) async {
    AgentActivityApi.clientOverride = MockClient(
      (request) async => http.Response(
        jsonEncode({
          "ok": true,
          "activities": [
            {
              "id": "act_informed_1",
              "kind": "action.schedule_change",
              "category": "schedule",
              "title": "发现日程变动",
              "summary": "王工：评审会延迟到4点",
              "status": "changed",
              "statusLabel": "已告知",
              "createdAt": 1758000000000,
              "readAt": null,
            },
          ],
          "unreadCount": 1,
        }),
        200,
        headers: {"content-type": "application/json"},
      ),
    );
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: AgentActivitySection())),
    );
    await tester.pump(); await tester.pump(const Duration(milliseconds: 50));
    expect(find.text("代办足迹"), findsOneWidget);
    expect(find.text("发现日程变动"), findsOneWidget);
    expect(find.text("已告知"), findsOneWidget);
    expect(find.text("1 条新"), findsOneWidget);
  });

  testWidgets("agent.activity_new 推送 → 立即重拉台账（不等 1 分钟轮询）",
      (WidgetTester tester) async {
    var fetchCount = 0;
    AgentActivityApi.clientOverride = MockClient((request) async {
      if (request.method == "GET") {
        fetchCount++;
        return http.Response(
          jsonEncode({"ok": true, "activities": const [], "unreadCount": 0}),
          200,
          headers: {"content-type": "application/json"},
        );
      }
      return http.Response(jsonEncode({"ok": true, "marked": 0}), 200);
    });
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: AgentActivitySection())),
    );
    await tester.pump(); await tester.pump(const Duration(milliseconds: 50));
    expect(fetchCount, 1);

    AgentActivityBus.notify(); // 模拟服务端 agent.activity_new WS 推送
    await tester.pump(); await tester.pump(const Duration(milliseconds: 50));
    expect(fetchCount, 2, reason: "推送触达后立即重拉，不等待轮询周期");
  });

  testWidgets("点开未读条目 → 置已读请求携带其 id",
      (WidgetTester tester) async {
    final requests = <http.Request>[];
    AgentActivityApi.clientOverride = MockClient((request) async {
      requests.add(request);
      if (request.method == "GET") {
        return http.Response(
          jsonEncode({
            "ok": true,
            "activities": [
              {
                "id": "act_informed_1",
                "kind": "action.schedule_change",
                "category": "schedule",
                "title": "发现日程变动",
                "summary": "王工：评审会延迟到4点",
                "status": "changed",
                "statusLabel": "已告知",
                "createdAt": 1758000000000,
                "readAt": null,
              },
            ],
            "unreadCount": 1,
          }),
          200,
          headers: {"content-type": "application/json"},
        );
      }
      return http.Response(jsonEncode({"ok": true, "marked": 1}), 200);
    });
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: AgentActivitySection())),
    );
    await tester.pump(); await tester.pump(const Duration(milliseconds: 50));

    await tester.tap(find.text("发现日程变动"));
    await tester.pump(); await tester.pump(const Duration(milliseconds: 50));

    final post = requests.where((r) => r.method == "POST").toList();
    expect(post, isNotEmpty, reason: "点开未读条目应触发置已读");
    expect(post.first.url.path, endsWith("/agent/activities/read"));
    expect(post.first.body, contains("act_informed_1"));
  });
}
