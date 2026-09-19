// webview_ghost_window_guardian 的独立手动测试（不参与 CMake 构建）。
//
// 验证两条核心规则：
//   1. 本进程内"可见 + Chromium 类名 + 覆盖屏幕≥25%"的窗口 → 被打上
//      WS_EX_TRANSPARENT | WS_EX_NOACTIVATE（幽灵窗被中和）；
//   2. 同类名的小窗口（模拟页内下拉等合法弹层）→ 不受影响。
//
// 编译运行（VS 开发者命令行，在 runner 目录下）：
//   cl /utf-8 /EHsc /W4 webview_ghost_window_guardian_test.cpp ^
//      webview_ghost_window_guardian.cpp /Fe:ghost_guardian_test.exe
//   ghost_guardian_test.exe

#include "webview_ghost_window_guardian.h"

#include <windows.h>

#include <cstdio>

namespace {

constexpr wchar_t kGhostClass[] = L"Chrome_WidgetWin_GhostTest";
constexpr LONG_PTR kNeutralizeMask =
    WS_EX_TRANSPARENT | WS_EX_NOACTIVATE;

LRESULT CALLBACK DefWndProc(HWND hwnd, UINT msg, WPARAM wparam,
                            LPARAM lparam) {
  return DefWindowProcW(hwnd, msg, wparam, lparam);
}

HWND CreateTestWindow(int width, int height) {
  WNDCLASSW wc{};
  wc.lpfnWndProc = &DefWndProc;
  wc.lpszClassName = kGhostClass;
  wc.hInstance = GetModuleHandleW(nullptr);
  RegisterClassW(&wc);
  // WS_POPUP + WS_VISIBLE：与幽灵窗同为"可见顶层窗口"。
  return CreateWindowExW(0, kGhostClass, L"ghost", WS_POPUP | WS_VISIBLE, 60,
                         60, width, height, nullptr, nullptr,
                         wc.hInstance, nullptr);
}

LONG_PTR ExStyle(HWND hwnd) { return GetWindowLongPtrW(hwnd, GWL_EXSTYLE); }

}  // namespace

int main() {
  HWND big = CreateTestWindow(1400, 900);   // 4K 工作区外也成立：按比例判定
  HWND small_one = CreateTestWindow(200, 200);
  if (!big || !small_one) {
    wprintf(L"FAIL: create window\n");
    return 1;
  }
  Sleep(200);  // 等窗口状态稳定

  const int neutralized = webview_ghost_guardian::SweepOnce();
  const bool big_ok = (ExStyle(big) & kNeutralizeMask) == kNeutralizeMask;
  const bool small_ok = (ExStyle(small_one) & kNeutralizeMask) == 0;

  wprintf(L"neutralized=%d big_hit=%d small_untouched=%d\n", neutralized,
          big_ok ? 1 : 0, small_ok ? 1 : 0);
  wprintf(L"%ls\n",
          (neutralized == 1 && big_ok && small_ok) ? L"PASS" : L"FAIL");

  DestroyWindow(big);
  DestroyWindow(small_one);
  UnregisterClassW(kGhostClass, GetModuleHandleW(nullptr));
  return (neutralized == 1 && big_ok && small_ok) ? 0 : 1;
}
