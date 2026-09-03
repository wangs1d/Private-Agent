#include "schedule_floating_window.h"

#include <algorithm>

#include <windowsx.h>

#include "window_position_store.h"

namespace {

// ═══════════════════════════════════════════════════════════════════
// 双主题调色板：逐字段对齐 right_side_panel.dart 的 _SchedSkin._dark /
// _SchedSkin._warm（docs/design/today-schedule-redesign）。
// Flutter 侧的半透明色（ARGB）按「alpha 混入对应底层」预计算为 GDI 实色：
//   深色底 = surfaceContainer #1C1C1C 上叠 cardFill(白3%) → #222222
//   浅色底 = surfaceContainer #F6F8FC 上叠 cardFill(纯白) → #FFFFFF
// 这样悬浮窗整体渲染色与 in-app 卡片逐层叠加后的最终效果一致。
// ═══════════════════════════════════════════════════════════════════

const ScheduleFloatingWindow::Palette kDarkPalette = {
    /*.surface_bg       =*/ RGB(34, 34, 34),      // cardFill 白3% over #1C1C1C
    /*.border           =*/ RGB(50, 50, 50),      // cardBorder 白7% over 卡底
    /*.text_primary     =*/ RGB(232, 232, 232),   // titleText #E8E8E8
    /*.text_body        =*/ RGB(222, 222, 222),   // bodyText #DEDEDE
    /*.text_secondary   =*/ RGB(152, 152, 152),   // mutedText #989898
    /*.text_dim         =*/ RGB(92, 96, 102),     // dimTitle #5C6066
    /*.text_strike      =*/ RGB(83, 83, 83),      // dimStrike 白22% over 卡底
    /*.time_dim         =*/ RGB(78, 81, 87),      // dimTime #4E5157
    /*.accent           =*/ RGB(0, 0, 0),         // accent #000000
    /*.accent_soft      =*/ RGB(0, 0, 0),         // accentSoft #000000
    /*.focus_border     =*/ RGB(24, 24, 24),      // focusBorder 黑30% over 卡底
    /*.focus_time       =*/ RGB(234, 253, 255),   // focusTime #EAFDFF
    /*.focus_note       =*/ RGB(143, 166, 173),   // focusNote #8FA6AD
    /*.dot_blue         =*/ RGB(0, 0, 0),         // dotBlue #000000
    /*.dot_amber        =*/ RGB(242, 185, 75),    // dotAmber #F2B94B
    /*.dot_green        =*/ RGB(0, 0, 0),         // dotGreen #000000
    /*.dot_gray         =*/ RGB(138, 143, 150),   // dotGray #8A8F96
    /*.glow_blue        =*/ RGB(28, 28, 28),      // dotBlue 18% over 卡底
    /*.glow_amber       =*/ RGB(71, 61, 41),      // dotAmber 18% over 卡底
    /*.glow_green       =*/ RGB(28, 28, 28),      // dotGreen 18% over 卡底
    /*.glow_gray        =*/ RGB(53, 54, 55),      // dotGray 18% over 卡底
    /*.glow_accent      =*/ RGB(22, 22, 22),      // accent 35% over 卡底
    /*.dot_done_fill    =*/ RGB(58, 61, 66),      // doneDotFill #3A3D42
    /*.dot_done_ring    =*/ RGB(107, 112, 118),   // doneDotRing #6B7076
    /*.timeline_line    =*/ RGB(54, 54, 54),      // line 白9% over 卡底
    /*.track            =*/ RGB(50, 50, 50),      // 轨道 白7% over 卡底
    /*.elapsed_start    =*/ RGB(57, 57, 57),      // 已流逝段 白10% over 卡底
    /*.elapsed_end      =*/ RGB(79, 79, 79),      // 已流逝段 #A3A3A3 35% over 卡底
    /*.needle           =*/ RGB(242, 245, 249),   // now 游标 #F2F5F9
    /*.needle_glow      =*/ RGB(3, 3, 3),         // 游标光晕 黑90% over 卡底
    /*.tick_label       =*/ RGB(85, 89, 95),      // tickLabel #55595F
    /*.now_tag_bg       =*/ RGB(30, 30, 30),      // NOW 底 accent 12% over 卡底
    /*.all_done_fill    =*/ RGB(31, 31, 31),      // 完成横幅底 dotGreen 8% over 卡底
    /*.all_done_border  =*/ RGB(26, 26, 26),      // 完成横幅描边 dotGreen 25% over 卡底
    /*.all_done_text    =*/ RGB(0, 0, 0),         // 完成横幅文字 dotGreen
    /*.btn_bg           =*/ RGB(38, 38, 40),      // 顶栏按钮底（in-app 无对应）
    /*.btn_border       =*/ RGB(58, 58, 62),      // 顶栏按钮描边
    /*.btn_text         =*/ RGB(222, 222, 222),   // 顶栏按钮文字
    /*.chip_grad_top    =*/ RGB(62, 62, 62),      // chipGradient[0] 灰22% over 卡底
    /*.chip_grad_bottom =*/ RGB(57, 57, 57),      // chipGradient[1] 灰18% over 卡底
    /*.focus_grad_top    =*/ RGB(30, 30, 30),     // focusGradient[0] 黑13% over 卡底
    /*.focus_grad_bottom =*/ RGB(32, 32, 32),     // focusGradient[1] 黑7% over 卡底
    /*.empty_icon_border =*/ RGB(27, 27, 27),     // accent 22% over 卡底
    /*.empty_bar         =*/ RGB(19, 19, 19),     // accent 45% over 卡底
    /*.empty_cell        =*/ RGB(74, 74, 74),     // emptyCell 白18% over 卡底
};

const ScheduleFloatingWindow::Palette kLightPalette = {
    /*.surface_bg       =*/ RGB(255, 255, 255),   // cardFill 纯白 over #F6F8FC
    /*.border           =*/ RGB(220, 227, 236),   // cardBorder #DCE3EC
    /*.text_primary     =*/ RGB(35, 40, 51),      // titleText #232833
    /*.text_body        =*/ RGB(35, 40, 51),      // bodyText #232833
    /*.text_secondary   =*/ RGB(152, 162, 179),   // mutedText #98A2B3
    /*.text_dim         =*/ RGB(152, 162, 179),   // dimTitle #98A2B3
    /*.text_strike      =*/ RGB(200, 201, 204),   // dimStrike #232833 25% over 白
    /*.time_dim         =*/ RGB(179, 188, 201),   // dimTime #B3BCC9
    /*.accent           =*/ RGB(185, 139, 67),    // accent #B98B43
    /*.accent_soft      =*/ RGB(168, 121, 47),    // accentSoft #A8792F
    /*.focus_border     =*/ RGB(231, 214, 189),   // focusBorder #B98B43 35% over 白
    /*.focus_time       =*/ RGB(35, 40, 51),      // focusTime #232833
    /*.focus_note       =*/ RGB(138, 148, 166),   // focusNote #8A94A6
    /*.dot_blue         =*/ RGB(91, 141, 239),    // dotBlue #5B8DEF
    /*.dot_amber        =*/ RGB(192, 138, 45),    // dotAmber #C08A2D
    /*.dot_green        =*/ RGB(47, 174, 132),    // dotGreen #2FAE84
    /*.dot_gray         =*/ RGB(152, 162, 179),   // dotGray #98A2B3
    /*.glow_blue        =*/ RGB(225, 234, 252),   // dotBlue 18% over 白
    /*.glow_amber       =*/ RGB(244, 234, 217),   // dotAmber 18% over 白
    /*.glow_green       =*/ RGB(218, 240, 233),   // dotGreen 18% over 白
    /*.glow_gray        =*/ RGB(237, 238, 241),   // dotGray 18% over 白
    /*.glow_accent      =*/ RGB(231, 214, 189),   // accent 35% over 白
    /*.dot_done_fill    =*/ RGB(221, 227, 236),   // doneDotFill #DDE3EC
    /*.dot_done_ring    =*/ RGB(174, 184, 198),   // doneDotRing #AEB8C6
    /*.timeline_line    =*/ RGB(238, 238, 239),   // line #232833 8% over 白
    /*.track            =*/ RGB(232, 237, 244),   // 轨道 #E8EDF4
    /*.elapsed_start    =*/ RGB(225, 231, 240),   // 已流逝段 #E1E7F0
    /*.elapsed_end      =*/ RGB(234, 220, 198),   // 已流逝段 #B98B43 30% over 白
    /*.needle           =*/ RGB(35, 40, 51),      // now 游标 #232833
    /*.needle_glow      =*/ RGB(199, 162, 105),   // 游标光晕 #B98B43 80% over 白
    /*.tick_label       =*/ RGB(152, 162, 179),   // tickLabel #98A2B3
    /*.now_tag_bg       =*/ RGB(247, 241, 232),   // NOW 底 accent 12% over 白
    /*.all_done_fill    =*/ RGB(238, 248, 245),   // 完成横幅底 dotGreen 8% over 白
    /*.all_done_border  =*/ RGB(203, 235, 224),   // 完成横幅描边 dotGreen 25% over 白
    /*.all_done_text    =*/ RGB(47, 174, 132),    // 完成横幅文字 dotGreen #2FAE84
    /*.btn_bg           =*/ RGB(240, 244, 249),   // 顶栏按钮底（in-app 无对应）
    /*.btn_border       =*/ RGB(220, 227, 236),   // 顶栏按钮描边
    /*.btn_text         =*/ RGB(35, 40, 51),      // 顶栏按钮文字
    /*.chip_grad_top    =*/ RGB(244, 236, 225),   // chipGradient[0] #B98B43 16% over 白
    /*.chip_grad_bottom =*/ RGB(238, 243, 253),   // chipGradient[1] #5B8DEF 10% over 白
    /*.focus_grad_top    =*/ RGB(248, 243, 236),  // focusGradient[0] #B98B43 10% over 白
    /*.focus_grad_bottom =*/ RGB(247, 249, 254),  // focusGradient[1] #5B8DEF 5% over 白
    /*.empty_icon_border =*/ RGB(240, 230, 214),  // accent 22% over 白
    /*.empty_bar         =*/ RGB(224, 203, 170),  // accent 45% over 白
    /*.empty_cell        =*/ RGB(207, 208, 210),  // emptyCell #232833 22% over 白
};


constexpr int kStripBarTop = 5;    // 日程带轨道在区块内的纵向偏移（逻辑 px）
constexpr int kStripBarHeight = 4;
constexpr int kNeedleHeight = 12;  // now 游标高（高出轨道两侧）
constexpr int kNowTagWidth = 32;   // NOW 标签宽
constexpr int kNowTagHeight = 14;  // NOW 标签高
constexpr int kButtonZoneWidth = 58;  // 顶栏右侧按钮占位（22+6+22+8）
constexpr int kEmptyBlockHeight = 124;  // 空态区块高（插画+文案）

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

const ScheduleFloatingWindow::Palette& ScheduleFloatingWindow::pal() const {
  return dark_theme_ ? kDarkPalette : kLightPalette;
}

void ScheduleFloatingWindow::SetTheme(bool dark) {
  if (dark_theme_ == dark) return;
  dark_theme_ = dark;
  if (!window_handle_) return;
  // 主题切换：整体重绘 + 顶栏按钮（owner-draw）随 WM_CTLCOLORBTN/WM_DRAWITEM 取新色
  InvalidateRect(window_handle_, nullptr, FALSE);
}

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
  font_title_ = CreateFontW(S(14), 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE,
                            DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                            CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                            DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  font_body_lg_ = CreateFontW(S(13), 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE,
                              FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
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
  if (font_body_lg_) {
    DeleteObject(font_body_lg_);
    font_body_lg_ = nullptr;
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
  if (hour < 0) return pal().dot_gray;
  if (hour < 10) return pal().dot_blue;
  if (hour < 14) return pal().dot_amber;
  if (hour < 18) return pal().dot_green;
  return pal().dot_gray;
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
    return S(kTitleBarHeight) + body + S(kEmptyBlockHeight) + S(8);
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
  body += visible * S(kRowHeight);
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

void ScheduleFloatingWindow::DrawGradientRounded(HDC hdc, const RECT& rc,
                                                 int radius, COLORREF top,
                                                 COLORREF bottom) {
  HRGN clip = CreateRoundRectRgn(rc.left, rc.top, rc.right + 1, rc.bottom + 1,
                                 S(radius), S(radius));
  SaveDC(hdc);
  SelectClipRgn(hdc, clip);
  int h = rc.bottom - rc.top;
  if (h <= 0) h = 1;
  constexpr int kGradientBands = 24;
  const int r0 = GetRValue(top), g0 = GetGValue(top), b0 = GetBValue(top);
  const int r1 = GetRValue(bottom), g1 = GetGValue(bottom), b1 = GetBValue(bottom);
  for (int i = 0; i < kGradientBands; ++i) {
    double t = (i + 0.5) / kGradientBands;
    HBRUSH br =
        CreateSolidBrush(RGB(static_cast<int>(r0 + (r1 - r0) * t),
                             static_cast<int>(g0 + (g1 - g0) * t),
                             static_cast<int>(b0 + (b1 - b0) * t)));
    RECT band = {rc.left, rc.top + i * h / kGradientBands, rc.right,
                 rc.top + (i + 1) * h / kGradientBands};
    FillRect(hdc, &band, br);
    DeleteObject(br);
  }
  RestoreDC(hdc, -1);
  DeleteObject(clip);
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
  DrawRoundedRect(hdc, track, S(2), pal().track, 0);

  // 已流逝段（渐变：elapsedStart→elapsedEnd，对齐 in-app）
  int now_px = now_min * sw / 1440;
  if (now_px > S(2)) {
    RECT elapsed = {x0, bar_top, x0 + now_px, bar_top + S(kStripBarHeight)};
    DrawGradientRounded(hdc, elapsed, 2, pal().elapsed_start, pal().elapsed_end);
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
      // 下一事项：accent 圆角刻度 + 光晕（对齐 in-app 5px 圆角方形）
      RECT g = {x0 + px - S(5), cy - S(5), x0 + px + S(5), cy + S(5)};
      DrawRoundedRect(hdc, g, S(4), pal().glow_accent, 0);
      RECT c = {x0 + px - S(3), cy - S(3), x0 + px + S(3), cy + S(3)};
      DrawRoundedRect(hdc, c, S(2), pal().accent, 0);
    } else if (item.completed) {
      DrawCircle(hdc, x0 + px, cy, Sd(2.0), pal().dot_done_fill);
    } else {
      DrawCircle(hdc, x0 + px, cy, Sd(2.0),
                 CategoryColor(ParseHour(item.time_text)));
    }
  }

  // now 游标：发光圆角竖条 + 白芯（对齐 in-app 2x12 圆角条）
  if (now_px < 1) now_px = 1;
  if (now_px > sw - 1) now_px = sw - 1;
  const int needle_h = S(kNeedleHeight);
  RECT glow = {x0 + now_px - S(5), cy - needle_h / 2,
               x0 + now_px + S(5), cy + needle_h / 2};
  DrawRoundedRect(hdc, glow, S(6), pal().needle_glow, 0);
  RECT core = {x0 + now_px - S(1), glow.top + S(1), x0 + now_px + S(1),
               glow.bottom - S(1)};
  DrawRoundedRect(hdc, core, S(2), pal().needle, 0);

  // 刻度标签：0/6/12/18/24 点均布
  const wchar_t* labels[] = {L"0点", L"6点", L"12点", L"18点", L"24点"};
  const int label_y = y + S(13);
  for (int i = 0; i < 5; ++i) {
    int cx = x0 + sw * i / 4;
    if (i == 0) cx = x0 + S(8);
    if (i == 4) cx = x1 - S(8);
    RECT lrc = {cx - S(24), label_y, cx + S(24), label_y + S(14)};
    DrawUiText(hdc, lrc, labels[i], font_caption_, pal().tick_label,
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
  DrawGradientRounded(hdc, card, 10, pal().focus_grad_top, pal().focus_grad_bottom);
  // 渐变后再补充青色描边（对齐 in-app 焦点卡 focusBorder）
  {
    HPEN pen = CreatePen(PS_SOLID, S(1), pal().focus_border);
    HBRUSH null_brush = static_cast<HBRUSH>(GetStockObject(NULL_BRUSH));
    HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, pen));
    HBRUSH old_brush = static_cast<HBRUSH>(SelectObject(hdc, null_brush));
    RoundRect(hdc, card.left, card.top, card.right, card.bottom, S(10), S(10));
    SelectObject(hdc, old_pen);
    SelectObject(hdc, old_brush);
    DeleteObject(pen);
  }

  const int cx = x0 + S(10);
  const int right = x1 - S(10);

  // 说明行：接下来 · 倒计时
  std::wstring caption = L"接下来 · " + CountdownLabel(minutes_ahead);
  RECT cap_rc = {cx, y + S(7), right, y + S(7) + S(13)};
  DrawUiText(hdc, cap_rc, caption, font_caption_, pal().accent_soft,
             DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);

  // 时间 + 标题
  RECT time_rc = {cx, y + S(22), cx + S(48), y + S(22) + S(19)};
  DrawUiText(hdc, time_rc, Utf8ToWide(next.time_text), font_focus_time_,
             pal().focus_time, DT_LEFT | DT_SINGLELINE | DT_VCENTER);
  RECT title_rc = {cx + S(54), y + S(24), right, y + S(24) + S(17)};
  DrawUiText(hdc, title_rc, Utf8ToWide(next.title), font_time_, pal().text_body,
             DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);

  // 备注（地点别针 + 文本）
  if (!next.notes.empty()) {
    HPEN pen = CreatePen(PS_SOLID, S(1), pal().focus_note);
    HBRUSH brush = CreateSolidBrush(pal().focus_note);
    HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, pen));
    HBRUSH old_brush =
        static_cast<HBRUSH>(SelectObject(hdc, GetStockObject(NULL_BRUSH)));
    const int pin_y = y + S(45);
    Ellipse(hdc, cx, pin_y, cx + S(7), pin_y + S(7));       // 针头圆
    MoveToEx(hdc, cx + S(3), pin_y + S(7), nullptr);
    LineTo(hdc, cx + S(3), pin_y + S(12));                   // 针尾
    SelectObject(hdc, old_brush);
    SelectObject(hdc, old_pen);
    HBRUSH dot_brush = CreateSolidBrush(pal().focus_note);
    old_brush = static_cast<HBRUSH>(SelectObject(hdc, dot_brush));
    Ellipse(hdc, cx + S(2), pin_y + S(2), cx + S(5), pin_y + S(5));
    SelectObject(hdc, old_brush);
    DeleteObject(dot_brush);
    DeleteObject(pen);
    DeleteObject(brush);
    RECT notes_rc = {cx + S(12), pin_y - S(1), right, pin_y - S(1) + S(14)};
    DrawUiText(hdc, notes_rc, Utf8ToWide(next.notes), font_notes_, pal().focus_note,
               DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
  }
}

void ScheduleFloatingWindow::DrawAllDoneBanner(HDC hdc, int y, int width) {
  const int x0 = S(kBodyPadding);
  const int x1 = width - S(kBodyPadding);
  RECT banner = {x0, y, x1, y + S(kAllDoneBannerHeight)};
  DrawRoundedRect(hdc, banner, S(10), pal().all_done_fill, pal().all_done_border);

  const int cx = x0 + S(10);
  // 圆圈对勾
  HPEN pen = CreatePen(PS_SOLID, S(1), pal().all_done_text);
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
  DrawUiText(hdc, text_rc, L"今日安排已全部完成", font_notes_, pal().all_done_text,
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
  const int h = S(kRowHeight);  // 恒定行高（对齐 in-app）

  // 竖向点线：从首行圆心连到末行圆心（先画线，圆点后画覆盖其上）
  if (visible > 1) {
    const int first_center = y + h / 2 - 1;
    const int last_center = y + (visible - 1) * h + h / 2 - 1;
    HPEN pen = CreatePen(PS_SOLID, S(1), pal().timeline_line);
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
    const int center_y = row_y + h / 2 - 1;

    // 时间
    RECT time_rc = {x0, row_y + S(3), x0 + S(kTimeColWidth),
                    row_y + S(3) + S(17)};
    DrawUiText(hdc, time_rc, Utf8ToWide(item.time_text), font_time_,
               item.completed ? pal().time_dim
                              : (is_next ? pal().accent : pal().text_secondary),
               DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);

    // 圆点（对齐 in-app 7px 圆点 + 光晕；光晕先画、实心/圆环覆盖其上）
    if (is_next) {
      DrawCircle(hdc, line_x, center_y, Sd(7.0), pal().glow_accent);
      DrawCircle(hdc, line_x, center_y, Sd(3.5), pal().accent);
    } else if (item.completed) {
      DrawCircle(hdc, line_x, center_y, Sd(3.5), pal().dot_done_fill, pal().dot_done_ring);
    } else {
      COLORREF c = CategoryColor(ParseHour(item.time_text));
      COLORREF glow = pal().glow_gray;
      if (c == pal().dot_blue) glow = pal().glow_blue;
      else if (c == pal().dot_amber) glow = pal().glow_amber;
      else if (c == pal().dot_green) glow = pal().glow_green;
      DrawCircle(hdc, line_x, center_y, Sd(7.0), glow);
      DrawCircle(hdc, line_x, center_y, Sd(3.5), c);
    }

    // 标题（完成态划线变淡；下一事项加粗高亮 + NOW 标签）
    int title_right = right;
    if (is_next) title_right = right - S(kNowTagWidth + 6);
    RECT title_rc = {line_x + S(kNodeColWidth) / 2 + 1, row_y + S(3),
                     title_right, row_y + S(3) + S(17)};
    DrawUiText(hdc, title_rc, Utf8ToWide(item.title),
               item.completed ? font_strike_
                              : (is_next ? font_time_ : font_ui_),
               item.completed ? pal().text_dim
                              : (is_next ? pal().text_primary : pal().text_body),
               DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);

    if (is_next) {
      RECT tag = {right - S(kNowTagWidth), center_y - S(kNowTagHeight) / 2,
                  right, center_y + S(kNowTagHeight) / 2};
      DrawRoundedRect(hdc, tag, S(4), pal().now_tag_bg, 0);
      DrawUiText(hdc, tag, L"NOW", font_caption_, pal().accent_soft,
                 DT_CENTER | DT_SINGLELINE | DT_VCENTER);
    }

    row_y += h;
  }
}

void ScheduleFloatingWindow::DrawFooter(HDC hdc, int y, int width,
                                        int hidden_count) {
  wchar_t buf[48];
  wsprintfW(buf, L"还有 %d 项安排 · 查看全部 ›", hidden_count);
  RECT rc = {S(kBodyPadding), y, width - S(kBodyPadding),
             y + S(kFooterHeight)};
  DrawUiText(hdc, rc, buf, font_notes_, pal().text_secondary,
             DT_CENTER | DT_SINGLELINE | DT_VCENTER);
}

void ScheduleFloatingWindow::DrawEmptyState(HDC hdc, int y, int width) {
  // 空态插画配色对齐 in-app：边框 accent 22% / 横条 accent 45% / 格子 emptyCell
  const COLORREF empty_icon_border = pal().empty_icon_border;
  const COLORREF empty_bar = pal().empty_bar;
  const COLORREF empty_cell = pal().empty_cell;

  const int cx = width / 2;

  // 插画块：44x44 圆角渐变底座 + 日历网格
  const int icon = S(44);
  const int ix = cx - icon / 2;
  RECT illu = {ix, y, ix + icon, y + icon};
  DrawGradientRounded(hdc, illu, 12, pal().chip_grad_top, pal().chip_grad_bottom);
  {
    HPEN pen = CreatePen(PS_SOLID, S(1), empty_icon_border);
    HBRUSH null_brush = static_cast<HBRUSH>(GetStockObject(NULL_BRUSH));
    HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, pen));
    HBRUSH old_brush = static_cast<HBRUSH>(SelectObject(hdc, null_brush));
    RoundRect(hdc, illu.left, illu.top, illu.right, illu.bottom, S(12), S(12));
    SelectObject(hdc, old_pen);
    SelectObject(hdc, old_brush);
    DeleteObject(pen);
  }
  // 顶部横条
  RECT bar = {ix + S(10), y + S(9), ix + icon - S(10), y + S(9) + S(6)};
  DrawRoundedRect(hdc, bar, S(2), empty_bar, 0);
  // 4 个格子
  const int cell = S(7);
  const int cell_x[] = {S(10), S(27)};
  const int cell_y[] = {S(20), S(29)};
  for (int cyi = 0; cyi < 2; ++cyi) {
    for (int cxi = 0; cxi < 2; ++cxi) {
      RECT c = {ix + cell_x[cxi], y + cell_y[cyi], ix + cell_x[cxi] + cell,
                y + cell_y[cyi] + cell};
      DrawRoundedRect(hdc, c, S(2), empty_cell, 0);
    }
  }

  // 「今天还没有安排」
  int ty = y + icon + S(12);
  RECT title_rc = {0, ty, width, ty + S(22)};
  DrawUiText(hdc, title_rc, L"今天还没有安排", font_title_, pal().text_primary,
             DT_CENTER | DT_SINGLELINE | DT_VCENTER);

  // 引导文案（两行）
  int gy = ty + S(22) + S(6);
  RECT guide_rc = {S(kBodyPadding), gy, width - S(kBodyPadding),
                   gy + S(38)};
  DrawUiText(hdc, guide_rc,
             L"对我说「明天 9 点提醒我开会」\n我来帮你记录并到点提醒",
             font_body_lg_, pal().text_secondary, DT_CENTER | DT_NOCLIP);
}

void ScheduleFloatingWindow::Paint(HWND hwnd, HDC hdc) {
  RECT rc;
  GetClientRect(hwnd, &rc);

  // 主背景
  HBRUSH bg = CreateSolidBrush(pal().surface_bg);
  FillRect(hdc, &rc, bg);
  DeleteObject(bg);

  // 窗口描边（1px 圆角）
  HPEN border_pen = CreatePen(PS_SOLID, S(1), pal().border);
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
  DrawGradientRounded(hdc, chip, 6, pal().chip_grad_top, pal().chip_grad_bottom);
  const int icon_pad = (S(kHeaderChipSize) - S(kCalIconSize)) / 2;
  DrawCalendarIcon(hdc, chip_x + icon_pad, chip_y + icon_pad - S(1),
                   S(kCalIconSize), pal().accent);

  RECT title_text_rc = {chip_x + S(kHeaderChipSize + 7), 0,
                        chip_x + S(kHeaderChipSize + 7) + S(90),
                        S(kTitleBarHeight)};
  DrawUiText(hdc, title_text_rc, L"今日安排", font_title_, pal().text_primary,
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
    DrawUiText(hdc, total_rc, total_text, font_title_, pal().text_secondary,
               DT_LEFT | DT_SINGLELINE | DT_VCENTER);
    wchar_t done_buf[8];
    wsprintfW(done_buf, L"%d", done);
    std::wstring done_text = done_buf;
    SIZE done_size = {0, 0};
    GetTextExtentPoint32W(hdc, done_text.c_str(),
                          static_cast<int>(done_text.size()), &done_size);
    RECT done_rc = {total_rc.left - done_size.cx, 0, total_rc.left,
                    S(kTitleBarHeight)};
    DrawUiText(hdc, done_rc, done_text, font_title_, pal().accent_soft,
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
    DrawUiText(hdc, date_rc, date_label, font_ui_, pal().text_secondary,
               DT_LEFT | DT_SINGLELINE | DT_VCENTER);
    return;
  }

  int y = S(kTitleBarHeight) + S(10);

  // 24h 日程带
  DrawDayStrip(hdc, y, width);
  y += S(kStripBlockHeight);

  if (items_.empty()) {
    DrawEmptyState(hdc, y, rc.right);
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

  // 底部折叠计数
  int visible = std::min(static_cast<int>(items_.size()), kMaxVisibleItems);
  int hidden = static_cast<int>(items_.size()) - visible;
  if (hidden > 0) {
    DrawFooter(hdc, y + visible * S(kRowHeight), width, hidden);
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
        SetTextColor(btn_dc, pal().btn_text);
      } else if (btn == btn_close_) {
        SetTextColor(btn_dc, pal().btn_text);
      }
      return reinterpret_cast<INT_PTR>(GetStockObject(NULL_BRUSH));
    }
    case WM_DRAWITEM: {
      // 自绘按钮（BS_OWNERDRAW）
      auto* dis = reinterpret_cast<DRAWITEMSTRUCT*>(lparam);
      if (dis == nullptr || dis->hwndItem == nullptr) break;
      HDC dc = dis->hDC;
      RECT rc = dis->rcItem;

      HBRUSH bg_brush = CreateSolidBrush(pal().btn_bg);
      FillRect(dc, &rc, bg_brush);
      DeleteObject(bg_brush);

      HPEN border_pen = CreatePen(PS_SOLID, 1, pal().btn_border);
      HPEN old_pen = static_cast<HPEN>(SelectObject(dc, border_pen));
      HBRUSH old_brush = static_cast<HBRUSH>(SelectObject(dc, GetStockObject(NULL_BRUSH)));
      Rectangle(dc, rc.left, rc.top, rc.right, rc.bottom);
      SelectObject(dc, old_pen);
      SelectObject(dc, old_brush);
      DeleteObject(border_pen);

      wchar_t text[8] = {0};
      GetWindowTextW(dis->hwndItem, text, 7);
      SetBkMode(dc, TRANSPARENT);
      SetTextColor(dc, pal().btn_text);
      HFONT font = (dis->hwndItem == btn_close_) ? font_title_ : font_ui_;
      HFONT old_font = static_cast<HFONT>(SelectObject(dc, font));
      RECT text_rc = rc;
      ::DrawTextW(dc, text, -1, &text_rc,
                  DT_CENTER | DT_SINGLELINE | DT_VCENTER);
      SelectObject(dc, old_font);

      if (dis->itemState & ODS_SELECTED) {
        HBRUSH dim = CreateSolidBrush(pal().focus_border);
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
