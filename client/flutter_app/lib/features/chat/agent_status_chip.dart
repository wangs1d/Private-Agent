import "package:flutter/material.dart";

/// 对话页面顶栏常驻的 agent 状态条（QQ 风格）。
///
///  - 一个圆点 + 状态文字
///  - 根据 mood_style 自动选择文案和颜色
class AgentStatusChip extends StatelessWidget {
  const AgentStatusChip({
    super.key,
    required this.moodStyle,
    this.statusText = "",
  });

  final String moodStyle;
  final String statusText;

  ({String label, Color color}) _resolveMode() {
    switch (moodStyle) {
      case "funny":
        return (label: "摸鱼中", color: const Color(0xFFFFB04D));
      case "sad":
        return (label: "emo中", color: const Color(0xFF8091A7));
      case "cool":
        return (label: "忙碌中", color: const Color(0xFF7C73FF));
      case "energetic":
        return (label: "在线", color: const Color(0xFF3AE06C));
      case "mysterious":
        return (label: "发呆中", color: const Color(0xFF3F8CFF));
      case "gentle":
      default:
        return (label: "在线", color: const Color(0xFF3AA7A3));
    }
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final mode = _resolveMode();

    return Semantics(
      label: "agent 状态：${mode.label}",
      container: true,
      child: Container(
        height: 28,
        constraints: const BoxConstraints(minWidth: 72),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 0),
        decoration: BoxDecoration(
          color: cs.surface.withValues(alpha: 0.78),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
            color: mode.color.withValues(alpha: 0.45),
            width: 1,
          ),
          boxShadow: <BoxShadow>[
            BoxShadow(
              color: mode.color.withValues(alpha: 0.18),
              blurRadius: 8,
              offset: const Offset(0, 2),
            ),
          ],
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: <Widget>[
            _BlinkDot(color: mode.color, size: 8),
            const SizedBox(width: 6),
            Text(
              mode.label,
              style: TextStyle(
                color: mode.color,
                fontSize: 12,
                fontWeight: FontWeight.w700,
                height: 1.0,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _BlinkDot extends StatefulWidget {
  const _BlinkDot({required this.color, this.size = 10});

  final Color color;
  final double size;

  @override
  State<_BlinkDot> createState() => _BlinkDotState();
}

class _BlinkDotState extends State<_BlinkDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1600),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _ctrl,
      builder: (BuildContext _, Widget? __) {
        final double t = _ctrl.value;
        return Container(
          width: widget.size,
          height: widget.size,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: widget.color,
            boxShadow: <BoxShadow>[
              BoxShadow(
                color: widget.color.withValues(alpha: 0.35 + 0.45 * t),
                blurRadius: 4 + 6 * t,
                spreadRadius: 0.5 + 1.5 * t,
              ),
            ],
          ),
        );
      },
    );
  }
}
