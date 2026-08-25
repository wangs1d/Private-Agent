import "package:flutter/material.dart";

/// 手机端(App)白黑极简主题。
///
/// 遵循「简洁现代、白黑为主」的方向：
/// - 浅色白底 + 近黑文字,大面积留白,弱化边框,用图标/间距而非描边分层。
/// - 强调色收敛为纯净黑(气泡 / 发送按钮 / 输入框),点缀一处低饱和蓝用于链接。
/// - 与桌面端 [AppTheme] 完全独立,互不影响。
abstract final class MobileTheme {
  /// 手机端配色。
  static const Color background = Color(0xFFF7F7F8); // 页面底色(极浅灰,白黑之间)
  static const Color surface = Color(0xFFFFFFFF); // 卡片 / 输入栏底
  static const Color textPrimary = Color(0xFF111112); // 主文字(近黑)
  static const Color textSecondary = Color(0xFF70707A); // 次要文字
  static const Color textMuted = Color(0xFFA6A6AF); // 弱化文字 / 时间
  static const Color accent = Color(0xFF000000); // 强调(纯黑)
  static const Color link = Color(0xFF3B82F6); // 链接(低饱和蓝,极少量点缀)
  static const Color userBubble = Color(0xFF000000); // 用户气泡(黑底)
  static const Color userBubbleText = Color(0xFFFFFFFF); // 用户气泡文字(白)
  static const Color assistantBubble = Color(0xFFECECEF); // 助手气泡(浅灰)
  static const Color assistantBubbleText = Color(0xFF1A1A1C); // 助手文字(近黑)
  static const Color divider = Color(0xFFEDEDEF); // 分隔线
  static const Color online = Color(0xFF22C55E); // 在线状态点

  /// 构建 MaterialApp 使用的主题。
  static ThemeData get material {
    final ColorScheme cs = ColorScheme.light(
      brightness: Brightness.light,
      primary: accent,
      onPrimary: Colors.white,
      secondary: accent,
      onSecondary: Colors.white,
      surface: surface,
      onSurface: textPrimary,
      onSurfaceVariant: textSecondary,
      outline: divider,
      outlineVariant: divider,
      surfaceContainerHighest: assistantBubble,
      surfaceContainerHigh: innerFieldBackground,
      surfaceContainer: background,
      surfaceContainerLow: surface,
      surfaceContainerLowest: surface,
    );

    return ThemeData(
      useMaterial3: true,
      colorScheme: cs,
      scaffoldBackgroundColor: background,
      splashFactory: InkSparkle.splashFactory,
      // 全局字体族跟随桌面统一 MiSans,移动端同样内嵌生效
      fontFamily: "MiSans",
      fontFamilyFallback: const [
        "PingFang SC",
        "Noto Sans CJK SC",
        "Source Han Sans SC",
        "sans-serif",
      ],
      appBarTheme: const AppBarTheme(
        backgroundColor: surface,
        foregroundColor: textPrimary,
        elevation: 0,
        scrolledUnderElevation: 0,
        surfaceTintColor: Colors.transparent,
        centerTitle: true,
        titleTextStyle: TextStyle(
          color: textPrimary,
          fontSize: 17,
          fontWeight: FontWeight.w600,
          letterSpacing: 0.2,
        ),
      ),
      textSelectionTheme: const TextSelectionThemeData(
        cursorColor: accent,
        selectionColor: Color(0x22000000),
        selectionHandleColor: accent,
      ),
      snackBarTheme: const SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: Color(0xFF1A1A1C),
        contentTextStyle: TextStyle(color: Colors.white, fontSize: 14),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(14)),
        ),
      ),
      dividerTheme: const DividerThemeData(
        color: divider,
        thickness: 1,
        space: 1,
      ),
      // 手机端关闭全部水波纹 / focus ring 的高亮过渡,更克制
      focusColor: Colors.transparent,
      hoverColor: Colors.transparent,
      highlightColor: Color(0x0D000000),
    );
  }

  /// 输入框内层背景(比页面略亮)。
  static const Color innerFieldBackground = Color(0xFFF2F2F4);

  /// 输入框圆角(现代极简,大圆角)。
  static const double inputRadius = 24;

  /// 气泡圆角(用户 / 助手可对称)。
  static const double bubbleRadius = 20;
}