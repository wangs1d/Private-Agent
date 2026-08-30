#include "desktop_notification_window.h"

#include <dwmapi.h>
#include <windowsx.h>

#include <algorithm>

// ── 透明度：整窗 Alpha（WS_EX_LAYERED 配合 COLORREF 通道混合） ──
//    面板底色 rgba(58,58,64, 72%) ≈ 72% 不透明
constexpr BYTE kWindowAlpha = 184;  // 255 * 0.72 ≈ 184

namespace {

// 新版配色：深色半透明 macOS 风格
constexpr COLORREF kPanelBg       = RGB(0x3A, 0x3A, 0x40);  // 面板深色底
constexpr COLORREF kPanelBorder   = RGB(0x60, 0x60, 0x68);  // 1px 边（GDI 实色，透明度由整窗 Alpha 稀释）
constexpr COLORREF kDivider       = RGB(0x8C, 0x8C, 0x96);  // 顶部分隔线
constexpr COLORREF kTextWhite     = RGB(0xFF, 0xFF, 0xFF);
constexpr COLORREF kTextDim       = RGB(0xBD, 0xBD, 0xBD);  // 副标题 55% 明度
constexpr COLORREF kTextBody      = RGB(0xDD, 0xDD, 0xDF);  // 正文 82% 明度
constexpr COLORREF kIconBg        = RGB(0x8A, 0x8A, 0x93);  // 图标胶囊 14% 白（实色+整窗alpha=透明）
constexpr COLORREF kCloseBg       = RGB(0x00, 0x00, 0x00);  // 关闭钮深色底 25%
constexpr COLORREF kCloseBgHover  = RGB(0x30, 0x30, 0x36);  // 关闭 hover
constexpr COLORREF kCloseGlyph    = RGB(0xE8, 0xE8, 0xEC);  // × 白
constexpr COLORREF kBtnDismissBg  = RGB(0x70, 0x70, 0x76);  // "稍后" 弱按钮 12%
constexpr COLORREF kBtnDismissBd  = RGB(0x86, 0x86, 0x90);  // 弱化描边
constexpr COLORREF kBtnConfirmBg  = RGB(0xF5, 0xF5, 0xF7);  // "知道了" 白填
constexpr COLORREF kBtnConfirmTx  = RGB(0x1D, 0x1D, 0x1F);  // 知道了 深色字
constexpr COLORREF kInnerHighlight= RGB(0x9A, 0x9A, 0xA0);  // 内 1px 高光（极淡）

// 字形（Segoe MDL2 Assets：EA2F = Bell 通知铃铛 近似）
// 用线条自绘小铃铛图标更稳，不依赖字体存在与否

std::wstring Utf8ToWide(const std::string& s) {
  if (s.empty()) return L"";
  int len = MultiByteToWideChar(CP_UTF8, 0, s.c_str(),
                                static_cast<int>(s.size()), nullptr, 0);
  std::wstring out(len, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()),
                      out.data(), len);
  return out;
}

COLORREF PriorityAccent(const std::wstring& priority) {
  // 只在"图标胶囊"上叠一层主题色高光，不是满版顶色条
  if (priority == L"urgent") return RGB(0xFF, 0x3B, 0x30);  // 红
  if (priority == L"high")   return RGB(0xFF, 0x95, 0x00);  // 橙
  return RGB(0x34, 0xC7, 0x59);  // 默认绿（提醒）
}

// 启用 DWM 阴影 + 圆角
void EnableDwmShadow(HWND hwnd) {
  DWMNCRENDERINGPOLICY policy = DWMNCRP_ENABLED;
  DwmSetWindowAttribute(hwnd, DWMWA_NCRENDERING_POLICY,
                        &policy, sizeof(policy));
  MARGINS margins = {0, 0, 0, 1};
  DwmExtendFrameIntoClientArea(hwnd, &margins);
  BOOL prefer_rounded = DWMWCP_ROUNDSMALL;
  DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE,
                        &prefer_rounded, sizeof(prefer_rounded));
}

void SetRectEx(RECT* rc, int l, int t, int r, int b) {
  SetRect(rc, l, t, r, b);
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
  wc.cbSize        = sizeof(WNDCLASSEXW);
  wc.style         = CS_HREDRAW | CS_VREDRAW | CS_DBLCLKS;
  wc.lpfnWndProc   = DesktopNotificationWindow::WndProc;
  wc.hInstance     = GetModuleHandle(nullptr);
  wc.hCursor       = LoadCursor(nullptr, IDC_ARROW);
  wc.hbrBackground = nullptr;
  wc.lpszClassName = kClassName;
  RegisterClassExW(&wc);
  registered = true;
}

bool DesktopNotificationWindow::CreateWindowIfNeeded() {
  if (window_handle_) return true;
  EnsureClassRegistered();

  // WS_EX_LAYERED + SetLayeredWindowAttributes 提供整窗 alpha，
  // 面板实色填充经过整窗alpha稀释后得到半透明毛玻璃底观感。
  DWORD ex_style = WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED;
  DWORD style    = WS_POPUP | WS_CLIPCHILDREN;

  HWND hwnd = CreateWindowExW(
      ex_style, kClassName, L"", style, 0, 0, kWindowWidth, kWindowHeight,
      nullptr, nullptr, GetModuleHandle(nullptr), this);
  if (!hwnd) return false;
  window_handle_ = hwnd;

  // 整窗 Alpha ≈ 72%（COLORREF 颜色通道仍用实色，透过度由 LWA_ALPHA 统一控）
  SetLayeredWindowAttributes(hwnd, 0, kWindowAlpha, LWA_ALPHA);
  EnableDwmShadow(hwnd);

  // ── 稍后（左按钮） ──
  dismiss_btn_ = CreateWindowExW(
      0, L"BUTTON", L"",
      WS_CHILD | WS_VISIBLE | BS_OWNERDRAW, 0, 0, 0, 0, hwnd,
      reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdDismiss)),
      GetModuleHandle(nullptr), nullptr);
  // ── 知道了（右按钮） ──
  confirm_btn_ = CreateWindowExW(
      0, L"BUTTON", L"",
      WS_CHILD | WS_VISIBLE | BS_OWNERDRAW, 0, 0, 0, 0, hwnd,
      reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdConfirm)),
      GetModuleHandle(nullptr), nullptr);
  // ── 右上角 × 圆形关闭钮 ──
  close_btn_ = CreateWindowExW(
      0, L"BUTTON", L"",
      WS_CHILD | WS_VISIBLE | BS_OWNERDRAW, 0, 0, 0, 0, hwnd,
      reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdClose)),
      GetModuleHandle(nullptr), nullptr);

  HFONT font = reinterpret_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT));
  SendMessage(dismiss_btn_, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
  SendMessage(confirm_btn_, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
  SendMessage(close_btn_,   WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);

  dismiss_brush_        = CreateSolidBrush(kBtnDismissBg);
  dismiss_border_brush_ = CreateSolidBrush(kBtnDismissBd);
  confirm_brush_        = CreateSolidBrush(kBtnConfirmBg);
  return true;
}

void DesktopNotificationWindow::LayoutChildren() {
  if (!window_handle_) return;
  // ── 关闭钮：右上角 22×22 ──
  SetWindowPos(close_btn_, nullptr, kWindowWidth - 22 - 14, 14, 22, 22,
               SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);

  // ── 底部按钮：右下对齐并排 ──
  //  高度 32 · 稍后 auto-width（默认 64） · 知道了 auto（默认 84） · gap 10
  constexpr int kBtnH   = 32;
  constexpr int kGap    = 10;
  constexpr int kPadB   = 12;
  constexpr int kPadRL  = 16;
  const int btn_y       = kWindowHeight - kPadB - kBtnH;

  int confirm_w = 84;
  if (!confirm_text_.empty() && confirm_text_.size() > 4) confirm_w = 100;
  const int confirm_x = kWindowWidth - kPadRL - confirm_w;

  if (show_confirm_button_) {
    const int dismiss_w = 64;
    const int dismiss_x = confirm_x - kGap - dismiss_w;
    SetWindowPos(dismiss_btn_, nullptr, dismiss_x, btn_y, dismiss_w, kBtnH,
                 SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    SetWindowPos(confirm_btn_, nullptr, confirm_x, btn_y, confirm_w, kBtnH,
                 SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
  } else {
    // 无确认按钮：仅一个按钮居中偏右（替代稍后作为"知道了"唯一入口）
    if (dismiss_btn_) ShowWindow(dismiss_btn_, SW_HIDE);
    const int single_w = 100;
    SetWindowPos(confirm_btn_, nullptr, kWindowWidth - kPadRL - single_w, btn_y,
                 single_w, kBtnH,
                 SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
  }
}

void DesktopNotificationWindow::PositionAtBottomRight() {
  if (!window_handle_) return;
  MONITORINFO mi = {sizeof(mi)};
  GetMonitorInfoW(MonitorFromWindow(window_handle_, MONITOR_DEFAULTTONEAREST),
                  &mi);
  const int x = mi.rcWork.right  - kWindowWidth  - kMargin;
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
  // header_title 固定"系统通知"（对齐设计稿图示），message 的首行做正文标题+正文拆
  // 为了保持最小改动：把 title 填进 header 主标题；没有的话用 priority 对应标签
  header_title_         = Utf8ToWide(title.empty() ? "系统通知" : title);
  message_              = Utf8ToWide(message);
  priority_             = Utf8ToWide(priority);
  confirm_text_         = Utf8ToWide(confirm_text.empty() ? "知道了" : confirm_text);
  dismiss_text_         = L"\u7A0D\u540E";  // "稍后"
  show_confirm_button_  = show_confirm_button;
  auto_close_ms_        = auto_close_ms;
  if (!CreateWindowIfNeeded()) return;
  PositionAtBottomRight();
  StartTimer();
  InvalidateRect(window_handle_, nullptr, TRUE);
}

void DesktopNotificationWindow::Hide() {
  StopTimer();
  if (window_handle_) ShowWindow(window_handle_, SW_HIDE);
}

bool DesktopNotificationWindow::IsVisible() const {
  return window_handle_ && IsWindowVisible(window_handle_);
}

void DesktopNotificationWindow::StartTimer() {
  StopTimer();
  if (window_handle_ && auto_close_ms_ > 0) {
    SetTimer(window_handle_, kAutoCloseTimerId,
             static_cast<UINT>(auto_close_ms_), nullptr);
  }
}

void DesktopNotificationWindow::StopTimer() {
  if (window_handle_) KillTimer(window_handle_, kAutoCloseTimerId);
}

void DesktopNotificationWindow::DestroyNativeWindow() {
  StopTimer();
  if (dismiss_btn_ && IsWindow(dismiss_btn_)) DestroyWindow(dismiss_btn_);
  if (confirm_btn_ && IsWindow(confirm_btn_)) DestroyWindow(confirm_btn_);
  if (close_btn_   && IsWindow(close_btn_))   DestroyWindow(close_btn_);
  dismiss_btn_ = nullptr; confirm_btn_ = nullptr; close_btn_ = nullptr;
  if (dismiss_brush_)        DeleteObject(dismiss_brush_);
  if (dismiss_border_brush_) DeleteObject(dismiss_border_brush_);
  if (confirm_brush_)        DeleteObject(confirm_brush_);
  dismiss_brush_ = dismiss_border_brush_ = confirm_brush_ = nullptr;
  if (window_handle_ && IsWindow(window_handle_)) DestroyWindow(window_handle_);
  window_handle_ = nullptr;
}

// ═════════════════════════════════ 绘制 ═════════════════════════════════

void DesktopNotificationWindow::DrawRoundedFill(HDC hdc, const RECT& rc,
                                                 int radius, COLORREF fill) {
  HBRUSH brush = CreateSolidBrush(fill);
  HPEN pen = CreatePen(PS_NULL, 0, 0);
  HBRUSH ob = static_cast<HBRUSH>(SelectObject(hdc, brush));
  HPEN op = static_cast<HPEN>(SelectObject(hdc, pen));
  RoundRect(hdc, rc.left, rc.top, rc.right, rc.bottom, radius * 2, radius * 2);
  SelectObject(hdc, ob); SelectObject(hdc, op);
  DeleteObject(brush); DeleteObject(pen);
}

void DesktopNotificationWindow::DrawBellIcon(HDC hdc, const RECT& rc,
                                             COLORREF bg, COLORREF glyph) {
  // 28×28 胶囊底 + 白色铃铛线条图标
  // 先画圆角方（胶囊：高度=28 圆角=8 或一半=14 即圆形）
  DrawRoundedFill(hdc, rc, 8, bg);

  // 铃铛：用多条直线 + 半圆拼（在 16×16 居中画布上画）
  const int cx = (rc.left + rc.right) / 2;
  const int cy = (rc.top + rc.bottom) / 2;
  HPEN pen = CreatePen(PS_SOLID, 1, glyph);
  HPEN op  = static_cast<HPEN>(SelectObject(hdc, pen));
  HBRUSH bg_brush = static_cast<HBRUSH>(GetStockObject(NULL_BRUSH));
  HBRUSH ob = static_cast<HBRUSH>(SelectObject(hdc, bg_brush));

  // 铃体：椭圆
  Ellipse(hdc, cx - 5, cy - 7, cx + 5, cy + 4);
  // 底部小圆（铃舌）
  Ellipse(hdc, cx - 2, cy + 4, cx + 2, cy + 7);
  // 铃把：顶部短弧
  Arc(hdc, cx - 3, cy - 8, cx + 3, cy - 2, cx - 3, cy - 5, cx + 3, cy - 5);

  SelectObject(hdc, ob); SelectObject(hdc, op);
  DeleteObject(pen);
}

void DesktopNotificationWindow::DrawCloseButton(HDC hdc, const RECT& rc,
                                                 bool hovered) {
  // 圆形底
  HRGN rgn = CreateEllipticRgn(rc.left, rc.top, rc.right, rc.bottom);
  COLORREF fill = hovered ? kCloseBgHover : kCloseBg;
  HBRUSH b = CreateSolidBrush(fill);
  FillRgn(hdc, rgn, b);
  DeleteObject(b); DeleteObject(rgn);

  // × 两划
  const int cx = (rc.left + rc.right) / 2;
  const int cy = (rc.top + rc.bottom) / 2;
  const int s  = 5;
  HPEN pen = CreatePen(PS_SOLID, 1, kCloseGlyph);
  HPEN op = static_cast<HPEN>(SelectObject(hdc, pen));
  MoveToEx(hdc, cx - s, cy - s, nullptr); LineTo(hdc, cx + s, cy + s);
  MoveToEx(hdc, cx + s, cy - s, nullptr); LineTo(hdc, cx - s, cy + s);
  SelectObject(hdc, op); DeleteObject(pen);
}

void DesktopNotificationWindow::DrawRoundedPillButton(HDC hdc, const RECT& rc,
    COLORREF fill, COLORREF border, const std::wstring& label,
    COLORREF text_color) {
  // 填充
  DrawRoundedFill(hdc, rc, 8, fill);
  // 描边（仅当 border 存在）
  HRGN rgn = CreateRoundRectRgn(rc.left, rc.top, rc.right, rc.bottom, 16, 16);
  FrameRgn(hdc, rgn, CreateSolidBrush(border), 1, 1);
  DeleteObject(rgn);
  // 文字
  HFONT f = CreateFontW(-13, 0, 0, 0, FW_MEDIUM, FALSE, FALSE, FALSE,
                        DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                        CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                        DEFAULT_PITCH | FF_SWISS, L"Microsoft YaHei UI");
  HFONT of = static_cast<HFONT>(SelectObject(hdc, f));
  SetBkMode(hdc, TRANSPARENT);
  SetTextColor(hdc, text_color);
  RECT tr = rc;
  DrawTextW(hdc, label.c_str(), -1, &tr,
            DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
  SelectObject(hdc, of); DeleteObject(f);
}

void DesktopNotificationWindow::DrawHeaderText(HDC hdc,
    const std::wstring& main, const std::wstring& sub, const RECT& rc) {
  // 主标题 14px semibold 白
  HFONT main_f = CreateFontW(-14, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
                             DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                             CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                             DEFAULT_PITCH | FF_SWISS, L"Microsoft YaHei UI");
  HFONT of = static_cast<HFONT>(SelectObject(hdc, main_f));
  SetBkMode(hdc, TRANSPARENT);
  SetTextColor(hdc, kTextWhite);
  RECT mr = rc; mr.bottom = rc.top + 16;
  DrawTextW(hdc, main.c_str(), -1, &mr,
            DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
  SelectObject(hdc, of); DeleteObject(main_f);

  // 副标题 12px dim
  HFONT sub_f = CreateFontW(-12, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                            DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                            CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                            DEFAULT_PITCH | FF_SWISS, L"Microsoft YaHei UI");
  of = static_cast<HFONT>(SelectObject(hdc, sub_f));
  SetTextColor(hdc, kTextDim);
  RECT sr = rc; sr.top = rc.top + 15;
  DrawTextW(hdc, sub.c_str(), -1, &sr,
            DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
  SelectObject(hdc, of); DeleteObject(sub_f);
}

void DesktopNotificationWindow::Paint(HWND hwnd, HDC hdc) {
  RECT rc; GetClientRect(hwnd, &rc);
  HDC mem = CreateCompatibleDC(hdc);
  HBITMAP bmp = CreateCompatibleBitmap(hdc, rc.right, rc.bottom);
  HBITMAP ob  = static_cast<HBITMAP>(SelectObject(mem, bmp));

  // ── 1) 面板深色实色底（整窗 Alpha 负责半透明） ──
  DrawRoundedFill(mem, rc, kCornerRadius, kPanelBg);

  // ── 2) 1px 细描边（外） ──
  {
    HRGN rgn = CreateRoundRectRgn(rc.left, rc.top, rc.right, rc.bottom,
                                  kCornerRadius * 2, kCornerRadius * 2);
    HBRUSH bd = CreateSolidBrush(kPanelBorder);
    FrameRgn(mem, rgn, bd, 1, 1);
    DeleteObject(bd); DeleteObject(rgn);
  }

  // ── 3) 内 1px 高光（靠上 1/2 边，模拟毛玻璃反射） ──
  {
    HPEN pen = CreatePen(PS_SOLID, 1, kInnerHighlight);
    HPEN op = static_cast<HPEN>(SelectObject(mem, pen));
    HBRUSH nb = static_cast<HBRUSH>(GetStockObject(NULL_BRUSH));
    HBRUSH ob2 = static_cast<HBRUSH>(SelectObject(mem, nb));
    // 仅画上边 + 左右上 1/3 的弧，模拟"顶部高光"
    Arc(mem, 0, 0, kCornerRadius * 2, kCornerRadius * 2,
        0, kCornerRadius, kCornerRadius, 0);                       // 左上 1/4
    MoveToEx(mem, kCornerRadius, 0, nullptr);
    LineTo(mem, kWindowWidth - kCornerRadius, 0);                   // 上边
    Arc(mem, kWindowWidth - kCornerRadius * 2, 0, kWindowWidth, kCornerRadius * 2,
        kWindowWidth - kCornerRadius, 0, kWindowWidth, kCornerRadius);  // 右上
    SelectObject(mem, ob2); SelectObject(mem, op); DeleteObject(pen);
  }

  // ── 4) 顶部栏：图标 + 主副文字 ──
  constexpr int kPad = 16;
  constexpr int kHeaderTop = 14;
  constexpr int kIconSize = 28;
  RECT icon_rc;
  SetRectEx(&icon_rc, kPad, kHeaderTop, kPad + kIconSize, kHeaderTop + kIconSize);
  // 图标胶囊色：用局部非 const 变量阻止编译期常量折叠
  COLORREF accent_col = PriorityAccent(priority_);
  COLORREF icon_base = kIconBg;  // 运行时拷贝，避免 const 折叠
  int ir = int(GetRValue(icon_base)) * 85 + int(GetRValue(accent_col)) * 15;
  int ig = int(GetGValue(icon_base)) * 85 + int(GetGValue(accent_col)) * 15;
  int ib = int(GetBValue(icon_base)) * 85 + int(GetBValue(accent_col)) * 15;
  ir = (ir > 25500) ? 255 : ((ir < 0) ? 0 : ir / 100);
  ig = (ig > 25500) ? 255 : ((ig < 0) ? 0 : ig / 100);
  ib = (ib > 25500) ? 255 : ((ib < 0) ? 0 : ib / 100);
  unsigned uir = unsigned(ir & 0xFF);
  unsigned uig = unsigned(ig & 0xFF);
  unsigned uib = unsigned(ib & 0xFF);
  COLORREF icon_bg = COLORREF(uir | (uig << 8) | (uib << 16));
  DrawBellIcon(mem, icon_rc, icon_bg, kTextWhite);

  RECT header_rc;
  SetRectEx(&header_rc, kPad + kIconSize + 10, kHeaderTop,
            kWindowWidth - 22 - 14 - 10, kHeaderTop + 28);
  DrawHeaderText(mem, header_title_, L"\u521A\u521A" /*刚刚*/, header_rc);

  // ── 5) 分隔线 ──
  {
    HPEN pen = CreatePen(PS_SOLID, 1, kDivider);
    HPEN op = static_cast<HPEN>(SelectObject(mem, pen));
    MoveToEx(mem, kPad, 52, nullptr);
    LineTo(mem, kWindowWidth - kPad, 52);
    SelectObject(mem, op); DeleteObject(pen);
  }

  // ── 6) 正文标题（16px semibold 白） ──
  HFONT body_title_f = CreateFontW(-16, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
                                   DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                                   CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                                   DEFAULT_PITCH | FF_SWISS,
                                   L"Microsoft YaHei UI");
  HFONT of = static_cast<HFONT>(SelectObject(mem, body_title_f));
  SetBkMode(mem, TRANSPARENT);
  SetTextColor(mem, kTextWhite);
  RECT bt_rc;
  SetRectEx(&bt_rc, kPad, 62, kWindowWidth - kPad, 84);
  // 正文标题：用 message_ 首行（到第一个换行），没有则整个 message_
  size_t brk = message_.find(L'\n');
  std::wstring body_title = (brk == std::wstring::npos)
                              ? message_
                              : message_.substr(0, brk);
  // 如果 message 是单段短的，优先做 body_title；body 可留空。
  DrawTextW(mem, body_title.c_str(), -1, &bt_rc,
            DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
  SelectObject(mem, of); DeleteObject(body_title_f);

  // ── 7) 正文内容（13px dim） ──
  HFONT body_f = CreateFontW(-13, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                             DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                             CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                             DEFAULT_PITCH | FF_SWISS, L"Microsoft YaHei UI");
  of = static_cast<HFONT>(SelectObject(mem, body_f));
  SetTextColor(mem, kTextBody);
  RECT body_rc;
  const int body_top    = 88;
  const int body_bottom = show_confirm_button_ ? 122 : 138;
  SetRectEx(&body_rc, kPad, body_top, kWindowWidth - kPad, body_bottom);
  std::wstring body;
  if (brk != std::wstring::npos && brk + 1 < message_.size()) {
    body = message_.substr(brk + 1);
  }
  DrawTextW(mem, body.c_str(), -1, &body_rc,
            DT_LEFT | DT_WORDBREAK | DT_END_ELLIPSIS | DT_NOPREFIX);
  SelectObject(mem, of); DeleteObject(body_f);

  // ── 8) 圆角裁剪（防止边外画溢出）── 已靠 RoundRect 主填充完成。
  BitBlt(hdc, 0, 0, rc.right, rc.bottom, mem, 0, 0, SRCCOPY);
  SelectObject(mem, ob);
  DeleteObject(bmp); DeleteDC(mem);
}

// ═══════════════════════════════ 消息处理 ════════════════════════════════

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

    // ── 自绘按钮 / 关闭钮 ──
    case WM_DRAWITEM: {
      auto* dis = reinterpret_cast<DRAWITEMSTRUCT*>(lparam);
      if (dis->CtlType == ODT_BUTTON) {
        const bool hovered =
            (dis->itemState & ODS_HOTLIGHT) || (dis->itemState & ODS_SELECTED);
        if (dis->CtlID == kIdClose) {
          close_hovered_ = hovered;
          DrawCloseButton(dis->hDC, dis->rcItem, hovered);
          return TRUE;
        }
        if (dis->CtlID == kIdConfirm) {
          DrawRoundedPillButton(dis->hDC, dis->rcItem, kBtnConfirmBg,
                                kBtnConfirmBg, confirm_text_.empty()
                                    ? L"\u77E5\u9053\u4E86"  /*知道了*/
                                    : confirm_text_,
                                kBtnConfirmTx);
          return TRUE;
        }
        if (dis->CtlID == kIdDismiss) {
          DrawRoundedPillButton(dis->hDC, dis->rcItem, kBtnDismissBg,
                                kBtnDismissBd, dismiss_text_, kTextWhite);
          return TRUE;
        }
      }
      break;
    }

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
      if (id == kIdDismiss || id == kIdClose) {
        if (on_dismiss_) on_dismiss_();
        Hide();
        return 0;
      }
      break;
    }

    case WM_CTLCOLORBTN: {
      // 自绘按钮（BS_OWNERDRAW）不走 CTLCOLORBTN；保留作为兜底
      HDC btn_dc = reinterpret_cast<HDC>(wparam);
      SetBkMode(btn_dc, TRANSPARENT);
      return reinterpret_cast<INT_PTR>(GetStockObject(NULL_BRUSH));
    }

    case WM_NCHITTEST: {
      POINT pt = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
      ScreenToClient(hwnd, &pt);
      // 顶部 52px 范围内可拖动
      if (pt.y < 52) return HTCAPTION;
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
