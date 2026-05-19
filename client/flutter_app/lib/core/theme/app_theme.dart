import "package:flutter/material.dart";

/// 侧栏与主内容区色值。侧栏组件请继续用 [sidebar] 等显式着色；主区依赖 [AppTheme.material]。
abstract final class AppPalette {
  static const Color mainPanel = Color(0xFF211D1B);
  static const Color sidebar = Color(0xFF252423);
  static const Color sidebarSeparator = Color(0xFF3E3E3B);
  static const Color appBarForeground = Color(0xFFE8E4E0);
}

/// 全应用 `MaterialApp.theme`。
///
/// 新增根级 Tab 时：在 `main.dart` 的 Tab 标题列表、`IndexedStack`、侧栏 `destinations`
/// 三处对齐索引；页面根布局用 [MainPanel] 包裹（或至少使用 `Theme.of(context).colorScheme`，勿写死浅色底）。
abstract final class AppTheme {
  static ThemeData get material => _material ??= _buildMaterial();
  static ThemeData? _material;

  static ThemeData _buildMaterial() {
    final ColorScheme base = ColorScheme.fromSeed(
      seedColor: const Color(0xFF6A5DAF),
      brightness: Brightness.dark,
    );
    final ColorScheme cs = base.copyWith(
      surface: AppPalette.mainPanel,
      surfaceContainerLowest: AppPalette.mainPanel,
      surfaceContainerLow: const Color(0xFF2C2724),
      surfaceContainer: const Color(0xFF322D28),
      surfaceContainerHigh: const Color(0xFF38332E),
      surfaceContainerHighest: const Color(0xFF403A35),
    );
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      colorScheme: cs,
      scaffoldBackgroundColor: AppPalette.mainPanel,
      appBarTheme: const AppBarTheme(
        backgroundColor: AppPalette.mainPanel,
        foregroundColor: AppPalette.appBarForeground,
        elevation: 0,
        scrolledUnderElevation: 0,
        surfaceTintColor: Colors.transparent,
      ),
      cardTheme: CardThemeData(
        color: cs.surfaceContainerLow,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
      ),
      dividerTheme: DividerThemeData(
        color: cs.outline.withValues(alpha: 0.35),
        thickness: 1,
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: cs.surfaceContainerHigh,
        contentTextStyle: TextStyle(color: cs.onSurface, fontSize: 14),
        actionTextColor: cs.primary,
      ),
    );
  }
}

/// 主内容区画布，与 [AppPalette.mainPanel] / `colorScheme.surface` 一致。
///
/// 新 Tab 的根 `build` 推荐：`return MainPanel(child: YourPageBody(...));`
class MainPanel extends StatelessWidget {
  const MainPanel({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: Theme.of(context).colorScheme.surface,
      child: child,
    );
  }
}
