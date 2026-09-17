import "package:flutter/foundation.dart";

import "../utils/content_summary_parser.dart";

/// 内容详情启动器：详情卡(ContentSummaryDetailCard) → 右侧双面板 的桥接。
///
/// 与 `image_preview_launcher.dart` 同款「静态回调注册」方案：
/// - 主壳(main.dart)启动时调用 [setHandler] 注册一个打开右面板的方法；
/// - 消息气泡等深层 widget 不关心面板如何实现，只需调用 [open] 触发打开。
///
/// 宽屏下详情在右侧双面板中继续展示；未注册 handler（如手机端独立入口）
/// 或窄窗口时，由调用方回退为居中弹窗（ContentSummaryDetailModal）。
class ContentSummaryLauncher {
  ContentSummaryLauncher._();

  static void Function(ContentSummaryDataV2 summary)? _handler;

  /// 当前最近一次请求展示的摘要数据（面板打开后可读取）。
  static ContentSummaryDataV2? _last;

  static ContentSummaryDataV2? get last => _last;

  /// 主壳在启动时注册右面板打开回调。
  static void setHandler(void Function(ContentSummaryDataV2 summary) handler) {
    _handler = handler;
  }

  /// 请求在右侧双面板中展示内容详情。
  ///
  /// 返回 false 表示当前没有可用的面板宿主（未注册 handler），
  /// 调用方应回退为弹窗展示。
  static bool open(ContentSummaryDataV2 summary) {
    _last = summary;
    if (_handler == null) return false;
    _handler!(summary);
    return true;
  }

  @visibleForTesting
  static void reset() {
    _handler = null;
    _last = null;
  }
}
