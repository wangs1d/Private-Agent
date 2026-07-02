import "package:flutter/material.dart";
import "package:flutter/services.dart";

/// 通用右侧面板容器。
///
/// 设计目标:
/// - 作为浮层覆盖在所有现有组件(侧边栏 / 顶栏 / 聊天主区)之上
/// - 宽度由外部传入的绝对像素 [panelWidth] 决定(由 main.dart 根据分屏比例计算)
/// - 从屏幕顶部 (y=0) 到底部全屏展开
/// - 点击遮罩或按 ESC 关闭
class RightSidePanel extends StatefulWidget {
  const RightSidePanel({
    super.key,
    required this.visible,
    required this.title,
    required this.child,
    required this.onClose,
    required this.panelWidth,
  });

  /// 是否显示面板
  final bool visible;

  /// 面板顶部标题
  final String title;

  /// 面板内要展示的内容(如 MailboxPage / GameCenterPage)
  final Widget child;

  /// 关闭回调(点遮罩、点 ✕、按 ESC 都会触发)
  final VoidCallback onClose;

  /// 面板绝对像素宽度(由外部根据分屏比例计算后传入)
  final double panelWidth;

  @override
  State<RightSidePanel> createState() => _RightSidePanelState();
}

class _RightSidePanelState extends State<RightSidePanel>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  late final Animation<Offset> _slide;
  late final Animation<double> _fade;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 280),
      reverseDuration: const Duration(milliseconds: 220),
    );
    _slide = Tween<Offset>(
      begin: const Offset(1, 0),
      end: Offset.zero,
    ).animate(CurvedAnimation(parent: _controller, curve: Curves.easeOutCubic));
    _fade = CurvedAnimation(parent: _controller, curve: Curves.easeOut);

    if (widget.visible) {
      _controller.value = 1.0;
    }
  }

  @override
  void didUpdateWidget(covariant RightSidePanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.visible != oldWidget.visible) {
      if (widget.visible) {
        _controller.forward();
      } else {
        _controller.reverse();
      }
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _handleKey(KeyEvent event) {
    if (event is KeyDownEvent &&
        (event.logicalKey == LogicalKeyboardKey.escape ||
            event.logicalKey == LogicalKeyboardKey.close)) {
      widget.onClose();
    }
  }

  @override
  Widget build(BuildContext context) {
    // 不可见且动画已归零时,直接不挂载,避免吞掉点击事件
    if (!widget.visible && _controller.value == 0) {
      return const SizedBox.shrink();
    }

    final ColorScheme cs = Theme.of(context).colorScheme;
    final double panelWidth = widget.panelWidth;

    return Focus(
      autofocus: true,
      onKeyEvent: (_, event) {
        _handleKey(event);
        return KeyEventResult.handled;
      },
      child: AnimatedBuilder(
        animation: _controller,
        builder: (BuildContext context, Widget? _) {
          return Stack(
            children: <Widget>[
              // 遮罩:半透明覆盖所有底层组件
              Positioned.fill(
                child: IgnorePointer(
                  ignoring: !widget.visible,
                  child: GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTap: widget.onClose,
                    child: Container(
                      color: cs.scrim.withValues(alpha: 0.32 * _fade.value),
                    ),
                  ),
                ),
              ),
              // 面板本体
              Positioned(
                top: 0,
                bottom: 0,
                right: 0,
                width: panelWidth,
                child: SlideTransition(
                  position: _slide,
                  child: Material(
                    color: cs.surface,
                    surfaceTintColor: Colors.transparent,
                    elevation: 16,
                    shadowColor: cs.shadow.withValues(alpha: 0.18),
                    borderRadius: const BorderRadius.horizontal(
                      left: Radius.circular(16),
                    ),
                    clipBehavior: Clip.antiAlias,
                    child: Column(
                      children: <Widget>[
                        _buildHeader(context, cs),
                        const Divider(height: 1, thickness: 0.5),
                        Expanded(child: widget.child),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  Widget _buildHeader(BuildContext context, ColorScheme cs) {
    return Container(
      height: 48,
      padding: const EdgeInsets.symmetric(horizontal: 16),
      color: cs.surfaceContainerLow,
      child: Row(
        children: <Widget>[
          Text(
            widget.title,
            style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w600,
                  color: cs.onSurface,
                ),
          ),
          const Spacer(),
          IconButton(
            tooltip: "关闭",
            onPressed: widget.onClose,
            icon: const Icon(Icons.close, size: 20),
            color: cs.onSurfaceVariant,
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints.tightFor(width: 32, height: 32),
          ),
        ],
      ),
    );
  }
}
