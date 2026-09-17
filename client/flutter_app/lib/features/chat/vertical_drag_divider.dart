import "package:flutter/material.dart";

/// 竖向拖动分割条。
///
/// 设计:
/// - **常显淡分隔缝**：整个 hit-test 区域填一条比面板底色仅亮/暗约 2–4%
///   的过渡带，把左右两块面板淡淡地隔开，不形成明显的灰缝
/// - 鼠标进入时显现拖拽手柄（居中竖直胶囊），拖动期间高亮
/// - 拖动期间整个 hit-test 区域(默认 8px)持续可命中
///
/// 用法:
/// ```dart
/// VerticalDragDivider(
///   onDrag: (deltaX) { ... },
/// )
/// ```
class VerticalDragDivider extends StatefulWidget {
  const VerticalDragDivider({
    super.key,
    required this.onDrag,
    this.showStrip = true,
    this.width = 8.0,
    this.handleWidth = 4.0,
    this.handleHeight = 32.0,
  });

  /// 拖动回调(累计水平位移,正值向右)
  final ValueChanged<double> onDrag;

  /// 是否显示常显淡分隔缝。
  /// 只在双面板（split）模式为 true；side 窄面板模式不显示缝，仅保留拖拽。
  final bool showStrip;

  /// 整个 hit-test 区域宽度
  final double width;

  /// 手柄可见宽度
  final double handleWidth;

  /// 手柄可见高度
  final double handleHeight;

  @override
  State<VerticalDragDivider> createState() => _VerticalDragDividerState();
}

class _VerticalDragDividerState extends State<VerticalDragDivider> {
  bool _hovering = false;
  bool _dragging = false;

  /// 分隔缝底色：极淡。从面板底色（cs.surface）派生——深色下向白色
  /// 混 2%、浅色下向黑色混 4%，只留下一条若隐若现的浅缝而非明显灰带。
  Color _stripColor(ColorScheme cs) {
    final bool isDark = Theme.of(context).brightness == Brightness.dark;
    return isDark
        ? Color.lerp(cs.surface, Colors.white, 0.02)!
        : Color.lerp(cs.surface, Colors.black, 0.04)!;
  }

  Color _lineColor(ColorScheme cs) {
    if (_dragging) return cs.primary.withValues(alpha: 0.55);
    if (_hovering) return cs.outline.withValues(alpha: 0.55);
    return cs.outline.withValues(alpha: 0);
  }

  Color _handleColor(ColorScheme cs) {
    if (_dragging) return cs.primary;
    if (_hovering) return cs.onSurfaceVariant;
    return cs.onSurfaceVariant.withValues(alpha: 0);
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final double w = widget.width;
    final double hw = widget.handleWidth;
    final double hh = widget.handleHeight;

    return MouseRegion(
      cursor: SystemMouseCursors.resizeColumn,
      onEnter: (_) => setState(() => _hovering = true),
      onExit: (_) {
        if (!_dragging) setState(() => _hovering = false);
      },
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onHorizontalDragStart: (_) => setState(() => _dragging = true),
        onHorizontalDragUpdate: (DragUpdateDetails d) => widget.onDrag(d.delta.dx),
        onHorizontalDragEnd: (_) {
          setState(() => _dragging = false);
          if (!_hovering) {} // 状态由 MouseRegion 维护
        },
        onHorizontalDragCancel: () => setState(() => _dragging = false),
        child: SizedBox(
          width: w,
          child: Stack(
            alignment: Alignment.center,
            children: <Widget>[
              // 常显灰色分隔缝（仅双面板模式显示）
              if (widget.showStrip)
                Positioned.fill(
                  child: ColoredBox(color: _stripColor(cs)),
                ),
              // 中线（hover / 拖动时显现）
              Container(
                width: 1,
                color: _lineColor(cs),
              ),
              // 把手: 居中竖直胶囊
              AnimatedContainer(
                duration: const Duration(milliseconds: 120),
                width: hw,
                height: hh,
                decoration: BoxDecoration(
                  color: _handleColor(cs),
                  borderRadius: BorderRadius.circular(hw),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
