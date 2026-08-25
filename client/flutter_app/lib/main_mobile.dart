import "package:flutter/material.dart";

import "mobile_ui/mobile_theme.dart";
import "mobile_ui/mobile_chat_page.dart";

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
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const MobileApp());
}

/// 手机端根组件：白黑极简主题 + 对话主界面。
class MobileApp extends StatelessWidget {
  const MobileApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: "智能助手",
      theme: MobileTheme.material,
      home: const MobileChatPage(),
    );
  }
}