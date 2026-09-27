import "dart:async" show unawaited;

import "package:flutter/material.dart";
import "package:webview_windows/webview_windows.dart";

import "gallery_page.dart";
import "gallery_review_page.dart";
import "gallery_wall_host.dart";

/// 图库工作台：一级 tab 的落地页。
///
/// 三个视图（顶部切换，IndexedStack 保活）：
///   照片墙 —— 3D 时间走廊（WebView 承载 /gallery-wall，服务端 three.js 场景）；
///   管理   —— 2D 网格（复用 GalleryPage：上传/多选批量删/收藏）；
///   回顾   —— 盲盒清理（随机 15 张三向滑断舍离）+ 记忆放映。
///
/// WebView 懒启动铁律：只有首次真正进入本 tab 才调用 host.ensureStarted()
/// （WebView2 提前创建会产生幽灵窗）。离开 tab（visible=false）调用
/// setPaused 暂停页面渲染，避免后台烧 GPU。
class GalleryWorkbenchPage extends StatefulWidget {
  const GalleryWorkbenchPage({super.key, required this.visible});

  /// 当前是否是激活 tab（由主壳 _tabIndex 驱动）。
  final bool visible;

  @override
  State<GalleryWorkbenchPage> createState() => _GalleryWorkbenchPageState();
}

enum _GalleryView { wall, manage, review }

class _GalleryWorkbenchPageState extends State<GalleryWorkbenchPage> {
  final GalleryWallHost _host = GalleryWallHost.instance;
  _GalleryView _view = _GalleryView.wall;
  /// 首次激活才挂载 WebView（IndexedStack 会在启动期构建全部子项，
  /// 必须用此闸挡住 WebView 的提前创建）。
  bool _everActivated = false;

  @override
  void initState() {
    super.initState();
    if (widget.visible) {
      _everActivated = true;
      unawaited(_activate());
    }
  }

  @override
  void didUpdateWidget(covariant GalleryWorkbenchPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.visible == oldWidget.visible) return;
    if (widget.visible && !_everActivated) {
      _everActivated = true;
      unawaited(_activate());
    } else {
      unawaited(_host.setPaused(!widget.visible));
    }
  }

  Future<void> _activate() async {
    await _host.ensureStarted();
    await _host.setPaused(!widget.visible);
  }

  @override
  void dispose() {
    if (_host.onOpenGrid == _handleOpenGrid) {
      _host.onOpenGrid = null;
    }
    super.dispose();
  }

  /// 墙页 openGrid 意图：切到 2D 管理视图（可带照片 id，目前仅做视图切换）。
  void _handleOpenGrid(String? photoId) {
    if (!mounted) return;
    setState(() => _view = _GalleryView.manage);
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    if (!_everActivated) {
      return _buildScaffold(
        cs,
        body: const Center(
          child: SizedBox(
            width: 22,
            height: 22,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        ),
      );
    }
    // 注册/刷新 openGrid 意图回调（每次 build 保持最新闭包）
    _host.onOpenGrid = _handleOpenGrid;
    return _buildScaffold(
      cs,
      body: IndexedStack(
        index: _view == _GalleryView.wall ? 0 : (_view == _GalleryView.manage ? 1 : 2),
        children: <Widget>[
          _buildWallView(),
          const GalleryPage(embedded: true),
          const GalleryReviewPage(),
        ],
      ),
    );
  }

  Widget _buildScaffold(ColorScheme cs, {required Widget body}) {
    return Scaffold(
      backgroundColor: cs.surface,
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          _buildViewToggle(cs),
          Expanded(child: body),
        ],
      ),
    );
  }

  Widget _buildViewToggle(ColorScheme cs) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 8),
      child: Row(
        children: <Widget>[
          _ToggleChip(
            label: "照片墙",
            selected: _view == _GalleryView.wall,
            cs: cs,
            onTap: () => setState(() => _view = _GalleryView.wall),
          ),
          const SizedBox(width: 8),
          _ToggleChip(
            label: "管理",
            selected: _view == _GalleryView.manage,
            cs: cs,
            onTap: () => setState(() => _view = _GalleryView.manage),
          ),
          const SizedBox(width: 8),
          _ToggleChip(
            label: "回顾 🎲",
            selected: _view == _GalleryView.review,
            cs: cs,
            onTap: () => setState(() => _view = _GalleryView.review),
          ),
        ],
      ),
    );
  }

  Widget _buildWallView() {
    if (_host.error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            _host.error!,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 13, color: Color(0xFF9A9A9A)),
          ),
        ),
      );
    }
    return FutureBuilder<void>(
      future: _host.ensureStarted(),
      builder: (BuildContext context, AsyncSnapshot<void> snapshot) {
        if (snapshot.connectionState != ConnectionState.done ||
            !_host.isInitialized) {
          return Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                SizedBox(
                  width: 22,
                  height: 22,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: Theme.of(context).colorScheme.outline,
                  ),
                ),
                const SizedBox(height: 10),
                const Text(
                  "照片墙加载中…",
                  style: TextStyle(fontSize: 12, color: Color(0xFF9A9A9A)),
                ),
              ],
            ),
          );
        }
        return Webview(_host.controller!);
      },
    );
  }
}

/// 视图切换胶囊：黑白极简，选中态实底。
class _ToggleChip extends StatelessWidget {
  const _ToggleChip({
    required this.label,
    required this.selected,
    required this.cs,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final ColorScheme cs;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: selected ? cs.onSurface : Colors.transparent,
      shape: StadiumBorder(
        side: BorderSide(
          color: selected ? cs.onSurface : cs.outline.withValues(alpha: 0.4),
        ),
      ),
      child: InkWell(
        customBorder: const StadiumBorder(),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
          child: Text(
            label,
            style: TextStyle(
              fontSize: 12.5,
              letterSpacing: 0.06,
              color: selected ? cs.surface : cs.onSurface.withValues(alpha: 0.75),
            ),
          ),
        ),
      ),
    );
  }
}
