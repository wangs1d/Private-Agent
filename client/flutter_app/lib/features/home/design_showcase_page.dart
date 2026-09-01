import "package:flutter/material.dart";

import "../../core/theme/app_theme.dart";

/// 新设计系统展示页。
///
/// 集中呈现暗色/浅色主题下的颜色、字体、按钮、卡片、输入框等组件，
/// 方便快速预览设计一致性。可在 [AppShell] 中作为 body 使用。
class DesignShowcasePage extends StatelessWidget {
  const DesignShowcasePage({super.key});

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final AppThemeVariant variant = AppThemeController.instance.value;
    final bool isDark = variant == AppThemeVariant.dark;

    return SingleChildScrollView(
      padding: const EdgeInsets.all(AppSpacing.xxl),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 960),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              _SectionTitle("颜色 Color"),
              Wrap(
                spacing: AppSpacing.lg,
                runSpacing: AppSpacing.lg,
                children: <Widget>[
                  _ColorChip(label: "Primary", color: cs.primary, fg: cs.onPrimary),
                  _ColorChip(label: "Secondary", color: cs.secondary, fg: cs.onSecondary),
                  _ColorChip(label: "Tertiary", color: cs.tertiary, fg: cs.onTertiary),
                  _ColorChip(label: "Surface", color: cs.surface, fg: cs.onSurface),
                  _ColorChip(label: "Surface Container", color: cs.surfaceContainer, fg: cs.onSurface),
                  _ColorChip(label: "Surface Container High", color: cs.surfaceContainerHigh, fg: cs.onSurface),
                  _ColorChip(label: "Error", color: cs.error, fg: cs.onError),
                ],
              ),
              const SizedBox(height: AppSpacing.xxxl),
              _SectionTitle("字体 Typography"),
              _FontPreview(cs: cs),
              const SizedBox(height: AppSpacing.xxxl),
              _SectionTitle("按钮 Buttons"),
              Wrap(
                spacing: AppSpacing.md,
                runSpacing: AppSpacing.md,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: <Widget>[
                  FilledButton(onPressed: () {}, child: const Text("Filled")),
                  ElevatedButton(onPressed: () {}, child: const Text("Elevated")),
                  OutlinedButton(onPressed: () {}, child: const Text("Outlined")),
                  TextButton(onPressed: () {}, child: const Text("Text")),
                ],
              ),
              const SizedBox(height: AppSpacing.xxxl),
              _SectionTitle("卡片 Cards"),
              _CardsPreview(cs: cs, isDark: isDark),
              const SizedBox(height: AppSpacing.xxxl),
              _SectionTitle("输入框 Inputs"),
              _InputsPreview(cs: cs),
              const SizedBox(height: AppSpacing.xxxl),
              _SectionTitle("标签 Chips"),
              Wrap(
                spacing: AppSpacing.sm,
                runSpacing: AppSpacing.sm,
                children: <Widget>[
                  Chip(label: Text("默认", style: TextStyle(color: cs.onSurface))),
                  ChoiceChip(
                    label: const Text("选中"),
                    selected: true,
                    onSelected: (_) {},
                  ),
                  FilterChip(
                    label: const Text("过滤"),
                    selected: false,
                    onSelected: (_) {},
                  ),
                ],
              ),
              const SizedBox(height: AppSpacing.xxxl),
              _SectionTitle("装饰 Decorations"),
              _DecorationsPreview(cs: cs, isDark: isDark),
            ],
          ),
        ),
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.lg),
      child: Text(
        text,
        style: TextStyle(
          fontSize: 20,
          fontWeight: FontWeight.w700,
          color: cs.onSurface,
          letterSpacing: -0.3,
        ),
      ),
    );
  }
}

class _ColorChip extends StatelessWidget {
  const _ColorChip({
    required this.label,
    required this.color,
    required this.fg,
  });

  final String label;
  final Color color;
  final Color fg;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 120,
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(AppRadius.md),
        border: Border.all(color: Theme.of(context).colorScheme.outline.withValues(alpha: 0.25)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            label,
            style: TextStyle(
              color: fg,
              fontSize: 12,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            "#${color.toARGB32().toRadixString(16).toUpperCase().padLeft(8, '0')}",
            style: TextStyle(
              color: fg.withValues(alpha: 0.7),
              fontSize: 10,
              fontFamily: "monospace",
            ),
          ),
        ],
      ),
    );
  }
}

class _FontPreview extends StatelessWidget {
  const _FontPreview({required this.cs});

  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(AppSpacing.lg),
      decoration: AppTheme.borderedPanel(cs, fill: cs.surfaceContainerLowest),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text("Display Large", style: TextStyle(fontSize: 32, fontWeight: FontWeight.w700, color: cs.onSurface)),
          const SizedBox(height: AppSpacing.sm),
          Text("Headline Medium", style: TextStyle(fontSize: 24, fontWeight: FontWeight.w600, color: cs.onSurface)),
          const SizedBox(height: AppSpacing.sm),
          Text("Title Small", style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: cs.onSurface)),
          const SizedBox(height: AppSpacing.sm),
          Text("Body Medium · 正文内容展示，浅色主题使用深灰文字，暗色主题使用柔和纸白。", style: TextStyle(fontSize: 14, color: cs.onSurfaceVariant)),
        ],
      ),
    );
  }
}

class _CardsPreview extends StatelessWidget {
  const _CardsPreview({required this.cs, required this.isDark});

  final ColorScheme cs;
  final bool isDark;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: AppSpacing.lg,
      runSpacing: AppSpacing.lg,
      children: <Widget>[
        SizedBox(
          width: 280,
          child: Card(
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.lg),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text("标准卡片", style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: cs.onSurface)),
                  const SizedBox(height: AppSpacing.sm),
                  Text("圆角 12px、柔和阴影与细描边，浅色与暗色主题自动适配。", style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant)),
                ],
              ),
            ),
          ),
        ),
        Container(
          width: 280,
          padding: const EdgeInsets.all(AppSpacing.lg),
          decoration: AppTheme.glassCard(cs, isDark: isDark),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text("玻璃卡片", style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: cs.onSurface)),
              const SizedBox(height: AppSpacing.sm),
              Text("半透明表面 + 低对比描边，适合浮层与强调区块。", style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant)),
            ],
          ),
        ),
      ],
    );
  }
}

class _InputsPreview extends StatelessWidget {
  const _InputsPreview({required this.cs});

  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: AppSpacing.lg,
      runSpacing: AppSpacing.lg,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: <Widget>[
        SizedBox(
          width: 280,
          child: TextField(
            decoration: InputDecoration(
              hintText: "请输入内容...",
              prefixIcon: Icon(Icons.search, color: cs.onSurfaceVariant),
            ),
          ),
        ),
        SizedBox(
          width: 280,
          child: TextField(
            enabled: false,
            decoration: InputDecoration(
              hintText: "禁用状态",
              prefixIcon: Icon(Icons.lock_outline, color: cs.onSurfaceVariant),
            ),
          ),
        ),
      ],
    );
  }
}

class _DecorationsPreview extends StatelessWidget {
  const _DecorationsPreview({required this.cs, required this.isDark});

  final ColorScheme cs;
  final bool isDark;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: AppSpacing.lg,
      runSpacing: AppSpacing.lg,
      children: <Widget>[
        Container(
          width: 120,
          height: 80,
          decoration: AppTheme.borderedPanel(cs),
          alignment: Alignment.center,
          child: Text("描边面板", style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant)),
        ),
        Container(
          width: 120,
          height: 80,
          decoration: BoxDecoration(
            color: cs.surfaceContainerLow,
            borderRadius: BorderRadius.circular(AppRadius.md),
            boxShadow: AppShadows.resolveSurface(AppThemeController.instance.value),
          ),
          alignment: Alignment.center,
          child: Text("阴影面板", style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant)),
        ),
        Container(
          width: 48,
          height: 48,
          decoration: AppTheme.fab(cs, isDark: isDark),
          alignment: Alignment.center,
          child: Icon(Icons.add, color: cs.onPrimary),
        ),
      ],
    );
  }
}
