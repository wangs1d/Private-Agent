import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// 岛内容类别（与原生 Kind 枚举一一对应）。
enum IslandKind { task, update, schedule, briefing, inbox }

/// 一条要在岛上展示的信息。
class IslandEntry {
  const IslandEntry({
    required this.id,
    required this.title,
    required this.kind,
    this.trailing,
    this.progress,
    this.spinning = false,
    this.priority = 2,
  });

  final String id;
  final String title;
  final IslandKind kind;

  /// 右侧短文案（如 2'14 / 64% / 25 分钟后）。
  final String? trailing;

  /// 0~1，非空时胶囊底部画一条细进度线（更新下载用）。
  final double? progress;

  /// 尾部呼吸活点（任务进行中用）。
  final bool spinning;

  /// 数值越小优先级越高；被高优先级抢占的条目回队列尾部。
  final int priority;
}

/// 灵动岛状态控制器：单插槽 + 优先级抢占 + 有界队列。
/// 纯状态大脑，不碰平台通道——渲染端是原生窗口，
/// 由 [DynamicIslandLauncher] 监听本控制器并同步过去。
///
/// 与通知分流定调一致：岛上只走「不需要决策的被动信息」，
/// 需要决策的通知仍走右下角原生弹窗，不进岛。
class DynamicIslandController extends ChangeNotifier {
  /// 运行态统一用 [instance] 单例；测试需要干净实例时直接新建。
  DynamicIslandController();

  static final DynamicIslandController instance = DynamicIslandController();

  static const int _maxQueue = 3;

  IslandEntry? _entry;
  bool _expanded = false;
  final List<IslandEntry> _queue = <IslandEntry>[];

  IslandEntry? get entry => _entry;
  bool get expanded => _expanded;

  /// 展示/刷新一条信息。同 id 原地刷新；不同 id 按优先级抢占或排队。
  void present(IslandEntry e) {
    if (_entry?.id == e.id) {
      _entry = e;
      notifyListeners();
      return;
    }
    if (_entry == null || e.priority < _entry!.priority) {
      final IslandEntry? displaced = _entry;
      _entry = e;
      if (displaced != null) _enqueue(displaced);
    } else {
      _enqueue(e);
    }
    notifyListeners();
  }

  void _enqueue(IslandEntry e) {
    _queue
      ..removeWhere((IslandEntry q) => q.id == e.id)
      ..add(e);
    if (_queue.length > _maxQueue) _queue.removeAt(0);
  }

  void dismiss(String id) {
    final bool wasTop = _entry?.id == id;
    _queue.removeWhere((IslandEntry q) => q.id == id);
    if (!wasTop) {
      notifyListeners();
      return;
    }
    // FIFO：按入队顺序轮播，先来的信息先露面。
    _entry = _queue.isEmpty ? null : _queue.removeAt(0);
    _expanded = false;
    notifyListeners();
  }

  void dismissAll() {
    if (_entry == null && _queue.isEmpty) return;
    _entry = null;
    _queue.clear();
    _expanded = false;
    notifyListeners();
  }

  void toggleExpanded() {
    _expanded = !_expanded;
    notifyListeners();
  }

  void collapse() {
    if (!_expanded) return;
    _expanded = false;
    notifyListeners();
  }
}

/// 灵动岛原生窗口通道：把控制器状态同步给 C++ 分层窗口，
/// 并接回原生事件（展开变化 / 快捷按钮）。
class DynamicIslandLauncher {
  DynamicIslandLauncher._();

  static final DynamicIslandLauncher instance = DynamicIslandLauncher._();

  static const MethodChannel _channel = MethodChannel('pai/dynamic_island');

  DynamicIslandController? _controller;
  bool _nativeReady = false;
  bool _syncingFromNative = false;

  /// 绑定控制器并创建原生窗口。应用启动后调用一次。
  Future<void> attach(DynamicIslandController controller) async {
    if (_controller != null) return;
    _controller = controller;
    controller.addListener(_syncToNative);
    try {
      _nativeReady = await _channel.invokeMethod<bool>('create') ?? false;
    } on PlatformException catch (_) {
      _nativeReady = false;
    } on MissingPluginException catch (_) {
      _nativeReady = false;
    }
    _channel.setMethodCallHandler((MethodCall call) async {
      if (call.method == 'onNativeEvent') {
        final Map<dynamic, dynamic> args =
            call.arguments as Map<dynamic, dynamic>;
        final String event = args['event']?.toString() ?? '';
        final String payload = args['payload']?.toString() ?? '';
        if (event == 'expandedChanged') {
          // 原生点击驱动展开/收起；控制器监听器会把状态推回原生（幂等）。
          _syncingFromNative = true;
          final DynamicIslandController c = _controller!;
          if (payload == 'true' && !c.expanded) {
            c.toggleExpanded();
          } else if (payload == 'false' && c.expanded) {
            c.collapse();
          }
          _syncingFromNative = false;
        } else if (event == 'action') {
          handleIslandAction(payload);
        }
      }
      return null;
    });
    _syncToNative();
  }

  /// 提醒时刻的 attention 动画：放大 2 倍 + 高亮脉冲。
  Future<void> attention({
    required String title,
    String trailing = '',
  }) async {
    if (!_nativeReady) return;
    try {
      await _channel.invokeMethod<bool>('attention', <String, Object?>{
        'title': title,
        'trailing': trailing,
      });
    } on PlatformException catch (_) {}
  }

  /// 下发今日安排（展开卡内容）。
  Future<void> setAgenda(List<Map<String, Object?>> items) async {
    if (!_nativeReady) return;
    try {
      await _channel.invokeMethod<bool>('setAgenda', <String, Object?>{
        'items': items,
      });
    } on PlatformException catch (_) {}
  }

  Future<void> _syncToNative() async {
    if (!_nativeReady || _controller == null || _syncingFromNative) return;
    final IslandEntry? e = _controller!.entry;
    try {
      if (e == null) {
        await _channel.invokeMethod<bool>('clearEntry');
      } else {
        await _channel.invokeMethod<bool>('present', <String, Object?>{
          'id': e.id,
          'title': e.title,
          'trailing': e.trailing ?? '',
          'kind': e.kind.index,
          'progress': e.progress ?? -1.0,
          'spinning': e.spinning,
        });
      }
      await _channel.invokeMethod<bool>('setExpanded',
          <String, Object?>{'expanded': _controller!.expanded});
    } on PlatformException catch (_) {}
  }
}

/// 展开卡快捷动作：唤起主窗口到前台。
/// 具体页面导航等主窗口就绪后由 main.dart 注入 [_islandActionHandler]。
void Function(String label) _islandActionHandler = _defaultActionHandler;

void setDynamicIslandActionHandler(void Function(String label) handler) {
  _islandActionHandler = handler;
}

void _defaultActionHandler(String label) {
  // 默认：把主窗口带回前台（用户从岛点了快捷入口）。
  // main.dart 会用带导航的实现覆盖这里。
}

void handleIslandAction(String label) => _islandActionHandler(label);

// ───────────────────────── 行程预告调度器 ─────────────────────────

/// 行程提醒的提前量策略：按事项标题关键词分类，不同事情不同提前时间。
/// v1 策略表在客户端；服务端 schedule.reminder_fired 也可作为提醒源汇入
/// 同一条 attention 通路。
class IslandReminderPolicy {
  IslandReminderPolicy._();

  /// 返回该事项的提前提醒分钟档（升序，如 [25, 5] = 提前 25 分钟一次、
  /// 提前 5 分钟再催一次）。命中多个类别取最靠前的规则。
  static List<int> leadMinutesFor(String title) {
    if (_contains(title, const ['评审', '会议', '面试', '答辩', '汇报', '客户'])) {
      return const <int>[25, 5];
    }
    if (_contains(title, const ['课', '上课', '考试'])) {
      return const <int>[120, 15];
    }
    if (_contains(title, const ['晚餐', '午餐', '早餐', '聚餐', '约饭'])) {
      return const <int>[40];
    }
    if (_contains(title, const ['旅行', '航班', '火车', '出发'])) {
      return const <int>[180, 60];
    }
    return const <int>[30];
  }

  /// 提醒文案的尾注（第几档）。
  static String trailingFor(int minutesAhead, int tierIndex, int tierCount) {
    if (minutesAhead <= 0) return '现在';
    final String base = minutesAhead >= 60
        ? '${minutesAhead ~/ 60} 小时 ${minutesAhead % 60} 分'
        : '$minutesAhead 分钟';
    return tierCount > 1 ? '$base · 第${tierIndex + 1}次提醒' : '$base 后';
  }

  static bool _contains(String title, List<String> keys) {
    for (final String k in keys) {
      if (title.contains(k)) return true;
    }
    return false;
  }
}

/// 行程预告调度器：从今日日程生成各提前档的提醒时刻，
/// 到点让岛播放 attention 动画（放大 2 倍 + 高亮）。
/// 接真实数据：main.dart 把今日日程喂给 [refresh]；
/// 服务端 schedule.reminder_fired 事件也可直接调 [fireNow]。
class IslandReminderScheduler {
  IslandReminderScheduler._();

  static final IslandReminderScheduler instance = IslandReminderScheduler._();

  final List<Timer> _timers = <Timer>[];

  /// 用今日日程重建提醒计划（幂等：清掉旧 timer 再排）。
  void refresh(List<Map<String, Object?>> agenda) {
    cancelAll();
    final DateTime now = DateTime.now();
    for (final Map<String, Object?> item in agenda) {
      final Object? timeRaw = item['time'];
      if (timeRaw is! String || timeRaw.length < 4) continue;
      final int? hour = int.tryParse(timeRaw.substring(0, 2));
      final int? minute = int.tryParse(timeRaw.substring(3, 5));
      if (hour == null || minute == null) continue;
      final DateTime start =
          DateTime(now.year, now.month, now.day, hour, minute);
      if (item['completed'] == true || !start.isAfter(now)) continue;
      final String title = (item['title'] ?? '').toString();
      final List<int> leads = IslandReminderPolicy.leadMinutesFor(title);
      for (int i = 0; i < leads.length; i++) {
        final int lead = leads[i];
        final DateTime fireAt = start.subtract(Duration(minutes: lead));
        if (!fireAt.isAfter(now)) continue;
        final int tier = i;
        final int tiers = leads.length;
        _timers.add(Timer(fireAt.difference(now), () {
          fireNow(
            title: title,
            minutesAhead: lead,
            tierIndex: tier,
            tierCount: tiers,
          );
        }));
      }
    }
  }

  void cancelAll() {
    for (final Timer t in _timers) {
      t.cancel();
    }
    _timers.clear();
  }

  /// 立即触发一次提醒动画（调度器到点 / 服务端 reminder_fired 共用）。
  /// [trailingOverride] 非空时直接作为尾注文案（服务端已算好提前量的场景）。
  void fireNow({
    required String title,
    int minutesAhead = 0,
    int tierIndex = 0,
    int tierCount = 1,
    String? trailingOverride,
  }) {
    final DynamicIslandLauncher launcher = DynamicIslandLauncher.instance;
    launcher.attention(
      title: title,
      trailing: trailingOverride ??
          IslandReminderPolicy.trailingFor(minutesAhead, tierIndex, tierCount),
    );
    // 提醒动画结束后胶囊回落：6 秒后清掉提醒条目。
    Timer(const Duration(seconds: 6), () {
      DynamicIslandController.instance.dismiss('attention');
    });
  }
}

/// 启动灵动岛（应用初始化时调用一次）：绑定控制器。
/// 数据全部来自真实事件源（IslandRealFeeds），无演示模式。
Future<void> initDynamicIsland() async {
  await DynamicIslandLauncher.instance
      .attach(DynamicIslandController.instance);
}

// ───────────────────────── 真实数据喂点 ─────────────────────────

/// 各真实事件源 → 岛条目的统一入口（main.dart 各 WS 处理器/服务调用）。
/// 全部走控制器同 id 幂等刷新；移除条件满足时 dismiss。
class IslandRealFeeds {
  IslandRealFeeds._();

  static final DynamicIslandController _c = DynamicIslandController.instance;
  static final DynamicIslandLauncher _l = DynamicIslandLauncher.instance;
  static Timer? _briefingDismissTimer;

  /// 后台任务进行中（chat.task_update 生命周期驱动）。
  static void setTaskActivity({required int activeCount}) {
    if (activeCount > 0) {
      _c.present(IslandEntry(
        id: 'task',
        title: activeCount == 1 ? '后台任务进行中' : '$activeCount 个任务进行中',
        kind: IslandKind.task,
        spinning: true,
        priority: 0,
      ));
    } else {
      _c.dismiss('task');
    }
  }

  /// 应用更新下载进度（ClientUpdateFlowController 通知驱动）。
  /// progress 非 null = 下载中（0~1）；null = 回 idle/终态，撤条目。
  static void setUpdateProgress(double? progress, {String version = ''}) {
    if (progress != null) {
      _c.present(IslandEntry(
        id: 'update',
        title: '更新下载中',
        kind: IslandKind.update,
        trailing: '${(progress * 100).round()}%',
        progress: progress.clamp(0.0, 1.0),
        priority: 1,
      ));
    } else {
      _c.dismiss('update');
    }
  }

  /// 日程倒计时（今日日程同步驱动）+ 展开卡内容 + 提醒计划。
  /// [agenda] 为完整今日安排（含已完成，供展开卡）；[next] 为最近未完成项。
  static void setSchedule({
    required List<Map<String, Object?>> agenda,
    Map<String, Object?>? next,
  }) {
    _l.setAgenda(agenda);
    IslandReminderScheduler.instance.refresh(agenda);
    if (next == null) {
      _c.dismiss('schedule.next');
      return;
    }
    _c.present(IslandEntry(
      id: 'schedule.next',
      title: (next['title'] ?? '').toString(),
      kind: IslandKind.schedule,
      trailing: (next['trailing'] ?? '').toString(),
      priority: 2,
    ));
  }

  /// 早报就绪（morning.briefing 事件驱动），10 分钟后自动撤下。
  static void setBriefingReady({String trailing = '点击查看'}) {
    _briefingDismissTimer?.cancel();
    _c.present(IslandEntry(
      id: 'briefing',
      title: '今日简报已就绪',
      kind: IslandKind.briefing,
      trailing: trailing,
      priority: 3,
    ));
    _briefingDismissTimer = Timer(const Duration(minutes: 10), () {
      _c.dismiss('briefing');
    });
  }

  /// 站内信未读（inbox.message / 轮询校准驱动）。
  static void setInboxUnread(int count) {
    if (count > 0) {
      _c.present(IslandEntry(
        id: 'inbox',
        title: '站内信',
        kind: IslandKind.inbox,
        trailing: '$count 条未读',
        priority: 3,
      ));
    } else {
      _c.dismiss('inbox');
    }
  }
}
