import "package:flutter/material.dart";

/// 侧栏与主内容区色值。侧栏组件请继续用 [sidebar] 等显式着色；主区依赖 [AppTheme.material]。
abstract final class AppPalette {
  static const Color mainPanel = Color(0xFF1E1E1E);
  static const Color sidebar = Color(0xFF252525);
  static const Color sidebarSeparator = Color(0xFF3D3D3D);
  static const Color appBarForeground = Color(0xFFE8E8E8);

  /// 五子棋邀请卡片：固定灰色，勿用 theme primary（种子色为灰）
  static const Color gomokuCardBg = Color(0xFF2D2D2D);
  static const Color gomokuCardBorder = Color(0xFF454545);
  static const Color gomokuCardTitle = Color(0xFFE8E8E8);
  static const Color gomokuCardBody = Color(0xFFBEBEBE);
  static const Color gomokuCardButtonBg = Color(0xFF3C3C3C);
  static const Color gomokuCardButtonFg = Color(0xFFE8E8E8);

  /// 定位权限弹窗：灰色系，与主面板/侧栏协调
  static const Color locationDialogBg = Color(0xFF2A2A2A);
  static const Color locationDialogCard = Color(0xFF353535);
  static const Color locationDialogBorder = Color(0xFF484848);
  static const Color locationDialogTitle = Color(0xFFE8E8E8);
  static const Color locationDialogBody = Color(0xFFBBBBBB);
  static const Color locationDialogMuted = Color(0xFF989898);
  static const Color locationDialogButtonBg = Color(0xFF4A4A4A);
  static const Color locationDialogButtonFg = Color(0xFFE8E8E8);
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
      seedColor: const Color(0xFF757575),
      brightness: Brightness.dark,
    );
    // fromSeed 仍可能带出色相；强调色统一为中性灰，与侧栏/弹窗一致。
    final ColorScheme cs = base.copyWith(
      primary: const Color(0xFF8A8A8A),
      onPrimary: AppPalette.appBarForeground,
      primaryContainer: AppPalette.gomokuCardButtonBg,
      onPrimaryContainer: AppPalette.gomokuCardBody,
      secondary: const Color(0xFF757575),
      onSecondary: AppPalette.appBarForeground,
      secondaryContainer: const Color(0xFF353535),
      onSecondaryContainer: AppPalette.locationDialogBody,
      tertiary: AppPalette.locationDialogMuted,
      onTertiary: AppPalette.appBarForeground,
      outline: AppPalette.locationDialogBorder,
      onSurface: AppPalette.appBarForeground,
      surface: AppPalette.mainPanel,
      surfaceContainerLowest: AppPalette.mainPanel,
      surfaceContainerLow: const Color(0xFF282828),
      surfaceContainer: const Color(0xFF2D2D2D),
      surfaceContainerHigh: const Color(0xFF353535),
      surfaceContainerHighest: const Color(0xFF3C3C3C),
    );
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      colorScheme: cs,
      dialogTheme: DialogThemeData(
        backgroundColor: AppPalette.locationDialogBg,
        surfaceTintColor: Colors.transparent,
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: AppPalette.locationDialogButtonBg,
          foregroundColor: AppPalette.locationDialogButtonFg,
        ),
      ),
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
