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

    /// side 模式下右面板的初始总占位（含 8px 拖拽条），
    /// 不传则用 [kRightSidePanelWidth] + 8 = 228。split 模式下忽略。
    ///
    /// 此值会在拖动时被改写，并同步给 [onRightPanelWidthChanged]。
    /// 含义上等同于 split 模式的"右占位"语义（[kRightSidePanelWidth] 早先
    /// 不含 divider，现加上 8px 的拖拽条后语义对齐为"总右占位"）。
    this.sidePanelWidth,

    /// side 模式下右面板可调整的最小总占位（含 8px 拖拽条）。
    /// 低于此值时禁止继续收窄。
    this.minSidePanelWidth = 208.0,
  });

  /// 中间的聊天页（通常为 ChatPage）。
  final Widget child;

  /// 是否为 split 模式（聊天 + 分割条 + 动态右面板宽度）。
  /// 为 false 时聊天区占满主区，右侧留出 [sidePanelWidth] 占位；
  /// 此时仍会渲染一个常驻 [VerticalDragDivider]，允许用户拖拽调整面板宽度。
  final bool useSplit;

  /// 左聊天区占可用宽度的比例（0.1~0.9），仅在 [useSplit] 为 true 时使用。
  final double splitRatio;

  /// 拖动分割条时回调，参数为新的 leftRatio。
  final ValueChanged<double>? onSplitRatioChanged;

  /// 当前应预留的右面板宽度（含 split 动态宽度与 side 动态宽度）。
  /// 调用方可用此值同步 AppBar 右边距，避免右面板覆盖顶部栏。
  final ValueChanged<double>? onRightPanelWidthChanged;

  /// side 模式下右面板宽度（含 divider），用于初始化。
  final double? sidePanelWidth;

  /// side 模式下右面板最小宽度（含 divider）。低于此值时禁止继续收窄。
  final double minSidePanelWidth;

  @override
  State<NextbotChatLayout> createState() => _NextbotChatLayoutState();
}

class _NextbotChatLayoutState extends State<NextbotChatLayout> {
  static const double _minLeft = 400.0;
  static const double _minRight = 420.0;
  static const double _dividerWidth = 8.0;

  /// side 模式下右面板的当前宽度（含 divider），内部状态以便持续响应拖动。
  /// split 模式下不使用。
  late double _sidePanelWidth;

  double? _lastReportedRightWidth;

  @override
  void initState() {
    super.initState();
    // side 模式下总右占位 = 面板内容宽 [kRightSidePanelWidth] + 8px 拖拽条。
    // 拖拽条位于 chat 与右面板之间, 不挤压面板内容, 只让 chat 区略窄 8px。
    // 调用方传入的 [widget.sidePanelWidth] 已是"总右占位"（含 divider），
    // 此处只在没传时按 kRightSidePanelWidth + 8 给默认值。
    _sidePanelWidth = widget.sidePanelWidth ??
        (kRightSidePanelWidth + _dividerWidth);
  }

  @override
  void didUpdateWidget(covariant NextbotChatLayout oldWidget) {
    super.didUpdateWidget(oldWidget);
    // 仅 side 模式才用 sidePanelWidth 同步 _sidePanelWidth。
    // split 模式下 onRightPanelWidthChanged 推上来的宽度是 split 实际宽度，
    // 不能用它覆盖侧边宽度的内部状态——否则关闭面板后会"继承"工具面板的宽度。
    if (!widget.useSplit &&
        widget.sidePanelWidth != null &&
        widget.sidePanelWidth != oldWidget.sidePanelWidth) {
      _sidePanelWidth = widget.sidePanelWidth!;
    }
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;

    // 用 LayoutBuilder 获取实际约束宽度，而非 MediaQuery.sizeOf(context).width。
    // 因为 NextbotChatLayout 在 AppSidebar 右侧的 Expanded 里，实际宽度 =
    // 屏宽 - sidebar - 1px(VerticalDivider)，直接用屏宽会导致子元素溢出。
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final double actualWidth = constraints.maxWidth;

        double? leftWidth;
        double rightWidth;
        if (widget.useSplit) {
          final double availForPanels = actualWidth - _dividerWidth;
          double lw = (availForPanels * widget.splitRatio)
              .clamp(_minLeft, availForPanels - _minRight);
          double rw = availForPanels - lw;
          if (rw < _minRight) {
            rw = _minRight;
            lw = (availForPanels - rw)
                .clamp(_minLeft, availForPanels - _minRight);
          }
          leftWidth = lw;
          rightWidth = rw;
        } else {
          // side 模式:聊天区占满,右面板宽度由拖动条控制
          rightWidth = _sidePanelWidth;
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
              // 分割条：split 模式已写过，但渲染在 Expanded 之后；
              // side 模式现在也始终渲染常驻分割条,允许用户调整宽度
              VerticalDragDivider(
                onDrag: widget.useSplit
                    ? (double deltaX) {
                        if (widget.onSplitRatioChanged == null) return;
                        final double avail = actualWidth - _dividerWidth;
                        final double newLeft = (leftWidth! + deltaX)
                            .clamp(_minLeft, avail - _minRight);
                        final double newRatio =
                            (newLeft / avail).clamp(0.1, 0.9);
                        final double newRight = avail - newLeft;
                        widget.onSplitRatioChanged!(newRatio);
                        _reportRightWidth(newRight);
                      }
                    : (double deltaX) {
                        // side 模式: 分割条在右面板左边缘
                        // 向右拖 (deltaX>0) → 面板变窄；向左拖 (deltaX<0) → 面板变宽
                        final double maxRight = actualWidth - _minLeft;
                        final double newRight = (_sidePanelWidth - deltaX)
                            .clamp(widget.minSidePanelWidth, maxRight);
                        if ((newRight - _sidePanelWidth).abs() < 0.5) return;
                        setState(() => _sidePanelWidth = newRight);
                        _reportRightWidth(newRight);
                      },
              ),
              if (widget.useSplit)
                SizedBox(width: rightWidth)
              else
                SizedBox(width: rightWidth - _dividerWidth),
            ],
          ),
        );
      },
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
