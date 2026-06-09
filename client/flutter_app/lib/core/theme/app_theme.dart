import "package:flutter/material.dart";

/// 侧栏与主内容区色值。侧栏组件请继续用 [sidebar] 等显式着色；主区依赖 [AppTheme.material]。
abstract final class AppPalette {
  static const Color mainPanel = Color(0xFF0F0F0F);
  static const Color sidebar = Color(0xFF161616);
  static const Color sidebarSeparator = Color(0xFF2A2A2A);
  static const Color appBarForeground = Color(0xFFE8E8E8);

  /// 五子棋邀请卡片：固定灰色，勿用 theme primary（种子色为灰）
  static const Color gomokuCardBg = Color(0xFF1C1C1C);
  static const Color gomokuCardBorder = Color(0xFF333333);
  static const Color gomokuCardTitle = Color(0xFFE8E8E8);
  static const Color gomokuCardBody = Color(0xFFBEBEBE);
  static const Color gomokuCardButtonBg = Color(0xFF2A2A2A);
  static const Color gomokuCardButtonFg = Color(0xFFE8E8E8);

  /// 定位权限弹窗：灰色系，与主面板/侧栏协调
  static const Color locationDialogBg = Color(0xFF171717);
  static const Color locationDialogCard = Color(0xFF1F1F1F);
  static const Color locationDialogBorder = Color(0xFF353535);
  static const Color locationDialogTitle = Color(0xFFE8E8E8);
  static const Color locationDialogBody = Color(0xFFBBBBBB);
  static const Color locationDialogMuted = Color(0xFF989898);
  static const Color locationDialogButtonBg = Color(0xFF2C2C2C);
  static const Color locationDialogButtonFg = Color(0xFFE8E8E8);
}

/// 全应用 `MaterialApp.theme`。
///
/// 新增根级 Tab 时：在 `main.dart` 的 Tab 标题列表、`IndexedStack`、侧栏 `destinations`
/// 三处对齐索引；页面根布局用 [MainPanel] 包裹（或至少使用 `Theme.of(context).colorScheme`，勿写死浅色底）。
abstract final class AppTheme {
  static ThemeData get material => _buildMaterial();

  /// PingFang SC（苹方）字体族及跨平台回退顺序。
  ///
  /// 苹方是 Apple 系（iOS/macOS）默认中文字体；其他平台按以下顺序回退：
  ///   - Windows:  Microsoft YaHei（微软雅黑）→ SimHei（黑体）
  ///   - Linux:    Noto Sans CJK SC（思源黑体）
  ///   - 兜底:     系统默认 sans-serif
  static const List<String> pingFangFontFamilyFallback = <String>[
    'PingFang SC',
    'Microsoft YaHei',
    '微软雅黑',
    'Heiti SC',
    'Noto Sans CJK SC',
    'Source Han Sans SC',
    'sans-serif',
  ];

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
      secondaryContainer: const Color(0xFF1F1F1F),
      onSecondaryContainer: AppPalette.locationDialogBody,
      tertiary: AppPalette.locationDialogMuted,
      onTertiary: AppPalette.appBarForeground,
      outline: AppPalette.locationDialogBorder,
      onSurface: AppPalette.appBarForeground,
      surface: AppPalette.mainPanel,
      surfaceContainerLowest: AppPalette.mainPanel,
      surfaceContainerLow: const Color(0xFF161616),
      surfaceContainer: const Color(0xFF1C1C1C),
      surfaceContainerHigh: const Color(0xFF232323),
      surfaceContainerHighest: const Color(0xFF2A2A2A),
    );
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      colorScheme: cs,
      // 全局字体族：苹方 PingFang SC，并按平台回退到雅黑/思源黑体/系统无衬线
      fontFamily: 'PingFang SC',
      fontFamilyFallback: pingFangFontFamilyFallback,
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
        color: Colors.transparent,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(color: cs.outline.withValues(alpha: 0.35)),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: Colors.transparent,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(24),
          borderSide: BorderSide(color: cs.outline.withValues(alpha: 0.35)),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(24),
          borderSide: BorderSide(color: cs.outline.withValues(alpha: 0.35)),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(24),
          borderSide: BorderSide(color: cs.onSurface.withValues(alpha: 0.5)),
        ),
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

  /// 与主面板同色、仅用描边区分的容器（卡片、区块等）。
  static BoxDecoration borderedPanel(
    ColorScheme cs, {
    double radius = 12,
    double borderAlpha = 0.35,
    Color? borderColor,
  }) {
    return BoxDecoration(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(radius),
      border: Border.all(
        color: borderColor ?? cs.outline.withValues(alpha: borderAlpha),
      ),
    );
  }

  /// 子 Tab 胶囊：背景透明，选中时描边略强。
  static BoxDecoration subNavChip(ColorScheme cs, {required bool selected}) {
    return BoxDecoration(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(20),
      border: Border.all(
        color: selected
            ? cs.onSurface.withValues(alpha: 0.55)
            : cs.outline.withValues(alpha: 0.35),
        width: selected ? 1.25 : 1,
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
