// 「此刻」卡单测（原「代办足迹卡」，已去名）：服务端 JSON 解析（告知类/执行类）、
// 状态 pill 语义、agent.activity_new 实时刷新总线、置已读请求体、盯着小节数据源。
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
    AgentNowApi.clientOverride = null;
    AgentActivityBus.version.value = 0;
  });

  void mockAgentNow({List<Map<String, dynamic>> watching = const []}) {
    AgentNowApi.clientOverride = MockClient(
      (request) async {
        if (request.url.path.endsWith("/api/agent-now")) {
          return http.Response(
            jsonEncode({"ok": true, "watching": watching, "recent": const []}),
            200,
            headers: {"content-type": "application/json"},
          );
        }
        return http.Response(jsonEncode({"ok": true}), 200);
      },
    );
  }

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

  testWidgets("面板渲染：无名片内容——未读告知类显示「已告知」pill 与「N 条新」徽标",
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
    mockAgentNow();
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: AgentActivitySection())),
    );
    await tester.pump(); await tester.pump(const Duration(milliseconds: 50));
    // 本区块不叫任何名字（原「代办足迹」标题已去）
    expect(find.text("代办足迹"), findsNothing);
    expect(find.text("发现日程变动"), findsOneWidget);
    expect(find.text("已告知"), findsOneWidget);
    expect(find.text("1 条新"), findsOneWidget);
    expect(find.text("查看全部 → 主页"), findsOneWidget);
  });

  testWidgets("盯着小节：承诺板 active 项渲染文本与复核倒计时",
      (WidgetTester tester) async {
    AgentActivityApi.clientOverride = MockClient(
      (request) async => http.Response(
        jsonEncode({"ok": true, "activities": const [], "unreadCount": 0}),
        200,
        headers: {"content-type": "application/json"},
      ),
    );
    final soon = DateTime.now().add(const Duration(minutes: 30)).toIso8601String();
    mockAgentNow(watching: <Map<String, dynamic>>[
      {"id": "c1", "text": "洗衣机结束提醒", "deadline": soon, "category": null},
    ]);
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: AgentActivitySection())),
    );
    // 两次 pump：先落台账刷新，再落 watching 二段异步
    await tester.pump(); await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(); await tester.pump(const Duration(milliseconds: 50));
    expect(find.text("盯着"), findsOneWidget);
    // 倒计时随真实时钟取整（30 分钟 ≈ 还剩 29 分钟），只锁前缀与倒计时形态
    expect(find.textContaining("洗衣机结束提醒 · 还剩"), findsOneWidget);
    // 没有足迹时不再显示「还没有足迹」空态（盯着小节本身就是内容）
    expect(find.text("还没有足迹"), findsNothing);
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
    mockAgentNow();
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
    mockAgentNow();
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
