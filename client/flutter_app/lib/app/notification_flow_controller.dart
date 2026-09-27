import "dart:async";

/// 桌面弹窗生命周期状态机 —— 原 `_PrivateAiAppState` 内联状态收口。
///
/// 承载右下角共享原生弹窗（DesktopNotificationWindow）的闭合事件配对：
/// confirm/dismiss/timeout 是全局回调、不带 id，展示方按自造 id 挂完成器
/// 等待，全局回调据 [pendingDesktopAckCardId] 给当前等待者补发闭合事件。
/// 纯 Dart 状态，无 widget / 平台依赖，可单测。
class NotificationFlowController {
  NotificationFlowController._();

  static final NotificationFlowController instance =
      NotificationFlowController._();

  /// 决策弹窗闭合事件 → ack/outcome 完成器。
  final Map<String, Completer<String>> _pendingPopupCloseEvents =
      <String, Completer<String>>{};

  /// 注意力弹窗（reminder_popup）当前在等待闭合的卡 id。
  String? pendingDesktopAckCardId;

  /// 待回传 outcome 的主动消息 deliveryId（原生弹窗生命周期内有效）。
  String? _pendingProactiveDeliveryId;

  /// 桌面通知关闭后是否需要回传联系反馈（静默挂断场景置位）。
  bool needsFeedback = false;

  /// 联系反馈渠道标记（websocket / phone…）。
  String feedbackChannel = "websocket";

  /// 等待桌面原生弹窗闭合（confirm/dismiss/timeout）。show 返回 true 后才
  /// 注册完成器，事件只会晚于展示到达（用户点击/倒计时），不存在先到丢失。
  Future<String> waitForPopupClose(String id) {
    final Completer<String> completer = Completer<String>();
    _pendingPopupCloseEvents[id] = completer;
    return completer.future;
  }

  /// 全局闭合回调 → 给当前等待者补发闭合事件。
  void completeDesktopAck(String event) {
    final String? cardId = pendingDesktopAckCardId;
    pendingDesktopAckCardId = null;
    if (cardId == null) return;
    final Completer<String>? completer =
        _pendingPopupCloseEvents.remove(cardId);
    if (completer != null && !completer.isCompleted) {
      completer.complete(event);
    }
  }

  /// 登记 active 主动消息（outcome 走全局回调按此配对）。
  void armProactiveOutcome(String deliveryId) {
    _pendingProactiveDeliveryId = deliveryId;
  }

  void clearProactiveOutcome() {
    _pendingProactiveDeliveryId = null;
  }

  /// 取走当前待回传的 deliveryId（有则由调用方回传 outcome）。
  String? takePendingProactiveDeliveryId() {
    final String? id = _pendingProactiveDeliveryId;
    _pendingProactiveDeliveryId = null;
    return id;
  }

  /// 当前是否挂着未回传的主动消息 outcome。
  bool get hasPendingProactiveOutcome => _pendingProactiveDeliveryId != null;
}
