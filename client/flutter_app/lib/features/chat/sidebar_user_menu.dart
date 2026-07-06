import "dart:async";

import "package:flutter/material.dart";

import "../../core/region/region_config.dart";
import "../../core/services/device_api_client.dart";
import "../../core/theme/app_theme.dart";

/// 用户菜单里的「主题」3 选 1 状态。
///
/// 与 [AppThemeVariant] 的对应关系:
/// - [light]  → AppThemeVariant.warm
/// - [dark]   → AppThemeVariant.dark
/// - [system] → 跟随 MediaQuery.platformBrightness（运行时计算）
enum ThemeChoice { light, dark, system }

/// 侧边栏底部的「用户头像」入口 + 弹出菜单。
///
/// 设计目标（与侧栏风格一致,深色卡片,顶栏展示当前用户 + 头像）:
/// - 默认收起:只显示一个圆形头像按钮(放在侧栏最底部)
/// - 点击后:在头像右侧弹出列表面板,模仿"设置菜单"
/// - 列表面板内容(根据当前需求裁剪):
///   - 主题           亮色 / 暗色 / 跟随系统   (hover 浮出 3 选 1 子菜单)
///   - (文档 / 检测更新 暂不做)
///   - 设置
///   - 帮助与反馈
///   - 绑定微信 Claw
///   - 站内信          (带未读小红点)
///   - 退出登录
///
/// 实现说明:主题的 hover 子菜单**不放在主弹窗内部**,
/// 而是作为 outer Stack 的独立 Positioned 挂在外层,这样子菜单的
/// hit area 不会被主弹窗 240px 宽度限制,点击可以正常触发回调。
class SidebarUserMenu extends StatefulWidget {
  const SidebarUserMenu({
    super.key,
    required this.userName,
    this.totalUnread = 0,
    required this.currentTheme,
    required this.onSetLightTheme,
    required this.onSetDarkTheme,
    required this.onSetSystemTheme,
    required this.onOpenMessages,
    required this.onOpenSettings,
    required this.onOpenHelp,
    this.onOpenWechatClaw,
    required this.onOpenDevices,
    required this.onOpenBriefingSettings,
    required this.onLogout,
  });

  /// 顶部头像右侧显示的用户名(暂用 "king" 占位,后续接账号系统)
  final String userName;

  /// 站内信未读总数;>0 时在「站内信」行右侧显示红底白字小徽标
  final int totalUnread;

  /// 当前主题选择(用于在子菜单里高亮当前项)
  final ThemeChoice currentTheme;

  /// 点击「主题」子菜单「亮色」
  final VoidCallback onSetLightTheme;

  /// 点击「主题」子菜单「暗色」
  final VoidCallback onSetDarkTheme;

  /// 点击「主题」子菜单「跟随系统」
  final VoidCallback onSetSystemTheme;

  /// 点击「站内信」:滑出右侧消息聚合面板
  final VoidCallback onOpenMessages;

  /// 点击「设置」:后续接设置页
  final VoidCallback onOpenSettings;

  /// 点击「帮助与反馈」:后续接帮助页
  final VoidCallback onOpenHelp;

  /// 点击「微信 Claw 绑定」:复用原侧栏底部入口。
  ///
  /// 可选：当 [RegionCapabilities.wechatClaw] 为 false（国际版）时
  /// 该行不渲染，回调可为 null。
  final VoidCallback? onOpenWechatClaw;

  /// 点击「我的设备」:打开终端互连平台设备管理页
  final VoidCallback onOpenDevices;

  /// 点击「每日简报」:打开简报设置页（启用开关/时间/模式/sections）
  final VoidCallback onOpenBriefingSettings;

  /// 点击「退出登录」:后续接账号注销
  final VoidCallback onLogout;

  @override
  State<SidebarUserMenu> createState() => _SidebarUserMenuState();
}

class _SidebarUserMenuState extends State<SidebarUserMenu> {
  final GlobalKey _buttonKey = GlobalKey();
  bool _hovering = false;

  void _openMenu() {
    // 按钮相对屏幕的 Rect,用于把菜单贴到按钮右侧
    final RenderBox? box =
        _buttonKey.currentContext?.findRenderObject() as RenderBox?;
    if (box == null) return;
    final Offset origin = box.localToGlobal(Offset.zero);
    final Size size = box.size;
    final Rect anchor = origin & Size(size.width, size.height);

    showDialog<void>(
      context: context,
      barrierColor: Colors.transparent,
      barrierDismissible: true,
      useRootNavigator: true,
      builder: (BuildContext _) {
        return _UserMenuOverlay(
          anchor: anchor,
          userName: widget.userName,
          totalUnread: widget.totalUnread,
          currentTheme: widget.currentTheme,
          onSetLightTheme: () {
            Navigator.of(context, rootNavigator: true).pop();
            widget.onSetLightTheme();
          },
          onSetDarkTheme: () {
            Navigator.of(context, rootNavigator: true).pop();
            widget.onSetDarkTheme();
          },
          onSetSystemTheme: () {
            Navigator.of(context, rootNavigator: true).pop();
            widget.onSetSystemTheme();
          },
          onOpenMessages: () {
            Navigator.of(context, rootNavigator: true).pop();
            widget.onOpenMessages();
          },
          onOpenSettings: () {
            Navigator.of(context, rootNavigator: true).pop();
            widget.onOpenSettings();
          },
          onOpenHelp: () {
            Navigator.of(context, rootNavigator: true).pop();
            widget.onOpenHelp();
          },
          onOpenWechatClaw: widget.onOpenWechatClaw == null
              ? null
              : () {
                  Navigator.of(context, rootNavigator: true).pop();
                  widget.onOpenWechatClaw!();
                },
          onOpenDevices: () {
            Navigator.of(context, rootNavigator: true).pop();
            widget.onOpenDevices();
          },
          onOpenBriefingSettings: () {
            Navigator.of(context, rootNavigator: true).pop();
            widget.onOpenBriefingSettings();
          },
          onLogout: () {
            Navigator.of(context, rootNavigator: true).pop();
            widget.onLogout();
          },
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final AppThemeVariant variant = AppThemeController.instance.value;
    final ColorScheme cs = Theme.of(context).colorScheme;
    final Color bgColor = _hovering
        ? cs.surfaceContainer.withValues(alpha: 0.6)
        : Colors.transparent;

    return Tooltip(
      message: widget.userName,
      child: MouseRegion(
        onEnter: (_) {
          if (mounted) setState(() => _hovering = true);
        },
        onExit: (_) {
          if (mounted) setState(() => _hovering = false);
        },
        cursor: SystemMouseCursors.click,
        child: GestureDetector(
          onTap: _openMenu,
          behavior: HitTestBehavior.opaque,
          child: AnimatedContainer(
            key: _buttonKey,
            duration: const Duration(milliseconds: 200),
            curve: Curves.easeOutCubic,
            width: 40,
            height: 40,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: bgColor,
              borderRadius: BorderRadius.circular(8),
            ),
            child: _UserAvatar(
              name: widget.userName,
              variant: variant,
            ),
          ),
        ),
      ),
    );
  }
}

/// 圆形头像(只有 1 个字符的 fallback,没有真实图片资源时使用)
class _UserAvatar extends StatelessWidget {
  const _UserAvatar({required this.name, required this.variant});

  final String name;
  final AppThemeVariant variant;

  @override
  Widget build(BuildContext context) {
    final String initial = name.isEmpty ? "U" : name.characters.first;
    final ColorScheme cs = Theme.of(context).colorScheme;
    // 圆形头像底色:统一使用品牌主色(深浅主题都用同一色,不随主题翻转)
    final Color bg = cs.primary;
    final Color fg = cs.onPrimary;

    return Container(
      width: 32,
      height: 32,
      decoration: BoxDecoration(
        color: bg,
        shape: BoxShape.circle,
      ),
      alignment: Alignment.center,
      child: Text(
        initial,
        style: TextStyle(
          color: fg,
          fontWeight: FontWeight.w600,
          fontSize: 14,
        ),
      ),
    );
  }
}

/// 浮在用户头像右侧的菜单(深色卡片 + 圆角 + 阴影)。
///
/// hover 子菜单的实现:
/// 主题行的 hover 子菜单**作为 outer Stack 的独立
/// Positioned 渲染**,而不是塞在主弹窗的内部 Stack 里。这样子菜单的
/// hit-test 区域不受主弹窗 240px 宽度限制,鼠标点击子菜单项能正常
/// 命中 `_SubmenuItem` 的 GestureDetector 而不是穿透到
/// `Positioned.fill` 的"点空白关闭"层。
class _UserMenuOverlay extends StatefulWidget {
  const _UserMenuOverlay({
    required this.anchor,
    required this.userName,
    required this.totalUnread,
    required this.currentTheme,
    required this.onSetLightTheme,
    required this.onSetDarkTheme,
    required this.onSetSystemTheme,
    required this.onOpenMessages,
    required this.onOpenSettings,
    required this.onOpenHelp,
    this.onOpenWechatClaw,
    required this.onOpenDevices,
    required this.onOpenBriefingSettings,
    required this.onLogout,
  });

  final Rect anchor;
  final String userName;
  final int totalUnread;
  final ThemeChoice currentTheme;
  final VoidCallback onSetLightTheme;
  final VoidCallback onSetDarkTheme;
  final VoidCallback onSetSystemTheme;
  final VoidCallback onOpenMessages;
  final VoidCallback onOpenSettings;
  final VoidCallback onOpenHelp;
  final VoidCallback? onOpenWechatClaw;
  final VoidCallback onOpenDevices;
  final VoidCallback onOpenBriefingSettings;
  final VoidCallback onLogout;

  @override
  State<_UserMenuOverlay> createState() => _UserMenuOverlayState();
}

class _UserMenuOverlayState extends State<_UserMenuOverlay> {
  // 主题行持有一个 GlobalKey,用来在 build 时算子菜单在 outer Stack 里的绝对位置。
  final GlobalKey _themeRowKey = GlobalKey();
  // 「我的设备」行的 GlobalKey,同上。
  final GlobalKey _deviceRowKey = GlobalKey();

  // false = 没有 hover,true = 主题行 hover
  bool _themeHovered = false;
  Timer? _hideTimer;

  // false = 没有 hover,true = 「我的设备」行 hover
  bool _deviceHovered = false;
  Timer? _deviceHideTimer;

  // 数值常量统一在这里管,子菜单 widget 也从这里读 _submenuWidth
  static const double _panelWidth = 240;
  static const double _submenuOverlap = 6;
  static const double _submenuWidth = 150;
  // 「我的设备」悬浮面板宽度(比主题子菜单宽,要放下设备名)
  static const double _devicePanelWidth = 280;
  static const double _devicePanelOverlap = 6;
  static const Duration _hoverDelay = Duration(milliseconds: 120);

  void _onThemeHover() {
    _hideTimer?.cancel();
    _deviceHideTimer?.cancel();
    if (!_themeHovered || _deviceHovered) {
      setState(() {
        _themeHovered = true;
        _deviceHovered = false;
      });
    }
  }

  void _onThemeUnhover() {
    _hideTimer?.cancel();
    _hideTimer = Timer(_hoverDelay, () {
      if (mounted && _themeHovered) {
        setState(() => _themeHovered = false);
      }
    });
  }

  void _onDeviceHover() {
    _deviceHideTimer?.cancel();
    _hideTimer?.cancel();
    if (!_deviceHovered || _themeHovered) {
      setState(() {
        _deviceHovered = true;
        _themeHovered = false;
      });
    }
  }

  void _onDeviceUnhover() {
    _deviceHideTimer?.cancel();
    _deviceHideTimer = Timer(_hoverDelay, () {
      if (mounted && _deviceHovered) {
        setState(() => _deviceHovered = false);
      }
    });
  }

  /// 拿到 [key] 对应 row 在 outer Stack 局部坐标系里的 Rect,
  /// 用来挂子菜单的 Positioned。
  Rect? _getRowRectInStack(GlobalKey key) {
    final RenderBox? rowBox =
        key.currentContext?.findRenderObject() as RenderBox?;
    final RenderBox? stackBox = context.findRenderObject() as RenderBox?;
    if (rowBox == null || stackBox == null) return null;
    final Offset rowGlobal = rowBox.localToGlobal(Offset.zero);
    final Offset stackGlobal = stackBox.localToGlobal(Offset.zero);
    return (rowGlobal - stackGlobal) & rowBox.size;
  }

  @override
  void dispose() {
    _hideTimer?.cancel();
    _deviceHideTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    // 弹窗贴按钮右侧;若右侧空间不足则改贴按钮左侧(桌面端不会触发,兜底)
    final double screenWidth = MediaQuery.of(context).size.width;
    final double left = (widget.anchor.right + 8).clamp(
      8.0,
      (screenWidth - _panelWidth - 8).clamp(8.0, double.infinity),
    );
    // 弹窗底部贴头像底部往上 8px(而不是顶部往下)——
    // 这样弹窗是从头像位置往上长的,视觉上紧贴头像,不会跑到屏幕最底端。
    final double screenHeight = MediaQuery.of(context).size.height;
    // 预估面板高度,用来在面板太高时夹一下避免溢出屏幕顶部
    const double estimatedPanelHeight = 470;
    double bottom = screenHeight - widget.anchor.bottom + 8;
    final double maxBottom = screenHeight - 8 - estimatedPanelHeight;
    if (bottom > maxBottom) bottom = maxBottom;

    final String themeLabel = switch (widget.currentTheme) {
      ThemeChoice.light => "亮色",
      ThemeChoice.dark => "暗色",
      ThemeChoice.system => "跟随系统",
    };

    // 主题行处于 hover 状态时,取该行在 outer Stack 里的 rect
    // (注意:这里要在 setState 触发的 build 里读 key,key 此时必然已 attach)
    final Rect? themeRowRect =
        _themeHovered ? _getRowRectInStack(_themeRowKey) : null;
    // 「我的设备」行同理
    final Rect? deviceRowRect =
        _deviceHovered ? _getRowRectInStack(_deviceRowKey) : null;

    return Stack(
      children: <Widget>[
        // 让整片空白区域可点击(屏障虽然 barrierDismissible=true,
        // 但 barrier 已被 transparent 化,这里再补一层兜底)
        Positioned.fill(
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () => Navigator.of(context).pop(),
            child: const SizedBox.shrink(),
          ),
        ),
        // 主弹窗(纯列表,不再嵌套子菜单)
        Positioned(
          left: left,
          bottom: bottom,
          child: Material(
            color: cs.surface,
            surfaceTintColor: cs.surfaceTint,
            elevation: 12,
            borderRadius: BorderRadius.circular(14),
            // 关闭裁剪(子菜单虽然已经挪到外层,但保留 Clip.none 也不会出错)
            clipBehavior: Clip.none,
            child: SizedBox(
              width: _panelWidth,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  _Header(userName: widget.userName),
                  const Divider(height: 1, thickness: 1),
                  _ThemeRow(
                    rowKey: _themeRowKey,
                    currentTheme: widget.currentTheme,
                    themeLabel: themeLabel,
                    onHover: _onThemeHover,
                    onUnhover: _onThemeUnhover,
                  ),
                  const Divider(height: 1, thickness: 1),
                  _Row(
                    leading: const Icon(Icons.settings_outlined, size: 18),
                    title: "设置",
                    onTap: widget.onOpenSettings,
                  ),
                  _Row(
                    leading:
                        const Icon(Icons.wb_sunny_outlined, size: 18),
                    title: "每日简报",
                    trailing: const _TrailingValue(showChevron: true),
                    onTap: widget.onOpenBriefingSettings,
                  ),
                  _Row(
                    leading: const Icon(Icons.help_outline, size: 18),
                    title: "帮助与反馈",
                    trailing: const _TrailingValue(showChevron: true),
                    onTap: widget.onOpenHelp,
                  ),
                  _DeviceHoverRow(
                    rowKey: _deviceRowKey,
                    onHover: _onDeviceHover,
                    onUnhover: _onDeviceUnhover,
                    onTap: widget.onOpenDevices,
                  ),
                  if (RegionConfig.capabilities.wechatClaw &&
                      widget.onOpenWechatClaw != null)
                    _Row(
                      leading: const Icon(Icons.qr_code_2_outlined, size: 18),
                      title: "绑定微信 Claw",
                      onTap: widget.onOpenWechatClaw!,
                    ),
                  _Row(
                    leading:
                        const Icon(Icons.notifications_outlined, size: 18),
                    title: "站内信",
                    trailing: widget.totalUnread > 0
                        ? _UnreadBadge(count: widget.totalUnread)
                        : const _TrailingValue(showChevron: true),
                    onTap: widget.onOpenMessages,
                  ),
                  const Divider(height: 1, thickness: 1),
                  _Row(
                    leading: Icon(
                      Icons.logout,
                      size: 18,
                      color: cs.error,
                    ),
                    title: "退出登录",
                    titleColor: cs.error,
                    onTap: widget.onLogout,
                  ),
                ],
              ),
            ),
          ),
        ),
        // 主题子菜单:作为 outer Stack 的独立 Positioned,
        // hit area 在自己 bounds 内,不受主弹窗宽度限制
        if (_themeHovered && themeRowRect != null)
          Positioned(
            left: themeRowRect.right - _submenuOverlap,
            top: themeRowRect.top - 4,
            child: MouseRegion(
              onEnter: (_) => _onThemeHover(),
              onExit: (_) => _onThemeUnhover(),
              child: _ThemeSubmenu(
                currentTheme: widget.currentTheme,
                onSelectLight: widget.onSetLightTheme,
                onSelectDark: widget.onSetDarkTheme,
                onSelectSystem: widget.onSetSystemTheme,
              ),
            ),
          ),
        // 「我的设备」hover 悬浮面板:显示已连接设备列表
        if (_deviceHovered && deviceRowRect != null)
          Positioned(
            left: (deviceRowRect.right - _devicePanelOverlap).clamp(
              8.0,
              (screenWidth - _devicePanelWidth - 8).clamp(8.0, double.infinity),
            ),
            top: (deviceRowRect.top - 4).clamp(
              8.0,
              (screenHeight - 360).clamp(8.0, double.infinity),
            ),
            child: MouseRegion(
              onEnter: (_) => _onDeviceHover(),
              onExit: (_) => _onDeviceUnhover(),
              child: _DeviceHoverPanel(
                onOpenDevices: widget.onOpenDevices,
              ),
            ),
          ),
      ],
    );
  }
}

/// 「主题」行 —— 只负责通知外层 overlay 当前 hover 状态,
/// 不再自己渲染子菜单(子菜单挪到 outer Stack 的独立 Positioned)。
class _ThemeRow extends StatefulWidget {
  const _ThemeRow({
    required this.rowKey,
    required this.currentTheme,
    required this.themeLabel,
    required this.onHover,
    required this.onUnhover,
  });

  /// 外层 overlay 持有的 GlobalKey,通过 [RenderBox.localToGlobal]
  /// 拿这个 row 的屏幕坐标来挂子菜单。
  final GlobalKey rowKey;

  final ThemeChoice currentTheme;

  /// 右侧尾随的"当前值"文案(亮色 / 暗色 / 跟随系统)
  final String themeLabel;

  final VoidCallback onHover;
  final VoidCallback onUnhover;

  @override
  State<_ThemeRow> createState() => _ThemeRowState();
}

class _ThemeRowState extends State<_ThemeRow> {
  bool _hovering = false;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return MouseRegion(
      onEnter: (_) {
        if (mounted) {
          setState(() => _hovering = true);
          widget.onHover();
        }
      },
      onExit: (_) {
        if (mounted) {
          setState(() => _hovering = false);
          widget.onUnhover();
        }
      },
      child: Container(
        key: widget.rowKey,
        color: _hovering
            ? cs.surfaceContainerHigh.withValues(alpha: 0.6)
            : Colors.transparent,
        child: _Row(
          leading: const Icon(Icons.palette_outlined, size: 18),
          title: "主题",
          trailing: _TrailingValue(
            text: widget.themeLabel,
            showChevron: true,
          ),
          onTap: () {},
        ),
      ),
    );
  }
}

/// 「主题」hover 子菜单本体
class _ThemeSubmenu extends StatelessWidget {
  const _ThemeSubmenu({
    required this.currentTheme,
    required this.onSelectLight,
    required this.onSelectDark,
    required this.onSelectSystem,
  });

  final ThemeChoice currentTheme;
  final VoidCallback onSelectLight;
  final VoidCallback onSelectDark;
  final VoidCallback onSelectSystem;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Material(
      color: cs.surface,
      surfaceTintColor: cs.surfaceTint,
      elevation: 12,
      borderRadius: BorderRadius.circular(10),
      clipBehavior: Clip.antiAlias,
      child: SizedBox(
        width: _UserMenuOverlayState._submenuWidth,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            _SubmenuItem(
              icon: Icons.light_mode_outlined,
              label: "亮色",
              selected: currentTheme == ThemeChoice.light,
              onTap: onSelectLight,
            ),
            _SubmenuItem(
              icon: Icons.dark_mode_outlined,
              label: "暗色",
              selected: currentTheme == ThemeChoice.dark,
              onTap: onSelectDark,
            ),
            _SubmenuItem(
              icon: Icons.brightness_auto_outlined,
              label: "跟随系统",
              selected: currentTheme == ThemeChoice.system,
              onTap: onSelectSystem,
            ),
          ],
        ),
      ),
    );
  }
}

class _SubmenuItem extends StatefulWidget {
  const _SubmenuItem({
    required this.icon,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  State<_SubmenuItem> createState() => _SubmenuItemState();
}

class _SubmenuItemState extends State<_SubmenuItem> {
  bool _hovering = false;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final Color bg = _hovering
        ? cs.surfaceContainerHigh.withValues(alpha: 0.6)
        : Colors.transparent;
    final Color fg = widget.selected ? cs.primary : cs.onSurface;

    return MouseRegion(
      onEnter: (_) {
        if (mounted) setState(() => _hovering = true);
      },
      onExit: (_) {
        if (mounted) setState(() => _hovering = false);
      },
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 120),
          color: bg,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          child: Row(
            children: <Widget>[
              Icon(widget.icon, size: 16, color: fg),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  widget.label,
                  style: TextStyle(
                    fontSize: 13,
                    color: fg,
                    fontWeight:
                        widget.selected ? FontWeight.w600 : FontWeight.w500,
                  ),
                ),
              ),
              if (widget.selected)
                Icon(Icons.check, size: 16, color: cs.primary),
            ],
          ),
        ),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.userName});

  final String userName;

  @override
  Widget build(BuildContext context) {
    final AppThemeVariant variant = AppThemeController.instance.value;
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 12),
      child: Row(
        children: <Widget>[
          _UserAvatar(name: userName, variant: variant),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              userName,
              style: TextStyle(
                fontSize: 15,
                fontWeight: FontWeight.w600,
                color: cs.onSurface,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }
}

class _Row extends StatefulWidget {
  const _Row({
    required this.leading,
    required this.title,
    this.trailing,
    this.titleColor,
    required this.onTap,
  });

  final Widget leading;
  final String title;
  final Widget? trailing;
  final Color? titleColor;
  final VoidCallback onTap;

  @override
  State<_Row> createState() => _RowState();
}

class _RowState extends State<_Row> {
  bool _hovering = false;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final Color bg = _hovering
        ? cs.surfaceContainerHigh.withValues(alpha: 0.6)
        : Colors.transparent;
    final Color textColor = widget.titleColor ?? cs.onSurface;

    return MouseRegion(
      onEnter: (_) {
        if (mounted) setState(() => _hovering = true);
      },
      onExit: (_) {
        if (mounted) setState(() => _hovering = false);
      },
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 140),
          color: bg,
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          child: Row(
            children: <Widget>[
              IconTheme(
                data: IconThemeData(color: cs.onSurfaceVariant, size: 18),
                child: widget.leading,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  widget.title,
                  style: TextStyle(
                    fontSize: 14,
                    color: textColor,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ),
              if (widget.trailing != null) widget.trailing!,
            ],
          ),
        ),
      ),
    );
  }
}

class _TrailingValue extends StatelessWidget {
  const _TrailingValue({this.text, this.showChevron = false});

  final String? text;
  final bool showChevron;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        if (text != null && text!.isNotEmpty) ...<Widget>[
          Text(
            text!,
            style: TextStyle(
              fontSize: 13,
              color: cs.onSurfaceVariant,
            ),
          ),
          const SizedBox(width: 6),
        ],
        if (showChevron)
          Icon(
            Icons.chevron_right,
            size: 16,
            color: cs.onSurfaceVariant,
          ),
      ],
    );
  }
}

class _UnreadBadge extends StatelessWidget {
  const _UnreadBadge({required this.count});

  final int count;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(
        color: cs.error,
        borderRadius: BorderRadius.circular(8),
      ),
      constraints: const BoxConstraints(minWidth: 18, minHeight: 16),
      alignment: Alignment.center,
      child: Text(
        count > 99 ? "99+" : count.toString(),
        style: TextStyle(
          color: cs.onError,
          fontSize: 11,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

/// 「我的设备」行 —— 只负责通知外层 overlay 当前 hover 状态,
/// 不自己渲染悬浮面板(面板挪到 outer Stack 的独立 Positioned)。
/// 点击行本体仍然触发 onTap(打开设备管理页)。
class _DeviceHoverRow extends StatefulWidget {
  const _DeviceHoverRow({
    required this.rowKey,
    required this.onHover,
    required this.onUnhover,
    required this.onTap,
  });

  final GlobalKey rowKey;
  final VoidCallback onHover;
  final VoidCallback onUnhover;
  final VoidCallback onTap;

  @override
  State<_DeviceHoverRow> createState() => _DeviceHoverRowState();
}

class _DeviceHoverRowState extends State<_DeviceHoverRow> {
  bool _hovering = false;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return MouseRegion(
      onEnter: (_) {
        if (mounted) {
          setState(() => _hovering = true);
          widget.onHover();
        }
      },
      onExit: (_) {
        if (mounted) {
          setState(() => _hovering = false);
          widget.onUnhover();
        }
      },
      child: Container(
        key: widget.rowKey,
        color: _hovering
            ? cs.surfaceContainerHigh.withValues(alpha: 0.6)
            : Colors.transparent,
        child: _Row(
          leading: const Icon(Icons.devices_other_outlined, size: 18),
          title: "我的设备",
          trailing: const _TrailingValue(showChevron: true),
          onTap: widget.onTap,
        ),
      ),
    );
  }
}

/// 「我的设备」hover 悬浮面板 —— 异步拉取已绑定设备列表并展示。
///
/// 状态:
/// - loading: 转圈
/// - error: 红字提示
/// - empty: "暂未绑定设备"
/// - 有数据: 设备列表(在线/离线用颜色圆点区分),底部「管理全部设备」入口
class _DeviceHoverPanel extends StatefulWidget {
  const _DeviceHoverPanel({required this.onOpenDevices});

  final VoidCallback onOpenDevices;

  @override
  State<_DeviceHoverPanel> createState() => _DeviceHoverPanelState();
}

class _DeviceHoverPanelState extends State<_DeviceHoverPanel> {
  late final DeviceApiClient _client;
  List<DeviceInfo> _devices = const <DeviceInfo>[];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _client = DeviceApiClient();
    _loadDevices();
  }

  Future<void> _loadDevices() async {
    final DeviceApiResult<List<DeviceInfo>> result =
        await _client.listDevices();
    if (!mounted) return;
    setState(() {
      _loading = false;
      if (result.ok) {
        _devices = result.value ?? const <DeviceInfo>[];
        _error = null;
      } else {
        _error = result.error ?? "获取设备列表失败";
        _devices = const <DeviceInfo>[];
      }
    });
  }

  /// 设备类型 → 图标(与设备管理页保持一致的视觉语义)
  IconData _iconForKind(String kind) {
    switch (kind.toLowerCase()) {
      case "phone":
        return Icons.phone_iphone;
      case "tablet":
        return Icons.tablet_mac;
      case "glasses":
        return Icons.visibility_outlined;
      case "camera":
        return Icons.videocam_outlined;
      case "speaker":
        return Icons.speaker_outlined;
      case "watch":
        return Icons.watch_outlined;
      case "laptop":
      case "desktop":
        return Icons.laptop_mac;
      default:
        return Icons.devices_other_outlined;
    }
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final int onlineCount =
        _devices.where((DeviceInfo d) => d.online).length;

    Widget body;
    if (_loading) {
      body = const Padding(
        padding: EdgeInsets.symmetric(vertical: 24, horizontal: 16),
        child: Center(
          child: SizedBox(
            width: 20,
            height: 20,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        ),
      );
    } else if (_error != null) {
      body = Padding(
        padding: const EdgeInsets.symmetric(vertical: 20, horizontal: 16),
        child: Text(
          _error!,
          style: TextStyle(fontSize: 13, color: cs.error),
        ),
      );
    } else if (_devices.isEmpty) {
      body = Padding(
        padding: const EdgeInsets.symmetric(vertical: 20, horizontal: 16),
        child: Text(
          "暂未绑定设备",
          style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant),
        ),
      );
    } else {
      body = ConstrainedBox(
        constraints: const BoxConstraints(maxHeight: 260),
        child: ListView.separated(
          shrinkWrap: true,
          padding: const EdgeInsets.symmetric(vertical: 4),
          itemCount: _devices.length,
          separatorBuilder: (BuildContext _, int __) => Divider(
            height: 1,
            thickness: 1,
            color: cs.outline.withValues(alpha: 0.15),
          ),
          itemBuilder: (BuildContext _, int index) {
            final DeviceInfo d = _devices[index];
            final Color dotColor = d.online ? cs.primary : cs.outline;
            return Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              child: Row(
                children: <Widget>[
                  Icon(_iconForKind(d.kind),
                      size: 18, color: cs.onSurfaceVariant),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      d.name,
                      style: TextStyle(
                        fontSize: 13,
                        color: cs.onSurface,
                        fontWeight: FontWeight.w500,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Container(
                    width: 8,
                    height: 8,
                    decoration: BoxDecoration(
                      color: dotColor,
                      shape: BoxShape.circle,
                    ),
                  ),
                ],
              ),
            );
          },
        ),
      );
    }

    return Material(
      color: cs.surface,
      surfaceTintColor: cs.surfaceTint,
      elevation: 12,
      borderRadius: BorderRadius.circular(10),
      clipBehavior: Clip.antiAlias,
      child: SizedBox(
        width: _UserMenuOverlayState._devicePanelWidth,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            // 标题栏:已连接设备 + 在线计数
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 8),
              child: Row(
                children: <Widget>[
                  Text(
                    "已连接设备",
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: cs.onSurface,
                    ),
                  ),
                  const Spacer(),
                  if (!_loading && _error == null && _devices.isNotEmpty)
                    Text(
                      "$onlineCount/${_devices.length} 在线",
                      style: TextStyle(
                        fontSize: 11,
                        color: cs.onSurfaceVariant,
                      ),
                    ),
                ],
              ),
            ),
            Divider(
              height: 1,
              thickness: 1,
              color: cs.outline.withValues(alpha: 0.2),
            ),
            body,
            // 底部「管理全部设备」入口
            if (!_loading)
              MouseRegion(
                cursor: SystemMouseCursors.click,
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: widget.onOpenDevices,
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 14, vertical: 10),
                    decoration: BoxDecoration(
                      border: Border(
                        top: BorderSide(
                            color: cs.outline.withValues(alpha: 0.2)),
                      ),
                    ),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: <Widget>[
                        Text(
                          "管理全部设备",
                          style: TextStyle(
                            fontSize: 12,
                            color: cs.primary,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                        const SizedBox(width: 4),
                        Icon(Icons.chevron_right, size: 14, color: cs.primary),
                      ],
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
