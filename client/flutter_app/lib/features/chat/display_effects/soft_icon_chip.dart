import "package:flutter/material.dart";

/// 软底图标芯片：整组效果卡的统一「图标块」视觉单元。
///
/// 浅色圆角方块 + 实色图标，同一语言两档大小：
///   - 默认（title 档）：28×28 圆角 8，图标 16 —— 卡片标题行图标块
///   - item 档：16×16 圆角 5，图标 10.5 —— 列表项标记
///
/// 取代过去「标题块 vs 列表项符号各自为政」的双轨样式，
/// 让卡片标题图标与列表项符号共享同一套底、形、色语言。
class SoftIconChip extends StatelessWidget {
  const SoftIconChip({
    super.key,
    required this.icon,
    required this.color,
    this.chipSize = 28,
    this.iconSize = 16,
    this.radius = 8,
    this.colorAlpha = 0.13,
  });

  final IconData icon;
  final Color color;
  final double chipSize;
  final double iconSize;
  final double radius;
  final double colorAlpha;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: chipSize,
      height: chipSize,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: color.withValues(alpha: colorAlpha),
        borderRadius: BorderRadius.circular(radius),
      ),
      child: Icon(icon, size: iconSize, color: color),
    );
  }
}