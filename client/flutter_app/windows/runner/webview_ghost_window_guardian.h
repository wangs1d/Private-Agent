#ifndef RUNNER_WEBVIEW_GHOST_WINDOW_GUARDIAN_H_
#define RUNNER_WEBVIEW_GHOST_WINDOW_GUARDIAN_H_

namespace webview_ghost_guardian {

// 启动常驻防护线程（进程级幂等，随进程存活）。
//
// 背景：WebView2 Composition 模式下，msedgewebview2.exe 浏览器进程会自行
// 创建内部 Win32 顶层窗口（Chrome_WidgetWin_* / Chrome_RenderWidgetHostHWND）。
// 个别滞留场景下该窗口会以"透明幽灵窗"形态盖在屏幕上拦截其他应用的点击
// （曾实测盖住左半屏）。这是 WebView2 运行时行为，Dart/插件层无法干预。
//
// 防护策略：周期枚举顶层窗口，凡是「本进程或本进程派生的 msedgewebview2.exe
// 进程树所有 + Chromium 内部类名 + 可见 + 覆盖某显示器工作区 ≥25%」的窗口，
// 打上 WS_EX_TRANSPARENT | WS_EX_NOACTIVATE —— 鼠标命中直接穿透、不可激活。
// Composition 模式的网页交互全走 SendMouseInput 合成事件，不依赖这些窗口的
// 原生命中，因此对内嵌 WebView 的正常使用零影响。
//
// 在 runner 入口（wWinMain）尽早调用；主窗口与简报/行程等子进程模式共用
// 同一入口，天然全覆盖。
void Start();

// 立即清扫一轮，返回本次被中和的窗口数。供调试或手动触发。
int SweepOnce();

}  // namespace webview_ghost_guardian

#endif  // RUNNER_WEBVIEW_GHOST_WINDOW_GUARDIAN_H_
