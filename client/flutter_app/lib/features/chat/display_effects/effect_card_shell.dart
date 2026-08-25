import "package:flutter/material.dart";

import "../content_summary_detail_formatter.dart";
import "soft_icon_chip.dart";

/// 展示效果卡片的公共壳：统一容器、标题行与 footer。
///
/// 各效果组件（steps/metric/chips/fold_list/carousel/compare）只负责 body，
/// 视觉规格（maxWidth 390 / 圆角 12 / 描边 0.22 / 标题 14 w700 /
/// footer 分隔线 + 12.5 onSurfaceVariant）在此统一，保证整组卡片风格一致。
class EffectCardShell extends StatelessWidget {
  /// 卡片排版 token：整组效果卡共享一条视觉基线，一处改全局生效。
  static const double kMaxWidth = 390;
  static const double kTitleSize = 14;
  static const double kMetaSize = 12.5;
  static const double kTitleToBodyGap = 10;
  static const double kBodyToMetaGap = 8;

  const EffectCardShell({
    super.key,
    required this.cs,
    required this.body,
    this.icon,
    this.iconColor,
    this.title = "",
    this.footer = "",
    this.padding = const EdgeInsets.fromLTRB(14, 12, 14, 12),
    this.maxWidth = kMaxWidth,
  });

  final ColorScheme cs;

  /// 卡片主体（效果组件自行渲染的部分）。
  final Widget body;

  /// 标题行图标（可选；标题为空时不渲染标题行）。
  final IconData? icon;

  /// 标题行图标颜色（默认 primary）。
  final Color? iconColor;

  final String title;
  final String footer;
  final EdgeInsetsGeometry padding;
  final double maxWidth;

  @override
  Widget build(BuildContext context) {
    final Color accent = iconColor ?? cs.primary;
    return Container(
      constraints: BoxConstraints(maxWidth: maxWidth),
      padding: padding,
      decoration: BoxDecoration(
        color: cs.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: cs.outline.withValues(alpha: 0.22)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (title.trim().isNotEmpty) ...<Widget>[
            Row(
              children: <Widget>[
                if (icon != null) ...<Widget>[
                  SoftIconChip(icon: icon!, color: accent),
                  const SizedBox(width: 8),
                ],
                Expanded(
                  child: Text(
                    title,
                    style: TextStyle(
                      fontSize: kTitleSize,
                      fontWeight: FontWeight.w700,
                      color: cs.onSurface,
                      height: 1.4,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: kTitleToBodyGap),
          ],
          body,
          if (footer.trim().isNotEmpty) ...<Widget>[
            const SizedBox(height: kBodyToMetaGap),
            Container(
              padding: EdgeInsets.only(top: kBodyToMetaGap),
              decoration: BoxDecoration(
                border: Border(
                  top: BorderSide(
                    color: cs.outline.withValues(alpha: 0.28),
                    width: 1,
                  ),
                ),
              ),
              child: buildInlineMarkdownText(
                footer,
                TextStyle(
                  fontSize: kMetaSize,
                  color: cs.onSurfaceVariant,
                  height: 1.5,
                ),
                cs: cs,
              ),
            ),
          ],
        ],
      ),
    );
  }
}
