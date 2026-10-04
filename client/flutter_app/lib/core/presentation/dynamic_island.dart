import 'dart:async';
import 'dart:convert';
import 'dart:developer' as developer;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// 岛内容类别（与原生 Kind 枚举一一对应）。
/// briefing 已退役：简报就绪不再上岛，触达交给各呈现形态（悬浮窗/系统通知/
/// 对话流卡片），见 _handleMorningBriefingEvent。
enum IslandKind { task, update, schedule, inbox, voice }

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

  // 语音模式独占（岛=唯一视觉）：激活期间非语音条目停泊在此，
  // 退出语音模式后按原顺序放行回常规仲裁。
  bool _voiceExclusive = false;
  final List<IslandEntry> _voiceParking = <IslandEntry>[];

  // 环境数据（不走条目优先级仲裁，直接进原生 hover 态）。
  int _taskPlaneCount = 0;
  bool _foregroundAgentActive = false;
  int _ambientUnread = 0;

  /// 消息聚合未读（微信/QQ/飞书等多来源平台消息）：与站内信分账，
  /// hover 环境行合并为同一个「N 未读」。
  int _messageHubUnread = 0;
  String _agentStatusLine = '';

  IslandEntry? get entry => _entry;
  bool get expanded => _expanded;
  /// hover 环境行未读总数（站内信 + 消息聚合）。
  int get ambientUnread => _ambientUnread + _messageHubUnread;
  String get agentStatusLine => _agentStatusLine;

  /// agent 是否在忙：后台任务面有活任务，或前台轮次处理中。
  bool get agentActive => _taskPlaneCount > 0 || _foregroundAgentActive;

  /// 更新后台任务面活跃任务数（chat.task_update 生命周期）。
  void updateTaskPlaneCount(int count) {
    if (_taskPlaneCount == count) return;
    _taskPlaneCount = count;
    notifyListeners();
  }

  /// 前台轮次 agent 处理状态（tool.call 开始 / 收尾清位）。
  void setForegroundAgent({required bool active}) {
    if (_foregroundAgentActive == active) return;
    _foregroundAgentActive = active;
    notifyListeners();
  }

  /// hover「任务」页状态行（最后一次工具调用的 userStatusLine）。
  void updateAgentStatusLine(String line) {
    final String trimmed = line.trim();
    if (_agentStatusLine == trimmed) return;
    _agentStatusLine = trimmed;
    notifyListeners();
  }

  /// 站内信未读数（hover 环境行数据源）。
  void setAmbientUnread(int count) {
    if (_ambientUnread == count) return;
    _ambientUnread = count;
    notifyListeners();
  }

  /// 消息聚合未读数（hover 环境行与站内信合并展示）。
  void setMessageHubUnread(int count) {
    if (_messageHubUnread == count) return;
    _messageHubUnread = count;
    notifyListeners();
  }

  /// 消息聚合未读原始值（岛旁挂件数据源；hover 行用合并后的 [ambientUnread]）。
  int get messageHubUnread => _messageHubUnread;

  /// 展示/刷新一条信息。同 id 原地刷新；不同 id 按优先级抢占或排队。
  /// 语音模式独占期间，非语音条目改道停泊区（不抢屏）。
  void present(IslandEntry e) {
    if (_voiceExclusive && e.kind != IslandKind.voice) {
      _park(e);
      return;
    }
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

  void _park(IslandEntry e) {
    _voiceParking
      ..removeWhere((IslandEntry q) => q.id == e.id)
      ..add(e);
    if (_voiceParking.length > _maxQueue + 3) _voiceParking.removeAt(0);
  }

  /// 语音模式独占开关。
  /// 开：当前条目与轮播队列整体停泊（语音条目之外不再上屏）；
  /// 关：停泊条目按原顺序放行回常规队列。
  void setVoiceExclusive(bool exclusive) {
    if (_voiceExclusive == exclusive) return;
    _voiceExclusive = exclusive;
    if (exclusive) {
      final IslandEntry? top = _entry;
      if (top != null && top.kind != IslandKind.voice) {
        _park(top);
        _entry = null;
      }
      for (final IslandEntry q in List<IslandEntry>.of(_queue)) {
        _park(q);
      }
      _queue.clear();
    } else {
      for (final IslandEntry p in List<IslandEntry>.of(_voiceParking)) {
        _enqueue(p);
      }
      _voiceParking.clear();
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
    if (_voiceExclusive && id != 'voice') {
      // 独占期间只从停泊区摘除，不放行上屏。
      _voiceParking.removeWhere((IslandEntry q) => q.id == id);
      return;
    }
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
    if (_entry == null && _queue.isEmpty && _voiceParking.isEmpty) return;
    _entry = null;
    _queue.clear();
    _voiceParking.clear();
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
  // 岛旁独立消息卡的最近数据缓存：原生窗口重建后随状态同步补推。
  List<Map<String, Object?>> _lastMessageRows = const <Map<String, Object?>>[];
  // create 失败退避重试（2026-09-28 根治）：此前一次失败 = 整进程无岛且零日志。
  Timer? _createRetryTimer;
  int _createAttempts = 0;
  // 看门狗：窗口定时器随窗口同死，窗口失活的自愈只能活在窗口之外。
  Timer? _watchdogTimer;

  /// 原生窗口是否就绪（E2E 断言用）。
  bool get isNativeReady => _nativeReady;

  /// 胶囊本体点击回调（payload="voice"=纯语音模式点击说话）。
  void Function(String payload)? onIslandTapped;

  /// 点击说话模式开关（纯语音模式进入时开启，退出时关闭）。
  Future<void> setVoiceTalkMode(bool enabled) async {
    if (!_nativeReady) return;
    try {
      await _channel.invokeMethod<bool>(
          'setVoiceTalkMode', <String, Object?>{'enabled': enabled});
    } on PlatformException catch (_) {}
  }

  /// 绑定控制器并创建原生窗口。应用启动后调用一次。
  Future<void> attach(DynamicIslandController controller) async {
    if (_controller != null) return;
    _controller = controller;
    controller.addListener(_syncToNative);
    await _ensureNativeCreated();
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
        } else if (event == 'tapped') {
          // 胶囊本体点击（纯语音模式：点击说话）。无注册回调时静默。
          onIslandTapped?.call(payload);
        }
      }
      return null;
    });
    _startWatchdog();
    _syncToNative();
  }

  /// 创建原生窗口：失败带日志退避重试（2s/5s/10s，之后每 30s 兜底），
  /// 不再静默终身放弃。重试成功时补一次全量状态同步。
  Future<void> _ensureNativeCreated() async {
    if (_nativeReady) return;
    _createAttempts += 1;
    Object? error;
    try {
      _nativeReady = await _channel.invokeMethod<bool>('create') ?? false;
    } on PlatformException catch (e) {
      error = e;
    } on MissingPluginException catch (e) {
      error = e;
    }
    if (_nativeReady) {
      _createRetryTimer?.cancel();
      _createRetryTimer = null;
      if (_createAttempts > 1) {
        debugPrint('[dynamic-island] 原生窗口第 $_createAttempts 次尝试创建成功');
        unawaited(_syncToNative());
      }
      return;
    }
    debugPrint('[dynamic-island] 原生窗口创建失败（第 $_createAttempts 次）：'
        '$error，将退避重试');
    final int delaySec = switch (_createAttempts) {
      1 => 2,
      2 => 5,
      3 => 10,
      _ => 30,
    };
    _createRetryTimer?.cancel();
    _createRetryTimer = Timer(Duration(seconds: delaySec), () {
      unawaited(_ensureNativeCreated());
    });
  }

  /// 窗口活体看门狗：周期 ping 原生句柄，失活（曾被外部销毁）即走重建链。
  /// 2026-09-28 取证发现：岛窗口创建成功后仍可能被外部销毁，而 C++ 悬空
  /// 句柄会让 create 空转返回 true——看门狗是窗口生命周期之外的兜底。
  void _startWatchdog() {
    _watchdogTimer?.cancel();
    _watchdogTimer = Timer.periodic(const Duration(seconds: 15), (_) async {
      if (!_nativeReady) return;  // 重试链在跑时让路
      bool alive = true;
      try {
        alive = await _channel.invokeMethod<bool>('ping') ?? false;
      } catch (_) {
        return;  // 通道瞬时异常：交给下一轮
      }
      if (alive) {
        // 抑制检查兜底：原生 WM_TIMER 心跳会失效（2026-10-01 实证：全屏
        // 游戏期间创建的岛心跳永久停摆，退出全屏后卡死隐藏），由看门狗
        // 每 15s 直推一次抑制检查，退出全屏 ≤15s 必然恢复。
        try {
          await _channel.invokeMethod<void>('suppressCheck');
        } catch (_) {}
        return;
      }
      debugPrint('[dynamic-island] 原生窗口失活，触发重建');
      _nativeReady = false;
      _createAttempts = 0;
      unawaited(_ensureNativeCreated());
    });
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

  /// 岛旁独立消息卡数据（最近会话预览行）；缓存待原生重建后补推。
  Future<void> setMessagesPreview(List<Map<String, Object?>> items) async {
    _lastMessageRows = items;
    if (!_nativeReady) return;
    try {
      await _channel.invokeMethod<bool>('setMessagesPreview',
          <String, Object?>{'items': items});
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
      // hover 态环境行 + 岛旁消息挂件：轻量数据随状态同步直推。
      await _channel.invokeMethod<bool>('setAmbient', <String, Object?>{
        'unread': _controller!.ambientUnread,
        'agentActive': _controller!.agentActive,
        'agentStatus': _controller!.agentStatusLine,
        'messageHub': _controller!.messageHubUnread,
      });
      if (_lastMessageRows.isNotEmpty) {
        await _channel.invokeMethod<bool>('setMessagesPreview',
            <String, Object?>{'items': _lastMessageRows});
      }
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
  if (kDebugMode) {
    // 真机取证口：VM service 直查岛的原生窗口创建状态，并现场探测一次
    // create 调用（带 3 秒超时）——用于诊断「岛没上屏」类问题（2026-09-28）。
    developer.registerExtension('ext.pai.debug.islandState', (method, parameters) async {
      final DynamicIslandLauncher l = DynamicIslandLauncher.instance;
      final Map<String, Object?> info = <String, Object?>{
        'controllerAttached': l._controller != null,
        'nativeReady': l._nativeReady,
        'createAttempts': l._createAttempts,
        'retryTimerActive': l._createRetryTimer != null,
      };
      final Stopwatch sw = Stopwatch()..start();
      try {
        info['probeCreate'] = await DynamicIslandLauncher._channel
            .invokeMethod<bool>('create')
            .timeout(const Duration(seconds: 3));
      } catch (e) {
        info['probeCreateError'] = e.toString();
      }
      info['probeMs'] = sw.elapsedMilliseconds;
      return developer.ServiceExtensionResponse.result(jsonEncode(info));
    });
  }
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

  /// 后台任务计数/状态行（chat.task_update 生命周期驱动）：只喂 hover「任务」页
  /// （agentActive + 状态行），胶囊不再出「后台任务进行中」条目（2026-10-04 拍板）。
  static void setTaskActivity({required int activeCount, String? statusLine}) {
    _c.updateTaskPlaneCount(activeCount);
    if (statusLine != null && statusLine.trim().isNotEmpty) {
      _c.updateAgentStatusLine(statusLine);
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

  /// 站内信未读（inbox.message / 轮询校准驱动）。
  /// 未读数同时进 hover 环境行（「日期 · 下一日程 · N 未读」）。
  static void setInboxUnread(int count) {
    _c.setAmbientUnread(count);
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

  /// 消息聚合未读（多来源平台消息轮询驱动）。不做胶囊条目：
  /// 原生在胶囊右缘画小挂件（信封 + 未读数，点击展开独立消息卡），
  /// 数值随 setAmbient 全量同步，原生窗口重建后自动恢复。
  static void setMessageHubUnread(int count) {
    debugPrint('[island-feed] setMessagesUnread=$count');
    _c.setMessageHubUnread(count);
  }

  /// 独立消息卡预览行（最近会话，挂件点开即看，与应用内隔离）。
  static void setMessagesPreview(List<Map<String, Object?>> items) {
    _l.setMessagesPreview(items);
  }

  // ───────────────────── 纯语音模式（岛=唯一视觉） ─────────────────────
  // 原玻璃胶囊悬浮球（voice-orb-py）退役，语音交互的状态载体移交通灵岛。

  /// 语音模式状态条目：等待唤醒 / 聆听 / 思考 / 播报共用一个 id 原地刷新。
  /// priority 0 与任务态同级——纯语音模式下它是唯一的常驻视觉，必须置顶。
  static void setVoiceEntry({
    required String title,
    bool spinning = false,
    String? trailing,
  }) {
    _c.present(IslandEntry(
      id: 'voice',
      title: title,
      kind: IslandKind.voice,
      spinning: spinning,
      trailing: (trailing ?? '').trim().isEmpty ? null : trailing,
      priority: 0,
    ));
  }

  /// 退出语音模式：撤下语音条目。
  static void dismissVoice() {
    _c.dismiss('voice');
  }
}
