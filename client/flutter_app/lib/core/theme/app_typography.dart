import "package:flutter/material.dart";

/// 全局排版 token(桌面端与手机端共用)。
///
/// 项目内所有文字排版统一引用这里的字号/行高,不再手写字面量:
/// - 字号收敛为 8 档阶梯,消灭 10.5 / 12.8 之类的碎片化取值;
/// - 行高收敛为 4 档:正文 1.6(CJK 长文阅读最优)、标题 1.3、
///   紧凑(表格/代码)1.5、控件单行 1.4;
/// - [applyLineHeights] 把行高写入 M3 默认 TextTheme,
///   未显式覆盖行高的样式自动继承同一套值。
abstract final class AppTypography {
  // ═══════════════════════════════════════════════════════════
  // 字号阶梯(唯一允许使用的档位)
  // ═══════════════════════════════════════════════════════════

  /// 大标题 / 数字展示
  static const double display = 20;

  /// 页面标题 / 一级标题
  static const double title = 17;

  /// 区块标题
  static const double heading = 15;

  /// 移动端正文(触屏阅读偏大一号)
  static const double bodyLarge = 16;

  /// 桌面端正文
  static const double body = 14;

  /// 辅助说明文字
  static const double secondary = 13;

  /// 次要信息 / 头像旁名称
  static const double caption = 12;

  /// 时间戳 / 徽标等最小可读文字
  static const double micro = 11;

  // ═══════════════════════════════════════════════════════════
  // 行高(4 档)
  // ═══════════════════════════════════════════════════════════

  /// 正文(CJK 长文阅读最优)
  static const double bodyLineHeight = 1.6;

  /// 标题
  static const double headingLineHeight = 1.3;

  /// 紧凑内容(表格单元格 / 代码块)
  static const double compactLineHeight = 1.5;

  /// 控件 / 单行 UI 文字
  static const double uiLineHeight = 1.4;

  /// 等宽字体族(代码块 / 行内 code)。
  static const String monoFontFamily = "monospace";

  /// 头像与「名称/时间行」的顶部对齐偏移:
  /// 行盒顶部自带半行距 leading,取 (行盒高 - 字号) / 2,
  /// 让头像盒顶部与文字字形顶部对齐;字号/行高调整后自动跟随。
  static double get avatarHeaderOffset =>
      (caption * headingLineHeight - caption) / 2;

  /// 把统一行高写入 M3 默认 [TextTheme](display/title/body 档),
  /// label 档(按钮/徽标)保持 M3 默认不动。
  static TextTheme applyLineHeights(TextTheme base) {
    TextStyle withHeight(TextStyle? style, double height) =>
        (style ?? const TextStyle()).copyWith(height: height);

    return base.copyWith(
      displayLarge: withHeight(base.displayLarge, headingLineHeight),
      displayMedium: withHeight(base.displayMedium, headingLineHeight),
      displaySmall: withHeight(base.displaySmall, headingLineHeight),
      headlineLarge: withHeight(base.headlineLarge, headingLineHeight),
      headlineMedium: withHeight(base.headlineMedium, headingLineHeight),
      headlineSmall: withHeight(base.headlineSmall, headingLineHeight),
      titleLarge: withHeight(base.titleLarge, headingLineHeight),
      titleMedium: withHeight(base.titleMedium, headingLineHeight),
      titleSmall: withHeight(base.titleSmall, headingLineHeight),
      bodyLarge: withHeight(base.bodyLarge, bodyLineHeight),
      bodyMedium: withHeight(base.bodyMedium, bodyLineHeight),
      bodySmall: withHeight(base.bodySmall, compactLineHeight),
    );
  }

  /// 行内 code 样式:等宽字体、略缩一号、浅底色。
  /// 与 MiSans 混排时靠「字号 -1 + 继承正文行高」尽量保持基线对齐。
  static TextStyle inlineCode(TextStyle base, Color background) {
    return base.copyWith(
      fontFamily: monoFontFamily,
      fontSize: (base.fontSize ?? body) - 1,
      backgroundColor: background,
    );
  }
}
