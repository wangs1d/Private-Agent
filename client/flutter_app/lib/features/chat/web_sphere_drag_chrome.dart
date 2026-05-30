import "package:flutter/material.dart";

/// Web 球形浮层顶部拖动手柄：按住即可在页面任意位置移动，无需 Shift。
class WebSphereDragChrome extends StatelessWidget {
  const WebSphereDragChrome({
    super.key,
    required this.onDragDelta,
  });

  static const double height = 26;

  final ValueChanged<Offset> onDragDelta;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onPanUpdate: (DragUpdateDetails d) => onDragDelta(d.delta),
      child: MouseRegion(
        cursor: SystemMouseCursors.grab,
        child: SizedBox(
          height: height,
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: Colors.black.withValues(alpha: 0.28),
              borderRadius: const BorderRadius.vertical(top: Radius.circular(12)),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                Icon(
                  Icons.drag_indicator,
                  size: 18,
                  color: Colors.white.withValues(alpha: 0.55),
                ),
                const SizedBox(width: 6),
                Text(
                  "拖动移动",
                  style: TextStyle(
                    color: Colors.white.withValues(alpha: 0.55),
                    fontSize: 11,
                    letterSpacing: 0.2,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
