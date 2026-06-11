#include "incoming_call_window.h"

#include <mmsystem.h>   // PlaySound
#include <windowsx.h>   // GET_X_LPARAM / GET_Y_LPARAM
#include <stringapiset.h>

#include <algorithm>
#include <cmath>
#include <cwctype>

#ifndef CLR_NONE
#define CLR_NONE static_cast<COLORREF>(0xFFFFFFFFL)
#endif

#pragma comment(lib, "winmm.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "user32.lib")

namespace {

constexpr LPCWSTR kRingAliasIncoming = L"IncomingCall";

constexpr int kWindowWidth = 384;
constexpr int kWindowHeight = 176;
constexpr int kMargin = 16;  // Workspace margin

COLORREF ParseArgb(uint32_t argb) {
  // Convert 0xAARRGGBB to GDI 0x00BBGGRR
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

}  // namespace

void IncomingCallWindow::EnsureClassRegistered() {
  static bool registered = false;
  if (registered) return;

  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(WNDCLASSEXW);
  wc.style = CS_HREDRAW | CS_VREDRAW | CS_DBLCLKS;
  wc.lpfnWndProc = IncomingCallWindow::WndProc;
  wc.hInstance = GetModuleHandle(nullptr);
  wc.hCursor = LoadCursor(nullptr, IDC_HAND);
  wc.hbrBackground = nullptr;
  wc.lpszClassName = kClassName;
  RegisterClassExW(&wc);
  registered = true;
}

IncomingCallWindow::IncomingCallWindow() = default;

IncomingCallWindow::~IncomingCallWindow() { DestroyNativeWindow(); }

void IncomingCallWindow::SetCallbacks(AcceptCallback on_accept,
                                      DeclineCallback on_decline,
                                      TimeoutCallback on_timeout) {
  on_accept_ = std::move(on_accept);
  on_decline_ = std::move(on_decline);
  on_timeout_ = std::move(on_timeout);
}

bool IncomingCallWindow::CreateWindowIfNeeded() {
  if (window_handle_) return true;

  EnsureClassRegistered();



  DWORD ex_style = WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
  DWORD style = WS_POPUP | WS_CLIPCHILDREN;

  HWND hwnd = CreateWindowExW(
      ex_style, kClassName, L"", style, 0, 0, kWindowWidth, kWindowHeight,
      nullptr, nullptr, GetModuleHandle(nullptr), this);
  if (!hwnd) {
    OutputDebugStringW(L"IncomingCallWindow: CreateWindowExW failed");
    return false;
  }

  window_handle_ = hwnd;



  accept_btn_ = CreateWindowExW(
      0, L"BUTTON", L"\u63A5\u542C",
      WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON | BS_FLAT, 0, 0, 0, 0, hwnd,
      reinterpret_cast<HMENU>(1), GetModuleHandle(nullptr), nullptr);
  decline_btn_ = CreateWindowExW(
      0, L"BUTTON", L"\u6302\u65AD",
      WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON | BS_FLAT, 0, 0, 0, 0, hwnd,
      reinterpret_cast<HMENU>(2), GetModuleHandle(nullptr), nullptr);


  HFONT ui_font = reinterpret_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT));
  SendMessage(accept_btn_, WM_SETFONT, reinterpret_cast<WPARAM>(ui_font),
              TRUE);
  SendMessage(decline_btn_, WM_SETFONT, reinterpret_cast<WPARAM>(ui_font),
              TRUE);

  accept_brush_ = CreateSolidBrush(RGB(34, 197, 94));
  decline_brush_ = CreateSolidBrush(RGB(239, 68, 68));
  return true;
}

void IncomingCallWindow::PositionAtBottomRight() {
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


  const int btn_w = 104;
  const int btn_h = 34;
  const int bottom_pad = 18;
  const int gap = 10;
  int btn_y = kWindowHeight - btn_h - bottom_pad;
  SetWindowPos(accept_btn_, nullptr, 18, btn_y, btn_w, btn_h,
               SWP_NOZORDER | SWP_NOACTIVATE);
  SetWindowPos(decline_btn_, nullptr, 18 + btn_w + gap, btn_y, btn_w, btn_h,
               SWP_NOZORDER | SWP_NOACTIVATE);


  StartAcceptButtonGlow();
}

void IncomingCallWindow::Show(const std::string& caller_name,
                              const std::string& subtitle,
                              const std::string& caller_initial,
                              int ring_timeout_ms,
                              uint32_t accent_color_hex) {
  caller_name_ = Utf8ToWide(caller_name);
  subtitle_ = Utf8ToWide(subtitle);
  caller_initial_ = Utf8ToWide(caller_initial);
  accent_color_ = accent_color_hex ? accent_color_hex : 0xFF22C55E;
  ring_timeout_ms_ = ring_timeout_ms > 0 ? ring_timeout_ms : 30000;

  if (!CreateWindowIfNeeded()) return;
  PositionAtBottomRight();


  StartRingtone();
  StartPulseTimer();
  StartTimeoutTimer();
  ringing_ = true;

  InvalidateRect(window_handle_, nullptr, TRUE);
}

void IncomingCallWindow::Hide() {
  StopRingtone();
  StopTimeoutTimer();
  StopPulseTimer();
  StopAcceptButtonGlow();
  ringing_ = false;
  if (window_handle_) {
    ShowWindow(window_handle_, SW_HIDE);
  }
}

void IncomingCallWindow::DestroyNativeWindow() {
  StopRingtone();
  StopTimeoutTimer();
  StopPulseTimer();
  StopAcceptButtonGlow();
  ringing_ = false;

  if (accept_btn_) {
    if (IsWindow(accept_btn_)) {
      DestroyWindow(accept_btn_);
    }
    accept_btn_ = nullptr;
  }
  if (decline_btn_) {
    if (IsWindow(decline_btn_)) {
      DestroyWindow(decline_btn_);
    }
    decline_btn_ = nullptr;
  }
  if (accept_brush_) {
    DeleteObject(accept_brush_);
    accept_brush_ = nullptr;
  }
  if (decline_brush_) {
    DeleteObject(decline_brush_);
    decline_brush_ = nullptr;
  }
  if (window_handle_) {
    if (IsWindow(window_handle_)) {
      DestroyWindow(window_handle_);
    }
    window_handle_ = nullptr;
  }
}

bool IncomingCallWindow::IsVisible() const {
  return window_handle_ && IsWindowVisible(window_handle_);
}

void IncomingCallWindow::StartRingtone() {
  // Play system alias.
  PlaySoundW(kRingAliasIncoming, nullptr,
             SND_ALIAS_ID | SND_ASYNC | SND_LOOP | SND_NODEFAULT);
}

void IncomingCallWindow::StopRingtone() {
  PlaySoundW(nullptr, nullptr, 0);
}

void IncomingCallWindow::StartTimeoutTimer() {
  if (!window_handle_ || ring_timeout_ms_ <= 0) return;
  SetTimer(window_handle_, kTimeoutTimerId,
           static_cast<UINT>(ring_timeout_ms_), nullptr);
}

void IncomingCallWindow::StopTimeoutTimer() {
  if (window_handle_) KillTimer(window_handle_, kTimeoutTimerId);
}

void IncomingCallWindow::StartPulseTimer() {
  if (!window_handle_) return;
  pulse_phase_ = 0;
  SetTimer(window_handle_, kPulseTimerId, 50, nullptr);
}

void IncomingCallWindow::StopPulseTimer() {
  if (window_handle_) KillTimer(window_handle_, kPulseTimerId);
}

void IncomingCallWindow::StartAcceptButtonGlow() {
  accept_glow_ = true;
  // Visual pulse is driven from WM_PAINT.
}

void IncomingCallWindow::StopAcceptButtonGlow() { accept_glow_ = false; }

// Drawing

void IncomingCallWindow::DrawRoundedRect(HDC hdc, const RECT& rc, int radius,
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

void IncomingCallWindow::DrawAvatar(HDC hdc, const RECT& rc,
                                    const std::wstring& initial,
                                    COLORREF bg) {
  int cx = (rc.left + rc.right) / 2;
  int cy = (rc.top + rc.bottom) / 2;
  int base_r = (std::min)(rc.right - rc.left, rc.bottom - rc.top) / 2;

  if (pulse_phase_ > 0) {
    double t = pulse_phase_ / 30.0;
    int glow_r = base_r + static_cast<int>(8 * std::sin(t * 6.28318));
    HBRUSH glow_brush = CreateSolidBrush(RGB((GetRValue(bg) + 255) / 2,
                                             (GetGValue(bg) + 255) / 2,
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
                  RECT{cx - base_r + 2, cy - base_r + 2, cx + base_r - 2,
                       cy + base_r - 2},
                  base_r - 2, bg, CLR_NONE);

  if (!initial.empty()) {
    std::wstring s(1, static_cast<wchar_t>(std::towupper(initial[0])));
    HFONT f = CreateFontW(base_r, 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE,
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

void IncomingCallWindow::Paint(HWND hwnd, HDC hdc) {
  RECT rc;
  GetClientRect(hwnd, &rc);

  HDC mem = CreateCompatibleDC(hdc);
  HBITMAP bmp = CreateCompatibleBitmap(hdc, rc.right, rc.bottom);
  HBITMAP old_bmp = static_cast<HBITMAP>(SelectObject(mem, bmp));

  HBRUSH bg_brush = CreateSolidBrush(RGB(249, 250, 252));
  FillRect(mem, &rc, bg_brush);
  DeleteObject(bg_brush);

  RECT card = rc;
  DrawRoundedRect(mem, card, 18, RGB(249, 250, 252), RGB(223, 228, 234));

  RECT avatar_rc = {18, 22, 72, 76};
  DrawAvatar(mem, avatar_rc, caller_initial_, ParseArgb(accent_color_));

  SetBkMode(mem, TRANSPARENT);
  HFONT old_font = nullptr;

  HFONT title_font = CreateFontW(18, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
                                 DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                                 CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                                 DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  old_font = static_cast<HFONT>(SelectObject(mem, title_font));
  SetTextColor(mem, RGB(31, 35, 41));
  RECT title_rc = {88, 24, kWindowWidth - 18, 54};
  DrawTextW(mem, caller_name_.c_str(), -1, &title_rc,
            DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
  SelectObject(mem, old_font);
  DeleteObject(title_font);

  HFONT sub_font = CreateFontW(13, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                               DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                               CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                               DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  old_font = static_cast<HFONT>(SelectObject(mem, sub_font));
  SetTextColor(mem, RGB(94, 104, 117));
  RECT sub_rc = {88, 50, kWindowWidth - 18, 72};
  DrawTextW(mem, subtitle_.c_str(), -1, &sub_rc,
            DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
  SelectObject(mem, old_font);
  DeleteObject(sub_font);

  if (accept_glow_) {
    RECT glow_rc;
    GetClientRect(accept_btn_, &glow_rc);
    MapWindowPoints(accept_btn_, hwnd, reinterpret_cast<POINT*>(&glow_rc), 2);
    InflateRect(&glow_rc, 2, 2);
    double phase = (pulse_phase_ % 30) / 30.0;
    int g_channel = static_cast<int>(140 + 70 * std::sin(phase * 6.28318));
    if (g_channel < 100) g_channel = 100;
    if (g_channel > 220) g_channel = 220;
    HPEN pen = CreatePen(PS_SOLID, 2, RGB(34, g_channel, 94));
    HPEN old_pen = static_cast<HPEN>(SelectObject(mem, pen));
    HBRUSH null_brush = static_cast<HBRUSH>(GetStockObject(NULL_BRUSH));
    HBRUSH old_brush = static_cast<HBRUSH>(SelectObject(mem, null_brush));
    RoundRect(mem, glow_rc.left, glow_rc.top, glow_rc.right, glow_rc.bottom,
              10, 10);
    SelectObject(mem, old_brush);
    SelectObject(mem, old_pen);
    DeleteObject(pen);
  }

  BitBlt(hdc, 0, 0, rc.right, rc.bottom, mem, 0, 0, SRCCOPY);
  SelectObject(mem, old_bmp);
  DeleteObject(bmp);
  DeleteDC(mem);
}

// Message handling

LRESULT CALLBACK IncomingCallWindow::WndProc(HWND hwnd, UINT message,
                                             WPARAM wparam,
                                             LPARAM lparam) noexcept {
  if (message == WM_NCCREATE) {
    auto* cs = reinterpret_cast<CREATESTRUCT*>(lparam);
    SetWindowLongPtr(hwnd, GWLP_USERDATA,
                     reinterpret_cast<LONG_PTR>(cs->lpCreateParams));
  } else {
    auto* that = reinterpret_cast<IncomingCallWindow*>(
        GetWindowLongPtr(hwnd, GWLP_USERDATA));
    if (that) return that->HandleMessage(hwnd, message, wparam, lparam);
  }
  return DefWindowProc(hwnd, message, wparam, lparam);
}

LRESULT IncomingCallWindow::HandleMessage(HWND hwnd, UINT message,
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
        pulse_phase_ = (pulse_phase_ + 1) % 30;
        InvalidateRect(hwnd, nullptr, FALSE);
        return 0;
      }
      if (wparam == kTimeoutTimerId) {
        StopTimeoutTimer();
        StopRingtone();
        if (on_timeout_) on_timeout_();
        PostMessage(hwnd, kMsgDeferredHide, 0, 0);
        return 0;
      }
      break;
    case WM_COMMAND: {
      int id = LOWORD(wparam);
      if (id == 1) {
        StopRingtone();
        if (on_accept_) on_accept_();
        PostMessage(hwnd, kMsgDeferredHide, 0, 0);
        return 0;
      }
      if (id == 2) {
        StopRingtone();
        if (on_decline_) on_decline_();
        PostMessage(hwnd, kMsgDeferredHide, 0, 0);
        return 0;
      }
      break;
    }
    case WM_CTLCOLORBTN: {
      HDC btn_dc = reinterpret_cast<HDC>(wparam);
      HWND btn = reinterpret_cast<HWND>(lparam);
      SetBkMode(btn_dc, TRANSPARENT);
      if (btn == accept_btn_ && accept_brush_) {
        SetTextColor(btn_dc, RGB(255, 255, 255));
        return reinterpret_cast<INT_PTR>(accept_brush_);
      }
      if (btn == decline_btn_ && decline_brush_) {
        SetTextColor(btn_dc, RGB(255, 255, 255));
        return reinterpret_cast<INT_PTR>(decline_brush_);
      }
      return DefWindowProc(hwnd, message, wparam, lparam);
    }
    case WM_NCHITTEST: {
      POINT pt = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
      ScreenToClient(hwnd, &pt);
      if (pt.y < 50 && pt.x < 280) return HTCAPTION;
      return HTCLIENT;
    }
    case WM_LBUTTONDBLCLK:

      if (on_accept_) on_accept_();
      PostMessage(hwnd, kMsgDeferredHide, 0, 0);
      return 0;
    case kMsgDeferredHide:
      Hide();
      return 0;
    case WM_DESTROY:
      StopRingtone();
      StopTimeoutTimer();
      StopPulseTimer();
      SetWindowLongPtr(hwnd, GWLP_USERDATA, 0);
      window_handle_ = nullptr;
      return 0;
  }
  return DefWindowProc(hwnd, message, wparam, lparam);
}
