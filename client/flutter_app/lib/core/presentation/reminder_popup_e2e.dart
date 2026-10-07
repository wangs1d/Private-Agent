// 日程提醒「预告档/到点档」桌面分流 E2E 数据注入引导。
//
// 仅当 --dart-define=PAI_REMINDER_POPUP_E2E=true 构建时由 main.dart 调用，
// 生产构建该常量为 false，整段零开销（tree-shake 后不进包）。
//
// 验证链路与生产完全同一条（WS schedule.reminder_fired 的处理入口）：
//   AmbientFeedsController.onScheduleReminderFired
//     - 预告档（preReminder=true）→ 只走灵动岛 attention 默认档，不上弹窗；
//     - 到点档（preReminder 缺省）→ 灵动岛长驻留 + 桌面原生弹窗（我知道了）。
// 弹窗真伪以 DesktopNotificationLauncher.isVisible（show 成功才置真）为准，
// PS 侧另用 FindWindow(PAI_DesktopNotification_Window) 双重印证。
//
// 与 integration_test/reminder_popup_capture.ps1 握手
// （%TEMP%\pai_reminder_popup）：
//   写 app_ready.flag → 等 fire_pre.flag → 预告注入 + 2s 弹窗观察 →
//   写 pre_fired.flag/pre_result.txt → 8s 后写 pre_settled.flag →
//   等 fire_due.flag → 到点注入 + 弹窗轮询 → 写 due_fired.flag/
//   due_result.txt → 等 done.flag → exit。
import 'dart:async';
import 'dart:io';

import '../../app/ambient_feeds_controller.dart';
import '../services/desktop_notification_launcher.dart';
import 'dynamic_island.dart';

Future<void> runReminderPopupE2EBootstrap() async {
  final Directory stageDir = Directory(
      "${Directory.systemTemp.path}${Platform.pathSeparator}pai_reminder_popup");
  stageDir.createSync(recursive: true);
  File flag(String name) =>
      File("${stageDir.path}${Platform.pathSeparator}$name");
  for (final String name in <String>[
    'app_ready.flag',
    'fire_pre.flag',
    'pre_fired.flag',
    'pre_result.txt',
    'pre_settled.flag',
    'fire_due.flag',
    'due_fired.flag',
    'due_result.txt',
    'done.flag',
  ]) {
    final File f = flag(name);
    if (f.existsSync()) f.deleteSync();
  }

  // main.dart 启动序列已调 initDynamicIsland()（其 VM 扩展注册非幂等，
  // 这里二次调用会 UNCAUGHT 炸掉本引导）——只轮询就绪标志。
  for (int i = 0;
      i < 60 && !DynamicIslandLauncher.instance.isNativeReady;
      i++) {
    await Future<void>.delayed(const Duration(milliseconds: 250));
  }
  if (!DynamicIslandLauncher.instance.isNativeReady) {
    return; // 非桌面平台/通道不可用：静默退出。
  }
  // 多等几秒让岛回待机胶囊（应用启动期的初始化条目退场）。
  await Future<void>.delayed(const Duration(seconds: 6));

  // ── 阶段 1：预告档 → 只走岛，弹窗不得出现 ──
  // app_ready 由等待循环心跳式重写：PS 若在 dart 落旗后才启动并清场，
  // 下个心跳会把旗子补回来（单次写会被 PS 启动清理误删，双双死等）。
  final DateTime deadline = DateTime.now().add(const Duration(minutes: 5));
  while (DateTime.now().isBefore(deadline) && !flag('fire_pre.flag').existsSync()) {
    flag('app_ready.flag').writeAsStringSync(DateTime.now().toIso8601String());
    await Future<void>.delayed(const Duration(milliseconds: 300));
  }
  if (!flag('fire_pre.flag').existsSync()) exit(0);

  unawaited(AmbientFeedsController.instance.onScheduleReminderFired(
    <String, dynamic>{
      "title": "该出门了 · 14:00 出发",
      "message": "距离出发约 15 分钟",
      "preReminder": true,
    },
  ));
  // 先落旗让 PS 立刻截图（岛默认档 ≈6s，观察窗 2.5s 内仍在 hold 段，
  // 拖到观察后再落旗会错过 attention 画面）。
  flag('pre_fired.flag').writeAsStringSync(DateTime.now().toIso8601String());
  // 留 2.5s 观察窗：控制器内部 DesktopNotificationLauncher.show 若被
  // 误触发，isVisible 会被置真（show 成功才置真）。
  bool prePopupSeen = false;
  final DateTime preObserve =
      DateTime.now().add(const Duration(milliseconds: 2500));
  while (DateTime.now().isBefore(preObserve)) {
    if (DesktopNotificationLauncher.isVisible.value) {
      prePopupSeen = true;
      break;
    }
    await Future<void>.delayed(const Duration(milliseconds: 100));
  }
  flag('pre_result.txt').writeAsStringSync(prePopupSeen
      ? 'FAIL_POPUP_UNEXPECTED'
      : 'OK_NO_POPUP');
  // 岛默认档 ≈ 6s 收回，回待机后再进到点阶段，两帧互不污染。
  await Future<void>.delayed(const Duration(seconds: 8));
  flag('pre_settled.flag').writeAsStringSync(DateTime.now().toIso8601String());

  // ── 阶段 2：到点档 → 岛长驻留 + 桌面原生弹窗 ──
  while (DateTime.now().isBefore(deadline) &&
      !flag('fire_due.flag').existsSync()) {
    await Future<void>.delayed(const Duration(milliseconds: 300));
  }
  if (!flag('fire_due.flag').existsSync()) exit(0);

  unawaited(AmbientFeedsController.instance.onScheduleReminderFired(
    <String, dynamic>{
      "title": "设计评审 · 14:00",
      "message": "10 分钟后开始",
    },
  ));
  bool duePopupShown = false;
  final DateTime dueObserve =
      DateTime.now().add(const Duration(seconds: 4));
  while (DateTime.now().isBefore(dueObserve)) {
    if (DesktopNotificationLauncher.isVisible.value) {
      duePopupShown = true;
      break;
    }
    await Future<void>.delayed(const Duration(milliseconds: 100));
  }
  flag('due_result.txt')
      .writeAsStringSync(duePopupShown ? 'OK_POPUP_SHOWN' : 'FAIL_POPUP_MISSING');
  flag('due_fired.flag').writeAsStringSync(DateTime.now().toIso8601String());

  final DateTime doneDeadline = DateTime.now().add(const Duration(minutes: 2));
  while (DateTime.now().isBefore(doneDeadline) &&
      !flag('done.flag').existsSync()) {
    await Future<void>.delayed(const Duration(milliseconds: 300));
  }
  exit(0);
}
