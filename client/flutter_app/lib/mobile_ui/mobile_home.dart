import "package:flutter/material.dart";

import "../core/config/api_config.dart";
import "../core/services/schedule_api_client.dart";
import "../core/services/world_api_client.dart";
import "mobile_chat_controller.dart";
import "mobile_chat_page.dart";
import "mobile_profile_page.dart";
import "mobile_schedule_page.dart";
import "mobile_theme.dart";

/// 手机端主壳：底部导航 3 tab —— 对话 / 日程 / 我的。
///
/// - 日程为手机专属「行程表」[MobileSchedulePage]：一天一页 + 顶部日期条跳转，只读展示未来 30 天
/// - 「我的」为二级菜单聚合页(简报/邮箱/设备/审批/模型服务等)
/// - 各 tab 惰性构建 + IndexedStack 保活:未访问过的 tab 不发任何网络请求
class MobileHomePage extends StatefulWidget {
  const MobileHomePage({
    super.key,
    this.chatController,
    this.initialTabIndex = 0,
    this.themeMode,
    this.onThemeModeChanged,
    this.onLogout,
  });

  /// 外部注入的对话控制器(测试用);不传时自建。
  final MobileChatController? chatController;

  /// 初始 tab(截图取证用)。
  final int initialTabIndex;

  /// 当前主题模式(由根组件管理;null 时「我的」页隐藏主题设置行)。
  final ThemeMode? themeMode;

  /// 切换主题模式。
  final ValueChanged<ThemeMode>? onThemeModeChanged;

  /// 退出登录(根组件清会话并回到登录页;null 时「我的」页隐藏退出项)。
  final VoidCallback? onLogout;

  @override
  State<MobileHomePage> createState() => MobileHomePageState();
}

class MobileHomePageState extends State<MobileHomePage> {
  late final MobileChatController _chatController;
  late final WorldApiClient _worldApi;
  late final ScheduleApiClient _scheduleApi;

  int _tabIndex = 0;

  /// 惰性构建缓存:首次切到某 tab 才构建其页面,之后保活。
  final List<Widget?> _tabCache = <Widget?>[null, null, null];

  @override
  void initState() {
    super.initState();
    _tabIndex = widget.initialTabIndex.clamp(0, 2);
    _chatController = widget.chatController ?? MobileChatController();
    _worldApi = WorldApiClient(baseUrl: ApiConfig.httpBase);
    _scheduleApi = ScheduleApiClient(baseUrl: ApiConfig.httpBase);
  }

  @override
  void dispose() {
    _chatController.dispose();
    super.dispose();
  }

  /// 切到指定 tab(0=对话 1=日程 2=我的;供行程表空态跳回对话页等跨页联动)。
  void goToTab(int index) {
    if (index < 0 || index > 2) return;
    setState(() => _tabIndex = index);
  }

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Scaffold(
      backgroundColor: p.background,
      body: IndexedStack(index: _tabIndex, children: _buildTabs()),
      bottomNavigationBar: _buildBottomBar(context),
    );
  }

  List<Widget> _buildTabs() {
    return <Widget>[
      for (int i = 0; i < 3; i++)
        _tabCache[i] ??= _buildTab(i),
    ];
  }

  Widget _buildTab(int index) {
    switch (index) {
      case 0:
        return MobileChatPage(controller: _chatController);
      case 1:
        return MobileSchedulePage(
          scheduleApi: _scheduleApi,
          sessionId: ApiConfig.effectiveActorId,
          onGoToChat: () => goToTab(0),
        );
      case 2:
        return MobileProfilePage(
          chatController: _chatController,
          worldApi: _worldApi,
          themeMode: widget.themeMode,
          onThemeModeChanged: widget.onThemeModeChanged,
          onLogout: widget.onLogout,
        );
    }
    return const SizedBox.shrink();
  }

  Widget _buildBottomBar(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final bool dark = Theme.of(context).brightness == Brightness.dark;
    return NavigationBar(
      selectedIndex: _tabIndex,
      onDestinationSelected: (int i) => setState(() => _tabIndex = i),
      backgroundColor: cs.surface,
      indicatorColor: Colors.transparent,
      height: 64,
      destinations: <Widget>[
        NavigationDestination(
          icon: Icon(Icons.chat_bubble_outline_rounded,
              color: dark ? const Color(0xFF6C6C75) : const Color(0xFFA6A6AF)),
          selectedIcon: Icon(Icons.chat_bubble_rounded, color: cs.primary),
          label: "对话",
        ),
        NavigationDestination(
          icon: Icon(Icons.event_outlined,
              color: dark ? const Color(0xFF6C6C75) : const Color(0xFFA6A6AF)),
          selectedIcon: Icon(Icons.event_rounded, color: cs.primary),
          label: "日程",
        ),
        NavigationDestination(
          icon: Icon(Icons.person_outline_rounded,
              color: dark ? const Color(0xFF6C6C75) : const Color(0xFFA6A6AF)),
          selectedIcon: Icon(Icons.person_rounded, color: cs.primary),
          label: "我的",
        ),
      ],
    );
  }
}
