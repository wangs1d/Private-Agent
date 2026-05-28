import "package:flutter/material.dart";
import "package:flutter/services.dart";

/// 仅按住 Shift/Alt 时拦截指针，用于移动悬浮球；否则事件交给下层 WebView/3D 旋转。
class ShiftDragOverlay extends StatefulWidget {
  const ShiftDragOverlay({
    super.key,
    required this.onDragDelta,
  });

  final ValueChanged<Offset> onDragDelta;

  @override
  State<ShiftDragOverlay> createState() => _ShiftDragOverlayState();
}

class _ShiftDragOverlayState extends State<ShiftDragOverlay> {
  bool _modifierHeld = false;

  @override
  void initState() {
    super.initState();
    HardwareKeyboard.instance.addHandler(_onKey);
    _modifierHeld = _modifiersDown;
  }

  @override
  void dispose() {
    HardwareKeyboard.instance.removeHandler(_onKey);
    super.dispose();
  }

  bool get _modifiersDown =>
      HardwareKeyboard.instance.isShiftPressed ||
      HardwareKeyboard.instance.isAltPressed;

  bool _onKey(KeyEvent event) {
    final bool next = _modifiersDown;
    if (next != _modifierHeld) {
      setState(() => _modifierHeld = next);
    }
    return false;
  }

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      ignoring: !_modifierHeld,
      child: GestureDetector(
        behavior: HitTestBehavior.translucent,
        onPanUpdate: (DragUpdateDetails d) => widget.onDragDelta(d.delta),
        child: MouseRegion(
          cursor: _modifierHeld ? SystemMouseCursors.grab : MouseCursor.defer,
          child: const SizedBox.expand(),
        ),
      ),
    );
  }
}
