import "package:flutter/material.dart";

/// 左侧强调条面板：结构化导语 / 引用块 / 摘要预览 / 检索面板 / 一级标题共用。
///
/// 此前这四种场景各自手写「左竖条 + 浅底色 + 圆角」，竖条颜色/透明度/宽度、
/// 底色透明度、圆角半径互相漂移，同屏出现时视觉语言不统一；统一收进本组件。
///
/// 竖条用内嵌色条容器实现而非 `Border(left)`：Border + borderRadius 组合下
/// 竖条以直角贴在圆角容器上，边角处会顶出去。
class AccentPanel extends StatelessWidget {
  const AccentPanel({
    super.key,
    required this.child,
    required this.cs,
    this.accentColor,
    this.accentAlpha = 0.5,
    this.fillAlpha = 0.12,
    this.radius = 8,
    this.barWidth = 3,
    this.padding = const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
  });

  final ColorScheme cs;

  /// 竖条颜色，默认 [ColorScheme.primary]；导语等需要更弱强调的场景传 outline。
  final Color? accentColor;

  /// 竖条透明度。
  final double accentAlpha;

  /// 底色（primaryContainer）透明度。
  final double fillAlpha;

  final double radius;
  final double barWidth;
  final EdgeInsetsGeometry padding;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    // IntrinsicHeight + stretch：让竖条与内容等高。
    // 面板常被放进滚动视图（高度无界），Row 直接 stretch 会拿到无穷高约束。
    return ClipRRect(
      borderRadius: BorderRadius.circular(radius),
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            ColoredBox(
              color:
                  (accentColor ?? cs.primary).withValues(alpha: accentAlpha),
              child: SizedBox(width: barWidth),
            ),
            Expanded(
              child: ColoredBox(
                color: cs.primaryContainer.withValues(alpha: fillAlpha),
                child: Padding(padding: padding, child: child),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
