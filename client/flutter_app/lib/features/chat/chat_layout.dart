import "package:flutter/material.dart";

import "right_side_panel.dart";
import "vertical_drag_divider.dart";

/// 聊天主内容区布局：左侧聊天区 + 分割条 + （可选）右侧占位。
///
/// 右侧面板（无论是 side 模式 [RightSidePanel] 还是 split 模式的右抽屉）
/// 都由调用方在外层 Stack 用 [Positioned] 渲染，宽度同步通过
/// [onRightPanelWidthChanged] 回调返回给调用方（用于 AppBar 右边距等）。
class NextbotChatLayout extends StatefulWidget {
  const NextbotChatLayout({
    super.key,
    required this.child,
    this.useSplit = false,
    this.splitRatio = 0.5,
    this.onSplitRatioChanged,
    this.onRightPanelWidthChanged,
  });

  /// 中间的聊天页（通常为 ChatPage）。
  final Widget child;

  /// 是否为 split 模式（聊天 + 分割条 + 动态右面板宽度）。
  /// 为 false 时聊天区占满主区，右侧留出 [kRightSidePanelWidth] 占位。
  final bool useSplit;

  /// 左聊天区占可用宽度的比例（0.1~0.9），仅在 [useSplit] 为 true 时使用。
  final double splitRatio;

  /// 拖动分割条时回调，参数为新的 leftRatio。
  final ValueChanged<double>? onSplitRatioChanged;

  /// 当前应预留的右面板宽度（含 split 动态宽度与 side 固定宽度）。
  /// 调用方可用此值同步 AppBar 右边距，避免右面板覆盖顶部栏。
  final ValueChanged<double>? onRightPanelWidthChanged;

  @override
  State<NextbotChatLayout> createState() => _NextbotChatLayoutState();
}

class _NextbotChatLayoutState extends State<NextbotChatLayout> {
  static const double _minLeft = 400.0;
  static const double _minRight = 420.0;
  static const double _dividerWidth = 8.0;

  double? _lastReportedRightWidth;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;

    double? leftWidth;
    double rightWidth = kRightSidePanelWidth;
    if (widget.useSplit) {
      final double availForPanels =
          MediaQuery.sizeOf(context).width - _dividerWidth;
      double lw = (availForPanels * widget.splitRatio)
          .clamp(_minLeft, availForPanels - _minRight);
      double rw = availForPanels - lw;
      if (rw < _minRight) {
        rw = _minRight;
        lw = (availForPanels - rw).clamp(_minLeft, availForPanels - _minRight);
      }
      leftWidth = lw;
      rightWidth = rw;
    }

    _reportRightWidth(rightWidth);

    return ColoredBox(
      color: cs.surface,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          if (widget.useSplit)
            SizedBox(width: leftWidth, child: widget.child)
          else
            Expanded(child: widget.child),
          if (widget.useSplit)
            VerticalDragDivider(
              onDrag: (double deltaX) {
                if (widget.onSplitRatioChanged == null) return;
                final double avail = MediaQuery.sizeOf(context).width - _dividerWidth;
                final double newLeft = (leftWidth! + deltaX)
                    .clamp(_minLeft, avail - _minRight);
                final double newRatio = (newLeft / avail).clamp(0.1, 0.9);
                final double newRight = avail - newLeft;
                widget.onSplitRatioChanged!(newRatio);
                _reportRightWidth(newRight);
              },
            )
          else
            // 右侧 kRightSidePanelWidth 占位：实际内容由外层 Stack 的
            // RightSidePanel 以 Positioned(top: 0, right: 0, ...) 渲染，
            // 从而覆盖顶部 AppBar。
            const SizedBox(width: kRightSidePanelWidth),
          if (widget.useSplit)
            // split 模式右侧占位：实际内容（带关闭按钮的分栏面板）由
            // 调用方在外层 Stack 用 Positioned 渲染，宽度由 [onRightPanelWidthChanged]
            // 同步，避免右面板覆盖顶部 AppBar。
            SizedBox(width: rightWidth),
        ],
      ),
    );
  }

  /// 将当前右面板宽度同步给调用方；相同宽度不重复回调，避免 build 死循环。
  void _reportRightWidth(double width) {
    if (_lastReportedRightWidth == width) return;
    _lastReportedRightWidth = width;
    final ValueChanged<double>? cb = widget.onRightPanelWidthChanged;
    if (cb == null) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      cb(width);
    });
  }
}
