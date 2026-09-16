import "package:flutter/material.dart";
import "package:webview_windows/webview_windows.dart";

import "../../core/services/shared_browser_host.dart";

/// 浏览器页（用户与 Agent 共用）。
///
/// 颜色全部取自 [Theme.of] —— 深色/暖色两套主题自动跟随：
///   - 主页态：居中单层搜索框 + 「试试让 Agent」任务建议 chips
///     （点击直接把任务发进对话）
///   - 浏览态：顶部一条细工具栏（后退/前进/刷新 + omnibox + 主页）；
///     主页态下 omnibox 透明无框、居中提示，与主页搜索框风格一致
///   - Agent 正在操作时工具栏下方浮出细状态条（共用浏览器的信任提示）
///
/// 嵌入模式（embedded=true）：渲染在右侧 Dock 面板里，不自带关闭按钮
/// （面板顶栏已有）；false 时为整页（预留全屏打开形态）。
class BrowserPage extends StatefulWidget {
  const BrowserPage({super.key, this.embedded = false, this.onAgentTask});

  final bool embedded;

  /// 主页「试试让 Agent」chips 的回调：把任务文本作为用户消息发给 Agent。
  final ValueChanged<String>? onAgentTask;

  @override
  State<BrowserPage> createState() => _BrowserPageState();
}

class _BrowserPageState extends State<BrowserPage> {
  final SharedBrowserHost host = SharedBrowserHost.instance;
  final TextEditingController _omnibox = TextEditingController();
  final FocusNode _omniboxFocus = FocusNode();
  bool _starting = false;

  /// 「试试让 Agent」任务建议（点击即作为用户消息发给 Agent）。
  static const List<String> _agentSuggestions = <String>[
    "比较目的地酒店价格",
    "附近美食推荐",
    "查一下今天的重要新闻",
    "整理邮箱中的广告邮件",
    "帮我比价一个商品",
    "看看快递到哪了",
  ];

  @override
  void initState() {
    super.initState();
    _bootstrap();
    host.currentUrl.addListener(_syncOmnibox);
    _syncOmnibox();
  }

  Future<void> _bootstrap() async {
    if (host.isReady) return;
    setState(() => _starting = true);
    await host.ensureStarted();
    if (mounted) setState(() => _starting = false);
  }

  @override
  void dispose() {
    host.currentUrl.removeListener(_syncOmnibox);
    _omnibox.dispose();
    _omniboxFocus.dispose();
    super.dispose();
  }

  /// WebView 地址变化同步到 omnibox（用户手动点链接时输入框跟随）。
  /// 聚焦中不同步，避免覆盖用户正在输入的内容。
  void _syncOmnibox() {
    final String url = host.currentUrl.value;
    if (_omniboxFocus.hasFocus) return;
    if (host.atHome) {
      if (_omnibox.text.isNotEmpty) _omnibox.clear();
    } else if (_omnibox.text != url) {
      _omnibox.value = TextEditingValue(text: url);
    }
  }

  void _submit(String raw) {
    _omniboxFocus.unfocus();
    host.submitQuery(raw);
  }

  void _sendAgentTask(String task) {
    _omniboxFocus.unfocus();
    widget.onAgentTask?.call(task);
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        // URL 变化驱动工具栏重建（后退/主页按钮的可用态、omnibox 图标跟随）
        ValueListenableBuilder<String>(
          valueListenable: host.currentUrl,
          builder: (BuildContext context, String _, Widget? __) =>
              _buildToolbar(cs),
        ),
        // Agent 操作状态条（共用浏览器：操作可见、可接管）
        ValueListenableBuilder<int>(
          valueListenable: host.pendingAgentActions,
          builder: (BuildContext context, int pending, _) {
            if (pending <= 0) return const SizedBox.shrink();
            return _AgentStatusBar(cs: cs, action: host.lastAgentAction.value);
          },
        ),
        ValueListenableBuilder<String>(
          valueListenable: host.currentUrl,
          builder: (BuildContext context, String url, _) {
            final bool home = host.atHome;
            if (home) return Expanded(child: _buildHomePage(cs));
            return Expanded(child: _buildWebView(cs));
          },
        ),
      ],
    );
  }

  // ═══════════════════════════════════════════════════════════
  // 工具栏（Chrome 式：图标按钮 + 胶囊 omnibox；主页态 omnibox 透明无框）
  // ═══════════════════════════════════════════════════════════

  Widget _buildToolbar(ColorScheme cs) {
    return Container(
      height: 44,
      decoration: BoxDecoration(
        color: cs.surface,
        border: Border(
          bottom: BorderSide(color: cs.outline.withValues(alpha: 0.25)),
        ),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Row(
        children: <Widget>[
          _NavButton(
            icon: Icons.arrow_back_ios_new,
            tooltip: "后退",
            cs: cs,
            onTap: host.atHome ? null : host.goBack,
          ),
          _NavButton(
            icon: Icons.arrow_forward_ios,
            tooltip: "前进",
            cs: cs,
            onTap: host.atHome ? null : host.goForward,
          ),
          ValueListenableBuilder<bool>(
            valueListenable: host.isLoading,
            builder: (BuildContext context, bool loading, _) => _NavButton(
              icon: loading ? Icons.close : Icons.refresh,
              tooltip: loading ? "停止" : "刷新",
              cs: cs,
              onTap: loading ? host.stop : (host.atHome ? null : host.reload),
            ),
          ),
          const SizedBox(width: 4),
          Expanded(child: _buildOmnibox(cs)),
          const SizedBox(width: 4),
          _NavButton(
            icon: Icons.home_outlined,
            tooltip: "主页",
            cs: cs,
            onTap: host.atHome ? null : host.goHome,
          ),
        ],
      ),
    );
  }

  Widget _buildOmnibox(ColorScheme cs) {
    final bool home = host.atHome;
    // 主页态：透明无框、提示居中（与主页单层搜索框同一风格，不再套一层框）；
    // 浏览态：淡色胶囊填充，聚焦时浅描边。
    return TextField(
      controller: _omnibox,
      focusNode: _omniboxFocus,
      style: TextStyle(fontSize: 13, color: cs.onSurface),
      textAlign: home ? TextAlign.center : TextAlign.start,
      textAlignVertical: TextAlignVertical.center,
      textInputAction: TextInputAction.go,
      onSubmitted: _submit,
      decoration: InputDecoration(
        isDense: true,
        filled: true,
        fillColor: home
            ? Colors.transparent
            : cs.surfaceContainerHigh.withValues(alpha: 0.6),
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        prefixIcon: home
            ? null
            : Icon(_omniboxIcon, size: 15, color: cs.onSurfaceVariant),
        prefixIconConstraints: const BoxConstraints(minWidth: 34),
        hintText: "搜索或输入网址",
        hintStyle: TextStyle(fontSize: 12.5, color: cs.onSurfaceVariant),
        border: InputBorder.none,
        enabledBorder: home
            ? InputBorder.none
            : OutlineInputBorder(
                borderRadius: BorderRadius.circular(20),
                borderSide: BorderSide.none,
              ),
        focusedBorder: home
            ? InputBorder.none
            : OutlineInputBorder(
                borderRadius: BorderRadius.circular(20),
                borderSide:
                    BorderSide(color: cs.onSurface.withValues(alpha: 0.45)),
              ),
      ),
    );
  }

  IconData get _omniboxIcon {
    final String t = _omnibox.text.trim();
    if (t.isEmpty || SharedBrowserHost.resolveInputToUrl(t) == null) {
      return Icons.search;
    }
    return Icons.lock_outline_rounded;
  }

  // ═══════════════════════════════════════════════════════════
  // 主页：大标题 + 单层搜索框 + 「试试让 Agent」任务建议
  // ═══════════════════════════════════════════════════════════

  Widget _buildHomePage(ColorScheme cs) {
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(vertical: 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const SizedBox(height: 8),
            // 单层搜索框：仅一层淡色填充圆角，无外框、无描边
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 32),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 520),
                child: _HomeSearchBox(cs: cs, onSubmitted: _submit),
              ),
            ),
            const SizedBox(height: 40),
            Text(
              "试试让 Agent",
              style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant),
            ),
            const SizedBox(height: 14),
            // 滚动展示栏：通栏铺满面板宽，chips 在两侧边缘裁切，横向滚动
            _AgentSuggestionsRow(
              cs: cs,
              suggestions: _agentSuggestions,
              onTap: _sendAgentTask,
            ),
          ],
        ),
      ),
    );
  }

  // ═══════════════════════════════════════════════════════════
  // WebView 渲染区
  // ═══════════════════════════════════════════════════════════

  Widget _buildWebView(ColorScheme cs) {
    final WebviewController? controller = host.controller;
    if (_starting && controller == null) {
      return Center(
        child: SizedBox(
          width: 22,
          height: 22,
          child: CircularProgressIndicator(
            strokeWidth: 2.2,
            color: cs.onSurfaceVariant,
          ),
        ),
      );
    }
    if (controller == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            host.error ?? "浏览器组件暂不可用",
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant),
          ),
        ),
      );
    }
    return Webview(controller);
  }
}

/// 主页搜索框：单层淡色填充圆角（无外框、无描边、无聚焦描边），回车提交。
class _HomeSearchBox extends StatefulWidget {
  const _HomeSearchBox({required this.cs, required this.onSubmitted});

  final ColorScheme cs;
  final ValueChanged<String> onSubmitted;

  @override
  State<_HomeSearchBox> createState() => _HomeSearchBoxState();
}

class _HomeSearchBoxState extends State<_HomeSearchBox> {
  final TextEditingController _controller = TextEditingController();
  final FocusNode _focus = FocusNode();

  @override
  void dispose() {
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = widget.cs;
    return TextField(
      controller: _controller,
      focusNode: _focus,
      style: TextStyle(fontSize: 14.5, color: cs.onSurface),
      textInputAction: TextInputAction.search,
      onSubmitted: (String v) {
        widget.onSubmitted(v);
        _controller.clear();
      },
      decoration: InputDecoration(
        filled: true,
        fillColor: cs.surfaceContainerHigh,
        contentPadding: const EdgeInsets.symmetric(horizontal: 4, vertical: 15),
        prefixIcon: Icon(Icons.search, size: 20, color: cs.onSurfaceVariant),
        prefixIconConstraints: const BoxConstraints(minWidth: 46),
        hintText: "搜索或输入网址",
        hintStyle: TextStyle(fontSize: 14, color: cs.onSurfaceVariant),
        // 单层：所有状态一律无描边，仅靠填充色区分
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide.none,
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide.none,
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide.none,
        ),
      ),
    );
  }
}

/// 「试试让 Agent」滚动展示栏：通栏铺满面板宽，横向滚动；
/// 内容超宽时初始滚动到居中位置，两侧 chips 被边缘裁切（carousel 观感）。
class _AgentSuggestionsRow extends StatefulWidget {
  const _AgentSuggestionsRow({
    required this.cs,
    required this.suggestions,
    required this.onTap,
  });

  final ColorScheme cs;
  final List<String> suggestions;
  final ValueChanged<String> onTap;

  @override
  State<_AgentSuggestionsRow> createState() => _AgentSuggestionsRowState();
}

class _AgentSuggestionsRowState extends State<_AgentSuggestionsRow> {
  final ScrollController _controller = ScrollController();
  final GlobalKey _contentKey = GlobalKey();
  bool _centered = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _centerOnce());
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  /// 内容超宽时把初始滚动位置停在居中处，让两侧都被裁切，
  /// 一眼看出是可横滚的展示栏。
  void _centerOnce() {
    if (_centered || !mounted || !_controller.hasClients) return;
    final BuildContext? ctx = _contentKey.currentContext;
    if (ctx == null) return;
    final RenderObject? ro = ctx.findRenderObject();
    if (ro is! RenderBox) return;
    final double viewport = _controller.position.viewportDimension;
    final double over = ro.size.width - viewport;
    _centered = true;
    if (over > 0) {
      _controller.jumpTo(over / 2);
    }
  }

  @override
  Widget build(BuildContext context) {
    final List<Widget> chips = <Widget>[
      for (final String text in widget.suggestions)
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 5),
          child: _AgentSuggestionChip(
            cs: widget.cs,
            label: text,
            onTap: () => widget.onTap(text),
          ),
        ),
    ];
    return SingleChildScrollView(
      controller: _controller,
      scrollDirection: Axis.horizontal,
      child: Row(
        key: _contentKey,
        mainAxisSize: MainAxisSize.min,
        children: chips,
      ),
    );
  }
}

/// 单个任务建议 chip：淡色填充、无描边。
class _AgentSuggestionChip extends StatelessWidget {
  const _AgentSuggestionChip({
    required this.cs,
    required this.label,
    required this.onTap,
  });

  final ColorScheme cs;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: cs.surfaceContainerHigh,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
          child: Text(
            label,
            style: TextStyle(fontSize: 12.5, color: cs.onSurface),
          ),
        ),
      ),
    );
  }
}

/// 工具栏导航圆按钮。
class _NavButton extends StatelessWidget {
  const _NavButton({
    required this.icon,
    required this.tooltip,
    required this.cs,
    this.onTap,
  });

  final IconData icon;
  final String tooltip;
  final ColorScheme cs;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      waitDuration: const Duration(milliseconds: 500),
      child: IconButton(
        onPressed: onTap,
        visualDensity: VisualDensity.compact,
        iconSize: 16,
        color: onTap == null ? cs.onSurfaceVariant.withValues(alpha: 0.35) : cs.onSurface,
        icon: Icon(icon),
      ),
    );
  }
}

/// 「Agent 正在操作」状态条：细、低饱和，不抢注意力。
class _AgentStatusBar extends StatelessWidget {
  const _AgentStatusBar({required this.cs, required this.action});

  final ColorScheme cs;
  final String action;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      color: cs.surfaceContainerHigh.withValues(alpha: 0.8),
      child: Row(
        children: <Widget>[
          SizedBox(
            width: 10,
            height: 10,
            child: CircularProgressIndicator(
              strokeWidth: 1.6,
              color: cs.onSurfaceVariant,
            ),
          ),
          const SizedBox(width: 8),
          Text(
            "Agent 正在操作浏览器（$action）· 你随时可以手动接管",
            style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}
