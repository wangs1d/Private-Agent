#include "schedule_floating_window.h"

#include <algorithm>

#include <windowsx.h>

#include "window_position_store.h"

namespace {

// 配色对齐 in-app RightSidePanel._buildScheduleCard（深色主题）：
//   cs.surfaceContainerHigh ≈ #232323，cs.onSurface ≈ #E8E8E8，
//   cs.onSurfaceVariant ≈ #BBBBBB，cs.outline ≈ #353535
// 强调色对齐 Flutter 常量：
//   _kAccentBlue = #007AFF，_kAccentGreen = #34C759，_kAccentOrange = #FF9500
constexpr COLORREF kSurfaceBg = RGB(35, 35, 35);        // 卡片背景（对齐 surfaceContainerHigh）
constexpr COLORREF kBorderColor = RGB(53, 53, 53);      // 描边（对齐 outline）
constexpr COLORREF kTextPrimary = RGB(232, 232, 232);   // 主文字（对齐 onSurface）
constexpr COLORREF kTextSecondary = RGB(187, 187, 187); // 次文字（对齐 onSurfaceVariant）
constexpr COLORREF kAccentBlue = RGB(0, 122, 255);      // 蓝强调（<10 点）
constexpr COLORREF kAccentGreen = RGB(52, 199, 89);     // 绿强调（10-14 点）
constexpr COLORREF kAccentOrange = RGB(255, 149, 0);    // 橙强调（14-18 点）
constexpr COLORREF kCompletedColor = RGB(110, 110, 120);
constexpr COLORREF kTimeLineColor = RGB(90, 90, 100);   // 时间下方竖线色
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
  font_title_ = CreateFontW(15, 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE,
                            DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                            CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                            DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  font_time_ = CreateFontW(13, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
                           DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                           CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                           DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  font_notes_ = CreateFontW(12, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                            DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                            CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                            DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
}

void ScheduleFloatingWindow::EnsureButtons() {
  if (!window_handle_) return;
  EnsureFonts();

  if (btn_collapse_ == nullptr) {
    btn_collapse_ = CreateWindowExW(
        0, L"BUTTON", L"\u25B2",
        WS_CHILD | BS_OWNERDRAW,
        0, 0, 0, 0, window_handle_,
        reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kButtonCollapseId)),
        GetModuleHandle(nullptr), nullptr);
  }
  if (btn_close_ == nullptr) {
    btn_close_ = CreateWindowExW(
        0, L"BUTTON", L"\u2715",
        WS_CHILD | BS_OWNERDRAW,
        0, 0, 0, 0, window_handle_,
        reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kButtonCloseId)),
        GetModuleHandle(nullptr), nullptr);
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
  if (font_notes_) { DeleteObject(font_notes_); font_notes_ = nullptr; }
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
  // 对齐 in-app _buildScheduleCard：不再渲染底部统计栏
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

void ScheduleFloatingWindow::DrawCalendarIcon(HDC hdc, int x, int y, int size,
                                               COLORREF color) {
  // 矢量绘制一个简洁的日历图标：外框 + 顶部两条挂钩线 + 顶部横条
  // 视觉对齐 Material Icons.calendar_today_outlined。
  HPEN pen = CreatePen(PS_SOLID, 1, color);
  HBRUSH brush = CreateSolidBrush(color);
  HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, pen));
  HBRUSH old_brush = static_cast<HBRUSH>(SelectObject(hdc, GetStockObject(NULL_BRUSH)));

  // 外框
  RECT outer = {x, y + 3, x + size, y + 3 + size - 3};
  RoundRect(hdc, outer.left, outer.top, outer.right, outer.bottom, 2, 2);

  // 顶部横条
  RECT header = {x, y + 3, x + size, y + 3 + 2};
  FillRect(hdc, &header, brush);

  // 两条挂线
  int hook_x1 = x + 3;
  int hook_x2 = x + size - 4;
  MoveToEx(hdc, hook_x1, y, nullptr);
  LineTo(hdc, hook_x1, y + 5);
  MoveToEx(hdc, hook_x2, y, nullptr);
  LineTo(hdc, hook_x2, y + 5);

  SelectObject(hdc, old_pen);
  SelectObject(hdc, old_brush);
  DeleteObject(pen);
  DeleteObject(brush);
}

int ScheduleFloatingWindow::ParseHour(const std::string& time_text) const {
  // 期望格式 "HH:MM"
  if (time_text.size() < 2) return -1;
  // 简单解析：前两个字符为小时
  int h = 0;
  for (int i = 0; i < 2; ++i) {
    char c = time_text[i];
    if (c < '0' || c > '9') return -1;
    h = h * 10 + (c - '0');
  }
  return h;
}

COLORREF ScheduleFloatingWindow::GetTimeColor(
    const std::string& time_text) const {
  // 对齐 in-app _buildScheduleRow 配色规则：
  //   hour < 10 -> 蓝；< 14 -> 橙；< 18 -> 绿；其它 -> 次文字色
  int hour = ParseHour(time_text);
  if (hour < 0) return kTextSecondary;
  if (hour < 10) return kAccentBlue;
  if (hour < 14) return kAccentOrange;
  if (hour < 18) return kAccentGreen;
  return kTextSecondary;
}

void ScheduleFloatingWindow::Paint(HWND hwnd, HDC hdc) {
  RECT rc;
  GetClientRect(hwnd, &rc);

  // 主背景（对齐 in-app 卡片 surfaceContainerHigh）
  HBRUSH bg = CreateSolidBrush(kSurfaceBg);
  FillRect(hdc, &rc, bg);
  DeleteObject(bg);

  // 卡片描边（1px，对齐 in-app cs.outline * 0.35）
  HPEN border_pen = CreatePen(PS_SOLID, 1, kBorderColor);
  HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, border_pen));
  HBRUSH old_brush = static_cast<HBRUSH>(SelectObject(hdc, GetStockObject(NULL_BRUSH)));
  RECT border_rc = {0, 0, rc.right - 1, rc.bottom - 1};
  RoundRect(hdc, border_rc.left, border_rc.top, border_rc.right,
            border_rc.bottom, kCornerRadius, kCornerRadius);
  SelectObject(hdc, old_pen);
  SelectObject(hdc, old_brush);
  DeleteObject(border_pen);

  EnsureFonts();

  // ── 标题栏：📅 今日安排  …  日期 ──
  // 日历图标（矢量绘制，对齐 Material Icons.calendar_today_outlined）
  int cal_x = kBodyPadding;
  int cal_y = (kTitleBarHeight - kCalIconSize) / 2;
  DrawCalendarIcon(hdc, cal_x, cal_y, kCalIconSize, kAccentBlue);

  // 标题文字
  RECT title_text_rc = {cal_x + kCalIconSize + 8, 0,
                        cal_x + kCalIconSize + 8 + 80, kTitleBarHeight};
  DrawUiText(hdc, title_text_rc, L"\u4eca\u65e5\u5b89\u6392", font_title_,
             kTextPrimary, DT_LEFT | DT_SINGLELINE | DT_VCENTER);

  // 日期文字（右侧，蓝色）
  std::wstring date_label = FormatTodayLabel();
  RECT date_rc = {0, 0,
                  rc.right - kCloseBtnSize - kCollapseBtnSize - 22,
                  kTitleBarHeight};
  DrawUiText(hdc, date_rc, date_label, font_ui_, kAccentBlue,
             DT_RIGHT | DT_SINGLELINE | DT_VCENTER);

  // 标题栏底部分隔线（对齐 in-app Border(bottom)）
  HPEN sep_pen = CreatePen(PS_SOLID, 1, kBorderColor);
  old_pen = static_cast<HPEN>(SelectObject(hdc, sep_pen));
  MoveToEx(hdc, 0, kTitleBarHeight, nullptr);
  LineTo(hdc, rc.right, kTitleBarHeight);
  SelectObject(hdc, old_pen);
  DeleteObject(sep_pen);

  if (collapsed_) return;

  int y = kTitleBarHeight + kBodyPadding;

  if (items_.empty()) {
    RECT empty_rc = {0, y, rc.right, y + 44};
    DrawUiText(hdc, empty_rc,
               L"\u6682\u65e0\u65e5\u7a0b\u6570\u636e",
               font_ui_, kTextSecondary,
               DT_CENTER | DT_SINGLELINE | DT_VCENTER);
    return;
  }

  int visible_count = std::min(static_cast<int>(items_.size()),
                               kMaxVisibleItems);
  for (int i = 0; i < visible_count; ++i) {
    const auto& item = items_[i];
    int item_y = y + i * kItemHeight;

    // ── 时间列（左）：时间 + 下方竖线 ──
    int time_x = kBodyPadding;
    int time_w = kTimeColWidth;

    // 时间文字（颜色按小时变化，对齐 in-app _buildScheduleRow）
    RECT time_rc = {time_x, item_y + 4, time_x + time_w, item_y + 4 + 16};
    COLORREF time_color = item.completed
                              ? kCompletedColor
                              : GetTimeColor(item.time_text);
    DrawUiText(hdc, time_rc, Utf8ToWide(item.time_text), font_time_,
               time_color, DT_LEFT | DT_SINGLELINE | DT_VCENTER);

    // 时间下方竖线（1px * 18px，对齐 in-app Container(width:1, height:18)）
    int line_x = time_x + 1;
    int line_y_top = item_y + 22;
    int line_y_bottom = line_y_top + 18;
    HPEN line_pen = CreatePen(PS_SOLID, 1, kTimeLineColor);
    old_pen = static_cast<HPEN>(SelectObject(hdc, line_pen));
    MoveToEx(hdc, line_x, line_y_top, nullptr);
    LineTo(hdc, line_x, line_y_bottom);
    SelectObject(hdc, old_pen);
    DeleteObject(line_pen);

    // ── 标题列（右）：标题 + 备注（与时间列保持至少 50px 间距）──
    int title_x = time_x + time_w + 50;
    int title_right = rc.right - kBodyPadding;
    COLORREF title_color = item.completed ? kCompletedColor : kTextPrimary;
    std::wstring title_text = Utf8ToWide(item.title);

    // 标题文字（12pt，对齐 in-app fontSize:12）
    RECT title_col_rc = {title_x, item_y + 4, title_right, item_y + 4 + 16};
    DrawUiText(hdc, title_col_rc, title_text, font_ui_, title_color,
               DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);

    // 备注文字（10pt，仅当存在时绘制）
    if (!item.notes.empty()) {
      std::wstring notes_text = Utf8ToWide(item.notes);
      RECT notes_rc = {title_x, item_y + 24, title_right, item_y + 24 + 14};
      COLORREF notes_color = item.completed ? kCompletedColor : kTextSecondary;
      DrawUiText(hdc, notes_rc, notes_text, font_notes_, notes_color,
                 DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
    }
  }
  // 对齐 in-app _buildScheduleCard：不再渲染底部统计栏
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
    case WM_DRAWITEM: {
      // 自绘按钮（BS_OWNERDRAW）：黑色背景 + 白色文字
      auto* dis = reinterpret_cast<DRAWITEMSTRUCT*>(lparam);
      if (dis == nullptr || dis->hwndItem == nullptr) break;
      HDC dc = dis->hDC;
      RECT rc = dis->rcItem;

      // 背景：黑色填充
      HBRUSH bg_brush = CreateSolidBrush(RGB(0, 0, 0));
      FillRect(dc, &rc, bg_brush);
      DeleteObject(bg_brush);

      // 边框：略深灰 1px
      HPEN border_pen = CreatePen(PS_SOLID, 1, RGB(40, 40, 40));
      HPEN old_pen = static_cast<HPEN>(SelectObject(dc, border_pen));
      HBRUSH old_brush = static_cast<HBRUSH>(SelectObject(dc, GetStockObject(NULL_BRUSH)));
      Rectangle(dc, rc.left, rc.top, rc.right, rc.bottom);
      SelectObject(dc, old_pen);
      SelectObject(dc, old_brush);
      DeleteObject(border_pen);

      // 文字：白色，居中
      wchar_t text[8] = {0};
      GetWindowTextW(dis->hwndItem, text, 7);
      SetBkMode(dc, TRANSPARENT);
      SetTextColor(dc, RGB(255, 255, 255));
      HFONT font = (dis->hwndItem == btn_close_) ? font_title_ : font_ui_;
      HFONT old_font = static_cast<HFONT>(SelectObject(dc, font));
      RECT text_rc = rc;
      ::DrawTextW(dc, text, -1, &text_rc,
                  DT_CENTER | DT_SINGLELINE | DT_VCENTER);
      SelectObject(dc, old_font);

      // 按下态：略微变深
      if (dis->itemState & ODS_SELECTED) {
        HBRUSH dim = CreateSolidBrush(RGB(0, 0, 0));
        FrameRect(dc, &rc, dim);
        DeleteObject(dim);
      }
      return TRUE;
    }
    case WM_DESTROY:
      SetWindowLongPtr(hwnd, GWLP_USERDATA, 0);
      window_handle_ = nullptr;
      return 0;
  }
  return DefWindowProc(hwnd, message, wparam, lparam);
}
