import "dart:io";

import "package:webview_windows/webview_windows.dart";

/// 进程级 WebView2 环境参数附加项（环境只初始化一次，首次调用生效）。
/// 由驱动适配器在 start 前设置（如 `--remote-debugging-port=<port>`）。
String? webviewAdditionalArguments;

Future<void> bootstrapWindowsWebView({String? additionalArguments}) async {
  if (!Platform.isWindows) return;
  try {
    final String base = additionalArguments ?? webviewAdditionalArguments ?? "";
    await WebviewController.initializeEnvironment(
      additionalArguments: _mergeArgs(
        "--enable-gpu-rasterization --ignore-gpu-blocklist",
        base,
      ),
    );
  } catch (_) {
    // 已初始化或 WebView2 不可用。
  }
}

String _mergeArgs(String a, String? b) {
  final String extra = (b ?? "").trim();
  if (extra.isEmpty) return a;
  return "$a $extra";
}
