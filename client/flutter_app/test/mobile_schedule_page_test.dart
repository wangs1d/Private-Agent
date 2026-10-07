// 手机端行程表 widget 测试：今天默认视图、「查看之后的安排」切换、空态。
library;

import "dart:convert";

import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";
import "package:http/http.dart" as http;
import "package:private_ai_agent/core/services/schedule_api_client.dart";
import "package:private_ai_agent/mobile_ui/mobile_schedule_page.dart";

/// 假 http client：/schedule/tasks 返回今天 + 未来的样例任务。
class _MockScheduleHttp extends http.BaseClient {
  _MockScheduleHttp(this.tasks);

  final List<Map<String, dynamic>> tasks;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    if (request.url.path.endsWith("/schedule/tasks")) {
      return http.StreamedResponse(
        Stream<List<int>>.value(utf8.encode(jsonEncode(<String, dynamic>{
          "ok": true,
          "tasks": tasks,
        }))),
        200,
        headers: const <String, String>{
          "content-type": "application/json; charset=utf-8",
        },
        request: request,
      );
    }
    return http.StreamedResponse(
      Stream<List<int>>.value(utf8.encode("not found")),
      404,
      request: request,
    );
  }
}

String _isoAt(DateTime local) => local.toUtc().toIso8601String();

void main() {
  testWidgets("默认只看今天,展示今日条目与切换按钮", (WidgetTester tester) async {
    final DateTime now = DateTime.now();
    final DateTime todayAt =
        DateTime(now.year, now.month, now.day, 14, 30);
    final DateTime tomorrowAt = todayAt.add(const Duration(days: 1));
    await tester.pumpWidget(MaterialApp(
      home: MobileSchedulePage(
        scheduleApi: ScheduleApiClient(
          baseUrl: "http://localhost:3000",
          client: _MockScheduleHttp(<Map<String, dynamic>>[
            <String, dynamic>{
              "taskId": "t1",
              "shortTitle": "项目评审会",
              "runAt": _isoAt(todayAt),
              "nextRunAt": _isoAt(todayAt),
              "status": "active",
            },
            <String, dynamic>{
              "taskId": "t2",
              "shortTitle": "晨会",
              "runAt": _isoAt(tomorrowAt),
              "nextRunAt": _isoAt(tomorrowAt),
              "status": "active",
            },
          ]),
        ),
        sessionId: "test-actor",
      ),
    ));
    await tester.pumpAndSettle();

    expect(find.text("行程"), findsOneWidget);
    expect(find.text("项目评审会"), findsOneWidget);
    expect(find.text("14:30"), findsOneWidget);
    // 明天的条目默认不出现
    expect(find.text("晨会"), findsNothing);
    expect(find.text("查看之后的安排"), findsOneWidget);
  });

  testWidgets("点「查看之后的安排」进入按日分组视图,可切回", (WidgetTester tester) async {
    final DateTime now = DateTime.now();
    final DateTime todayAt = DateTime(now.year, now.month, now.day, 9, 0);
    final DateTime tomorrowAt = todayAt.add(const Duration(days: 1));
    await tester.pumpWidget(MaterialApp(
      home: MobileSchedulePage(
        scheduleApi: ScheduleApiClient(
          baseUrl: "http://localhost:3000",
          client: _MockScheduleHttp(<Map<String, dynamic>>[
            <String, dynamic>{
              "taskId": "t1",
              "shortTitle": "项目评审会",
              "runAt": _isoAt(todayAt),
              "nextRunAt": _isoAt(todayAt),
              "status": "active",
            },
            <String, dynamic>{
              "taskId": "t2",
              "shortTitle": "晨会",
              "runAt": _isoAt(tomorrowAt),
              "nextRunAt": _isoAt(tomorrowAt),
              "status": "active",
            },
          ]),
        ),
        sessionId: "test-actor",
      ),
    ));
    await tester.pumpAndSettle();

    await tester.tap(find.text("查看之后的安排"));
    await tester.pumpAndSettle();

    expect(find.text("晨会"), findsOneWidget);
    expect(find.text("项目评审会"), findsNothing);
    expect(find.textContaining("明天 · "), findsOneWidget);

    await tester.tap(find.text("只看今天"));
    await tester.pumpAndSettle();
    expect(find.text("项目评审会"), findsOneWidget);
    expect(find.text("晨会"), findsNothing);
  });

  testWidgets("已完成的条目不进未完成时刻口径,取消的整条滤掉", (WidgetTester tester) async {
    final DateTime now = DateTime.now();
    final DateTime todayAt =
        DateTime(now.year, now.month, now.day, 8, 0);
    await tester.pumpWidget(MaterialApp(
      home: MobileSchedulePage(
        scheduleApi: ScheduleApiClient(
          baseUrl: "http://localhost:3000",
          client: _MockScheduleHttp(<Map<String, dynamic>>[
            <String, dynamic>{
              "taskId": "t1",
              "title": "已完成的事",
              "runAt": _isoAt(todayAt),
              "lastRunAt": _isoAt(todayAt),
              "status": "completed",
            },
            <String, dynamic>{
              "taskId": "t2",
              "title": "被取消的事",
              "runAt": _isoAt(todayAt),
              "nextRunAt": _isoAt(todayAt),
              "status": "cancelled",
            },
          ]),
        ),
        sessionId: "test-actor",
      ),
    ));
    await tester.pumpAndSettle();

    expect(find.text("已完成的事"), findsOneWidget);
    expect(find.text("被取消的事"), findsNothing);
    expect(find.text("08:00"), findsOneWidget);
  });
}
