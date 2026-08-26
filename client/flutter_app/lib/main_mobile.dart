import "package:flutter/material.dart";

import "mobile_ui/mobile_theme.dart";
import "mobile_ui/mobile_chat_page.dart";
import "mobile_ui/mobile_chat_controller.dart";
import "mobile_ui/mobile_profile_page.dart";

/// 手机端应用入口(Android / iOS)。
///
/// 运行：
/// - Linux/macOS/Windows 桌面调试手机 UI：
///   `flutter run -d windows -t lib/main_mobile.dart`
/// - Web 预览：
///   `flutter run -d chrome -t lib/main_mobile.dart`
/// - Android 模拟器连接本机后端：
///   `flutter run -t lib/main_mobile.dart --dart-define=HTTP_BASE=http://10.0.2.2:3000`
/// - 真机(手机与后端在同一局域网)：
///   改用手机连的局域网 IP,如 `--dart-define=HTTP_BASE=http://192.168.1.100:3000`
/// - 指定登录账号(与桌面端同一账号以同步数据)：
///   `--dart-define=USER_ID=your-login-id`
///
/// 底部导航：「对话」 / 「我的」(账号、主题、每日简报、退出登录)。
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const MobileApp());
}

/// 手机端根组件：白黑极简主题 + 底部导航(对话 / 我的)。
class MobileApp extends StatefulWidget {
  const MobileApp({super.key});

  @override
  State<MobileApp> createState() => _MobileAppState();
}

class _MobileAppState extends State<MobileApp> {
  /// 主题模式(亮 / 暗 / 跟随系统)。
  final ValueNotifier<ThemeMode> _themeMode = ValueNotifier(ThemeMode.system);

  /// 当前底部导航页。
  int _tabIndex = 0;

  /// 全局共享的对话控制器(供「我的」页退出登录时清空会话)。
  late final MobileChatController _chatController;

  @override
  void initState() {
    super.initState();
    _chatController = MobileChatController();
  }

  @override
  void dispose() {
    _themeMode.dispose();
    _chatController.dispose();
    super.dispose();
  }

  void _logout() {
    _chatController.reset();
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<ThemeMode>(
      valueListenable: _themeMode,
      builder: (BuildContext context, ThemeMode mode, _) {
        return MaterialApp(
          debugShowCheckedModeBanner: false,
          title: "智能助手",
          theme: MobileTheme.light,
          darkTheme: MobileTheme.dark,
          themeMode: mode,
          home: Scaffold(
            body: IndexedStack(
              index: _tabIndex,
              children: <Widget>[
                MobileChatPage(controller: _chatController),
                MobileProfilePage(
                  themeMode: mode,
                  onThemeModeChanged: (ThemeMode m) {
                    _themeMode.value = m;
                  },
                  onLogout: _logout,
                ),
              ],
            ),
            bottomNavigationBar: _buildBottomBar(context),
          ),
        );
      },
    );
  }

  Widget _buildBottomBar(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return BottomNavigationBar(
      currentIndex: _tabIndex,
      onTap: (int i) => setState(() => _tabIndex = i),
      type: BottomNavigationBarType.fixed,
      backgroundColor: cs.surface,
      selectedItemColor: cs.primary,
      unselectedItemColor: Theme.of(context).brightness == Brightness.dark
          ? const Color(0xFF6C6C75)
          : const Color(0xFFA6A6AF),
      selectedFontSize: 11,
      unselectedFontSize: 11,
      items: const <BottomNavigationBarItem>[
        BottomNavigationBarItem(
          icon: Icon(Icons.chat_bubble_outline_rounded),
          activeIcon: Icon(Icons.chat_bubble_rounded),
          label: "对话",
        ),
        BottomNavigationBarItem(
          icon: Icon(Icons.person_outline_rounded),
          activeIcon: Icon(Icons.person_rounded),
          label: "我的",
        ),
      ],
    );
  }
}
