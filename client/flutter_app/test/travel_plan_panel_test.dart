import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:private_ai_agent/core/utils/agent_result_parser.dart";
import "package:private_ai_agent/features/chat/intelligent_route_planner.dart";
import "package:private_ai_agent/features/chat/travel_booking_sheet.dart";
import "package:private_ai_agent/features/chat/travel_plan_models.dart";
import "package:private_ai_agent/features/chat/travel_plan_panel.dart";

/// 服务端结构化 travelPlan 快照（带 planId / 坐标 / 媒体字段）。
Map<String, dynamic> structuredPlan() => <String, dynamic>{
      "planId": "plan-widget-test",
      "toolName": "travel.plan-itinerary",
      "ts": DateTime.now().millisecondsSinceEpoch,
      "destination": "大理",
      "title": "大理2日游·测试",
      "startDate": "2026-08-30",
      "endDate": "2026-08-31",
      "days": <dynamic>[
        <String, dynamic>{
          "date": "2026-08-30",
          "items": <dynamic>[
            <String, dynamic>{
              "type": "hotel",
              "name": "古城客栈",
              "itemId": "h1",
              "startTime": "15:00",
              "latitude": 25.693,
              "longitude": 100.16,
              "address": "大理古城",
              "priceInfo": "¥380/晚",
              "description": "海景房",
              "tips": <String>["提前预订"],
              "images": <String>["/travel/media/assets/a/x.jpg"],
              "reviews": <dynamic>[
                {"author": "旅友A", "rating": 4.5, "text": "位置很好"},
              ],
            },
            <String, dynamic>{
              "type": "attraction",
              "name": "洱海生态廊道",
              "itemId": "a1",
              "startTime": "09:00",
              "latitude": 25.72,
              "longitude": 100.18,
              "address": "环海西路",
              "priceInfo": "免费",
              "description": "骑行赏海",
            },
            <String, dynamic>{
              "type": "restaurant",
              "name": "白族私房菜",
              "itemId": "r1",
              "startTime": "12:00",
              "latitude": 25.69,
              "longitude": 100.17,
              "address": "古城内",
              "priceInfo": "¥80/人",
            },
          ],
        },
        <String, dynamic>{
          "date": "2026-08-31",
          "items": <dynamic>[
            <String, dynamic>{
              "type": "attraction",
              "name": "崇圣寺三塔",
              "itemId": "a2",
              "startTime": "10:00",
              "latitude": 25.72,
              "longitude": 100.145,
              "address": "崇圣寺",
              "priceInfo": "¥75",
            },
          ],
        },
      ],
    };

/// 结构化行程卡入参（面板走 travelPlan 直读路径）。
AgentResultData cardFrom(Map<String, dynamic> plan) => AgentResultData(
      title: plan["title"]?.toString() ?? "",
      items: const <AgentResultItem>[],
      cardType: "travel_itinerary",
      travelPlan: plan,
      autoOpen: true,
    );

void main() {
  group("TravelPlanData 结构化解析", () {
    test("planId/坐标/媒体字段齐全，条目类型映射正确", () {
      final TravelPlanData plan = TravelPlanData.fromPlanJson(structuredPlan());
      expect(plan.hasPlanId, isTrue);
      expect(plan.planId, "plan-widget-test");
      expect(plan.destination, "大理");
      expect(plan.days.length, 2);
      final TravelDayEntry hotel = plan.days[0].entries[0];
      expect(hotel.kind, TravelEntryKind.hotel);
      expect(hotel.latitude, closeTo(25.693, 1e-6));
      expect(hotel.images.first, contains("http")); // 相对路径已拼服务端地址
      expect(hotel.reviews.first.author, "旅友A");
      expect(hotel.tips.first, "提前预订");
      expect(plan.days[0].entries[1].kind, TravelEntryKind.attraction);
      expect(plan.days[0].entries[2].kind, TravelEntryKind.restaurant);
    });

    test("聚合键与数值价格抽取", () {
      final TravelPlanData plan = TravelPlanData.fromPlanJson(structuredPlan());
      final TravelDayEntry r = plan.days[0].entries[2];
      expect(r.aggregateKey, "r1");
      expect(r.numericPrice, 80);
    });
  });

  group("TravelPlanPanel 渲染与交互", () {
    Widget host() {
      return MaterialApp(
        home: Scaffold(
          body: TravelPlanPanel(
            data: cardFrom(structuredPlan()),
            fullscreen: true,
          ),
        ),
      );
    }

    Future<void> pumpPanel(WidgetTester tester) async {
      await tester.pumpWidget(host());
      await tester.pump(const Duration(seconds: 1));
      await tester.pump(const Duration(seconds: 1));
    }

    testWidgets("双栏骨架 + 天数列表 + 时间线条目渲染", (WidgetTester tester) async {
      await pumpPanel(tester);

      expect(find.text("大理"), findsOneWidget); // 目的地徽章
      expect(find.text("大理2日游·测试"), findsOneWidget); // 标题
      expect(find.text("2026-08-30"), findsWidgets); // 天标签
      expect(find.text("古城客栈"), findsOneWidget); // Day1 条目
      expect(find.text("洱海生态廊道"), findsOneWidget);
      expect(find.text("白族私房菜"), findsOneWidget);
    });

    testWidgets("点击第 2 天切换右栏内容", (WidgetTester tester) async {
      await pumpPanel(tester);

      await tester.tap(find.text("2026-08-31").first);
      // WebView 初始化占位含无限动画，不能用 pumpAndSettle，用固定时长推进
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump(const Duration(seconds: 1));
      expect(find.text("崇圣寺三塔"), findsOneWidget);
      expect(find.text("古城客栈"), findsNothing);
    });

    testWidgets("顶栏工具齐全（路线/地图/预订/偏好/更多）", (WidgetTester tester) async {
      await pumpPanel(tester);

      expect(find.byTooltip("规划当日路线"), findsOneWidget);
      expect(find.byTooltip("收起地图"), findsOneWidget);
      expect(find.byTooltip("预订清单"), findsOneWidget);
      expect(find.byTooltip("偏好设置"), findsOneWidget);
      expect(find.byTooltip("导出 / 分享"), findsOneWidget);
    });

    testWidgets("地图收起后时间线仍正常渲染", (WidgetTester tester) async {
      await pumpPanel(tester);

      await tester.tap(find.byTooltip("收起地图"));
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text("洱海生态廊道"), findsOneWidget);
    });

    testWidgets("无 planId 的文本兜底行程：编辑图标不出现（只读）", (WidgetTester tester) async {
      const AgentResultData textCard = AgentResultData(
        title: "大理2日游",
        items: <AgentResultItem>[
          AgentResultItem(type: "num", text: "Day 1"),
          AgentResultItem(type: "num", text: "09:00 洱海生态廊道：骑行赏海"),
        ],
        cardType: "travel_itinerary",
      );
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: TravelPlanPanel(data: textCard, fullscreen: true),
        ),
      ));
      await tester.pump(const Duration(seconds: 1));
      await tester.pump(const Duration(seconds: 1));

      // 文本兜底解析出了条目（无坐标/planId）
      expect(find.text("洱海生态廊道"), findsOneWidget);
      // 只读：无编辑/移除操作钮
      expect(find.byTooltip("替换 / 提意见"), findsNothing);
      expect(find.byTooltip("移除"), findsNothing);
    });
  });

  group("IntelligentRoutePlanner", () {
    test("生成路段/总览/评估，最短距离推荐步行或骑行", () {
      const List<RouteWaypoint> wps = <RouteWaypoint>[
        RouteWaypoint(name: "A点", latitude: 25.69, longitude: 100.16),
        RouteWaypoint(name: "B点", latitude: 25.693, longitude: 100.163),
        RouteWaypoint(name: "C点", latitude: 25.696, longitude: 100.166),
      ];
      final SmartRouteResult result = IntelligentRoutePlanner()
          .planIntelligentRoute(wps, const TravelPreferences());
      expect(result.segments.length, 2);
      expect(result.totalDistanceMeters, greaterThan(0));
      expect(result.segments.first.distanceMeters, lessThan(800)); // ~400m 短距离
      expect(
          result.segments.first.transportMode, anyOf("walking", "cycling"));
      expect(result.optimizationScore, inInclusiveRange(0, 100));
      expect(result.assessment, isNotEmpty);
      expect(result.totalDurationText, contains("分钟"));
    });

    test("服务链接生成（叫车/导航）", () {
      final SmartRouteResult result = IntelligentRoutePlanner()
          .planIntelligentRoute(
        const <RouteWaypoint>[
          RouteWaypoint(name: "A", latitude: 25.69, longitude: 100.16),
          RouteWaypoint(name: "B", latitude: 25.75, longitude: 100.22),
        ],
        const TravelPreferences(),
      );
      final Map<String, String> links = result.serviceLinks();
      expect(links["didi"], contains("lat=25.69"));
      expect(links["gaode"], contains("uri.amap.com/navigation"));
    });
  });

  group("预订清单条目解析", () {
    test("TravelBookingItem 折扣标签解析", () {
      final TravelBookingItem item = TravelBookingItem.fromJson(
        <String, dynamic>{
          "name": "古城客栈",
          "type": "hotel",
          "unitPrice": 342,
          "count": 2,
          "originalPrice": 760,
          "finalPrice": 684,
          "discounts": <String>["金卡会员 9折", "Booking Genius 2 9折"],
        },
      );
      expect(item.finalPrice, 684);
      expect(item.discounts.length, 2);
      item.checked = false;
      expect(item.checked, isFalse);
    });
  });
}
