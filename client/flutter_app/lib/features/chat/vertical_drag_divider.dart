import "package:flutter/material.dart";

/// 竖向拖动分割条。
///
/// 设计:
/// - 默认隐藏,鼠标进入时才显示手柄 (hover 才显现)
/// - 拖动时整个 hit-test 区域(默认 8px)持续可命中
/// - 手柄视觉: 1px 细线 + 居中 4×16 的胶囊形把手
/// - 拖动期间高亮,松手后回落到 hover 状态
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
    this.width = 8.0,
    this.handleWidth = 4.0,
    this.handleHeight = 32.0,
  });

  /// 拖动回调(累计水平位移,正值向右)
  final ValueChanged<double> onDrag;

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
              // 中线
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
