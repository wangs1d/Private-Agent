#include "outgoing_call_window.h"

#include <dwmapi.h>
#include <windowsx.h>

#include <algorithm>
#include <cmath>
#include <cwctype>

#include "call_visuals.h"

#ifndef DWMNCR_ENABLED
#define DWMNCR_ENABLED 1
#endif

#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "dwmapi.lib")

namespace {

// ── 内部布局（无头像/名称/标题文字的紧凑版：副标题贴顶） ──
constexpr int kSubTop = 52;                  // 副标题 top
constexpr int kDividerY = 92;                // 分隔线 y
constexpr int kPillLeft = 96;                // 挂断胶囊 left
constexpr int kPillTop = 116;                // 挂断胶囊 top
constexpr int kPillW = 108;
constexpr int kPillH = 38;

RECT PillRect() {
  return {kPillLeft, kPillTop, kPillLeft + kPillW, kPillTop + kPillH};
}

std::wstring Utf8ToWide(const std::string& s) {
  if (s.empty()) return L"";
  int len = MultiByteToWideChar(CP_UTF8, 0, s.c_str(),
                                 static_cast<int>(s.size()), nullptr, 0);
  std::wstring out(len, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()),
                      out.data(), len);
  return out;
}

}  // namespace

OutgoingCallWindow::OutgoingCallWindow() = default;

OutgoingCallWindow::~OutgoingCallWindow() { DestroyNativeWindow(); }

void OutgoingCallWindow::SetCallbacks(HangUpCallback on_hangup) {
  on_hangup_ = std::move(on_hangup);
}

void OutgoingCallWindow::EnsureClassRegistered() {
  static bool registered = false;
  if (registered) return;
  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(WNDCLASSEXW);
  wc.lpfnWndProc = OutgoingCallWindow::WndProc;
  wc.hInstance = GetModuleHandle(nullptr);
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.hbrBackground = nullptr;
  wc.lpszClassName = kClassName;
  RegisterClassExW(&wc);
  registered = true;
}

bool OutgoingCallWindow::CreateWindowIfNeeded() {
  if (window_handle_) return true;
  EnsureClassRegistered();
  call_vis::EnsureGdiplus();

  // 无子控件：整窗一层玻璃自绘表面，胶囊按钮靠命中测试。
  // WS_EX_LAYERED = 逐像素 alpha 半透明（见 call_visuals.h），首次
  // UpdateLayeredWindow 上屏前窗口不可见。
  HWND hwnd = CreateWindowExW(
      WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED,
      kClassName, L"", WS_POPUP, 0, 0, kWindowWidth, kWindowHeight, nullptr,
      nullptr, GetModuleHandle(nullptr), this);
  if (!hwnd) return false;
  window_handle_ = hwnd;

  call_vis::ApplyRoundedCorners(hwnd);
  return true;
}

void OutgoingCallWindow::PositionAtBottomRight() {
  if (!window_handle_) return;
  MONITORINFO mi = {sizeof(mi)};
  GetMonitorInfoW(MonitorFromWindow(window_handle_, MONITOR_DEFAULTTONEAREST),
                  &mi);
  const int x = mi.rcWork.right - kWindowWidth - kMargin;
  const int y = mi.rcWork.bottom - kWindowHeight - kMargin;

  SetWindowPos(window_handle_, HWND_TOPMOST, x, y, kWindowWidth, kWindowHeight,
               SWP_NOACTIVATE | SWP_SHOWWINDOW);
}

void OutgoingCallWindow::Show(const std::string& caller_name,
                              const std::string& subtitle,
                              const std::string& caller_initial,
                              uint32_t /*accent_color_hex*/) {
  caller_name_ = Utf8ToWide(caller_name);
  subtitle_ = Utf8ToWide(subtitle);
  caller_initial_ = Utf8ToWide(caller_initial);
  if (!CreateWindowIfNeeded()) return;
  PositionAtBottomRight();
  StartPulse();
  InvalidateRect(window_handle_, nullptr, FALSE);
}

void OutgoingCallWindow::Hide() {
  StopPulse();
  if (window_handle_) ShowWindow(window_handle_, SW_HIDE);
}

bool OutgoingCallWindow::IsVisible() const {
  return window_handle_ && IsWindowVisible(window_handle_);
}

void OutgoingCallWindow::StartPulse() {
  if (window_handle_) SetTimer(window_handle_, kPulseTimerId, 60, nullptr);
}

void OutgoingCallWindow::StopPulse() {
  if (window_handle_) KillTimer(window_handle_, kPulseTimerId);
}

void OutgoingCallWindow::DestroyNativeWindow() {
  StopPulse();
  if (window_handle_ && IsWindow(window_handle_)) DestroyWindow(window_handle_);
  window_handle_ = nullptr;
}

void OutgoingCallWindow::Paint(HWND hwnd, HDC hdc) {
  call_vis::GlassSurface& s =
      call_vis::SharedGlassSurface(kWindowWidth, kWindowHeight);

  // ── 半透明玻璃底（逐像素 alpha，拖到任何背景都是活的） ──
  call_vis::DrawGlassBase(s);

  // ── 标题栏仅保留最小化/关闭两钮（—=收起 ×=取消呼叫），不画信号条与标题文字 ──
  const call_vis::TitleRects tr = call_vis::TitleRectsFor(kWindowWidth);
  call_vis::DrawGlyph(s, tr.minimize, call_vis::kGlyphMinimize,
                      title_min_hover_ ? call_vis::kNameColor
                                       : call_vis::kSubColor,
                      10, L"Segoe MDL2 Assets");
  call_vis::DrawGlyph(s, tr.close, call_vis::kGlyphClose,
                      title_close_hover_ ? call_vis::kNameColor
                                         : call_vis::kSubColor,
                      10, L"Segoe MDL2 Assets");

  // ── 副标题（12px 中灰；呼叫中文案追加动画点） ──
  std::wstring sub = subtitle_;
  if (sub == L"正在呼叫" || sub == L"正在接通") {
    const int dots = 1 + (pulse_phase_ / 15) % 3;
    sub += L" ";
    sub.append(dots, L'\u00B7');
  }
  RECT sub_rc = {20, kSubTop, kWindowWidth - 20, kSubTop + 18};
  call_vis::DrawCenteredText(s, sub_rc, sub, call_vis::kSubColor, 12,
                             FW_NORMAL, L"Microsoft YaHei UI");

  // ── 分隔线 ──
  call_vis::DrawDivider(*s.gfx, kWindowWidth, kDividerY);

  // ── 挂断胶囊（自绘，无子控件） ──
  call_vis::DrawPillButton(s, PillRect(), pill_hover_);

  call_vis::PresentLayered(hwnd, s, hdc);
}

namespace {

bool UpdateHover(bool& state, const RECT& rc, const POINT& pt) {
  const bool hover = call_vis::PointInRect(rc, pt);
  if (hover != state) {
    state = hover;
    return true;
  }
  return false;
}

}  // namespace

LRESULT CALLBACK OutgoingCallWindow::WndProc(HWND hwnd, UINT message,
                                             WPARAM wparam,
                                             LPARAM lparam) noexcept {
  if (message == WM_NCCREATE) {
    auto* cs = reinterpret_cast<CREATESTRUCT*>(lparam);
    SetWindowLongPtr(hwnd, GWLP_USERDATA,
                     reinterpret_cast<LONG_PTR>(cs->lpCreateParams));
  } else {
    auto* that = reinterpret_cast<OutgoingCallWindow*>(
        GetWindowLongPtr(hwnd, GWLP_USERDATA));
    if (that) return that->HandleMessage(hwnd, message, wparam, lparam);
  }
  return DefWindowProc(hwnd, message, wparam, lparam);
}

LRESULT OutgoingCallWindow::HandleMessage(HWND hwnd, UINT message,
                                          WPARAM wparam,
                                          LPARAM lparam) noexcept {
  switch (message) {
    case WM_PAINT: {
      PAINTSTRUCT ps;
      HDC hdc = BeginPaint(hwnd, &ps);
      Paint(hwnd, hdc);
      EndPaint(hwnd, &ps);
      return 0;
    }
    case WM_ERASEBKGND:
      return 1;
    case WM_TIMER:
      if (wparam == kPulseTimerId) {
        pulse_phase_ = (pulse_phase_ + 1) % 60;
        InvalidateRect(hwnd, nullptr, FALSE);
        return 0;
      }
      break;
    case WM_MOUSEMOVE: {
      TRACKMOUSEEVENT tme = {};
      tme.cbSize = sizeof(tme);
      tme.dwFlags = TME_LEAVE;
      tme.hwndTrack = hwnd;
      TrackMouseEvent(&tme);

      POINT pt = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
      bool changed = false;
      const call_vis::TitleRects tr = call_vis::TitleRectsFor(kWindowWidth);
      changed |= UpdateHover(title_min_hover_, tr.minimize, pt);
      changed |= UpdateHover(title_close_hover_, tr.close, pt);
      changed |= UpdateHover(pill_hover_, PillRect(), pt);
      if (changed) InvalidateRect(hwnd, nullptr, FALSE);
      break;
    }
    case WM_MOUSELEAVE:
      if (title_min_hover_ || title_close_hover_ || pill_hover_) {
        title_min_hover_ = false;
        title_close_hover_ = false;
        pill_hover_ = false;
        InvalidateRect(hwnd, nullptr, FALSE);
      }
      break;
    case WM_LBUTTONUP: {
      POINT pt = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
      const call_vis::TitleRects tr = call_vis::TitleRectsFor(kWindowWidth);
      if (call_vis::PointInRect(tr.close, pt)) {
        // 关闭 = 取消呼叫
        if (on_hangup_) on_hangup_();
        Hide();
        return 0;
      }
      if (call_vis::PointInRect(tr.minimize, pt)) {
        ShowWindow(hwnd, SW_HIDE);
        return 0;
      }
      if (call_vis::PointInRect(PillRect(), pt)) {
        if (on_hangup_) on_hangup_();
        Hide();
        return 0;
      }
      break;
    }
    case WM_NCHITTEST: {
      POINT pt = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
      ScreenToClient(hwnd, &pt);
      // 标题栏钮与挂断胶囊可点击，其余整卡可拖动
      const call_vis::TitleRects tr = call_vis::TitleRectsFor(kWindowWidth);
      if (call_vis::PointInRect(tr.minimize, pt) ||
          call_vis::PointInRect(tr.close, pt) ||
          call_vis::PointInRect(PillRect(), pt)) {
        return HTCLIENT;
      }
      return HTCAPTION;
    }
    case WM_DESTROY:
      StopPulse();
      SetWindowLongPtr(hwnd, GWLP_USERDATA, 0);
      window_handle_ = nullptr;
      return 0;
  }
  return DefWindowProc(hwnd, message, wparam, lparam);
}
