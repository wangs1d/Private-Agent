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
    required this.onOpenUserMenuSettings,
    required this.onOpenUserMenuHelp,
    this.onOpenWechatClaw,
    required this.onOpenDevices,
    required this.onOpenBriefingSettings,
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

  /// 用户菜单「设置」行
  final VoidCallback onOpenUserMenuSettings;

  /// 用户菜单「帮助与反馈」行
  final VoidCallback onOpenUserMenuHelp;

  /// 用户菜单「绑定微信 Claw」行。
  ///
  /// 可选：国际版不渲染该行时可不传（由 [RegionCapabilities.wechatClaw]
  /// 决定是否显示）。
  final VoidCallback? onOpenWechatClaw;

  /// 用户菜单「我的设备」行:打开终端互连平台设备管理页
  final VoidCallback onOpenDevices;

  /// 用户菜单「每日简报」行:打开简报设置页
  final VoidCallback onOpenBriefingSettings;

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
  static const double _sidebarWidth = 64.0;
  static const EdgeInsets _sidebarPadding =
      EdgeInsets.symmetric(horizontal: 10, vertical: 8);

  @override
  Widget build(BuildContext context) {
    // 跟随当前主题（侧栏底部的用户菜单里点「主题」会改变
    // AppThemeController 的值，父级 ValueListenableBuilder 触发
    // 整个 MaterialApp 重建，使这里取到新色）。
    final AppThemeVariant variant = AppThemeController.instance.value;
    final Color bgColor = AppPalette.resolveSidebar(variant);

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
              // 头像锚定在最底端(留 8px 视觉间距,不贴死底边)
              Positioned(
                left: 0,
                right: 0,
                bottom: 8,
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 10),
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
                      onOpenSettings: widget.onOpenUserMenuSettings,
                      onOpenHelp: widget.onOpenUserMenuHelp,
                      onOpenWechatClaw: widget.onOpenWechatClaw,
                      onOpenDevices: widget.onOpenDevices,
                      onOpenBriefingSettings: widget.onOpenBriefingSettings,
                      onLogout: widget.onLogout,
                    ),
                  ),
                ),
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

    final Color bgColor = selected
        ? cs.surfaceContainerHigh.withValues(alpha: 0.6)
        : (hovering
            ? cs.surfaceContainer.withValues(alpha: 0.6)
            : Colors.transparent);

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
