#include "outgoing_call_window.h"

#include <windowsx.h>

#include <algorithm>
#include <cmath>
#include <cwctype>

namespace {

std::wstring Utf8ToWide(const std::string& s) {
  if (s.empty()) return L"";
  int len = MultiByteToWideChar(CP_UTF8, 0, s.c_str(),
                                static_cast<int>(s.size()), nullptr, 0);
  std::wstring out(len, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()),
                      out.data(), len);
  return out;
}

COLORREF ParseArgb(uint32_t argb) {
  return RGB((argb >> 16) & 0xFF, (argb >> 8) & 0xFF, argb & 0xFF);
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
  HWND hwnd = CreateWindowExW(
      WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, kClassName, L"",
      WS_POPUP | WS_CLIPCHILDREN, 0, 0, kWindowWidth, kWindowHeight, nullptr,
      nullptr, GetModuleHandle(nullptr), this);
  if (!hwnd) return false;
  window_handle_ = hwnd;

  hangup_btn_ = CreateWindowExW(
      0, L"BUTTON", L"\u6302\u65AD",
      WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON | BS_FLAT, 0, 0, 0, 0, hwnd,
      reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdHangup)),
      GetModuleHandle(nullptr), nullptr);
  HFONT font = reinterpret_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT));
  SendMessage(hangup_btn_, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
  hangup_brush_ = CreateSolidBrush(RGB(239, 68, 68));
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
   SetWindowPos(hangup_btn_, nullptr, (kWindowWidth - 112) / 2, kWindowHeight - 54,
                112, 34, SWP_NOZORDER | SWP_NOACTIVATE);
}

void OutgoingCallWindow::Show(const std::string& caller_name,
                              const std::string& subtitle,
                              const std::string& caller_initial,
                              uint32_t accent_color_hex) {
  caller_name_ = Utf8ToWide(caller_name);
  subtitle_ = Utf8ToWide(subtitle);
  caller_initial_ = Utf8ToWide(caller_initial);
  accent_color_ = accent_color_hex;
  if (!CreateWindowIfNeeded()) return;
  PositionAtBottomRight();
  StartPulse();
  InvalidateRect(window_handle_, nullptr, TRUE);
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
  if (hangup_btn_ && IsWindow(hangup_btn_)) DestroyWindow(hangup_btn_);
  hangup_btn_ = nullptr;
  if (hangup_brush_) DeleteObject(hangup_brush_);
  hangup_brush_ = nullptr;
  if (window_handle_ && IsWindow(window_handle_)) DestroyWindow(window_handle_);
  window_handle_ = nullptr;
}

void OutgoingCallWindow::Paint(HWND hwnd, HDC hdc) {
  RECT rc;
  GetClientRect(hwnd, &rc);
  HDC mem = CreateCompatibleDC(hdc);
  HBITMAP bmp = CreateCompatibleBitmap(hdc, rc.right, rc.bottom);
  HBITMAP old_bmp = static_cast<HBITMAP>(SelectObject(mem, bmp));

  HBRUSH bg = CreateSolidBrush(RGB(249, 250, 252));
  FillRect(mem, &rc, bg);
  DeleteObject(bg);

  HPEN border = CreatePen(PS_SOLID, 1, RGB(223, 228, 234));
  HBRUSH fill = CreateSolidBrush(RGB(249, 250, 252));
  HPEN old_pen = static_cast<HPEN>(SelectObject(mem, border));
  HBRUSH old_brush = static_cast<HBRUSH>(SelectObject(mem, fill));
  RoundRect(mem, rc.left, rc.top, rc.right, rc.bottom, 18, 18);
  SelectObject(mem, old_pen);
  SelectObject(mem, old_brush);
  DeleteObject(border);
  DeleteObject(fill);

  RECT top_bar = {0, 0, rc.right, 4};
  HBRUSH top_bar_brush = CreateSolidBrush(ParseArgb(accent_color_));
  FillRect(mem, &top_bar, top_bar_brush);
  DeleteObject(top_bar_brush);

  const int cx = kWindowWidth / 2;
  const int cy = 78;
  const int base_r = 40;
  const int glow_r = base_r + static_cast<int>(6 * std::sin(pulse_phase_ / 8.0));
  HBRUSH glow = CreateSolidBrush(RGB(217, 245, 208));
  HBRUSH old_glow = static_cast<HBRUSH>(SelectObject(mem, glow));
  HPEN null_pen = static_cast<HPEN>(GetStockObject(NULL_PEN));
  HPEN old_null = static_cast<HPEN>(SelectObject(mem, null_pen));
  Ellipse(mem, cx - glow_r, cy - glow_r, cx + glow_r, cy + glow_r);
  SelectObject(mem, old_null);
  SelectObject(mem, old_glow);
  DeleteObject(glow);

  HBRUSH avatar = CreateSolidBrush(ParseArgb(accent_color_));
  HBRUSH old_avatar = static_cast<HBRUSH>(SelectObject(mem, avatar));
  Ellipse(mem, cx - base_r, cy - base_r, cx + base_r, cy + base_r);
  SelectObject(mem, old_avatar);
  DeleteObject(avatar);

  HFONT initial_font = CreateFontW(30, 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE,
                                   DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                                   CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                                   DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  HFONT old_font = static_cast<HFONT>(SelectObject(mem, initial_font));
  SetBkMode(mem, TRANSPARENT);
  SetTextColor(mem, RGB(255, 255, 255));
  std::wstring initial =
      caller_initial_.empty() ? L"A" : std::wstring(1, std::towupper(caller_initial_[0]));
  RECT initial_rc = {cx - base_r, cy - base_r, cx + base_r, cy + base_r};
  DrawTextW(mem, initial.c_str(), -1, &initial_rc,
            DT_CENTER | DT_VCENTER | DT_SINGLELINE);
  SelectObject(mem, old_font);
  DeleteObject(initial_font);

  HFONT title_font = CreateFontW(18, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
                                 DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                                 CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                                 DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  old_font = static_cast<HFONT>(SelectObject(mem, title_font));
  SetTextColor(mem, RGB(31, 35, 41));
  RECT title_rc = {20, 130, kWindowWidth - 20, 158};
  DrawTextW(mem, caller_name_.c_str(), -1, &title_rc,
            DT_CENTER | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
  SelectObject(mem, old_font);
  DeleteObject(title_font);

  HFONT sub_font = CreateFontW(14, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                               DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                               CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                               DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  old_font = static_cast<HFONT>(SelectObject(mem, sub_font));
  SetTextColor(mem, RGB(107, 114, 128));
  RECT sub_rc = {32, 160, kWindowWidth - 32, 190};
  DrawTextW(mem, subtitle_.c_str(), -1, &sub_rc,
            DT_CENTER | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
  SelectObject(mem, old_font);
  DeleteObject(sub_font);

  BitBlt(hdc, 0, 0, rc.right, rc.bottom, mem, 0, 0, SRCCOPY);
  SelectObject(mem, old_bmp);
  DeleteObject(bmp);
  DeleteDC(mem);
}

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
    case WM_COMMAND:
      if (LOWORD(wparam) == kIdHangup) {
        if (on_hangup_) on_hangup_();
        Hide();
        return 0;
      }
      break;
    case WM_CTLCOLORBTN: {
      HDC btn_dc = reinterpret_cast<HDC>(wparam);
      SetBkMode(btn_dc, TRANSPARENT);
      SetTextColor(btn_dc, RGB(255, 255, 255));
      if (hangup_brush_) {
        return reinterpret_cast<INT_PTR>(hangup_brush_);
      }
      return DefWindowProc(hwnd, message, wparam, lparam);
    }
    case WM_NCHITTEST: {
      POINT pt = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
      ScreenToClient(hwnd, &pt);
      if (pt.y < 40) return HTCAPTION;
      return HTCLIENT;
    }
    case WM_DESTROY:
      StopPulse();
      SetWindowLongPtr(hwnd, GWLP_USERDATA, 0);
      window_handle_ = nullptr;
      return 0;
  }
  return DefWindowProc(hwnd, message, wparam, lparam);
}
