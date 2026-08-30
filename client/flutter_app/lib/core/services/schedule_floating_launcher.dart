import "dart:async";

import "package:flutter/foundation.dart";
import "package:flutter/services.dart";

/// 今日安排独立悬浮窗启动器。
///
/// 实现：同进程 HWND + GDI 自绘（不依赖 Electron / 独立后台进程）。
/// 通过 MethodChannel `pai/schedule_floating` 与
/// windows/runner/schedule_floating_window.cpp 通信。
///
/// 使用方式：
///   1. 用户点击"桌面悬浮模式" → [launch] / [show]
///   2. 再次点击 → [hide] 或 [toggle]
///   3. 日程数据更新 → [setSchedule]
///   4. 关闭 ✕ 只隐藏窗口，不退出进程
class ScheduleFloatingLauncher {
  ScheduleFloatingLauncher._();

  static const MethodChannel _channel = MethodChannel("pai/schedule_floating");

  /// 当前是否可见
  static final ValueNotifier<bool> isVisible = ValueNotifier<bool>(false);

  /// 当前活跃状态变化通知（兼容旧 API）
  static final ValueNotifier<bool> activeNotifier = ValueNotifier<bool>(false);

  /// 事件回调
  static void Function()? onClose;
  static void Function(bool collapsed)? onCollapseChanged;

  static bool _handlersBound = false;
  static bool _created = false;

  /// 日程悬浮窗是否正在运行
  static bool get isRunning => _created && isVisible.value;

  /// 是否已创建过（可能被隐藏）
  static bool get isCreated => _created;

  /// 绑定事件回调。建议在 App 启动时调一次。
  static void bindHandlers({
    void Function()? onCloseClicked,
    void Function(bool collapsed)? onCollapse,
  }) {
    onClose = onCloseClicked;
    onCollapseChanged = onCollapse;
    if (!_handlersBound) {
      _channel.setMethodCallHandler(_onNativeMessage);
      _handlersBound = true;
    }
  }

  static void _notifyActive() {
    activeNotifier.value = isRunning;
  }

  /// 创建底层窗口（一般不需要手动调，show 时会自动 create）。
  static Future<bool> create() async {
    if (kIsWeb) return false;
    try {
      final bool? ok = await _channel.invokeMethod<bool>("create");
      if (ok == true) _created = true;
      return ok ?? false;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  /// 显示窗口（首次会自动 create）。
  /// 不传 bounds 时由 C++ 端决定位置（加载上次保存的 / 默认右上角）。
  static Future<bool> show({
    int? x,
    int? y,
    int? width,
    int? height,
  }) async {
    if (kIsWeb) return false;
    try {
      if (!_created) {
        final bool? created = await _channel.invokeMethod<bool>("create");
        if (created != true) return false;
        _created = true;
      }
      // 只有显式传了坐标才覆盖 C++ 端的定位
      if (x != null && y != null) {
        await _channel.invokeMethod<bool>(
          "setBounds",
          <String, dynamic>{
            "x": x,
            "y": y,
            "width": width ?? 280,
            "height": height ?? 420,
          },
        );
      }
      await _channel.invokeMethod<bool>("show");
      isVisible.value = true;
      _notifyActive();
      return true;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  /// 隐藏窗口（不销毁，点 ✕ 也会触发）。
  static Future<bool> hide() async {
    if (!_created) return false;
    try {
      await _channel.invokeMethod<bool>("hide");
      isVisible.value = false;
      _notifyActive();
      return true;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  /// 切换显示/隐藏
  static Future<bool> toggle() async {
    if (!_created || !isVisible.value) {
      return show();
    }
    return hide();
  }

  /// 启动日程悬浮窗（等价于 show）
  static Future<bool> launch() => show();

  /// 完全销毁底层 HWND
  static Future<bool> destroy() async {
    try {
      await _channel.invokeMethod<bool>("destroy");
      _created = false;
      isVisible.value = false;
      _notifyActive();
      return true;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  /// 关闭悬浮窗（等价于 hide，保持进程不变）
  static Future<void> close() async {
    await hide();
  }

  /// 完全停止并重置
  static Future<void> stop() async {
    await destroy();
  }

  /// 设置/取消窗口置顶
  static Future<bool> setOnTop({required bool onTop}) async {
    try {
      await _channel.invokeMethod<bool>(
        "setOnTop",
        <String, dynamic>{"onTop": onTop},
      );
      return true;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  /// 移动 + 改变大小
  static Future<bool> setBounds({
    required int x,
    required int y,
    required int width,
    required int height,
  }) async {
    try {
      await _channel.invokeMethod<bool>(
        "setBounds",
        <String, dynamic>{
          "x": x,
          "y": y,
          "width": width,
          "height": height,
        },
      );
      return true;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  /// 读取当前窗口位置 + 大小
  static Future<Rect> getBounds() async {
    try {
      final Map<dynamic, dynamic>? r = await _channel.invokeMethod("getBounds");
      if (r == null) return Rect.zero;
      return Rect.fromLTWH(
        (r["x"] as num?)?.toDouble() ?? 0,
        (r["y"] as num?)?.toDouble() ?? 0,
        (r["width"] as num?)?.toDouble() ?? 0,
        (r["height"] as num?)?.toDouble() ?? 0,
      );
    } catch (_) {
      return Rect.zero;
    }
  }

  /// 设置折叠状态（true=只显示顶栏）
  static Future<bool> setCollapsed(bool collapsed) async {
    try {
      await _channel.invokeMethod<bool>(
        "setCollapsed",
        <String, dynamic>{"collapsed": collapsed},
      );
      return true;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  /// 替换整个日程列表。
  ///
  /// [devicePixelRatio]：宿主 FlutterView 的 DPR。GDI 悬浮窗按物理像素绘制，
  /// 用它把逻辑布局缩放到与 in-app 面板完全一致的物理尺寸
  /// （进程内 GetDpiForWindow 在部分环境下被虚拟化成 96，不可靠）。
  static Future<bool> setSchedule(
    List<ScheduleFloatingItem> items, {
    double? devicePixelRatio,
  }) async {
    try {
      await _channel.invokeMethod<bool>(
        "setSchedule",
        <String, dynamic>{
          "items": items.map((e) => e.toMap()).toList(),
          if (devicePixelRatio != null) "devicePixelRatio": devicePixelRatio,
        },
      );
      return true;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  // ---- native event handler ----

  static Future<dynamic> _onNativeMessage(MethodCall call) async {
    if (call.method != "onNativeEvent") return null;
    try {
      final Map<dynamic, dynamic> args =
          (call.arguments as Map).cast<dynamic, dynamic>();
      final String? event = args["event"] as String?;
      final String payload = (args["payload"] as String?) ?? "";
      switch (event) {
        case "close":
          isVisible.value = false;
          _notifyActive();
          onClose?.call();
          break;
        case "collapseChanged":
          onCollapseChanged?.call(payload == "true");
          break;
      }
    } catch (_) {
      // ignore malformed events
    }
    return null;
  }
}

/// 日程事项（与 native C++ 端 ScheduleFloatingWindow::ScheduleItem 对应）
class ScheduleFloatingItem {
  ScheduleFloatingItem({
    required this.id,
    required this.timeText,
    required this.title,
    this.notes = "",
    this.completed = false,
  });

  final String id;
  final String timeText; // "HH:MM"
  final String title;
  final String notes; // 备注（可选，空字符串表示无备注）
  final bool completed;

  Map<String, dynamic> toMap() => <String, dynamic>{
        "id": id,
        "timeText": timeText,
        "title": title,
        "notes": notes,
        "completed": completed,
      };
}
