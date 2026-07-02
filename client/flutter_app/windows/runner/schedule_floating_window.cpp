#include "schedule_floating_window.h"

#include <algorithm>

#include <windowsx.h>

#include "window_position_store.h"

namespace {

constexpr COLORREF kBgBlack = RGB(0, 0, 0);
constexpr COLORREF kSurfaceBg = RGB(10, 10, 12);
constexpr COLORREF kBorderColor = RGB(32, 32, 38);
constexpr COLORREF kTextPrimary = RGB(228, 228, 236);
constexpr COLORREF kTextSecondary = RGB(136, 136, 148);
constexpr COLORREF kAccentBlue = RGB(74, 164, 255);
constexpr COLORREF kCompletedColor = RGB(80, 80, 90);
constexpr COLORREF kFooterBg = RGB(10, 10, 14);
constexpr COLORREF kDangerRed = RGB(255, 72, 72);

constexpr int kCloseBtnSize = 24;
constexpr int kCollapseBtnSize = 24;

std::wstring FormatTodayLabel() {
  SYSTEMTIME st{};
  GetLocalTime(&st);
  const wchar_t* weekdays[] = {L"周日", L"周一", L"周二", L"周三",
                                L"周四", L"周五", L"周六"};
  int dow = st.wDayOfWeek;
  wchar_t buf[32];
  wsprintfW(buf, L"%d月%d日 %s", st.wMonth, st.wDay,
            (dow >= 0 && dow <= 6) ? weekdays[dow] : L"");
  return buf;
}

}  // namespace

ScheduleFloatingWindow::ScheduleFloatingWindow() = default;
ScheduleFloatingWindow::~ScheduleFloatingWindow() { Destroy(); }

std::wstring ScheduleFloatingWindow::Utf8ToWide(const std::string& s) const {
  if (s.empty()) return L"";
  int len = MultiByteToWideChar(CP_UTF8, 0, s.c_str(),
                                static_cast<int>(s.size()), nullptr, 0);
  std::wstring out(len, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()),
                      out.data(), len);
  return out;
}

void ScheduleFloatingWindow::EnsureClassRegistered() {
  static bool registered = false;
  if (registered) return;
  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(WNDCLASSEXW);
  wc.style = CS_HREDRAW | CS_VREDRAW;
  wc.lpfnWndProc = ScheduleFloatingWindow::WndProc;
  wc.hInstance = GetModuleHandle(nullptr);
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.hbrBackground = nullptr;
  wc.lpszClassName = kClassName;
  RegisterClassExW(&wc);
  registered = true;
}

void ScheduleFloatingWindow::EnsureFonts() {
  if (font_ui_ != nullptr) return;
  font_ui_ = CreateFontW(14, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                         DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                         CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                         DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  font_title_ = CreateFontW(16, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
                            DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                            CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                            DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  font_time_ = CreateFontW(13, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                           DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                           CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                           DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
}

void ScheduleFloatingWindow::EnsureButtons() {
  if (!window_handle_) return;
  EnsureFonts();

  if (btn_collapse_ == nullptr) {
    btn_collapse_ = CreateWindowExW(
        0, L"BUTTON", L"\u25B2", WS_CHILD | BS_PUSHBUTTON | BS_FLAT,
        0, 0, 0, 0, window_handle_,
        reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kButtonCollapseId)),
        GetModuleHandle(nullptr), nullptr);
    SendMessage(btn_collapse_, WM_SETFONT,
                reinterpret_cast<WPARAM>(font_ui_), TRUE);
  }
  if (btn_close_ == nullptr) {
    btn_close_ = CreateWindowExW(
        0, L"BUTTON", L"\u2715", WS_CHILD | BS_PUSHBUTTON | BS_FLAT,
        0, 0, 0, 0, window_handle_,
        reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kButtonCloseId)),
        GetModuleHandle(nullptr), nullptr);
    SendMessage(btn_close_, WM_SETFONT,
                reinterpret_cast<WPARAM>(font_title_), TRUE);
  }
}

void ScheduleFloatingWindow::ApplyWindowRgn() {
  if (!window_handle_) return;
  RECT rc;
  GetWindowRect(window_handle_, &rc);
  int w = rc.right - rc.left;
  int h = rc.bottom - rc.top;
  HRGN hRgn = CreateRoundRectRgn(0, 0, w + 1, h + 1, kCornerRadius,
                                 kCornerRadius);
  SetWindowRgn(window_handle_, hRgn, TRUE);
}

bool ScheduleFloatingWindow::Create() {
  if (window_handle_) return true;
  EnsureClassRegistered();

  DWORD ex_style = WS_EX_TOPMOST | WS_EX_TOOLWINDOW;
  DWORD style = WS_POPUP | WS_CLIPCHILDREN;

  HWND hwnd = CreateWindowExW(
      ex_style, kClassName, L"", style,
      CW_USEDEFAULT, CW_USEDEFAULT, kDefaultWidth, kDefaultHeight,
      nullptr, nullptr, GetModuleHandle(nullptr), this);
  if (!hwnd) return false;
  window_handle_ = hwnd;
  on_top_ = true;

  EnsureButtons();

  int w = kDefaultWidth;
  int h = CalculateWindowHeight();
  int x, y;
  RECT saved;
  if (window_position_store::LoadRect(L"schedule_floating", saved)) {
    x = saved.left;
    y = saved.top;
    w = std::max(kMinWidth, static_cast<int>(saved.right - saved.left));
    h = std::max(kTitleBarHeight, static_cast<int>(saved.bottom - saved.top));
  } else {
    RECT work = window_position_store::GetPrimaryWorkArea();
    x = work.right - w - 20;
    y = work.top + 20;
  }
  SetWindowPos(window_handle_, nullptr, x, y, w, h,
               SWP_NOZORDER | SWP_NOACTIVATE);
  ApplyWindowRgn();
  LayoutChildren();
  return true;
}

void ScheduleFloatingWindow::Destroy() {
  if (window_handle_ && IsWindow(window_handle_)) {
    RECT rc;
    if (GetWindowRect(window_handle_, &rc)) {
      window_position_store::SaveRect(L"schedule_floating", rc);
    }
  }
  if (btn_close_ && IsWindow(btn_close_)) {
    DestroyWindow(btn_close_);
    btn_close_ = nullptr;
  }
  if (btn_collapse_ && IsWindow(btn_collapse_)) {
    DestroyWindow(btn_collapse_);
    btn_collapse_ = nullptr;
  }
  if (font_ui_) { DeleteObject(font_ui_); font_ui_ = nullptr; }
  if (font_title_) { DeleteObject(font_title_); font_title_ = nullptr; }
  if (font_time_) { DeleteObject(font_time_); font_time_ = nullptr; }
  if (window_handle_ && IsWindow(window_handle_)) {
    DestroyWindow(window_handle_);
  }
  window_handle_ = nullptr;
}

void ScheduleFloatingWindow::Show() {
  if (!window_handle_) return;
  ShowWindow(window_handle_, SW_SHOW);
  SetForegroundWindow(window_handle_);
}

void ScheduleFloatingWindow::Hide() {
  if (!window_handle_) return;
  RECT rc;
  if (GetWindowRect(window_handle_, &rc)) {
    window_position_store::SaveRect(L"schedule_floating", rc);
  }
  ShowWindow(window_handle_, SW_HIDE);
}

bool ScheduleFloatingWindow::IsVisible() const {
  return window_handle_ && IsWindowVisible(window_handle_);
}

void ScheduleFloatingWindow::SetOnTop(bool on_top) {
  on_top_ = on_top;
  if (!window_handle_) return;
  SetWindowPos(window_handle_,
               on_top ? HWND_TOPMOST : HWND_NOTOPMOST,
               0, 0, 0, 0,
               SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

void ScheduleFloatingWindow::SetBounds(int x, int y, int width, int height) {
  if (!window_handle_) return;
  width = std::max(kMinWidth, width);
  height = std::max(kTitleBarHeight, height);
  SetWindowPos(window_handle_, nullptr, x, y, width, height,
               SWP_NOZORDER | SWP_NOACTIVATE);
  LayoutChildren();
}

RECT ScheduleFloatingWindow::GetBounds() const {
  RECT r{};
  if (window_handle_) GetWindowRect(window_handle_, &r);
  return r;
}

void ScheduleFloatingWindow::SetCollapsed(bool collapsed) {
  if (collapsed_ == collapsed) return;
  collapsed_ = collapsed;
  if (!window_handle_) return;

  RECT rc;
  GetWindowRect(window_handle_, &rc);
  int new_h = CalculateWindowHeight();
  SetWindowPos(window_handle_, nullptr, 0, 0, rc.right - rc.left, new_h,
               SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
  LayoutChildren();
  ApplyWindowRgn();
  InvalidateRect(window_handle_, nullptr, FALSE);

  if (btn_collapse_) {
    SetWindowTextW(btn_collapse_, collapsed_ ? L"\u25BC" : L"\u25B2");
  }

  FireEvent(EventType::kCollapseChanged, collapsed_ ? "true" : "false");
}

void ScheduleFloatingWindow::SetSchedule(std::vector<ScheduleItem> items) {
  items_ = std::move(items);
  if (!window_handle_) return;

  RECT rc;
  GetWindowRect(window_handle_, &rc);
  int new_h = CalculateWindowHeight();
  SetWindowPos(window_handle_, nullptr, 0, 0, rc.right - rc.left, new_h,
               SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
  LayoutChildren();
  ApplyWindowRgn();
  InvalidateRect(window_handle_, nullptr, FALSE);
}

int ScheduleFloatingWindow::CalculateWindowHeight() const {
  if (collapsed_) {
    return kTitleBarHeight;
  }
  int body_h = kBodyPadding * 2;
  if (items_.empty()) {
    body_h += 44;
  } else {
    int visible = std::min(static_cast<int>(items_.size()), kMaxVisibleItems);
    body_h += visible * kItemHeight;
  }
  if (!items_.empty()) {
    body_h += kFooterHeight;
  }
  return kTitleBarHeight + body_h;
}

void ScheduleFloatingWindow::LayoutChildren() {
  if (!window_handle_) return;
  RECT rc;
  GetClientRect(window_handle_, &rc);
  const int width = rc.right - rc.left;
  const int btn_y = (kTitleBarHeight - kCloseBtnSize) / 2;

  int x = width - kCloseBtnSize - 8;
  if (btn_close_) {
    SetWindowPos(btn_close_, nullptr, x, btn_y,
                 kCloseBtnSize, kCloseBtnSize,
                 SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
  }
  x -= kCollapseBtnSize + 6;
  if (btn_collapse_) {
    SetWindowTextW(btn_collapse_, collapsed_ ? L"\u25BC" : L"\u25B2");
    SetWindowPos(btn_collapse_, nullptr, x, btn_y,
                 kCollapseBtnSize, kCollapseBtnSize,
                 SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
  }
}

void ScheduleFloatingWindow::DrawRoundedRect(HDC hdc, const RECT& rc,
                                             int radius, COLORREF fill,
                                             COLORREF border) {
  HBRUSH fill_brush = CreateSolidBrush(fill);
  HPEN border_pen = CreatePen(PS_NULL, 0, 0);
  HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, border_pen));
  HBRUSH old_brush = static_cast<HBRUSH>(SelectObject(hdc, fill_brush));
  RoundRect(hdc, rc.left, rc.top, rc.right, rc.bottom, radius, radius);
  SelectObject(hdc, old_pen);
  SelectObject(hdc, old_brush);
  DeleteObject(fill_brush);
  DeleteObject(border_pen);
  if (border != 0) {
    HPEN pen = CreatePen(PS_SOLID, 1, border);
    HBRUSH null_brush = static_cast<HBRUSH>(GetStockObject(NULL_BRUSH));
    old_pen = static_cast<HPEN>(SelectObject(hdc, pen));
    old_brush = static_cast<HBRUSH>(SelectObject(hdc, null_brush));
    RoundRect(hdc, rc.left, rc.top, rc.right, rc.bottom, radius, radius);
    SelectObject(hdc, old_pen);
    SelectObject(hdc, old_brush);
    DeleteObject(pen);
  }
}

void ScheduleFloatingWindow::DrawUiText(HDC hdc, const RECT& rc,
                                        const std::wstring& text,
                                        HFONT font, COLORREF color,
                                        UINT flags) {
  SetBkMode(hdc, TRANSPARENT);
  SetTextColor(hdc, color);
  HFONT old_font = static_cast<HFONT>(SelectObject(hdc, font));
  RECT out = rc;
  ::DrawTextW(hdc, text.c_str(), -1, &out, flags);
  SelectObject(hdc, old_font);
}

void ScheduleFloatingWindow::Paint(HWND hwnd, HDC hdc) {
  RECT rc;
  GetClientRect(hwnd, &rc);

  HBRUSH bg = CreateSolidBrush(kBgBlack);
  FillRect(hdc, &rc, bg);
  DeleteObject(bg);

  RECT title_rc = {0, 0, rc.right, kTitleBarHeight};
  HBRUSH tb = CreateSolidBrush(kSurfaceBg);
  FillRect(hdc, &title_rc, tb);
  DeleteObject(tb);

  HPEN pen = CreatePen(PS_SOLID, 1, kBorderColor);
  HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, pen));
  MoveToEx(hdc, 0, kTitleBarHeight, nullptr);
  LineTo(hdc, rc.right, kTitleBarHeight);
  SelectObject(hdc, old_pen);
  DeleteObject(pen);

  EnsureFonts();

  RECT title_text_rc = {12, 0, 120, kTitleBarHeight};
  DrawUiText(hdc, title_text_rc, L"\u4eca\u65e5\u5b89\u6392", font_title_, kTextPrimary,
             DT_LEFT | DT_SINGLELINE | DT_VCENTER);

  std::wstring date_label = FormatTodayLabel();
  RECT date_rc = {120, 0, rc.right - kCloseBtnSize - kCollapseBtnSize - 22,
                  kTitleBarHeight};
  DrawUiText(hdc, date_rc, date_label, font_ui_, kAccentBlue,
             DT_RIGHT | DT_SINGLELINE | DT_VCENTER);

  if (collapsed_) return;

  int y = kTitleBarHeight + kBodyPadding;

  if (items_.empty()) {
    RECT empty_rc = {0, y, rc.right, y + 44};
    DrawUiText(hdc, empty_rc,
               L"\u2728 \u6682\u65e0\u65e5\u7a0b\u6570\u636e",
               font_ui_, kTextSecondary,
               DT_CENTER | DT_SINGLELINE | DT_VCENTER);
    return;
  }

  int visible_count = std::min(static_cast<int>(items_.size()),
                               kMaxVisibleItems);
  for (int i = 0; i < visible_count; ++i) {
    const auto& item = items_[i];
    int item_y = y + i * kItemHeight;

    int dot_x = kBodyPadding;
    int dot_y = item_y + (kItemHeight - 6) / 2;
    RECT dot_rc = {dot_x, dot_y, dot_x + 6, dot_y + 6};
    COLORREF dot_color = item.completed ? kCompletedColor : kAccentBlue;
    DrawRoundedRect(hdc, dot_rc, 3, dot_color, 0);

    RECT time_rc = {kBodyPadding + 14, item_y, kBodyPadding + 60,
                    item_y + kItemHeight};
    DrawUiText(hdc, time_rc, Utf8ToWide(item.time_text), font_time_,
               kTextSecondary, DT_LEFT | DT_SINGLELINE | DT_VCENTER);

    RECT title_col_rc = {kBodyPadding + 66, item_y, rc.right - kBodyPadding,
                         item_y + kItemHeight};
    COLORREF title_color = item.completed ? kCompletedColor : kTextPrimary;
    std::wstring title_text = Utf8ToWide(item.title);
    DrawUiText(hdc, title_col_rc, title_text, font_ui_, title_color,
               DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
  }

  int footer_y = kTitleBarHeight + kBodyPadding +
                 visible_count * kItemHeight;
  if (footer_y + kFooterHeight <= rc.bottom) {
    RECT footer_rc = {0, footer_y, rc.right, footer_y + kFooterHeight};
    HBRUSH fb = CreateSolidBrush(kFooterBg);
    FillRect(hdc, &footer_rc, fb);
    DeleteObject(fb);

    int pending = 0;
    for (const auto& it : items_) {
      if (!it.completed) ++pending;
    }
    wchar_t buf[64];
    wsprintfW(buf, L"共 %d 项 \u00B7 %d 待执行",
              static_cast<int>(items_.size()), pending);
    RECT footer_text_rc = {kBodyPadding, footer_y, rc.right - kBodyPadding,
                           footer_y + kFooterHeight};
    DrawUiText(hdc, footer_text_rc, buf, font_ui_, kTextSecondary,
               DT_LEFT | DT_SINGLELINE | DT_VCENTER);
  }
}

void ScheduleFloatingWindow::FireEvent(EventType type,
                                       const std::string& payload) {
  if (event_callback_) event_callback_(type, payload);
}

LRESULT ScheduleFloatingWindow::WndProc(HWND hwnd, UINT message,
                                        WPARAM wparam,
                                        LPARAM lparam) noexcept {
  if (message == WM_NCCREATE) {
    auto* cs = reinterpret_cast<CREATESTRUCT*>(lparam);
    SetWindowLongPtr(hwnd, GWLP_USERDATA,
                     reinterpret_cast<LONG_PTR>(cs->lpCreateParams));
  } else {
    auto* that = reinterpret_cast<ScheduleFloatingWindow*>(
        GetWindowLongPtr(hwnd, GWLP_USERDATA));
    if (that) return that->HandleMessage(hwnd, message, wparam, lparam);
  }
  return DefWindowProc(hwnd, message, wparam, lparam);
}

LRESULT ScheduleFloatingWindow::HandleMessage(HWND hwnd, UINT message,
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
    case WM_SIZE:
      LayoutChildren();
      ApplyWindowRgn();
      InvalidateRect(hwnd, nullptr, FALSE);
      return 0;
    case WM_EXITSIZEMOVE: {
      RECT rc;
      if (GetWindowRect(hwnd, &rc)) {
        window_position_store::SaveRect(L"schedule_floating", rc);
      }
      return 0;
    }
    case WM_NCHITTEST: {
      POINT pt = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
      ScreenToClient(hwnd, &pt);
      if (pt.y < kTitleBarHeight) {
        RECT rc;
        GetClientRect(hwnd, &rc);
        int btn_area_start = rc.right - kCloseBtnSize - kCollapseBtnSize - 16;
        if (pt.x < btn_area_start) {
          return HTCAPTION;
        }
      }
      return HTCLIENT;
    }
    case WM_COMMAND: {
      const int id = LOWORD(wparam);
      if (id == kButtonCloseId) {
        Hide();
        FireEvent(EventType::kCloseClicked);
        return 0;
      }
      if (id == kButtonCollapseId) {
        SetCollapsed(!collapsed_);
        return 0;
      }
      break;
    }
    case WM_CTLCOLORBTN: {
      HDC btn_dc = reinterpret_cast<HDC>(wparam);
      HWND btn = reinterpret_cast<HWND>(lparam);
      SetBkMode(btn_dc, TRANSPARENT);
      if (btn == btn_collapse_) {
        SetTextColor(btn_dc, RGB(0, 0, 0));
      } else if (btn == btn_close_) {
        SetTextColor(btn_dc, RGB(0, 0, 0));
      }
      return reinterpret_cast<INT_PTR>(GetStockObject(NULL_BRUSH));
    }
    case WM_DESTROY:
      SetWindowLongPtr(hwnd, GWLP_USERDATA, 0);
      window_handle_ = nullptr;
      return 0;
  }
  return DefWindowProc(hwnd, message, wparam, lparam);
}
