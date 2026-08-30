#include "schedule_floating_window.h"

#include <algorithm>

#include <windowsx.h>

#include "window_position_store.h"

namespace {

// 配色对齐 in-app「焦点时间轴」卡片（docs/design/today-schedule-redesign，
// 对应 right_side_panel.dart 的 _SchedSkin 深色皮肤）：
//   面板底 #1C1C1E，主文字 #E8E8E8，次文字 #989898，
//   强调色青 #18D6F3 / 绿 #1ED7A6 / 琥珀 #F2B94B，类别蓝 #4E9CFF。
// 焦点卡/光晕/标签等半透明色按「accent alpha 混入面板底」预计算为实色。
constexpr COLORREF kSurfaceBg = RGB(28, 28, 30);         // #1C1C1E 面板底
constexpr COLORREF kBorderColor = RGB(46, 46, 49);       // 窗口描边
constexpr COLORREF kTextPrimary = RGB(232, 232, 232);    // #E8E8E8 标题
constexpr COLORREF kTextBody = RGB(222, 222, 222);       // #DEDEDE 事项标题
constexpr COLORREF kTextSecondary = RGB(152, 152, 152);  // #989898 次文字
constexpr COLORREF kTextDim = RGB(92, 96, 102);          // #5C6066 完成标题
constexpr COLORREF kTimeColor = RGB(138, 143, 150);      // #8A8F96 未完成时间
constexpr COLORREF kTimeDim = RGB(78, 81, 87);           // #4E5157 完成时间
constexpr COLORREF kAccentCyan = RGB(24, 214, 243);      // #18D6F3 下一事项
constexpr COLORREF kFocusFill = RGB(28, 52, 56);         // 焦点卡底（青 13%）
constexpr COLORREF kFocusBorder = RGB(27, 84, 93);       // 焦点卡描边（青 30%）
constexpr COLORREF kFocusTime = RGB(234, 253, 255);      // #EAFDFF 焦点时间
constexpr COLORREF kFocusTitle = RGB(242, 242, 242);     // #F2F2F2 焦点标题
constexpr COLORREF kFocusNote = RGB(143, 166, 173);      // #8FA6AD 焦点备注
constexpr COLORREF kChipBg = RGB(27, 65, 71);            // 头部图标底座（青 20%）
constexpr COLORREF kDotBlue = RGB(78, 156, 255);         // #4E9CFF（<10 点）
constexpr COLORREF kDotAmber = RGB(242, 185, 75);        // #F2B94B（10-14 点）
constexpr COLORREF kDotGreen = RGB(30, 215, 166);        // #1ED7A6（14-18 点）
constexpr COLORREF kDotGray = RGB(138, 143, 150);        // 其它时段
constexpr COLORREF kGlowBlue = RGB(37, 51, 69);          // 圆点外圈光晕
constexpr COLORREF kGlowAmber = RGB(66, 56, 36);
constexpr COLORREF kGlowGreen = RGB(28, 62, 53);
constexpr COLORREF kGlowGray = RGB(44, 46, 48);
constexpr COLORREF kGlowCyan = RGB(27, 91, 101);         // 下一事项光晕（青 35%）
constexpr COLORREF kDotDoneFill = RGB(58, 61, 66);       // #3A3D42 完成圆点
constexpr COLORREF kDotDoneRing = RGB(107, 112, 118);    // #6B7076 完成圆环
constexpr COLORREF kTimelineLine = RGB(48, 50, 52);      // 时间轴竖线（白 9%）
constexpr COLORREF kTrack = RGB(45, 46, 48);             // 日程带轨道（白 7%）
constexpr COLORREF kElapsed = RGB(31, 58, 62);           // 已流逝段（青 22%）
constexpr COLORREF kNeedleCore = RGB(242, 245, 249);     // #F2F5F9 now 游标
constexpr COLORREF kNeedleGlow = RGB(27, 91, 101);       // now 游标光晕
constexpr COLORREF kTickLabel = RGB(85, 89, 95);         // #55595F 刻度标签
constexpr COLORREF kNowTagBg = RGB(28, 50, 54);          // NOW 标签底（青 12%）
constexpr COLORREF kAllDoneFill = RGB(28, 43, 41);       // 完成横幅底（绿 8%）
constexpr COLORREF kAllDoneBorder = RGB(34, 80, 69);     // 完成横幅描边（绿 25%）
constexpr COLORREF kAllDoneText = RGB(30, 215, 166);     // #1ED7A6
constexpr COLORREF kBtnBg = RGB(38, 38, 40);             // 顶栏按钮底
constexpr COLORREF kBtnBorder = RGB(58, 58, 62);         // 顶栏按钮描边
constexpr COLORREF kBtnText = RGB(222, 222, 222);        // 顶栏按钮文字

constexpr int kStripBarTop = 5;    // 日程带轨道在区块内的纵向偏移（逻辑 px）
constexpr int kStripBarHeight = 4;
constexpr int kNeedleHeight = 12;  // now 游标高（高出轨道两侧）
constexpr int kDotRadius = 3;      // 时间轴圆点半径
constexpr int kGlowRadius = 6;     // 圆点光晕半径
constexpr int kNowTagWidth = 32;   // NOW 标签宽
constexpr int kNowTagHeight = 14;  // NOW 标签高
constexpr int kButtonZoneWidth = 58;  // 顶栏右侧按钮占位（22+6+22+8）

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

int NowMinutes() {
  SYSTEMTIME st{};
  GetLocalTime(&st);
  return st.wHour * 60 + st.wMinute;
}

}  // namespace

ScheduleFloatingWindow::ScheduleFloatingWindow() = default;
ScheduleFloatingWindow::~ScheduleFloatingWindow() { Destroy(); }

int ScheduleFloatingWindow::S(int v) const {
  return static_cast<int>(v * dpi_scale_ + 0.5);
}

double ScheduleFloatingWindow::Sd(double v) const { return v * dpi_scale_; }

void ScheduleFloatingWindow::UpdateDpiScale() {
  UINT dpi = 96;
  if (window_handle_ != nullptr) {
    dpi = GetDpiForWindow(window_handle_);
  } else {
    dpi = GetDpiForSystem();
  }
  if (dpi == 0) dpi = 96;
  dpi_scale_ = static_cast<double>(dpi) / 96.0;
}

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
  font_ui_ = CreateFontW(S(12), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                         DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                         CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                         DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  font_title_ = CreateFontW(S(13), 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE,
                            DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                            CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                            DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  font_time_ = CreateFontW(S(12), 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
                           DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                           CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                           DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  font_notes_ = CreateFontW(S(11), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                            DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                            CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                            DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  font_caption_ = CreateFontW(S(10), 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE,
                              DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                              CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                              DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  font_strike_ = CreateFontW(S(12), 0, 0, 0, FW_NORMAL, FALSE, TRUE, FALSE,
                             DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                             CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                             DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  font_focus_time_ = CreateFontW(S(15), 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE,
                                 DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                                 CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                                 DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
}

void ScheduleFloatingWindow::DestroyFonts() {
  if (font_ui_) { DeleteObject(font_ui_); font_ui_ = nullptr; }
  if (font_title_) { DeleteObject(font_title_); font_title_ = nullptr; }
  if (font_time_) { DeleteObject(font_time_); font_time_ = nullptr; }
  if (font_notes_) { DeleteObject(font_notes_); font_notes_ = nullptr; }
  if (font_caption_) { DeleteObject(font_caption_); font_caption_ = nullptr; }
  if (font_strike_) { DeleteObject(font_strike_); font_strike_ = nullptr; }
  if (font_focus_time_) {
    DeleteObject(font_focus_time_);
    font_focus_time_ = nullptr;
  }
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
  HRGN hRgn = CreateRoundRectRgn(0, 0, w + 1, h + 1, S(kCornerRadius),
                                 S(kCornerRadius));
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
  UpdateDpiScale();

  EnsureButtons();

  const int w = S(kDefaultWidth);
  const int h = CalculateWindowHeight();
  int x, y;
  RECT saved;
  if (window_position_store::LoadRect(L"schedule_floating", saved)) {
    x = saved.left;
    y = saved.top;
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
  DestroyFonts();
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
  width = std::max(S(kMinWidth), width);
  height = std::max(S(kTitleBarHeight), height);
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
  const int w = rc.right - rc.left;
  // DPR 由 Dart 端下发，可能晚于窗口创建（创建时用的是 GetDpiForWindow 的
  // 虚拟化值）：缩放系数变化时同步修正窗口宽度，高度始终按内容重算。
  const int target_w = S(kDefaultWidth);
  const int new_h = CalculateWindowHeight();
  SetWindowPos(window_handle_, nullptr, 0, 0,
               std::max(target_w, S(kMinWidth)), new_h,
               w == target_w ? (SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE)
                             : (SWP_NOZORDER | SWP_NOACTIVATE));
  LayoutChildren();
  ApplyWindowRgn();
  InvalidateRect(window_handle_, nullptr, FALSE);
}

const ScheduleFloatingWindow::ScheduleItem*
ScheduleFloatingWindow::NextItem() const {
  for (const auto& item : items_) {
    if (!item.completed) return &item;
  }
  return nullptr;
}

int ScheduleFloatingWindow::ParseMinutes(const std::string& time_text) const {
  // 期望格式 "HH:MM"
  if (time_text.size() < 4 || time_text[2] != ':') return -1;
  int h = 0;
  int m = 0;
  for (int i = 0; i < 2; ++i) {
    char c = time_text[static_cast<size_t>(i)];
    if (c < '0' || c > '9') return -1;
    h = h * 10 + (c - '0');
  }
  for (int i = 3; i < 5; ++i) {
    char c = time_text[static_cast<size_t>(i)];
    if (c < '0' || c > '9') return -1;
    m = m * 10 + (c - '0');
  }
  if (h > 23 || m > 59) return -1;
  return h * 60 + m;
}

int ScheduleFloatingWindow::ParseHour(const std::string& time_text) const {
  int minutes = ParseMinutes(time_text);
  if (minutes < 0) return -1;
  return minutes / 60;
}

COLORREF ScheduleFloatingWindow::CategoryColor(int hour) const {
  // 对齐 in-app _categoryDot：<10 蓝 / <14 琥珀 / <18 绿 / 其它灰
  if (hour < 0) return kDotGray;
  if (hour < 10) return kDotBlue;
  if (hour < 14) return kDotAmber;
  if (hour < 18) return kDotGreen;
  return kDotGray;
}

std::wstring ScheduleFloatingWindow::CountdownLabel(int minutes_ahead) const {
  if (minutes_ahead < 1) return L"马上开始";
  if (minutes_ahead < 60) {
    wchar_t buf[32];
    wsprintfW(buf, L"%d分钟后", minutes_ahead);
    return buf;
  }
  wchar_t buf[32];
  int h = minutes_ahead / 60;
  int m = minutes_ahead % 60;
  if (m == 0) {
    wsprintfW(buf, L"%d小时后", h);
  } else {
    wsprintfW(buf, L"%d小时%d分后", h, m);
  }
  return buf;
}

int ScheduleFloatingWindow::CalculateWindowHeight() const {
  if (collapsed_) {
    return S(kTitleBarHeight);
  }
  // 顶栏 + 上内边距 + 日程带区块
  int body = S(10) + S(kStripBlockHeight);
  if (items_.empty()) {
    return S(kTitleBarHeight) + body + S(44) + S(8);
  }
  const ScheduleItem* next = NextItem();
  if (next != nullptr) {
    int focus_h = next->notes.empty() ? S(kFocusHeightNoNotes)
                                      : S(kFocusHeightNotes);
    body += focus_h + S(8);
  } else {
    body += S(kAllDoneBannerHeight) + S(8);
  }
  int visible = std::min(static_cast<int>(items_.size()), kMaxVisibleItems);
  for (int i = 0; i < visible; ++i) {
    body += items_[static_cast<size_t>(i)].notes.empty() ? S(kRowHeight)
                                                         : S(kRowHeightNotes);
  }
  int hidden = static_cast<int>(items_.size()) - visible;
  if (hidden > 0) {
    body += S(kFooterHeight);
  }
  body += S(8);  // 底部内边距
  return S(kTitleBarHeight) + body;
}

void ScheduleFloatingWindow::LayoutChildren() {
  if (!window_handle_) return;
  RECT rc;
  GetClientRect(window_handle_, &rc);
  const int width = rc.right - rc.left;
  const int btn_y = (S(kTitleBarHeight) - S(kCloseBtnSize)) / 2;

  int x = width - S(kCloseBtnSize) - S(8);
  if (btn_close_) {
    SetWindowPos(btn_close_, nullptr, x, btn_y,
                 S(kCloseBtnSize), S(kCloseBtnSize),
                 SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
  }
  x -= S(kCollapseBtnSize + 6);
  if (btn_collapse_) {
    SetWindowTextW(btn_collapse_, collapsed_ ? L"\u25BC" : L"\u25B2");
    SetWindowPos(btn_collapse_, nullptr, x, btn_y,
                 S(kCollapseBtnSize), S(kCollapseBtnSize),
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

void ScheduleFloatingWindow::DrawCircle(HDC hdc, int cx, int cy,
                                        double radius, COLORREF fill,
                                        COLORREF ring) {
  HBRUSH brush = CreateSolidBrush(fill);
  HPEN pen = (ring != 0) ? CreatePen(PS_SOLID, S(1), ring)
                         : CreatePen(PS_NULL, 0, 0);
  HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, pen));
  HBRUSH old_brush = static_cast<HBRUSH>(SelectObject(hdc, brush));
  int r = static_cast<int>(radius + 0.5);
  Ellipse(hdc, cx - r, cy - r, cx + r, cy + r);
  SelectObject(hdc, old_pen);
  SelectObject(hdc, old_brush);
  DeleteObject(brush);
  DeleteObject(pen);
}

void ScheduleFloatingWindow::DrawCalendarIcon(HDC hdc, int x, int y, int size,
                                               COLORREF color) {
  // 矢量绘制一个简洁的日历图标：外框 + 顶部两条挂钩线 + 顶部横条
  // 视觉对齐 Material Icons.calendar_today_outlined。
  HPEN pen = CreatePen(PS_SOLID, S(1), color);
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

void ScheduleFloatingWindow::DrawDayStrip(HDC hdc, int y, int width) {
  const int x0 = S(kBodyPadding);
  const int x1 = width - S(kBodyPadding);
  const int sw = x1 - x0;
  if (sw <= 0) return;

  const int now_min = NowMinutes();

  // 轨道
  const int bar_top = y + S(kStripBarTop);
  RECT track = {x0, bar_top, x1, bar_top + S(kStripBarHeight)};
  DrawRoundedRect(hdc, track, S(2), kTrack, 0);

  // 已流逝段
  int now_px = now_min * sw / 1440;
  if (now_px > S(2)) {
    RECT elapsed = {x0, bar_top, x0 + now_px, bar_top + S(kStripBarHeight)};
    DrawRoundedRect(hdc, elapsed, S(2), kElapsed, 0);
  }

  // 事项刻度
  const int cy = bar_top + S(kStripBarHeight) / 2;
  const ScheduleItem* next = NextItem();
  for (const auto& item : items_) {
    int minutes = ParseMinutes(item.time_text);
    if (minutes < 0) continue;
    int px = minutes * sw / 1440;
    if (px < 0) px = 0;
    if (px > sw) px = sw;
    if (&item == next) {
      // 下一事项：光晕 + 青色刻度
      DrawCircle(hdc, x0 + px, cy, Sd(4.0), kGlowCyan);
      DrawCircle(hdc, x0 + px, cy, Sd(2.5), kAccentCyan);
    } else if (item.completed) {
      DrawCircle(hdc, x0 + px, cy, Sd(2.0), kDotDoneFill);
    } else {
      DrawCircle(hdc, x0 + px, cy, Sd(2.0),
                 CategoryColor(ParseHour(item.time_text)));
    }
  }

  // now 游标：光晕 + 白芯
  if (now_px < 1) now_px = 1;
  if (now_px > sw - 1) now_px = sw - 1;
  const int needle_h = S(kNeedleHeight);
  RECT glow = {x0 + now_px - S(2), cy - needle_h / 2,
               x0 + now_px + S(2), cy + needle_h / 2};
  RECT core = {x0 + now_px - S(1), glow.top + S(1), x0 + now_px + S(1),
               glow.bottom - S(1)};
  HBRUSH glow_brush = CreateSolidBrush(kNeedleGlow);
  FillRect(hdc, &glow, glow_brush);
  DeleteObject(glow_brush);
  HBRUSH core_brush = CreateSolidBrush(kNeedleCore);
  FillRect(hdc, &core, core_brush);
  DeleteObject(core_brush);

  // 刻度标签：0/6/12/18/24 点均布
  const wchar_t* labels[] = {L"0点", L"6点", L"12点", L"18点", L"24点"};
  const int label_y = y + S(13);
  for (int i = 0; i < 5; ++i) {
    int cx = x0 + sw * i / 4;
    if (i == 0) cx = x0 + S(8);
    if (i == 4) cx = x1 - S(8);
    RECT lrc = {cx - S(24), label_y, cx + S(24), label_y + S(14)};
    DrawUiText(hdc, lrc, labels[i], font_caption_, kTickLabel,
               DT_CENTER | DT_SINGLELINE | DT_VCENTER);
  }
}

void ScheduleFloatingWindow::DrawFocusCard(HDC hdc, int y, int width,
                                           const ScheduleItem& next,
                                           int minutes_ahead) {
  const int h = next.notes.empty() ? S(kFocusHeightNoNotes)
                                   : S(kFocusHeightNotes);
  const int x0 = S(kBodyPadding);
  const int x1 = width - S(kBodyPadding);
  RECT card = {x0, y, x1, y + h};
  DrawRoundedRect(hdc, card, S(10), kFocusFill, kFocusBorder);

  const int cx = x0 + S(10);
  const int right = x1 - S(10);

  // 说明行：接下来 · 倒计时
  std::wstring caption = L"接下来 · " + CountdownLabel(minutes_ahead);
  RECT cap_rc = {cx, y + S(7), right, y + S(7) + S(13)};
  DrawUiText(hdc, cap_rc, caption, font_caption_, kAccentCyan,
             DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);

  // 时间 + 标题
  RECT time_rc = {cx, y + S(22), cx + S(48), y + S(22) + S(19)};
  DrawUiText(hdc, time_rc, Utf8ToWide(next.time_text), font_focus_time_,
             kFocusTime, DT_LEFT | DT_SINGLELINE | DT_VCENTER);
  RECT title_rc = {cx + S(54), y + S(24), right, y + S(24) + S(17)};
  DrawUiText(hdc, title_rc, Utf8ToWide(next.title), font_time_, kFocusTitle,
             DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);

  // 备注（地点别针 + 文本）
  if (!next.notes.empty()) {
    HPEN pen = CreatePen(PS_SOLID, S(1), kFocusNote);
    HBRUSH brush = CreateSolidBrush(kFocusNote);
    HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, pen));
    HBRUSH old_brush =
        static_cast<HBRUSH>(SelectObject(hdc, GetStockObject(NULL_BRUSH)));
    const int pin_y = y + S(45);
    Ellipse(hdc, cx, pin_y, cx + S(7), pin_y + S(7));       // 针头圆
    MoveToEx(hdc, cx + S(3), pin_y + S(7), nullptr);
    LineTo(hdc, cx + S(3), pin_y + S(12));                   // 针尾
    SelectObject(hdc, old_brush);
    SelectObject(hdc, old_pen);
    HBRUSH dot_brush = CreateSolidBrush(kFocusNote);
    old_brush = static_cast<HBRUSH>(SelectObject(hdc, dot_brush));
    Ellipse(hdc, cx + S(2), pin_y + S(2), cx + S(5), pin_y + S(5));
    SelectObject(hdc, old_brush);
    DeleteObject(dot_brush);
    DeleteObject(pen);
    DeleteObject(brush);
    RECT notes_rc = {cx + S(12), pin_y - S(1), right, pin_y - S(1) + S(14)};
    DrawUiText(hdc, notes_rc, Utf8ToWide(next.notes), font_notes_, kFocusNote,
               DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
  }
}

void ScheduleFloatingWindow::DrawAllDoneBanner(HDC hdc, int y, int width) {
  const int x0 = S(kBodyPadding);
  const int x1 = width - S(kBodyPadding);
  RECT banner = {x0, y, x1, y + S(kAllDoneBannerHeight)};
  DrawRoundedRect(hdc, banner, S(8), kAllDoneFill, kAllDoneBorder);

  const int cx = x0 + S(10);
  // 圆圈对勾
  HPEN pen = CreatePen(PS_SOLID, S(1), kAllDoneText);
  HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, pen));
  HBRUSH old_brush =
      static_cast<HBRUSH>(SelectObject(hdc, GetStockObject(NULL_BRUSH)));
  Ellipse(hdc, cx, y + S(7), cx + S(14), y + S(21));
  MoveToEx(hdc, cx + S(4), y + S(14), nullptr);
  LineTo(hdc, cx + S(6), y + S(17));
  LineTo(hdc, cx + S(11), y + S(11));
  SelectObject(hdc, old_brush);
  SelectObject(hdc, old_pen);
  DeleteObject(pen);

  RECT text_rc = {cx + S(20), y, x1 - S(10), y + S(kAllDoneBannerHeight)};
  DrawUiText(hdc, text_rc, L"今日安排已全部完成", font_notes_, kAllDoneText,
             DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
}

void ScheduleFloatingWindow::DrawTimeline(HDC hdc, int y, int width,
                                          const ScheduleItem* next) {
  const int visible = std::min(static_cast<int>(items_.size()),
                               kMaxVisibleItems);
  if (visible <= 0) return;
  const int x0 = S(kBodyPadding);
  const int right = width - S(kBodyPadding);
  const int line_x = x0 + S(kTimeColWidth) + S(kNodeColWidth) / 2;

  // 单行高度（含备注行更高）
  auto row_h = [&](const ScheduleItem& item) {
    return item.notes.empty() ? S(kRowHeight) : S(kRowHeightNotes);
  };

  // 竖向点线：从首行圆心连到末行圆心（先画线，圆点后画覆盖其上）
  if (visible > 1) {
    int acc = y;
    int first_center = 0;
    int last_center = 0;
    for (int i = 0; i < visible; ++i) {
      const ScheduleItem& item = items_[static_cast<size_t>(i)];
      int h = row_h(item);
      if (i == 0) first_center = acc + h / 2 - 1;
      if (i == visible - 1) last_center = acc + h / 2 - 1;
      acc += h;
    }
    HPEN pen = CreatePen(PS_SOLID, S(1), kTimelineLine);
    HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, pen));
    MoveToEx(hdc, line_x, first_center, nullptr);
    LineTo(hdc, line_x, last_center);
    SelectObject(hdc, old_pen);
    DeleteObject(pen);
  }

  int row_y = y;
  for (int i = 0; i < visible; ++i) {
    const ScheduleItem& item = items_[static_cast<size_t>(i)];
    const bool is_next = (&item == next);
    const int h = row_h(item);
    const int center_y = row_y + h / 2 - 1;

    // 时间
    RECT time_rc = {x0, row_y + S(3), x0 + S(kTimeColWidth),
                    row_y + S(3) + S(17)};
    DrawUiText(hdc, time_rc, Utf8ToWide(item.time_text), font_time_,
               item.completed ? kTimeDim
                              : (is_next ? kAccentCyan : kTimeColor),
               DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);

    // 圆点（光晕 + 实心/圆环）
    if (is_next) {
      DrawCircle(hdc, line_x, center_y, Sd(kGlowRadius), kGlowCyan);
      DrawCircle(hdc, line_x, center_y, Sd(kDotRadius), kAccentCyan);
    } else if (item.completed) {
      DrawCircle(hdc, line_x, center_y, Sd(kDotRadius), kDotDoneFill,
                 kDotDoneRing);
    } else {
      COLORREF c = CategoryColor(ParseHour(item.time_text));
      COLORREF glow = kGlowGray;
      if (c == kDotBlue) glow = kGlowBlue;
      else if (c == kDotAmber) glow = kGlowAmber;
      else if (c == kDotGreen) glow = kGlowGreen;
      DrawCircle(hdc, line_x, center_y, Sd(kGlowRadius), glow);
      DrawCircle(hdc, line_x, center_y, Sd(kDotRadius), c);
    }

    // 标题（完成态划线变淡；下一事项加粗高亮 + NOW 标签）
    int title_right = right;
    if (is_next) title_right = right - S(kNowTagWidth + 6);
    RECT title_rc = {line_x + S(kNodeColWidth) / 2 + 1, row_y + S(3),
                     title_right, row_y + S(3) + S(17)};
    DrawUiText(hdc, title_rc, Utf8ToWide(item.title),
               item.completed ? font_strike_
                              : (is_next ? font_time_ : font_ui_),
               item.completed ? kTextDim
                              : (is_next ? kTextPrimary : kTextBody),
               DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);

    if (is_next) {
      RECT tag = {right - S(kNowTagWidth), center_y - S(kNowTagHeight) / 2,
                  right, center_y + S(kNowTagHeight) / 2};
      DrawRoundedRect(hdc, tag, S(4), kNowTagBg, 0);
      DrawUiText(hdc, tag, L"NOW", font_caption_, kAccentCyan,
                 DT_CENTER | DT_SINGLELINE | DT_VCENTER);
    }

    // 备注
    if (!item.notes.empty()) {
      RECT notes_rc = {line_x + S(kNodeColWidth) / 2 + 1, row_y + S(24),
                       right, row_y + S(24) + S(14)};
      DrawUiText(hdc, notes_rc, Utf8ToWide(item.notes), font_notes_,
                 item.completed ? kTextDim : kTextSecondary,
                 DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
    }

    row_y += h;
  }
}

void ScheduleFloatingWindow::DrawFooter(HDC hdc, int y, int width,
                                        int hidden_count) {
  wchar_t buf[48];
  wsprintfW(buf, L"还有 %d 项安排", hidden_count);
  RECT rc = {S(kBodyPadding), y, width - S(kBodyPadding),
             y + S(kFooterHeight)};
  DrawUiText(hdc, rc, buf, font_notes_, kTextSecondary,
             DT_CENTER | DT_SINGLELINE | DT_VCENTER);
}

void ScheduleFloatingWindow::Paint(HWND hwnd, HDC hdc) {
  RECT rc;
  GetClientRect(hwnd, &rc);

  // 主背景
  HBRUSH bg = CreateSolidBrush(kSurfaceBg);
  FillRect(hdc, &rc, bg);
  DeleteObject(bg);

  // 窗口描边（1px 圆角）
  HPEN border_pen = CreatePen(PS_SOLID, S(1), kBorderColor);
  HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, border_pen));
  HBRUSH old_brush = static_cast<HBRUSH>(SelectObject(hdc, GetStockObject(NULL_BRUSH)));
  RECT border_rc = {0, 0, rc.right - 1, rc.bottom - 1};
  RoundRect(hdc, border_rc.left, border_rc.top, border_rc.right,
            border_rc.bottom, S(kCornerRadius), S(kCornerRadius));
  SelectObject(hdc, old_pen);
  SelectObject(hdc, old_brush);
  DeleteObject(border_pen);

  EnsureFonts();

  // ── 标题栏：[图标底座+📅] 今日安排  …  2/7  日期  [▲][✕] ──
  const int width = rc.right;
  const int chip_x = S(kBodyPadding);
  const int chip_y = (S(kTitleBarHeight) - S(kHeaderChipSize)) / 2;
  RECT chip = {chip_x, chip_y, chip_x + S(kHeaderChipSize),
               chip_y + S(kHeaderChipSize)};
  DrawRoundedRect(hdc, chip, S(6), kChipBg, 0);
  const int icon_pad = (S(kHeaderChipSize) - S(kCalIconSize)) / 2;
  DrawCalendarIcon(hdc, chip_x + icon_pad, chip_y + icon_pad - S(1),
                   S(kCalIconSize), kAccentCyan);

  RECT title_text_rc = {chip_x + S(kHeaderChipSize + 7), 0,
                        chip_x + S(kHeaderChipSize + 7) + S(90),
                        S(kTitleBarHeight)};
  DrawUiText(hdc, title_text_rc, L"今日安排", font_title_, kTextPrimary,
             DT_LEFT | DT_SINGLELINE | DT_VCENTER);

  const int date_right = width - S(kButtonZoneWidth) - S(2);

  // 完成计数（对齐 in-app 头部：标题 + done/total，无日期）
  if (!items_.empty() && !collapsed_) {
    int done = 0;
    for (const auto& item : items_) {
      if (item.completed) ++done;
    }
    wchar_t total_buf[8];
    wsprintfW(total_buf, L"/%d", static_cast<int>(items_.size()));
    std::wstring total_text = total_buf;
    SIZE total_size = {0, 0};
    GetTextExtentPoint32W(hdc, total_text.c_str(),
                          static_cast<int>(total_text.size()), &total_size);
    RECT total_rc = {date_right - total_size.cx, 0, date_right,
                     S(kTitleBarHeight)};
    DrawUiText(hdc, total_rc, total_text, font_time_, kTextSecondary,
               DT_LEFT | DT_SINGLELINE | DT_VCENTER);
    wchar_t done_buf[8];
    wsprintfW(done_buf, L"%d", done);
    std::wstring done_text = done_buf;
    SIZE done_size = {0, 0};
    GetTextExtentPoint32W(hdc, done_text.c_str(),
                          static_cast<int>(done_text.size()), &done_size);
    RECT done_rc = {total_rc.left - done_size.cx, 0, total_rc.left,
                    S(kTitleBarHeight)};
    DrawUiText(hdc, done_rc, done_text, font_time_, kAccentCyan,
               DT_LEFT | DT_SINGLELINE | DT_VCENTER);
  }

  if (collapsed_) {
    // 折叠态顶栏有富余：右侧显示日期
    std::wstring date_label = FormatTodayLabel();
    SIZE date_size = {0, 0};
    GetTextExtentPoint32W(hdc, date_label.c_str(),
                          static_cast<int>(date_label.size()), &date_size);
    RECT date_rc = {date_right - date_size.cx, 0, date_right,
                    S(kTitleBarHeight)};
    DrawUiText(hdc, date_rc, date_label, font_ui_, kTextSecondary,
               DT_LEFT | DT_SINGLELINE | DT_VCENTER);
    return;
  }

  int y = S(kTitleBarHeight) + S(10);

  // 24h 日程带
  DrawDayStrip(hdc, y, width);
  y += S(kStripBlockHeight);

  if (items_.empty()) {
    RECT empty_rc = {0, y, rc.right, y + S(44)};
    DrawUiText(hdc, empty_rc, L"今天还没有安排", font_ui_, kTextSecondary,
               DT_CENTER | DT_SINGLELINE | DT_VCENTER);
    return;
  }

  const ScheduleItem* next = NextItem();
  if (next != nullptr) {
    int ahead = ParseMinutes(next->time_text) - NowMinutes();
    if (ahead < 0) ahead = 0;
    DrawFocusCard(hdc, y, width, *next, ahead);
    y += (next->notes.empty() ? S(kFocusHeightNoNotes) : S(kFocusHeightNotes)) +
         S(8);
  } else {
    DrawAllDoneBanner(hdc, y, width);
    y += S(kAllDoneBannerHeight) + S(8);
  }

  // 时间轴
  DrawTimeline(hdc, y, width, next);

  // 底部折叠计数（行高需与 DrawTimeline 一致：含备注的行更高）
  int visible = std::min(static_cast<int>(items_.size()), kMaxVisibleItems);
  int hidden = static_cast<int>(items_.size()) - visible;
  if (hidden > 0) {
    int rows_h = 0;
    for (int i = 0; i < visible; ++i) {
      rows_h += items_[static_cast<size_t>(i)].notes.empty() ? S(kRowHeight)
                                                             : S(kRowHeightNotes);
    }
    DrawFooter(hdc, y + rows_h, width, hidden);
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
    case WM_DPICHANGED: {
      // 跨屏拖动 DPI 变化：重建字体并按新系数重排
      UpdateDpiScale();
      DestroyFonts();
      EnsureFonts();
      auto* sug = reinterpret_cast<RECT*>(lparam);
      int w = S(kDefaultWidth);
      int h = CalculateWindowHeight();
      SetWindowPos(hwnd, nullptr, sug->left, sug->top, w, h,
                   SWP_NOZORDER | SWP_NOACTIVATE);
      LayoutChildren();
      ApplyWindowRgn();
      InvalidateRect(hwnd, nullptr, FALSE);
      return 0;
    }
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
      if (pt.y < S(kTitleBarHeight)) {
        RECT rc;
        GetClientRect(hwnd, &rc);
        int btn_area_start = rc.right - S(kButtonZoneWidth) - S(8);
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
        SetTextColor(btn_dc, kBtnText);
      } else if (btn == btn_close_) {
        SetTextColor(btn_dc, kBtnText);
      }
      return reinterpret_cast<INT_PTR>(GetStockObject(NULL_BRUSH));
    }
    case WM_DRAWITEM: {
      // 自绘按钮（BS_OWNERDRAW）
      auto* dis = reinterpret_cast<DRAWITEMSTRUCT*>(lparam);
      if (dis == nullptr || dis->hwndItem == nullptr) break;
      HDC dc = dis->hDC;
      RECT rc = dis->rcItem;

      HBRUSH bg_brush = CreateSolidBrush(kBtnBg);
      FillRect(dc, &rc, bg_brush);
      DeleteObject(bg_brush);

      HPEN border_pen = CreatePen(PS_SOLID, 1, kBtnBorder);
      HPEN old_pen = static_cast<HPEN>(SelectObject(dc, border_pen));
      HBRUSH old_brush = static_cast<HBRUSH>(SelectObject(dc, GetStockObject(NULL_BRUSH)));
      Rectangle(dc, rc.left, rc.top, rc.right, rc.bottom);
      SelectObject(dc, old_pen);
      SelectObject(dc, old_brush);
      DeleteObject(border_pen);

      wchar_t text[8] = {0};
      GetWindowTextW(dis->hwndItem, text, 7);
      SetBkMode(dc, TRANSPARENT);
      SetTextColor(dc, kBtnText);
      HFONT font = (dis->hwndItem == btn_close_) ? font_title_ : font_ui_;
      HFONT old_font = static_cast<HFONT>(SelectObject(dc, font));
      RECT text_rc = rc;
      ::DrawTextW(dc, text, -1, &text_rc,
                  DT_CENTER | DT_SINGLELINE | DT_VCENTER);
      SelectObject(dc, old_font);

      if (dis->itemState & ODS_SELECTED) {
        HBRUSH dim = CreateSolidBrush(kFocusBorder);
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
