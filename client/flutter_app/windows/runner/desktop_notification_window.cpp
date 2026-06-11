#include "desktop_notification_window.h"

#include <windowsx.h>

#include <algorithm>

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

COLORREF PriorityColor(const std::wstring& priority) {
  if (priority == L"urgent") return RGB(214, 72, 64);
  if (priority == L"high") return RGB(227, 141, 42);
  return RGB(31, 122, 224);
}

}  // namespace

DesktopNotificationWindow::DesktopNotificationWindow() = default;

DesktopNotificationWindow::~DesktopNotificationWindow() {
  DestroyNativeWindow();
}

void DesktopNotificationWindow::SetCallbacks(ConfirmCallback on_confirm,
                                             DismissCallback on_dismiss,
                                             TimeoutCallback on_timeout) {
  on_confirm_ = std::move(on_confirm);
  on_dismiss_ = std::move(on_dismiss);
  on_timeout_ = std::move(on_timeout);
}

void DesktopNotificationWindow::EnsureClassRegistered() {
  static bool registered = false;
  if (registered) return;

  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(WNDCLASSEXW);
  wc.lpfnWndProc = DesktopNotificationWindow::WndProc;
  wc.hInstance = GetModuleHandle(nullptr);
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.hbrBackground = nullptr;
  wc.lpszClassName = kClassName;
  RegisterClassExW(&wc);
  registered = true;
}

bool DesktopNotificationWindow::CreateWindowIfNeeded() {
  if (window_handle_) return true;
  EnsureClassRegistered();

  HWND hwnd = CreateWindowExW(
      WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, kClassName, L"",
      WS_POPUP | WS_CLIPCHILDREN, 0, 0, kWindowWidth, kWindowHeight, nullptr,
      nullptr, GetModuleHandle(nullptr), this);
  if (!hwnd) return false;
  window_handle_ = hwnd;

  confirm_btn_ = CreateWindowExW(
      0, L"BUTTON", L"", WS_CHILD | BS_PUSHBUTTON | BS_FLAT, 0, 0, 0, 0, hwnd,
      reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdConfirm)),
      GetModuleHandle(nullptr), nullptr);
  close_btn_ = CreateWindowExW(
      0, L"BUTTON", L"\u00D7", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON | BS_FLAT,
      0, 0, 0, 0, hwnd,
      reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdClose)),
      GetModuleHandle(nullptr), nullptr);

  HFONT font = reinterpret_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT));
  SendMessage(confirm_btn_, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
  SendMessage(close_btn_, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
  confirm_brush_ = CreateSolidBrush(RGB(7, 193, 96));
  return true;
}

void DesktopNotificationWindow::LayoutChildren() {
  if (!window_handle_) return;
  SetWindowPos(close_btn_, nullptr, kWindowWidth - 34, 10, 20, 20,
               SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
  if (show_confirm_button_) {
    SetWindowTextW(confirm_btn_, confirm_text_.c_str());
    SetWindowPos(confirm_btn_, nullptr, kWindowWidth - 110, kWindowHeight - 46,
                 96, 30, SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
  } else if (confirm_btn_) {
    ShowWindow(confirm_btn_, SW_HIDE);
  }
}

void DesktopNotificationWindow::PositionAtBottomRight() {
  if (!window_handle_) return;
  MONITORINFO mi = {sizeof(mi)};
  GetMonitorInfoW(MonitorFromWindow(window_handle_, MONITOR_DEFAULTTONEAREST),
                  &mi);
  const int x = mi.rcWork.right - kWindowWidth - kMargin;
  const int y = mi.rcWork.bottom - kWindowHeight - kMargin;
  SetWindowPos(window_handle_, HWND_TOPMOST, x, y, kWindowWidth, kWindowHeight,
               SWP_NOACTIVATE | SWP_SHOWWINDOW);
  LayoutChildren();
}

void DesktopNotificationWindow::Show(const std::string& title,
                                     const std::string& message,
                                     const std::string& priority,
                                     bool show_confirm_button,
                                     const std::string& confirm_text,
                                     int auto_close_ms) {
  title_ = Utf8ToWide(title);
  message_ = Utf8ToWide(message);
  priority_ = Utf8ToWide(priority);
  confirm_text_ = Utf8ToWide(confirm_text);
  show_confirm_button_ = show_confirm_button;
  auto_close_ms_ = auto_close_ms;
  if (!CreateWindowIfNeeded()) return;
  PositionAtBottomRight();
  StartTimer();
  InvalidateRect(window_handle_, nullptr, TRUE);
}

void DesktopNotificationWindow::Hide() {
  StopTimer();
  if (window_handle_) {
    ShowWindow(window_handle_, SW_HIDE);
  }
}

bool DesktopNotificationWindow::IsVisible() const {
  return window_handle_ && IsWindowVisible(window_handle_);
}

void DesktopNotificationWindow::StartTimer() {
  StopTimer();
  if (window_handle_ && auto_close_ms_ > 0) {
    SetTimer(window_handle_, kAutoCloseTimerId, static_cast<UINT>(auto_close_ms_),
             nullptr);
  }
}

void DesktopNotificationWindow::StopTimer() {
  if (window_handle_) {
    KillTimer(window_handle_, kAutoCloseTimerId);
  }
}

void DesktopNotificationWindow::DestroyNativeWindow() {
  StopTimer();
  if (confirm_btn_ && IsWindow(confirm_btn_)) DestroyWindow(confirm_btn_);
  if (close_btn_ && IsWindow(close_btn_)) DestroyWindow(close_btn_);
  confirm_btn_ = nullptr;
  close_btn_ = nullptr;
  if (confirm_brush_) DeleteObject(confirm_brush_);
  confirm_brush_ = nullptr;
  if (confirm_border_brush_) DeleteObject(confirm_border_brush_);
  confirm_border_brush_ = nullptr;
  if (window_handle_ && IsWindow(window_handle_)) DestroyWindow(window_handle_);
  window_handle_ = nullptr;
}

void DesktopNotificationWindow::Paint(HWND hwnd, HDC hdc) {
  RECT rc;
  GetClientRect(hwnd, &rc);
  HDC mem = CreateCompatibleDC(hdc);
  HBITMAP bmp = CreateCompatibleBitmap(hdc, rc.right, rc.bottom);
  HBITMAP old_bmp = static_cast<HBITMAP>(SelectObject(mem, bmp));

  HBRUSH bg = CreateSolidBrush(RGB(249, 250, 252));
  FillRect(mem, &rc, bg);
  DeleteObject(bg);

  HPEN border = CreatePen(PS_SOLID, 1, RGB(224, 229, 235));
  HBRUSH fill = CreateSolidBrush(RGB(249, 250, 252));
  HPEN old_pen = static_cast<HPEN>(SelectObject(mem, border));
  HBRUSH old_brush = static_cast<HBRUSH>(SelectObject(mem, fill));
  RoundRect(mem, rc.left, rc.top, rc.right, rc.bottom, 18, 18);
  SelectObject(mem, old_pen);
  SelectObject(mem, old_brush);
  DeleteObject(border);
  DeleteObject(fill);

  RECT accent = {18, 16, 26, 24};
  HBRUSH accent_brush = CreateSolidBrush(PriorityColor(priority_));
  FillRect(mem, &accent, accent_brush);
  DeleteObject(accent_brush);

  HFONT title_font = CreateFontW(18, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
                                 DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                                 CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                                 DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  HFONT body_font = CreateFontW(15, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                                DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                                CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                                DEFAULT_PITCH | FF_SWISS, L"Segoe UI");

  SetBkMode(mem, TRANSPARENT);
  SetTextColor(mem, RGB(31, 35, 41));
  HFONT old_font = static_cast<HFONT>(SelectObject(mem, title_font));
  RECT title_rc = {36, 12, kWindowWidth - 50, 42};
  DrawTextW(mem, title_.c_str(), -1, &title_rc,
            DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);

  SelectObject(mem, body_font);
  SetTextColor(mem, RGB(94, 104, 117));
  RECT body_rc = {18, 50, kWindowWidth - 20, show_confirm_button_ ? 112 : 130};
  DrawTextW(mem, message_.c_str(), -1, &body_rc,
            DT_WORDBREAK | DT_END_ELLIPSIS | DT_NOPREFIX);

  RECT top_bar = {0, 0, rc.right, 4};
  HBRUSH top_bar_brush = CreateSolidBrush(PriorityColor(priority_));
  FillRect(mem, &top_bar, top_bar_brush);
  DeleteObject(top_bar_brush);

  SelectObject(mem, old_font);
  DeleteObject(title_font);
  DeleteObject(body_font);

  BitBlt(hdc, 0, 0, rc.right, rc.bottom, mem, 0, 0, SRCCOPY);
  SelectObject(mem, old_bmp);
  DeleteObject(bmp);
  DeleteDC(mem);
}

LRESULT CALLBACK DesktopNotificationWindow::WndProc(HWND hwnd, UINT message,
                                                    WPARAM wparam,
                                                    LPARAM lparam) noexcept {
  if (message == WM_NCCREATE) {
    auto* cs = reinterpret_cast<CREATESTRUCT*>(lparam);
    SetWindowLongPtr(hwnd, GWLP_USERDATA,
                     reinterpret_cast<LONG_PTR>(cs->lpCreateParams));
  } else {
    auto* that = reinterpret_cast<DesktopNotificationWindow*>(
        GetWindowLongPtr(hwnd, GWLP_USERDATA));
    if (that) return that->HandleMessage(hwnd, message, wparam, lparam);
  }
  return DefWindowProc(hwnd, message, wparam, lparam);
}

LRESULT DesktopNotificationWindow::HandleMessage(HWND hwnd, UINT message,
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
      if (wparam == kAutoCloseTimerId) {
        StopTimer();
        if (on_timeout_) on_timeout_();
        Hide();
        return 0;
      }
      break;
    case WM_COMMAND: {
      const int id = LOWORD(wparam);
      if (id == kIdConfirm) {
        if (on_confirm_) on_confirm_();
        Hide();
        return 0;
      }
      if (id == kIdClose) {
        if (on_dismiss_) on_dismiss_();
        Hide();
        return 0;
      }
      break;
    }
    case WM_CTLCOLORBTN: {
      HDC btn_dc = reinterpret_cast<HDC>(wparam);
      HWND btn = reinterpret_cast<HWND>(lparam);
      SetBkMode(btn_dc, TRANSPARENT);
      SetTextColor(btn_dc, RGB(255, 255, 255));
      if (btn == confirm_btn_ && confirm_brush_) {
        return reinterpret_cast<INT_PTR>(confirm_brush_);
      }
      return DefWindowProc(hwnd, message, wparam, lparam);
    }
    case WM_NCHITTEST: {
      POINT pt = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
      ScreenToClient(hwnd, &pt);
      if (pt.y < 42) return HTCAPTION;
      return HTCLIENT;
    }
    case WM_DESTROY:
      StopTimer();
      SetWindowLongPtr(hwnd, GWLP_USERDATA, 0);
      window_handle_ = nullptr;
      return 0;
  }
  return DefWindowProc(hwnd, message, wparam, lparam);
}
