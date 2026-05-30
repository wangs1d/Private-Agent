#include "sphere_overlay_window.h"

#include <algorithm>
#include <cmath>

namespace {

constexpr UINT_PTR kAnimTimerId = 1;

}  // namespace

void SphereOverlayWindow::EnsureClassRegistered() {
  static bool registered = false;
  if (registered) return;

  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(WNDCLASSEXW);
  wc.style = CS_HREDRAW | CS_VREDRAW;
  wc.lpfnWndProc = SphereOverlayWindow::WndProc;
  wc.hInstance = GetModuleHandle(nullptr);
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.hbrBackground = nullptr;
  wc.lpszClassName = kClassName;

  RegisterClassExW(&wc);
  registered = true;
}

SphereOverlayWindow::SphereOverlayWindow() = default;

SphereOverlayWindow::~SphereOverlayWindow() {
  Destroy();
}

bool SphereOverlayWindow::Create(HWND parent, const std::string& overlay_url) {
  (void)parent;
  (void)overlay_url;

  // WebView2 must live in webview_windows only (one loader per process).
  // Desk pet uses Electron or Flutter embedded WebView (SphereOverlayLauncher).
  OutputDebugStringW(
      L"[SphereOverlay] In-process WebView2 disabled in runner (use Electron "
      L"or embedded WebView). See SphereOverlayLauncher.\n");
  return false;
}

void SphereOverlayWindow::Destroy() {
  if (anim_state_.timer_id && window_handle_) {
    KillTimer(window_handle_, anim_state_.timer_id);
    anim_state_.timer_id = 0;
  }

  webview_ready_ = false;

  if (window_handle_) {
    DestroyWindow(window_handle_);
    window_handle_ = nullptr;
  }
}

void SphereOverlayWindow::Show() {
  if (window_handle_) ShowWindow(window_handle_, SW_SHOW);
}

void SphereOverlayWindow::Hide() {
  if (window_handle_) ShowWindow(window_handle_, SW_HIDE);
}

bool SphereOverlayWindow::IsVisible() const {
  return window_handle_ && IsWindowVisible(window_handle_);
}

bool SphereOverlayWindow::IsCreated() const {
  return window_handle_ != nullptr;
}

bool SphereOverlayWindow::IsWebViewReady() const {
  return webview_ready_;
}

void SphereOverlayWindow::ApplyWebviewBounds() {}

void SphereOverlayWindow::SetBounds(int x, int y, int width, int height,
                                    int duration_ms) {
  if (!window_handle_ || !webview_ready_) return;

  overlay_width_ = std::max(80, width);
  overlay_height_ = std::max(80, height);

  if (duration_ms <= 16 || duration_ms > 5000) {
    SetWindowPos(window_handle_, nullptr, x, y, overlay_width_, overlay_height_,
                 SWP_NOZORDER | SWP_NOACTIVATE);
    return;
  }

  AnimateMove(x, y, duration_ms);
  SetWindowPos(window_handle_, nullptr, 0, 0, overlay_width_, overlay_height_,
               SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
}

RECT SphereOverlayWindow::GetBounds() const {
  RECT rc = {};
  if (window_handle_) {
    GetWindowRect(window_handle_, &rc);
  }
  return rc;
}

void SphereOverlayWindow::MoveTo(int x, int y, int duration_ms) {
  if (!window_handle_ || !webview_ready_) return;
  if (duration_ms <= 16 || duration_ms > 5000) {
    SetWindowPos(window_handle_, nullptr, x, y, 0, 0,
                 SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    return;
  }
  AnimateMove(x, y, duration_ms);
}

void SphereOverlayWindow::MoveBy(int dx, int dy) {
  if (!window_handle_ || !webview_ready_) return;
  RECT rc;
  GetWindowRect(window_handle_, &rc);
  MoveTo(rc.left + dx, rc.top + dy, 0);
}

void SphereOverlayWindow::SetIgnoreMouseEvents(bool ignore, bool forward) {
  ignore_mouse_ = ignore;
  mouse_forward_ = forward;
}

void SphereOverlayWindow::Roam() {
  if (!window_handle_ || !webview_ready_) return;

  HMONITOR monitor =
      MonitorFromWindow(parent_handle_ ? parent_handle_ : window_handle_,
                        MONITOR_DEFAULTTONEAREST);
  MONITORINFO mi = {sizeof(mi)};
  GetMonitorInfoW(monitor, &mi);

  const int margin = 12;
  const int work_w = static_cast<int>(mi.rcWork.right - mi.rcWork.left);
  const int work_h = static_cast<int>(mi.rcWork.bottom - mi.rcWork.top);
  const int max_w = (std::max)(40, work_w - overlay_width_ - margin * 2);
  const int max_h = (std::max)(40, work_h - overlay_height_ - margin * 2);

  const int x = mi.rcWork.left + margin + (rand() % max_w);
  const int y = mi.rcWork.top + margin + (rand() % max_h);

  MoveTo(x, y, 0);
}

RECT SphereOverlayWindow::GetWorkArea() const {
  MONITORINFO mi = {sizeof(mi)};
  HMONITOR monitor =
      MonitorFromWindow(parent_handle_ ? parent_handle_ : window_handle_,
                        MONITOR_DEFAULTTONEAREST);
  GetMonitorInfoW(monitor, &mi);
  return mi.rcWork;
}

void SphereOverlayWindow::PatchMood(const std::string& json_patch) {
  (void)json_patch;
}

void SphereOverlayWindow::SetPatchMoodCallback(PatchMoodCallback cb) {
  patch_callback_ = std::move(cb);
}

LRESULT CALLBACK SphereOverlayWindow::WndProc(HWND hwnd, UINT message,
                                              WPARAM wparam,
                                              LPARAM lparam) noexcept {
  if (message == WM_NCCREATE) {
    auto* cs = reinterpret_cast<CREATESTRUCT*>(lparam);
    SetWindowLongPtr(hwnd, GWLP_USERDATA,
                     reinterpret_cast<LONG_PTR>(cs->lpCreateParams));
  } else {
    auto* that = reinterpret_cast<SphereOverlayWindow*>(
        GetWindowLongPtr(hwnd, GWLP_USERDATA));
    if (that) return that->HandleMessage(hwnd, message, wparam, lparam);
  }
  return DefWindowProc(hwnd, message, wparam, lparam);
}

LRESULT SphereOverlayWindow::HandleMessage(HWND hwnd, UINT message,
                                           WPARAM wparam,
                                           LPARAM lparam) noexcept {
  switch (message) {
    case WM_NCHITTEST:
      if (ignore_mouse_) {
        return mouse_forward_ ? HTTRANSPARENT : HTNOWHERE;
      }
      return HTCLIENT;

    case WM_TIMER:
      if (wparam == anim_state_.timer_id && anim_state_.timer_id) {
        const DWORD now = GetTickCount();
        const double t = std::min(1.0, static_cast<double>(
            now - anim_state_.start_time) / anim_state_.duration_ms);
        const double ease = t < 0.5
                                ? 2 * t * t
                                : 1 - pow(-2 * t + 2, 2) / 2.0;
        const int cx = static_cast<int>(
            anim_state_.start_x +
            (anim_state_.target_x - anim_state_.start_x) * ease);
        const int cy = static_cast<int>(
            anim_state_.start_y +
            (anim_state_.target_y - anim_state_.start_y) * ease);

        SetWindowPos(hwnd, nullptr, cx, cy, 0, 0,
                     SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);

        if (t >= 1.0) {
          KillTimer(hwnd, anim_state_.timer_id);
          anim_state_.timer_id = 0;
        }
        return 0;
      }
      break;

    case WM_DESTROY:
      window_handle_ = nullptr;
      break;
  }

  return DefWindowProc(hwnd, message, wparam, lparam);
}

void SphereOverlayWindow::AnimateMove(int target_x, int target_y,
                                      int duration_ms) {
  if (!window_handle_) return;

  RECT rc;
  GetWindowRect(window_handle_, &rc);

  anim_state_.start_x = rc.left;
  anim_state_.start_y = rc.top;
  anim_state_.target_x = target_x;
  anim_state_.target_y = target_y;
  anim_state_.start_time = GetTickCount();
  anim_state_.duration_ms = duration_ms;

  if (anim_state_.timer_id) {
    KillTimer(window_handle_, anim_state_.timer_id);
  }

  anim_state_.timer_id = kAnimTimerId;
  SetTimer(window_handle_, kAnimTimerId, 16, nullptr);
}

void SphereOverlayWindow::OnWebviewReady() {}

void SphereOverlayWindow::OnWebMessage(const std::wstring& json_msg) {
  (void)json_msg;
}
