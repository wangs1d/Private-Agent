#include "connected_call_window.h"

#include <windowsx.h>

#include <algorithm>
#include <cmath>
#include <cwctype>

#ifndef CLR_NONE
#define CLR_NONE static_cast<COLORREF>(0xFFFFFFFFL)
#endif

#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "user32.lib")

namespace {

COLORREF ParseArgb(uint32_t argb) {
  return RGB((argb >> 16) & 0xFF, (argb >> 8) & 0xFF, argb & 0xFF);
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

std::wstring FormatDuration(int seconds) {
  if (seconds < 0) seconds = 0;
  int mm = seconds / 60;
  int ss = seconds % 60;
  wchar_t buf[16];
  swprintf_s(buf, L"%02d:%02d", mm, ss);
  return std::wstring(buf);
}

}  // namespace

void ConnectedCallWindow::EnsureClassRegistered() {
  static bool registered = false;
  if (registered) return;
  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(WNDCLASSEXW);
  wc.style = CS_HREDRAW | CS_VREDRAW | CS_DBLCLKS;
  wc.lpfnWndProc = ConnectedCallWindow::WndProc;
  wc.hInstance = GetModuleHandle(nullptr);
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.hbrBackground = nullptr;
  wc.lpszClassName = kClassName;
  RegisterClassExW(&wc);
  registered = true;
}

ConnectedCallWindow::ConnectedCallWindow() = default;

ConnectedCallWindow::~ConnectedCallWindow() { DestroyNativeWindow(); }

void ConnectedCallWindow::SetCallbacks(
    HangUpCallback on_hangup, MuteCallback on_mute_toggle,
    SpeakerCallback on_speaker_toggle) {
  on_hangup_ = std::move(on_hangup);
  on_mute_toggle_ = std::move(on_mute_toggle);
  on_speaker_toggle_ = std::move(on_speaker_toggle);
}

bool ConnectedCallWindow::CreateWindowIfNeeded() {
  if (window_handle_) return true;
  EnsureClassRegistered();

  DWORD ex_style = WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
  DWORD style = WS_POPUP | WS_CLIPCHILDREN;

  HWND hwnd = CreateWindowExW(
      ex_style, kClassName, L"", style, 0, 0, kWindowWidth, kWindowHeight,
      nullptr, nullptr, GetModuleHandle(nullptr), this);
  if (!hwnd) {
    OutputDebugStringW(L"ConnectedCallWindow: CreateWindowExW failed");
    return false;
  }
  window_handle_ = hwnd;


  mute_btn_ = CreateWindowExW(
      0, L"BUTTON", L"\u9759\u97F3",
      WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON | BS_FLAT, 0, 0, 0, 0, hwnd,
      reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdMute)),
      GetModuleHandle(nullptr), nullptr);
  speaker_btn_ = CreateWindowExW(
      0, L"BUTTON", L"\u514D\u63D0",
      WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON | BS_FLAT, 0, 0, 0, 0, hwnd,
      reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdSpeaker)),
      GetModuleHandle(nullptr), nullptr);
  hangup_btn_ = CreateWindowExW(
      0, L"BUTTON", L"\u6302\u65AD",
      WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON | BS_FLAT, 0, 0, 0, 0, hwnd,
      reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdHangup)),
      GetModuleHandle(nullptr), nullptr);

  HFONT ui_font = reinterpret_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT));
  SendMessage(mute_btn_, WM_SETFONT, reinterpret_cast<WPARAM>(ui_font), TRUE);
  SendMessage(speaker_btn_, WM_SETFONT, reinterpret_cast<WPARAM>(ui_font), TRUE);
  SendMessage(hangup_btn_, WM_SETFONT, reinterpret_cast<WPARAM>(ui_font), TRUE);

  mute_brush_ = CreateSolidBrush(RGB(229, 231, 235));
  speaker_brush_ = CreateSolidBrush(RGB(229, 231, 235));
  hangup_brush_ = CreateSolidBrush(RGB(239, 68, 68));
  action_border_brush_ = CreateSolidBrush(RGB(223, 228, 234));
  return true;
}

void ConnectedCallWindow::RepositionChildren() {
  if (!window_handle_) return;
  const int btn_w = 88;
  const int btn_h = 34;
  const int gap = 10;
  const int bottom_pad = 20;
  int total_w = btn_w * 3 + gap * 2;
  int start_x = (kWindowWidth - total_w) / 2;
  int btn_y = kWindowHeight - btn_h - bottom_pad;
  if (mute_btn_) {
    SetWindowPos(mute_btn_, nullptr, start_x, btn_y, btn_w, btn_h,
                 SWP_NOZORDER | SWP_NOACTIVATE);
  }
  if (speaker_btn_) {
    SetWindowPos(speaker_btn_, nullptr, start_x + btn_w + gap, btn_y, btn_w,
                 btn_h, SWP_NOZORDER | SWP_NOACTIVATE);
  }
  if (hangup_btn_) {
    SetWindowPos(hangup_btn_, nullptr, start_x + (btn_w + gap) * 2, btn_y,
                 btn_w, btn_h, SWP_NOZORDER | SWP_NOACTIVATE);
  }
}

void ConnectedCallWindow::PositionAtBottomRight() {
  if (!window_handle_) return;
  HMONITOR mon = MonitorFromWindow(window_handle_, MONITOR_DEFAULTTONEAREST);
  MONITORINFO mi = {sizeof(mi)};
  GetMonitorInfoW(mon, &mi);
  const int work_w = mi.rcWork.right - mi.rcWork.left;
  const int work_h = mi.rcWork.bottom - mi.rcWork.top;
  const int x = mi.rcWork.left + (work_w - kWindowWidth - kMargin);
  const int y = mi.rcWork.top + (work_h - kWindowHeight - kMargin);
  SetWindowPos(window_handle_, HWND_TOPMOST, x, y, kWindowWidth, kWindowHeight,
               SWP_NOACTIVATE | SWP_SHOWWINDOW);
  RepositionChildren();
}

void ConnectedCallWindow::Show(const std::string& caller_name,
                               const std::string& caller_initial,
                               uint32_t accent_color_hex) {
  caller_name_ = Utf8ToWide(caller_name);
  caller_initial_ = Utf8ToWide(caller_initial);
  accent_color_ = accent_color_hex ? accent_color_hex : 0xFF22C55E;

  if (!CreateWindowIfNeeded()) return;
  PositionAtBottomRight();
  StartTimer();
  if (talking_) StartPulse();
  InvalidateRect(window_handle_, nullptr, TRUE);
}

void ConnectedCallWindow::Hide() {
  StopTimer();
  StopPulse();
  if (window_handle_) {
    ShowWindow(window_handle_, SW_HIDE);
  }
}

void ConnectedCallWindow::DestroyNativeWindow() {
  StopTimer();
  StopPulse();
  if (mute_btn_) {
    if (IsWindow(mute_btn_)) {
      DestroyWindow(mute_btn_);
    }
    mute_btn_ = nullptr;
  }
  if (speaker_btn_) {
    if (IsWindow(speaker_btn_)) {
      DestroyWindow(speaker_btn_);
    }
    speaker_btn_ = nullptr;
  }
  if (hangup_btn_) {
    if (IsWindow(hangup_btn_)) {
      DestroyWindow(hangup_btn_);
    }
    hangup_btn_ = nullptr;
  }
  if (mute_brush_) { DeleteObject(mute_brush_); mute_brush_ = nullptr; }
  if (speaker_brush_) { DeleteObject(speaker_brush_); speaker_brush_ = nullptr; }
  if (hangup_brush_) { DeleteObject(hangup_brush_); hangup_brush_ = nullptr; }
  if (action_border_brush_) {
    DeleteObject(action_border_brush_);
    action_border_brush_ = nullptr;
  }
  if (window_handle_) {
    if (IsWindow(window_handle_)) {
      DestroyWindow(window_handle_);
    }
    window_handle_ = nullptr;
  }
}

bool ConnectedCallWindow::IsVisible() const {
  return window_handle_ && IsWindowVisible(window_handle_);
}

void ConnectedCallWindow::SetMute(bool muted) {
  if (muted_ == muted) return;
  muted_ = muted;
  if (window_handle_) InvalidateRect(window_handle_, nullptr, TRUE);
}

void ConnectedCallWindow::SetSpeaker(bool on) {
  if (speaker_on_ == on) return;
  speaker_on_ = on;
  if (window_handle_) InvalidateRect(window_handle_, nullptr, TRUE);
}

void ConnectedCallWindow::SetTalking(bool talking) {
  if (talking_ == talking) return;
  talking_ = talking;
  if (talking_) StartPulse();
  else StopPulse();
  if (window_handle_) InvalidateRect(window_handle_, nullptr, TRUE);
}

void ConnectedCallWindow::ResetDuration() {
  elapsed_seconds_ = 0;
  if (window_handle_) InvalidateRect(window_handle_, nullptr, FALSE);
}

void ConnectedCallWindow::SetElapsedSeconds(int seconds) {
  elapsed_seconds_ = seconds > 0 ? seconds : 0;
  if (window_handle_) InvalidateRect(window_handle_, nullptr, FALSE);
}

void ConnectedCallWindow::StartTimer() {
  if (!window_handle_) return;
  SetTimer(window_handle_, kTickTimerId, 1000, nullptr);
}

void ConnectedCallWindow::StopTimer() {
  if (window_handle_) KillTimer(window_handle_, kTickTimerId);
}

void ConnectedCallWindow::StartPulse() {
  if (!window_handle_) return;
  pulse_phase_ = 0;
  SetTimer(window_handle_, kPulseTimerId, 50, nullptr);
}

void ConnectedCallWindow::StopPulse() {
  if (window_handle_) KillTimer(window_handle_, kPulseTimerId);
}

void CALLBACK ConnectedCallWindow::TickProc(HWND, UINT, UINT_PTR,
                                            DWORD) noexcept {
  // WM_TIMER handler
}

// Drawing

void ConnectedCallWindow::DrawRoundedRect(HDC hdc, const RECT& rc, int radius,
                                          COLORREF fill, COLORREF border) {
  HBRUSH brush = CreateSolidBrush(fill);
  HPEN pen = CreatePen(PS_NULL, 0, 0);
  HBRUSH old_brush = static_cast<HBRUSH>(SelectObject(hdc, brush));
  HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, pen));
  RoundRect(hdc, rc.left, rc.top, rc.right, rc.bottom, radius, radius);
  if (border != CLR_NONE) {
    HPEN border_pen = CreatePen(PS_SOLID, 1, border);
    HPEN old_pen2 = static_cast<HPEN>(SelectObject(hdc, border_pen));
    HBRUSH null_brush = static_cast<HBRUSH>(GetStockObject(NULL_BRUSH));
    HBRUSH old_brush2 = static_cast<HBRUSH>(SelectObject(hdc, null_brush));
    RoundRect(hdc, rc.left, rc.top, rc.right, rc.bottom, radius, radius);
    SelectObject(hdc, old_brush2);
    SelectObject(hdc, old_pen2);
    DeleteObject(border_pen);
    // null_brush is a stock object.
  }
  SelectObject(hdc, old_brush);
  SelectObject(hdc, old_pen);
  DeleteObject(brush);
  DeleteObject(pen);
}

void ConnectedCallWindow::DrawAvatar(HDC hdc, const RECT& rc,
                                     const std::wstring& initial,
                                     COLORREF bg) {
  int cx = (rc.left + rc.right) / 2;
  int cy = (rc.top + rc.bottom) / 2;
  int base_r = (std::min)(rc.right - rc.left, rc.bottom - rc.top) / 2;

  if (talking_) {
    double t = pulse_phase_ / 30.0;
    int glow_r = base_r + static_cast<int>(12 * std::sin(t * 6.28318));
    HBRUSH glow_brush = CreateSolidBrush(
        RGB((GetRValue(bg) + 255) / 2, (GetGValue(bg) + 255) / 2,
            (GetBValue(bg) + 255) / 2));
    HPEN null_pen = static_cast<HPEN>(GetStockObject(NULL_PEN));
    HBRUSH old_brush = static_cast<HBRUSH>(SelectObject(hdc, glow_brush));
    HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, null_pen));
    Ellipse(hdc, cx - glow_r, cy - glow_r, cx + glow_r, cy + glow_r);
    SelectObject(hdc, old_pen);
    SelectObject(hdc, old_brush);
    DeleteObject(glow_brush);
  }

  DrawRoundedRect(hdc,
                  RECT{cx - base_r + 4, cy - base_r + 4, cx + base_r - 4,
                       cy + base_r - 4},
                  base_r - 4, bg, CLR_NONE);

  if (!initial.empty()) {
    std::wstring s(1, static_cast<wchar_t>(std::towupper(initial[0])));
    HFONT f = CreateFontW(base_r - 8, 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE,
                          DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                          CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                          DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
    HFONT old = static_cast<HFONT>(SelectObject(hdc, f));
    SetBkMode(hdc, TRANSPARENT);
    SetTextColor(hdc, RGB(255, 255, 255));
    RECT tr = {cx - base_r, cy - base_r, cx + base_r, cy + base_r};
    DrawTextW(hdc, s.c_str(), 1, &tr, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    SelectObject(hdc, old);
    DeleteObject(f);
  }
}

void ConnectedCallWindow::Paint(HWND hwnd, HDC hdc) {
  RECT rc;
  GetClientRect(hwnd, &rc);

  HDC mem = CreateCompatibleDC(hdc);
  HBITMAP bmp = CreateCompatibleBitmap(hdc, rc.right, rc.bottom);
  HBITMAP old_bmp = static_cast<HBITMAP>(SelectObject(mem, bmp));

  RECT top_half = {0, 0, rc.right, rc.bottom};
  HBRUSH top_brush = CreateSolidBrush(RGB(249, 250, 252));
  HBRUSH bot_brush = CreateSolidBrush(RGB(249, 250, 252));
  FillRect(mem, &top_half, top_brush);
  DeleteObject(top_brush);
  DeleteObject(bot_brush);

  RECT top_bar = {0, 0, rc.right, 4};
  HBRUSH top_bar_brush = CreateSolidBrush(ParseArgb(accent_color_));
  FillRect(mem, &top_bar, top_bar_brush);
  DeleteObject(top_bar_brush);

  HPEN border = CreatePen(PS_SOLID, 1, RGB(223, 228, 234));
  HBRUSH fill = CreateSolidBrush(RGB(249, 250, 252));
  HPEN old_pen = static_cast<HPEN>(SelectObject(mem, border));
  HBRUSH old_brush = static_cast<HBRUSH>(SelectObject(mem, fill));
  RoundRect(mem, rc.left, rc.top, rc.right, rc.bottom, 18, 18);
  SelectObject(mem, old_brush);
  SelectObject(mem, old_pen);
  DeleteObject(border);
  DeleteObject(fill);

  RECT status_rc = {0, 24, rc.right, 56};
  std::wstring status_text = L"\u901A\u8BDD\u4E2D";
  if (muted_) status_text = L"\u5DF2\u9759\u97F3";
  if (muted_ && speaker_on_) status_text = L"\u5DF2\u9759\u97F3 \u00B7 \u514D\u63D0";
  if (!muted_ && !speaker_on_) status_text = L"\u901A\u8BDD\u4E2D \u00B7 \u624B\u673A\u6253\u63D0";
  HFONT status_font = CreateFontW(14, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                                  DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                                  CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                                  DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  HFONT old_font = static_cast<HFONT>(SelectObject(mem, status_font));
  SetBkMode(mem, TRANSPARENT);
  SetTextColor(mem, RGB(107, 114, 128));
  DrawTextW(mem, status_text.c_str(), -1, &status_rc,
            DT_CENTER | DT_SINGLELINE | DT_NOPREFIX);
  SelectObject(mem, old_font);
  DeleteObject(status_font);

  // Avatar
  const int avatar_size = 96;
  RECT avatar_rc = {(rc.right - avatar_size) / 2, 88,
                    (rc.right + avatar_size) / 2, 88 + avatar_size};
  DrawAvatar(mem, avatar_rc, caller_initial_, ParseArgb(accent_color_));

  // Name
  RECT name_rc = {0, 198, rc.right, 230};
  HFONT name_font = CreateFontW(18, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
                                DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                                CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                                DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  old_font = static_cast<HFONT>(SelectObject(mem, name_font));
  SetTextColor(mem, RGB(31, 35, 41));
  DrawTextW(mem, caller_name_.c_str(), -1, &name_rc,
            DT_CENTER | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
  SelectObject(mem, old_font);
  DeleteObject(name_font);

  // Timer
  RECT timer_rc = {0, 232, rc.right, 260};
  HFONT timer_font = CreateFontW(14, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                                 DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                                 CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                                 DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  old_font = static_cast<HFONT>(SelectObject(mem, timer_font));
  std::wstring duration = FormatDuration(elapsed_seconds_);
  SetTextColor(mem, RGB(107, 114, 128));
  DrawTextW(mem, duration.c_str(), -1, &timer_rc,
            DT_CENTER | DT_SINGLELINE | DT_NOPREFIX);
  SelectObject(mem, old_font);
  DeleteObject(timer_font);

  BitBlt(hdc, 0, 0, rc.right, rc.bottom, mem, 0, 0, SRCCOPY);
  SelectObject(mem, old_bmp);
  DeleteObject(bmp);
  DeleteDC(mem);
}

// Message handling

LRESULT CALLBACK ConnectedCallWindow::WndProc(HWND hwnd, UINT message,
                                              WPARAM wparam,
                                              LPARAM lparam) noexcept {
  if (message == WM_NCCREATE) {
    auto* cs = reinterpret_cast<CREATESTRUCT*>(lparam);
    SetWindowLongPtr(hwnd, GWLP_USERDATA,
                     reinterpret_cast<LONG_PTR>(cs->lpCreateParams));
  } else {
    auto* that = reinterpret_cast<ConnectedCallWindow*>(
        GetWindowLongPtr(hwnd, GWLP_USERDATA));
    if (that) return that->HandleMessage(hwnd, message, wparam, lparam);
  }
  return DefWindowProc(hwnd, message, wparam, lparam);
}

LRESULT ConnectedCallWindow::HandleMessage(HWND hwnd, UINT message,
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
      if (wparam == kTickTimerId) {
        elapsed_seconds_++;
        InvalidateRect(hwnd, nullptr, FALSE);
        return 0;
      }
      if (wparam == kPulseTimerId) {
        pulse_phase_ = (pulse_phase_ + 1) % 30;
        InvalidateRect(hwnd, nullptr, FALSE);
        return 0;
      }
      break;
    case WM_COMMAND: {
      int id = LOWORD(wparam);
      if (id == kIdMute) {
        muted_ = !muted_;
        InvalidateRect(hwnd, nullptr, FALSE);
        if (on_mute_toggle_) on_mute_toggle_(muted_);
        return 0;
      }
      if (id == kIdSpeaker) {
        speaker_on_ = !speaker_on_;
        InvalidateRect(hwnd, nullptr, FALSE);
        if (on_speaker_toggle_) on_speaker_toggle_(speaker_on_);
        return 0;
      }
      if (id == kIdHangup) {
        if (on_hangup_) on_hangup_();
        PostMessage(hwnd, kMsgDeferredHide, 0, 0);
        return 0;
      }
      break;
    }
    case WM_CTLCOLORBTN: {
      HDC btn_dc = reinterpret_cast<HDC>(wparam);
      HWND btn = reinterpret_cast<HWND>(lparam);
      SetBkMode(btn_dc, TRANSPARENT);
      SetTextColor(btn_dc, RGB(255, 255, 255));
      if (btn == mute_btn_ && mute_brush_) {
        return reinterpret_cast<INT_PTR>(
            muted_ ? hangup_brush_ : mute_brush_);
      }
      if (btn == speaker_btn_ && speaker_brush_) {
        return reinterpret_cast<INT_PTR>(
            speaker_on_ ? hangup_brush_ : speaker_brush_);
      }
      if (btn == hangup_btn_ && hangup_brush_) {
        return reinterpret_cast<INT_PTR>(hangup_brush_);
      }
      return DefWindowProc(hwnd, message, wparam, lparam);
    }
    case WM_NCHITTEST: {
      POINT pt = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
      ScreenToClient(hwnd, &pt);

      if (pt.y < 56 && pt.x < kWindowWidth && pt.y > 0) return HTCAPTION;
      return HTCLIENT;
    }
    case kMsgDeferredHide:
      Hide();
      return 0;
    case WM_DESTROY:
      StopTimer();
      StopPulse();
      SetWindowLongPtr(hwnd, GWLP_USERDATA, 0);
      window_handle_ = nullptr;
      return 0;
  }
  return DefWindowProc(hwnd, message, wparam, lparam);
}
