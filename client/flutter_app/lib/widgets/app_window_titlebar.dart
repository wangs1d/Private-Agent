import "package:flutter/material.dart";
import "package:window_manager/window_manager.dart";

import "../core/theme/app_theme.dart";

/// 自绘 Windows 标题栏高度（与右侧面板顶栏 40px 对齐）。
const double kWindowTitleBarHeight = 40;

/// 自绘窗口标题栏：
/// - 隐藏原生标题栏后，在窗口最顶部铺一条全宽拖拽条；
/// - 背景色与左侧边栏一致（AppPalette.resolveSidebar），
///   视觉上与侧边栏连为一体；
/// - 右侧为最小化 / 最大化(还原) / 关闭三个 Windows 风格按钮。
class AppWindowTitleBar extends StatelessWidget {
  const AppWindowTitleBar({super.key});

  @override
  Widget build(BuildContext context) {
    final AppThemeVariant variant = AppThemeController.instance.value;
    final Color bgColor = AppPalette.resolveSidebar(variant);
    final bool isDark = Theme.of(context).brightness == Brightness.dark;
    final Color iconColor =
        isDark ? Colors.white.withValues(alpha: 0.85) : Colors.black87;

    return Container(
      height: kWindowTitleBarHeight,
      color: bgColor,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          // 左侧全部为拖拽区（双击最大化/还原）。
          Expanded(child: WindowDragArea(child: SizedBox.expand())),
          WindowCaptionButton.minimize(iconColor: iconColor),
          _MaximizeButton(iconColor: iconColor),
          WindowCaptionButton.close(iconColor: iconColor),
        ],
      ),
    );
  }
}

/// 可拖拽移动窗口的区域，双击切换最大化/还原。
/// [HitTestBehavior.translucent] 保证叠在上面的按钮仍可点击。
class WindowDragArea extends StatelessWidget {
  const WindowDragArea({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.translucent,
      onPanStart: (_) => windowManager.startDragging(),
      onDoubleTap: () async {
        if (await windowManager.isMaximized()) {
          await windowManager.unmaximize();
        } else {
          await windowManager.maximize();
        }
      },
      child: child,
    );
  }
}

/// Windows 风格的窗口控制按钮（最小化 / 最大化 / 关闭）。
class WindowCaptionButton extends StatefulWidget {
  const WindowCaptionButton._({
    required this.icon,
    required this.iconSize,
    required this.iconColor,
    required this.onTap,
    this.isClose = false,
  });

  factory WindowCaptionButton.minimize({required Color iconColor}) {
    return WindowCaptionButton._(
      icon: Icons.remove_rounded,
      iconSize: 20,
      iconColor: iconColor,
      onTap: () => windowManager.minimize(),
    );
  }

  factory WindowCaptionButton.close({required Color iconColor}) {
    return WindowCaptionButton._(
      isClose: true,
      icon: Icons.close_rounded,
      iconSize: 20,
      iconColor: iconColor,
      onTap: () => windowManager.close(),
    );
  }

  final IconData icon;
  final double iconSize;
  final Color iconColor;
  final VoidCallback onTap;

  /// 关闭按钮 hover 用红色高亮。
  final bool isClose;

  @override
  State<WindowCaptionButton> createState() => _WindowCaptionButtonState();
}

class _WindowCaptionButtonState extends State<WindowCaptionButton> {
  bool _hovering = false;

  static const Color _closeHoverColor = Color(0xFFE81123);

  @override
  Widget build(BuildContext context) {
    final bool isDark = Theme.of(context).brightness == Brightness.dark;
    final Color normalHover =
        isDark ? Colors.white.withValues(alpha: 0.08) : Colors.black.withValues(alpha: 0.06);
    final Color hoverBg =
        widget.isClose ? _closeHoverColor : normalHover;
    final Color iconColor =
        (widget.isClose && _hovering) ? Colors.white : widget.iconColor;

    return MouseRegion(
      cursor: SystemMouseCursors.basic,
      onEnter: (_) => setState(() => _hovering = true),
      onExit: (_) => setState(() => _hovering = false),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.onTap,
        child: Container(
          width: 46,
          height: kWindowTitleBarHeight,
          color: _hovering ? hoverBg : Colors.transparent,
          alignment: Alignment.center,
          child: Icon(
            widget.icon,
            size: widget.iconSize,
            color: iconColor,
          ),
        ),
      ),
    );
  }
}

/// 最大化/还原按钮：根据窗口实际状态切换图标。
class _MaximizeButton extends StatefulWidget {
  const _MaximizeButton({required this.iconColor});

  final Color iconColor;

  @override
  State<_MaximizeButton> createState() => _MaximizeButtonState();
}

class _MaximizeButtonState extends State<_MaximizeButton> with WindowListener {
  bool _maximized = false;
  bool _hovering = false;

  @override
  void initState() {
    super.initState();
    windowManager.addListener(this);
    windowManager.isMaximized().then((bool value) {
      if (mounted) setState(() => _maximized = value);
    });
  }

  @override
  void dispose() {
    windowManager.removeListener(this);
    super.dispose();
  }

  @override
  void onWindowMaximize() {
    if (mounted) setState(() => _maximized = true);
  }

  @override
  void onWindowUnmaximize() {
    if (mounted) setState(() => _maximized = false);
  }

  @override
  Widget build(BuildContext context) {
    final bool isDark = Theme.of(context).brightness == Brightness.dark;
    final Color hoverBg =
        isDark ? Colors.white.withValues(alpha: 0.08) : Colors.black.withValues(alpha: 0.06);

    return MouseRegion(
      cursor: SystemMouseCursors.basic,
      onEnter: (_) => setState(() => _hovering = true),
      onExit: (_) => setState(() => _hovering = false),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () async {
          if (await windowManager.isMaximized()) {
            await windowManager.unmaximize();
          } else {
            await windowManager.maximize();
          }
        },
        child: Container(
          width: 46,
          height: kWindowTitleBarHeight,
          color: _hovering ? hoverBg : Colors.transparent,
          alignment: Alignment.center,
          child: Icon(
            _maximized
                ? Icons.filter_none_rounded
                : Icons.crop_square_rounded,
            size: 16,
            color: widget.iconColor,
          ),
        ),
      ),
    );
  }
}
