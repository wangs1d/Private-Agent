// 灵动岛「三级渐进展开」E2E 数据注入引导。
//
// 仅当以 --dart-define=PAI_ISLAND_E2E=true 构建时由 main.dart 调用，
// 生产构建该常量为 false，整段零开销（tree-shake 后不进包）。
//
// 职责（与 integration_test/dynamic_island_stage_capture.ps1 握手）：
//   1. 延迟待启动稳定后，通过生产喂点（IslandRealFeeds / 控制器）注入
//      今日日程、未读数、后台任务、agent 工具步骤流——数据链路与线上
//      完全同一条（WS 事件 → 喂点 → MethodChannel → C++ 壳层）；
//   2. 写 data_ready.flag 通知 PS 脚本开始真实鼠标交互（三级展开 /
//      hover 滚轮切页 / 形变保护连点 / 分级收回）并逐帧截图；
//   3. 收到 driver_done.flag 后撤下注入条目并退出进程。
import 'dart:async';
import 'dart:io';

import 'dynamic_island.dart';

final Directory _stageDir = Directory(
    "${Directory.systemTemp.path}${Platform.pathSeparator}pai_island_stage");

Future<void> runIslandStageE2EBootstrap() async {
  _stageDir.createSync(recursive: true);
  final File readyFlag =
      File("${_stageDir.path}${Platform.pathSeparator}data_ready.flag");
  final File doneFlag =
      File("${_stageDir.path}${Platform.pathSeparator}driver_done.flag");
  if (readyFlag.existsSync()) readyFlag.deleteSync();
  if (doneFlag.existsSync()) doneFlag.deleteSync();

  // main.dart 的 initDynamicIsland 与此幂等；attach 若已在途（_controller
  // 已置位但 create 尚未应答），轮询等待通道就绪，避免读早期 _nativeReady。
  await initDynamicIsland();
  for (int i = 0;
      i < 40 && !DynamicIslandLauncher.instance.isNativeReady;
      i++) {
    await Future<void>.delayed(const Duration(milliseconds: 250));
  }
  if (!DynamicIslandLauncher.instance.isNativeReady) {
    return; // 非桌面平台/通道不可用：静默退出。
  }
  await Future<void>.delayed(const Duration(seconds: 6));

  // 喂点 1：今日日程（展开卡「接下来」+ hover「下一节」）。
  IslandRealFeeds.setSchedule(
    agenda: <Map<String, Object?>>[
      <String, Object?>{
        "time": "12:00",
        "title": "午餐 · 与产品对齐",
        "hint": "已完成",
        "completed": true,
      },
      <String, Object?>{
        "time": "14:00",
        "title": "设计评审",
        "hint": "",
        "completed": false,
      },
      <String, Object?>{
        "time": "17:00",
        "title": "周报同步",
        "hint": "",
        "completed": false,
      },
    ],
    next: <String, Object?>{
      "time": "14:00",
      "title": "设计评审",
      "trailing": "25 分钟后",
    },
  );

  // 喂点 2：站内信未读（hover 环境行「N 未读」）。
  IslandRealFeeds.setInboxUnread(3);

  // 喂点 3：后台任务进行中（compact 声明档条目 + hover「任务」页激活）。
  IslandRealFeeds.setTaskActivity(activeCount: 1, statusLine: "正在搜索资料");

  // agent 工具步骤流（tool.call / tool.result 的产物形态）：
  // 进行中转圈、成功勾、失败叉——展开卡「任务动态」三态齐活。
  DynamicIslandController.instance.setAgentSteps(<IslandAgentStep>[
    const IslandAgentStep(label: "读取今日日程", state: 1, key: "calendar.list"),
    const IslandAgentStep(label: "生成晨报摘要", state: 2, key: "briefing.make"),
    const IslandAgentStep(label: "正在搜索资料", state: 0, key: "web.search"),
  ]);

  readyFlag.writeAsStringSync(DateTime.now().toIso8601String());

  // 最多等 3 分钟：PS 脚本完成全部交互与截图。
  final DateTime deadline = DateTime.now().add(const Duration(minutes: 3));
  while (DateTime.now().isBefore(deadline) && !doneFlag.existsSync()) {
    await Future<void>.delayed(const Duration(milliseconds: 500));
  }

  // ── 纯语音模式状态走查（语音唤醒已删除，点击说话）：供第二路 PS 连拍 ──
  // 交互走查结束时岛可能停在展开态（鼠标未离开不触发分级收回），
  // 先收合回胶囊；语音唤醒删除后待机=原态（无条目），点击=说话。
  // 帧序：原态 → 聆听 → 思考 → 播报 → 回原态。
  File("${_stageDir.path}${Platform.pathSeparator}voice_ready.flag")
      .writeAsStringSync(DateTime.now().toIso8601String());
  DynamicIslandController.instance.collapse();
  // 撤下任务条目：与语音条目同为 priority 0，不撤则语音条目只能排队。
  IslandRealFeeds.setTaskActivity(activeCount: 0);
  Future<void> hold(int ms) async =>
      await Future<void>.delayed(Duration(milliseconds: ms));
  await hold(3500); // 原态帧（无任何语音条目）
  IslandRealFeeds.setVoiceEntry(title: "正在聆听", spinning: true);
  await hold(2800);
  IslandRealFeeds.setVoiceEntry(title: "思考中", spinning: true);
  await hold(2800);
  IslandRealFeeds.setVoiceEntry(title: "播报中", trailing: "回复已落聊天流");
  await hold(2800);
  IslandRealFeeds.dismissVoice(); // 会话收束 → 回原态
  await hold(2600);

  // 撤下注入的条目（回 FIFO 队列轮播真实条目）。
  IslandRealFeeds.setTaskActivity(activeCount: 0);
  await Future<void>.delayed(const Duration(seconds: 1));
  exit(0);
}
