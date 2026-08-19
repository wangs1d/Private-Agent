#include <flutter/dart_project.h>
#include <flutter/flutter_view_controller.h>
#include <windows.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "flutter_window.h"
#include "utils.h"

int APIENTRY wWinMain(_In_ HINSTANCE instance, _In_opt_ HINSTANCE prev,
                      _In_ wchar_t *command_line, _In_ int show_command) {
  // Attach to console when present (e.g., 'flutter run') or create a
  // new console when running with a debugger.
  if (!::AttachConsole(ATTACH_PARENT_PROCESS) && ::IsDebuggerPresent()) {
    CreateAndAttachConsole();
  }

  // Suppress libpng "iCCP: known incorrect sRGB profile" warnings emitted by
  // the Flutter engine's built-in PNG resources. These are harmless and only
  // clutter the console output. Critical engine errors are still reported via
  // Dart's FlutterError.onError / PlatformDispatcher.onError.
  //
  // 注意：Flutter 引擎/图片解码/GPU 等 native 层的致命错误（如 OOM、跳过
  // Dart 的 onError 直接崩溃）只会走 stderr，Dart 侧日志抓不到。若这里丢弃
  // 到 NUL，这类崩溃就完全无迹可查（表现为 flutter run 打印 "Lost connection
  // to device" 但没有对应异常）。因此持久化到 CRT 崩溃日志，便于事后排查。
  FILE* stderr_sink;
  char env_buf[1024];
  char* crash_log_path = nullptr;
  size_t env_len = 0;
  errno_t env_err = _dupenv_s(&crash_log_path, &env_len, "PAI_STDERR_LOG");
  if (env_err != 0 || !crash_log_path || !*crash_log_path) {
    free(crash_log_path);
    crash_log_path = env_buf;
    strcpy_s(env_buf, sizeof(env_buf), "pai_app_stderr.log");
  }
  freopen_s(&stderr_sink, crash_log_path, "a", stderr); // 追加写，不覆盖历史
  if (env_err == 0 && crash_log_path && crash_log_path != env_buf) {
    free(crash_log_path);
  }

  // Initialize COM, so that it is available for use in the library and/or
  // plugins.
  ::CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

  flutter::DartProject project(L"data");

  std::vector<std::string> command_line_arguments =
      GetCommandLineArguments();

  project.set_dart_entrypoint_arguments(std::move(command_line_arguments));

  FlutterWindow window(project);
  Win32Window::Point origin(10, 10);
  Win32Window::Size size(1280, 720);
  if (!window.Create(L"", origin, size)) {
    return EXIT_FAILURE;
  }
  window.SetQuitOnClose(true);

  ::MSG msg;
  while (::GetMessage(&msg, nullptr, 0, 0)) {
    ::TranslateMessage(&msg);
    ::DispatchMessage(&msg);
  }

  ::CoUninitialize();
  return EXIT_SUCCESS;
}
