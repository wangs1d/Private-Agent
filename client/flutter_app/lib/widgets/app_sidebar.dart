import "package:flutter/material.dart";
import "package:flutter/scheduler.dart";

import "package:private_ai_agent/core/theme/app_theme.dart";
import "package:private_ai_agent/features/chat/sidebar_user_menu.dart";

/// 侧栏 hover 延后到下一帧，避免 AnimatedCrossFade 切换时触发
/// mouse_tracker 断言失败
void deferSidebarHover(VoidCallback fn) {
  SchedulerBinding.instance.addPostFrameCallback((_) => fn());
}

class AppSidebar extends StatefulWidget {
  const AppSidebar({
    super.key,
    required this.tabIndex,
    required this.onTabSelected,
    required this.currentTheme,
    required this.onSetLightTheme,
    required this.onSetDarkTheme,
    required this.onSetSystemTheme,
    required this.onOpenMessages,
    required this.onOpenSettings,
    required this.onOpenUserMenuHelp,
    required this.onOpenDevices,
    required this.onLogout,
    required this.totalUnread,
  });

  final int tabIndex;
  final ValueChanged<int> onTabSelected;

  /// 当前主题选择(用于在用户菜单的子菜单里高亮当前项)
  final ThemeChoice currentTheme;

  /// 切换「亮色」
  final VoidCallback onSetLightTheme;

  /// 切换「暗色」
  final VoidCallback onSetDarkTheme;

  /// 切换「跟随系统」
  final VoidCallback onSetSystemTheme;

  /// 用户菜单「站内信」行:打开右侧消息聚合面板
  final VoidCallback onOpenMessages;

  /// 侧栏底部「设置」按钮:全屏打开设置页
  final VoidCallback onOpenSettings;

  /// 用户菜单「帮助与反馈」行
  final VoidCallback onOpenUserMenuHelp;

  /// 用户菜单「我的设备」行:打开终端互连平台设备管理页
  final VoidCallback onOpenDevices;

  /// 用户菜单「退出登录」行
  final VoidCallback onLogout;

  /// 站内信未读总数(0 不显示徽标)
  final int totalUnread;

  @override
  State<AppSidebar> createState() => _AppSidebarState();
}

class _AppSidebarState extends State<AppSidebar> {
  static const List<SidebarItemSpec> _kItems = <SidebarItemSpec>[
    SidebarItemSpec(
      iconOutlined: Icons.chat_bubble_outline_rounded,
      iconFilled: Icons.chat_rounded,
      label: '对话',
      tabIndex: 0,
    ),
  ];

  // 预定义常量
  static const double _sidebarWidth = 256.0;
  static const EdgeInsets _sidebarPadding =
      EdgeInsets.symmetric(horizontal: 10, vertical: 8);

  @override
  Widget build(BuildContext context) {
    // 跟随当前主题（侧栏底部的用户菜单里点「主题」会改变
    // AppThemeController 的值，父级 ValueListenableBuilder 触发
    // 整个 MaterialApp 重建，使这里取到新色）。
    final AppThemeVariant variant = AppThemeController.instance.value;
    final Color bgColor = AppPalette.resolveSidebarPanel(variant);

    return Container(
      width: _sidebarWidth,
      decoration: BoxDecoration(color: bgColor),
      clipBehavior: Clip.hardEdge,
      child: Material(
        color: bgColor,
        child: SafeArea(
          // 用 Stack 把「用户头像」直接锚定在侧栏最底端(物理位置),
          // 跟上面可滚动的 tab 列解耦 ——
          // 即便 tab 列只有 1 项,头像也始终紧贴底边。
          child: Stack(
            children: <Widget>[
              // tab 列表(从顶部往下铺)
              Positioned.fill(
                child: Padding(
                  padding: _sidebarPadding,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      const SizedBox(height: 16),
                      Expanded(
                        child: SingleChildScrollView(
                          padding: EdgeInsets.zero,
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: <Widget>[
                              for (int i = 0; i < _kItems.length; i += 1)
                                SidebarNavItem(
                                  key: ValueKey<String>(_kItems[i].label),
                                  spec: _kItems[i],
                                  selected:
                                      widget.tabIndex == _kItems[i].tabIndex,
                                  onTap: () =>
                                      widget.onTabSelected(_kItems[i].tabIndex),
                                ),
                            ],
                          ),
                        ),
                      ),
                      // 底部预留一个头像高度(40) + 8px 底间距 + 4px 视觉间距,
                      // 避免最后一项 tab 被头像盖住。
                      const SizedBox(height: 40 + 8 + 4),
                    ],
                  ),
                ),
              ),
              // 头像锚定在侧栏底部最左(与上方导航图标左边距 10 对齐),
              // 「设置」按钮锚定在最右,二者各占一角,均无描边。
              Positioned(
                left: 10,
                bottom: 8,
                child: Tooltip(
                  message: "用户菜单",
                  child: SidebarUserMenu(
                    userName: "king",
                    totalUnread: widget.totalUnread,
                    currentTheme: widget.currentTheme,
                    onSetLightTheme: widget.onSetLightTheme,
                    onSetDarkTheme: widget.onSetDarkTheme,
                    onSetSystemTheme: widget.onSetSystemTheme,
                    onOpenMessages: widget.onOpenMessages,
                    onOpenHelp: widget.onOpenUserMenuHelp,
                    onOpenDevices: widget.onOpenDevices,
                    onLogout: widget.onLogout,
                  ),
                ),
              ),
              Positioned(
                right: 10,
                bottom: 8,
                child: _SidebarSettingsButton(onTap: widget.onOpenSettings),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class SidebarItemSpec {
  const SidebarItemSpec({
    required this.iconOutlined,
    required this.iconFilled,
    required this.label,
    required this.tabIndex,
  });

  final IconData iconOutlined;
  final IconData iconFilled;
  final String label;
  final int tabIndex;
}

/// 侧栏「设置」按钮:锚定在侧栏底部最右侧,与头像同规格但无描边,
/// 只保留 hover 底色反馈,点击全屏打开设置页。
class _SidebarSettingsButton extends StatefulWidget {
  const _SidebarSettingsButton({required this.onTap});

  final VoidCallback onTap;

  @override
  State<_SidebarSettingsButton> createState() => _SidebarSettingsButtonState();
}

class _SidebarSettingsButtonState extends State<_SidebarSettingsButton> {
  bool _hovering = false;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final AppThemeVariant variant = AppThemeController.instance.value;
    final Color bgColor = _hovering
        ? cs.surfaceContainer.withValues(alpha: 0.6)
        : Colors.transparent;
    final Color iconColor = _hovering
        ? AppPalette.resolveSidebarIconHover(variant)
        : AppPalette.resolveSidebarIconDefault(variant);

    return Tooltip(
      message: "设置",
      child: MouseRegion(
        onEnter: (_) => deferSidebarHover(() {
          if (mounted) setState(() => _hovering = true);
        }),
        onExit: (_) => deferSidebarHover(() {
          if (mounted) setState(() => _hovering = false);
        }),
        cursor: SystemMouseCursors.click,
        child: GestureDetector(
          onTap: widget.onTap,
          behavior: HitTestBehavior.opaque,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 200),
            curve: Curves.easeOutCubic,
            width: 40,
            height: 40,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: bgColor,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Icon(Icons.settings_outlined, size: 20, color: iconColor),
          ),
        ),
      ),
    );
  }
}

class SidebarNavItem extends StatefulWidget {
  const SidebarNavItem({
    super.key,
    required this.spec,
    required this.selected,
    required this.onTap,
  });

  final SidebarItemSpec spec;
  final bool selected;
  final VoidCallback onTap;

  @override
  State<SidebarNavItem> createState() => _SidebarNavItemState();
}

class _SidebarNavItemState extends State<SidebarNavItem> {
  bool _hovering = false;

  @override
  Widget build(BuildContext context) {
    final bool selected = widget.selected;
    final bool hovering = _hovering;
    final SidebarItemSpec spec = widget.spec;
    final ColorScheme cs = Theme.of(context).colorScheme;
    final AppThemeVariant variant = AppThemeController.instance.value;

    // 选中态加深:用最高一档 surface 容器色,在浅色侧栏上明显更深;
    // 未选中时只显示描边(框),hover 给一层浅底
    final Color bgColor = selected
        ? cs.surfaceContainerHighest
        : (hovering
            ? cs.surfaceContainer.withValues(alpha: 0.6)
            : Colors.transparent);

    // 框:始终有描边,选中时描边加深一档
    final Color borderColor =
        cs.outline.withValues(alpha: selected ? 0.6 : 0.35);

    final Color iconColor = selected
        ? AppPalette.resolveSidebarIconSelected(variant)
        : (hovering
            ? AppPalette.resolveSidebarIconHover(variant)
            : AppPalette.resolveSidebarIconDefault(variant));

    final Widget button = MouseRegion(
      onEnter: (_) => deferSidebarHover(() {
        if (mounted) setState(() => _hovering = true);
      }),
      onExit: (_) => deferSidebarHover(() {
        if (mounted) setState(() => _hovering = false);
      }),
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: widget.onTap,
        behavior: HitTestBehavior.opaque,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOutCubic,
          width: 40,
          height: 40,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: bgColor,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: borderColor, width: 1),
          ),
          child: Icon(
            selected ? spec.iconFilled : spec.iconOutlined,
            size: 20,
            color: iconColor,
          ),
        ),
      ),
    );

    return Tooltip(
      message: spec.label,
      child: button,
    );
  }
}
