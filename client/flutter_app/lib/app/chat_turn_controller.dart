import "dart:async";

/// 前台对话轮次控制器 —— 轮次 traceId 与回复 watchdog 的收口
/// （原 `_PrivateAiAppState` 内联字段 `_pendingAgentUserMessageId` /
/// `_agentReplyWatchdog`）。
///
/// watchdog 语义：新前台轮次开始 [armTrace] 上弦；流式期间 [resetTimer]
/// 续弦；超时（3 分钟无轮次事件）触发 [onTimeout]——写兜底消息等 UI
/// 收尾由 main 注入，这里只管时序判定。纯状态机，fakeAsync 可单测。
class ChatTurnController {
  ChatTurnController._();

  static final ChatTurnController instance = ChatTurnController._();

  /// 前台轮次 traceId（= 触发该轮的用户消息 id）；null 表示无前台轮次在途。
  /// 与岛/任务面的「后台任务」无关，仅描述聊天区当前前台轮次。
  String? activeTraceId;

  static const Duration replyTimeout = Duration(minutes: 3);

  Timer? _watchdog;

  /// 超时回调（main 注入；watchdog 到点时 showSnackBar 缺省 true，
  /// tool.result 提前收尾路径直接调用方传 false）。
  void Function({bool showSnackBar})? onTimeout;

  void _startTimer() {
    _watchdog?.cancel();
    _watchdog = Timer(replyTimeout, () => onTimeout?.call());
  }

  /// 新前台轮次开始：登记 traceId 并上弦。
  void armTrace(String userMessageId) {
    activeTraceId = userMessageId;
    _startTimer();
  }

  /// 轮次续弦（无在途轮次时为空操作，与原 watchdog 语义一致）。
  void resetTimer() {
    if (activeTraceId == null) return;
    _startTimer();
  }

  void cancelTimer() {
    _watchdog?.cancel();
    _watchdog = null;
  }

  bool get hasActiveTrace => activeTraceId != null;
}

/// 任务面活跃任务状态机（chat.task_update 生命周期驱动），
/// 计数驱动输入框上方「N 个任务后台进行中」状态条与岛任务条目。
class TaskPlaneState {
  final Set<String> _active = <String>{};

  int get activeCount => _active.length;

  bool get isEmpty => _active.isEmpty;

  /// 终态（done/failed/cancelled）移除、其余状态加入；返回是否发生变化。
  bool applyLifecycle({required String taskId, required String state}) {
    final bool terminal =
        state == "done" || state == "failed" || state == "cancelled";
    return terminal ? _active.remove(taskId) : _active.add(taskId);
  }

  void remove(String taskId) => _active.remove(taskId);

  void clear() => _active.clear();
}
