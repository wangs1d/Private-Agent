import "dart:async";

import "package:flutter/foundation.dart";
import "package:flutter/services.dart";

/// 独立翻译悬浮窗启动器。
///
/// 设计目标（参考豆包实时双语字幕）：
///   - 原生 HWND 窗口（与主 Flutter 窗口同进程但独立显示）
///   - 可在桌面自由拖动、可设 on-top
///   - 显示翻译卡片列表 + 顶栏（语言切换 / 清空 / ✕）
///   - 关闭 ✕ 只隐藏窗口，不退出进程
///
/// 通过 MethodChannel `pai/translate_overlay` 与 windows/runner/translate_overlay_window.cpp
/// 通信。所有方法调用都是 best-effort：channel 不存在（其它平台）时直接返回 false。
class TranslateOverlayLauncher {
  TranslateOverlayLauncher._();

  static const MethodChannel _channel = MethodChannel("pai/translate_overlay");

  /// 当前是否可见（best-effort 状态）
  static final ValueNotifier<bool> isVisible = ValueNotifier<bool>(false);

  /// 当前目标语言 code（"zh" / "en" / ...），由 setLanguage / lang 切换回调维护。
  /// 下次 show() 时会重新发给原生窗口。
  static final ValueNotifier<String> targetLangCode = ValueNotifier<String>("zh");
  static final ValueNotifier<String> targetLangLabel = ValueNotifier<String>("中文");

  /// 事件回调
  static void Function(String payload)? onClose;
  static void Function(String payload)? onClear;
  static void Function(String payload)? onLangChanged;

  static bool _handlersBound = false;

  /// 绑定事件回调。建议在 App 启动时调一次。
  static void bindHandlers({
    void Function(String payload)? onCloseClicked,
    void Function(String payload)? onClearClicked,
    void Function(String payload)? onLangChange,
  }) {
    onClose = onCloseClicked;
    onClear = onClearClicked;
    onLangChanged = onLangChange;
    if (!_handlersBound) {
      _channel.setMethodCallHandler(_onNativeMessage);
      _handlersBound = true;
    }
  }

  static void unbind() {
    onClose = null;
    onClear = null;
    onLangChanged = null;
  }

  /// 创建底层窗口（一般不需要手动调，show 时会自动 create）。
  static Future<bool> create() async {
    try {
      final bool? ok = await _channel.invokeMethod<bool>("create");
      return ok ?? false;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  /// 显示窗口（首次会自动 create）。
  /// 不传 bounds 时由 C++ 端决定位置（加载上次保存的 / 默认最右边）。
  static Future<bool> show({
    int? x,
    int? y,
    int? width,
    int? height,
  }) async {
    try {
      final bool? created = await _channel.invokeMethod<bool>("create");
      if (created != true) return false;
      // 只有显式传了坐标才覆盖 C++ 端的定位
      if (x != null && y != null) {
        await _channel.invokeMethod<bool>(
          "setBounds",
          <String, dynamic>{
            "x": x,
            "y": y,
            "width": width ?? 380,
            "height": height ?? 460,
          },
        );
      }
      // 把上次的目标语言同步给原生窗口
      await _channel.invokeMethod<bool>(
        "setLanguage",
        <String, dynamic>{
          "code": targetLangCode.value,
          "label": targetLangLabel.value,
        },
      );
      await _channel.invokeMethod<bool>("show");
      isVisible.value = true;
      return true;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  /// 隐藏窗口（不销毁，进程仍在；点 ✕ 也会触发）。
  static Future<bool> hide() async {
    try {
      await _channel.invokeMethod<bool>("hide");
      isVisible.value = false;
      return true;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  /// 完全销毁底层 HWND（一般用不到，App 退出时 OS 会自动释放）。
  static Future<bool> destroy() async {
    try {
      await _channel.invokeMethod<bool>("destroy");
      isVisible.value = false;
      return true;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
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

  /// 切换顶栏显示的目标语言
  static Future<bool> setLanguage({
    required String code,
    required String label,
  }) async {
    targetLangCode.value = code;
    targetLangLabel.value = label;
    try {
      await _channel.invokeMethod<bool>(
        "setLanguage",
        <String, dynamic>{"code": code, "label": label},
      );
      return true;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  /// 替换整个卡片列表
  static Future<bool> setCards(List<TranslateCard> cards) async {
    try {
      await _channel.invokeMethod<bool>(
        "setCards",
        <String, dynamic>{
          "cards": cards.map((c) => c.toMap()).toList(),
        },
      );
      return true;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  /// 追加一张卡片（最新在顶部）
  static Future<bool> appendCard(TranslateCard card) async {
    try {
      await _channel.invokeMethod<bool>(
        "appendCard",
        <String, dynamic>{"card": card.toMap()},
      );
      return true;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  /// 清空所有卡片
  static Future<bool> clearCards() async {
    try {
      await _channel.invokeMethod<bool>("clearCards");
      return true;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  /// 显示 loading 占位
  static Future<bool> setLoading({
    required String cardId,
    String message = "正在翻译...",
  }) async {
    try {
      await _channel.invokeMethod<bool>(
        "setLoading",
        <String, dynamic>{"cardId": cardId, "message": message},
      );
      return true;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  /// 移除 loading 占位
  static Future<bool> clearLoading(String cardId) async {
    try {
      await _channel.invokeMethod<bool>(
        "clearLoading",
        <String, dynamic>{"cardId": cardId},
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
          onClose?.call(payload);
          break;
        case "clear":
          onClear?.call(payload);
          break;
        case "langChanged":
          onLangChanged?.call(payload);
          break;
      }
    } catch (e) {
      // ignore malformed events
    }
    return null;
  }
}

/// 翻译卡片（与 native C++ 端 TranslateOverlayWindow::Card 对应）
class TranslateCard {
  TranslateCard({
    required this.cardId,
    required this.targetText,
    this.sourceText = "",
    this.langLabel = "中文",
    this.mode = "smart",
    this.showSource = true,
    this.timestampMs = 0,
  });

  final String cardId;
  final String targetText;
  final String sourceText;
  final String langLabel;
  final String mode;  // live / continuous / smart / text
  final bool showSource;
  final int timestampMs;

  Map<String, dynamic> toMap() => <String, dynamic>{
        "cardId": cardId,
        "sourceText": sourceText,
        "targetText": targetText,
        "langLabel": langLabel,
        "mode": mode,
        "showSource": showSource,
        "timestampMs": timestampMs,
      };
}
