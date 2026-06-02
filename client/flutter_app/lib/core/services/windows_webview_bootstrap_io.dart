import "dart:io";

import "package:webview_windows/webview_windows.dart";

Future<void> bootstrapWindowsWebView() async {
  if (!Platform.isWindows) return;
  try {
    await WebviewController.initializeEnvironment(
      additionalArguments:
          "--enable-gpu-rasterization --ignore-gpu-blocklist",
    );
  } catch (_) {
    // 已初始化或 WebView2 不可用。
  }
}
