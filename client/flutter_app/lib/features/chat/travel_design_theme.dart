import "package:flutter/material.dart";

/// 3D-Travel「行程规划」设计系统 —— 一比一映射 design-reference 的 --gt-* 变量。
///
/// 浅色中性配色（shadcn 风格）：白底 + 灰边框 + 灰阶强调色。
/// 行程概览 / 行程主界面都通过作用域化 [Theme] 使用这套配色，
/// 不污染 App 其它深色界面。
abstract final class TravelDesign {
  // ── 色板（对应 itinerary.html / overview.html :root 的 --gt-*）──
  static const Color background = Color(0xFFFFFFFF);
  static const Color card = Color(0xFFFFFFFF);
  static const Color foreground = Color(0xFF18181B);
  static const Color mutedForeground = Color(0xFF71717A);
  static const Color primary = Color(0xFF18181B);
  static const Color primaryForeground = Color(0xFFFAFAFA);
  static const Color secondary = Color(0xFFF4F4F5);
  static const Color secondaryForeground = Color(0xFF18181B);
  static const Color accent = Color(0xFFF4F4F5);
  static const Color muted = Color(0xFFFAFAFA);
  static const Color border = Color(0xFFE4E4E7);
  static const Color borderStrong = Color(0xFFD4D4D8);
  static const Color ring = Color(0xFFA1A1AA);

  // 灰阶强调色（图表/类型色）
  static const Color chart1 = Color(0xFF3F3F46); // 景点
  static const Color chart2 = Color(0xFF71717A); // 餐厅
  static const Color chart3 = Color(0xFFD4D4D8); // 住宿
  static const Color chart4 = Color(0xFFE4E4E7); // 交通

  // ── 圆角 / 间距（--gt-radius / --gt-spacing）──
  static const double radius = 12;
  static const double radiusSm = 6;
  static const double spacing = 4;

  /// 行程页专用浅色 ThemeData（作用域化使用）。
  static ThemeData theme() {
    const ColorScheme cs = ColorScheme.light(
      primary: primary,
      onPrimary: primaryForeground,
      primaryContainer: secondary,
      onPrimaryContainer: foreground,
      secondary: chart2,
      onSecondary: Colors.white,
      secondaryContainer: secondary,
      onSecondaryContainer: foreground,
      tertiary: chart3,
      onTertiary: foreground,
      surface: background,
      onSurface: foreground,
      onSurfaceVariant: mutedForeground,
      surfaceContainerLowest: Colors.white,
      surfaceContainerLow: Color(0xFFFDFDFD),
      surfaceContainer: Color(0xFFF7F7F8),
      surfaceContainerHigh: Color(0xFFF4F4F5),
      surfaceContainerHighest: Color(0xFFECECEE),
      outline: border,
      outlineVariant: border,
      error: Color(0xFFEF4444),
    );
    return ThemeData(
      useMaterial3: true,
      colorScheme: cs,
      scaffoldBackgroundColor: background,
      fontFamilyFallback: const <String>["PingFang SC", "Microsoft YaHei"],
    );
  }

  /// 包裹行程页作用域主题。
  static Widget scope({required Widget child}) {
    return Theme(
      data: theme(),
      child: Builder(
        builder: (BuildContext context) {
          // 保持局部 MediaQuery 不受外层约束影响
          return child;
        },
      ),
    );
  }
}

/// 类型中文名 + 设计稿灰阶色（列表行 / 详情标签共用）。
(String, Color) travelKindLabelAndColor(String rawType) {
  switch (rawType) {
    case "restaurant":
      return ("餐厅", TravelDesign.chart2);
    case "hotel":
      return ("住宿", TravelDesign.chart3);
    case "transport":
      return ("交通", TravelDesign.chart4);
    case "attraction":
    default:
      return ("景点", TravelDesign.chart1);
  }
}
