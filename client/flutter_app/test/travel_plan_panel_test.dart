import "dart:io" show Platform;

import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:private_ai_agent/core/utils/agent_result_parser.dart";
import "package:private_ai_agent/features/chat/intelligent_route_planner.dart";
import "package:private_ai_agent/features/chat/travel_booking_sheet.dart";
import "package:private_ai_agent/features/chat/travel_plan_models.dart";
import "package:private_ai_agent/features/chat/travel_plan_panel.dart";

/// 服务端结构化 travelPlan 快照（带 planId / 中心坐标 / 媒体字段）。
Map<String, dynamic> structuredPlan() => <String, dynamic>{
      "planId": "plan-widget-test",
      "toolName": "travel.plan-itinerary",
      "ts": DateTime.now().millisecondsSinceEpoch,
      "destination": "大理",
      "title": "大理2日游·测试",
      "startDate": "2026-08-30",
      "endDate": "2026-08-31",
      "center": <String, dynamic>{"latitude": 25.69, "longitude": 100.16},
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
  // 本组测试针对原生兜底面板（Windows 宿主上默认走 WebView 版，需强制关闭）
  setUp(() => TravelPlanPanel.webPanelSupported = false);
  tearDown(() => TravelPlanPanel.webPanelSupported = Platform.isWindows);

  group("TravelPlanData 结构化解析", () {
    test("planId/中心坐标/媒体字段齐全，条目类型映射正确", () {
      final TravelPlanData plan = TravelPlanData.fromPlanJson(structuredPlan());
      expect(plan.hasPlanId, isTrue);
      expect(plan.planId, "plan-widget-test");
      expect(plan.destination, "大理");
      expect(plan.centerLatitude, closeTo(25.69, 1e-6));
      expect(plan.centerLongitude, closeTo(100.16, 1e-6));
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
    Widget host({bool fullscreen = true}) {
      return MaterialApp(
        home: Scaffold(
          body: TravelPlanPanel(
            data: cardFrom(structuredPlan()),
            fullscreen: fullscreen,
          ),
        ),
      );
    }

    Future<void> pumpPanel(WidgetTester tester) async {
      await tester.pumpWidget(host());
      await tester.pump(const Duration(seconds: 1));
      await tester.pump(const Duration(seconds: 1));
    }

    testWidgets("左栏天数 + 地图主区骨架渲染", (WidgetTester tester) async {
      await pumpPanel(tester);

      expect(find.text("大理"), findsOneWidget); // 目的地徽章
      expect(find.text("大理2日游·测试"), findsOneWidget); // 标题
      expect(find.text("行程天数（共 2 天）"), findsOneWidget); // 左栏标题
      expect(find.text("2026-08-30"), findsWidgets); // 天标签
      expect(find.text("2026-08-31"), findsOneWidget);
      expect(find.text("规划路线"), findsOneWidget); // 地图路线悬浮按钮
    });

    testWidgets("顶栏只保留全屏查看，旧工具按钮全部移除", (WidgetTester tester) async {
      await pumpWidgetAndSettle(tester, host(fullscreen: false));

      expect(find.byTooltip("全屏查看"), findsOneWidget);
      expect(find.byTooltip("规划当日路线"), findsNothing);
      expect(find.byTooltip("收起地图"), findsNothing);
      expect(find.byTooltip("预订清单"), findsNothing);
      expect(find.byTooltip("偏好设置"), findsNothing);
      expect(find.byTooltip("导出 / 分享"), findsNothing);
    });

    testWidgets("点击第 2 天后地图当前天徽章跟随切换", (WidgetTester tester) async {
      await pumpPanel(tester);

      expect(find.text("2026-08-30 · 第 1 天"), findsOneWidget);
      await tester.tap(find.text("2026-08-31").first);
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump(const Duration(seconds: 1));
      expect(find.text("2026-08-31 · 第 2 天"), findsOneWidget);
    });

    testWidgets("左栏天数列表可收起为窄边栏并再展开", (WidgetTester tester) async {
      await pumpPanel(tester);

      // 收起：天标签消失，仅剩序号圆点
      await tester.tap(find.byTooltip("收起天数列表"));
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text("2026-08-30"), findsNothing);
      expect(find.text("1"), findsOneWidget);
      expect(find.text("2"), findsOneWidget);

      // 展开：天标签恢复
      await tester.tap(find.byTooltip("展开天数列表"));
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text("2026-08-30"), findsWidgets);
      expect(find.text("2026-08-31"), findsOneWidget);
    });

    testWidgets("无 planId 的文本兜底行程也能渲染（地图为中心布局）",
        (WidgetTester tester) async {
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

      expect(find.text("大理"), findsOneWidget); // 目的地徽章（标题推断）
      expect(find.text("规划路线"), findsOneWidget);
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

/// 固定时长推进（WebView 初始化占位含无限动画，不能用 pumpAndSettle）。
Future<void> pumpWidgetAndSettle(WidgetTester tester, Widget widget) async {
  await tester.pumpWidget(widget);
  await tester.pump(const Duration(seconds: 1));
  await tester.pump(const Duration(seconds: 1));
}
