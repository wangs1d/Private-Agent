#include "desktop_notification_window.h"

#include <dwmapi.h>
#include <windowsx.h>

#include <algorithm>

#pragma comment(lib, "dwmapi.lib")

namespace {

// ═══════════════════════════ 配色（实色近似，压在深色毛玻璃上） ═══════════════════════════
// 说明：Acrylic 层提供 rgba(30,30,30,0.7) 底色 + 桌面模糊；
// 这里的控件色 = 设计稿半透明色 与 毛玻璃底 混合后的“等效实色”，
// 保证 GDI 直接绘制时视觉与设计稿一致。
constexpr COLORREF kTextWhite    = RGB(0xFF, 0xFF, 0xFF);
constexpr COLORREF kTextSub      = RGB(0x8C, 0x8C, 0x94);  // "刚刚"  ≈ 白 55%
constexpr COLORREF kTextBody     = RGB(0xC4, 0xC4, 0xC8);  // 正文   ≈ 白 78%
constexpr COLORREF kDividerColor = RGB(0x40, 0x40, 0x48);  // 分隔线 ≈ 白 12%
constexpr COLORREF kIconBg       = RGB(0x4A, 0x4A, 0x52);  // 铃铛圆底 ≈ 白 16%
constexpr COLORREF kCloseBg      = RGB(0x1F, 0x1F, 0x24);  // 关闭圆底 ≈ 黑 25%
constexpr COLORREF kCloseBgHover = RGB(0x3A, 0x3A, 0x42);  // 关闭 hover
constexpr COLORREF kBtnBorder    = RGB(0x6E, 0x6E, 0x76);  // 按钮描边 ≈ 白 35%
constexpr COLORREF kBtnHoverFill = RGB(0x35, 0x35, 0x3D);  // 按钮 hover 填充 ≈ 白 10%
constexpr COLORREF kBtnText      = RGB(0xFF, 0xFF, 0xFF);

// ── DWM Acrylic（未公开 user32 接口，Win10 1803+ / Win11 稳定可用） ──
struct AccentPolicy {
  int   accent_state;
  int   flags;
  DWORD gradient_color;  // 0xAABBGGRR
  int   animation_id;
};
struct WindowCompositionAttributeData {
  int     attribute;
  PVOID   data;
  size_t  size;
};
using SetWindowCompositionAttributeFn =
    BOOL (WINAPI*)(HWND, WindowCompositionAttributeData*);

constexpr int kWcaAccentPolicy              = 19;
constexpr int kAccentEnableAcrylicBlurBehind = 4;
// rgba(30,30,30,0.7) → A=0xB2, B=0x1E, G=0x1E, R=0x1E
constexpr DWORD kAcrylicTint = 0xB21E1E1Eu;

constexpr int kDwmwaWindowCornerPreference = 33;
constexpr int kDwmwcpRound                 = 2;

std::wstring Utf8ToWide(const std::string& s) {
  if (s.empty()) return L"";
  int len = MultiByteToWideChar(CP_UTF8, 0, s.c_str(),
                                static_cast<int>(s.size()), nullptr, 0);
  std::wstring out(len, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()),
                      out.data(), len);
  return out;
}

// 过滤 GDI 字体无法渲染的 emoji / 杂项符号（避免豆腐块 □）
std::wstring StripUnrenderable(std::wstring s) {
  std::wstring out;
  out.reserve(s.size());
  for (size_t i = 0; i < s.size(); ++i) {
    wchar_t c = s[i];
    if (c >= 0xD800 && c <= 0xDFFF) continue;   // 代理对（emoji 等）
    if (c == 0xFE0F || c == 0xFE0E) continue;   // 变体选择符
    if (c >= 0x2600 && c <= 0x27BF) continue;   // 杂项符号 / dingbats
    if (c >= 0x2B00 && c <= 0x2BFF) continue;   // 箭头补充
    out.push_back(c);
  }
  return out;
}

bool PtIn(const POINT& pt, const RECT& rc) {
  return pt.x >= rc.left && pt.x < rc.right &&
         pt.y >= rc.top && pt.y < rc.bottom;
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
  wc.hbrBackground = nullptr;   // 背景由 Acrylic 层提供，绝不填充
  wc.lpszClassName = kClassName;
  RegisterClassExW(&wc);
  registered = true;
}

void DesktopNotificationWindow::ApplyAcrylicBlur(HWND hwnd) {
  HMODULE user32 = GetModuleHandleW(L"user32.dll");
  if (!user32) return;
  auto set_attr = reinterpret_cast<SetWindowCompositionAttributeFn>(
      reinterpret_cast<void*>(GetProcAddress(
          user32, "SetWindowCompositionAttribute")));
  if (!set_attr) return;

  AccentPolicy accent = {};
  accent.accent_state   = kAccentEnableAcrylicBlurBehind;
  accent.flags          = 2;
  accent.gradient_color = kAcrylicTint;
  accent.animation_id   = 0;

  WindowCompositionAttributeData data = {};
  data.attribute = kWcaAccentPolicy;
  data.data      = &accent;
  data.size      = sizeof(accent);
  set_attr(hwnd, &data);
}

void DesktopNotificationWindow::ApplyRoundedCorners(HWND hwnd) {
  // Win11：系统级圆角（带抗锯齿，Acrylic 自动跟随裁剪，无黑角）
  DWORD pref = kDwmwcpRound;
  DwmSetWindowAttribute(hwnd, kDwmwaWindowCornerPreference,
                        &pref, sizeof(pref));
}

bool DesktopNotificationWindow::CreateWindowIfNeeded() {
  if (window_handle_) return true;
  EnsureClassRegistered();

  // 注意：不要使用 WS_EX_LAYERED——它与 Acrylic 冲突且只会让整窗变淡。
  DWORD ex_style = WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
  DWORD style    = WS_POPUP;

  HWND hwnd = CreateWindowExW(
      ex_style, kClassName, L"", style, 0, 0, kWindowWidth, kWindowHeight,
      nullptr, nullptr, GetModuleHandle(nullptr), this);
  if (!hwnd) return false;
  window_handle_ = hwnd;

  ApplyAcrylicBlur(hwnd);
  ApplyRoundedCorners(hwnd);
  return true;
}

void DesktopNotificationWindow::ComputeLayout() {
  // 顶部栏
  SetRect(&rc_close_, kWindowWidth - 16 - 26, 12, kWindowWidth - 16, 38);
  // 底部按钮：右下角并排
  const int btn_h = 32;
  const int btn_y = kWindowHeight - 12 - btn_h;      // 128
  auto text_width = [](const std::wstring& t) {
    int n = static_cast<int>(t.size());
    return std::max(72, std::min(140, n * 14 + 24));
  };
  const int confirm_w = text_width(confirm_text_);
  const int dismiss_w = text_width(L"\u7A0D\u540E" /*稍后*/);
  const int gap       = 10;
  const int confirm_x = kWindowWidth - 16 - confirm_w;
  const int dismiss_x = confirm_x - gap - dismiss_w;

  SetRect(&rc_confirm_, confirm_x, btn_y,
          confirm_x + confirm_w, btn_y + btn_h);
  if (show_confirm_button_) {
    SetRect(&rc_dismiss_, dismiss_x, btn_y,
            dismiss_x + dismiss_w, btn_y + btn_h);
  } else {
    SetRectEmpty(&rc_dismiss_);
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
}

void DesktopNotificationWindow::Show(const std::string& title,
                                     const std::string& message,
                                     const std::string& /*priority*/,
                                     bool show_confirm_button,
                                     const std::string& confirm_text,
                                     int auto_close_ms) {
  title_              = StripUnrenderable(Utf8ToWide(title));
  message_            = StripUnrenderable(Utf8ToWide(message));
  confirm_text_       = StripUnrenderable(
      Utf8ToWide(confirm_text.empty() ? "\u6211\u77E5\u9053\u4E86"
                                      /*我知道了*/ : confirm_text));
  show_confirm_button_ = show_confirm_button;
  auto_close_ms_       = auto_close_ms;
  if (!CreateWindowIfNeeded()) return;
  ComputeLayout();
  hover_id_ = 0;
  PositionAtBottomRight();
  StartTimer();
  Repaint();
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
  if (window_handle_ && IsWindow(window_handle_)) DestroyWindow(window_handle_);
  window_handle_ = nullptr;
}

void DesktopNotificationWindow::Repaint() {
  if (!window_handle_) return;
  InvalidateRect(window_handle_, nullptr, FALSE);  // 不擦除，保护 Acrylic 底
}

int DesktopNotificationWindow::HitTest(const POINT& pt) const {
  if (PtIn(pt, rc_close_))   return 1;
  if (PtIn(pt, rc_dismiss_)) return 2;
  if (PtIn(pt, rc_confirm_)) return 3;
  return 0;
}

// ═══════════════════════════════ 绘制 ════════════════════════════════

void DesktopNotificationWindow::FillSolidCircle(HDC hdc, const RECT& rc,
                                                COLORREF fill) {
  HBRUSH brush = CreateSolidBrush(fill);
  HBRUSH old   = static_cast<HBRUSH>(SelectObject(hdc, brush));
  HPEN pen     = CreatePen(PS_NULL, 0, 0);
  HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, pen));
  Ellipse(hdc, rc.left, rc.top, rc.right, rc.bottom);
  SelectObject(hdc, old);
  SelectObject(hdc, old_pen);
  DeleteObject(brush);
  DeleteObject(pen);
}

void DesktopNotificationWindow::DrawLine(HDC hdc, int x1, int y1, int x2,
                                         int y2, COLORREF color, int width) {
  HPEN pen     = CreatePen(PS_SOLID, width, color);
  HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, pen));
  MoveToEx(hdc, x1, y1, nullptr);
  LineTo(hdc, x2, y2);
  SelectObject(hdc, old_pen);
  DeleteObject(pen);
}

// 几何铃铛：钟顶小圆钮 + 半圆钟身 + 外撇钟摆裙 + 底部钟舌
void DesktopNotificationWindow::DrawBell(HDC hdc, int cx, int cy,
                                         COLORREF color) {
  HBRUSH brush = CreateSolidBrush(color);
  HBRUSH old_b = static_cast<HBRUSH>(SelectObject(hdc, brush));
  HPEN pen     = CreatePen(PS_NULL, 0, 0);
  HPEN old_p   = static_cast<HPEN>(SelectObject(hdc, pen));

  // 钟身（圆头）：以 (cx, cy-3) 为中心、半径 6 的圆，上半是钟顶
  Ellipse(hdc, cx - 6, cy - 9, cx + 6, cy + 3);
  // 钟摆裙：梯形从钟身底部外撇
  const POINT skirt[4] = {
      {cx - 9, cy + 5}, {cx - 6, cy + 1},
      {cx + 6, cy + 1}, {cx + 9, cy + 5}};
  Polygon(hdc, skirt, 4);
  // 钟舌（底部小铃锤）
  Ellipse(hdc, cx - 3, cy + 3, cx + 3, cy + 9);
  // 顶部小吊钮
  Ellipse(hdc, cx - 2, cy - 12, cx + 2, cy - 8);

  SelectObject(hdc, old_b);
  SelectObject(hdc, old_p);
  DeleteObject(brush);
  DeleteObject(pen);
}

void DesktopNotificationWindow::DrawCloseGlyph(HDC hdc, const RECT& rc,
                                               COLORREF color) {
  const int cx = (rc.left + rc.right) / 2;
  const int cy = (rc.top + rc.bottom) / 2;
  const int s  = 5;
  DrawLine(hdc, cx - s, cy - s, cx + s, cy + s, color, 2);
  DrawLine(hdc, cx + s, cy - s, cx - s, cy + s, color, 2);
}

// 透明底 + 浅灰描边圆角按钮（Acrylic 透过未填充区域显示）
void DesktopNotificationWindow::DrawOutlineButton(HDC hdc, const RECT& rc,
                                                  const std::wstring& label,
                                                  bool hovered) {
  if (hovered) {
    // hover 浅色填充（等效实色），与描边同圆角
    HBRUSH fill = CreateSolidBrush(kBtnHoverFill);
    HBRUSH ob   = static_cast<HBRUSH>(SelectObject(hdc, fill));
    HPEN np     = CreatePen(PS_NULL, 0, 0);
    HPEN op     = static_cast<HPEN>(SelectObject(hdc, np));
    RoundRect(hdc, rc.left, rc.top, rc.right, rc.bottom, 16, 16);
    SelectObject(hdc, ob);
    SelectObject(hdc, op);
    DeleteObject(fill);
    DeleteObject(np);
  }

  HPEN pen     = CreatePen(PS_SOLID, 1, kBtnBorder);
  HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, pen));
  HBRUSH null_b = static_cast<HBRUSH>(GetStockObject(NULL_BRUSH));
  HBRUSH old_b = static_cast<HBRUSH>(SelectObject(hdc, null_b));
  RoundRect(hdc, rc.left, rc.top, rc.right, rc.bottom, 16, 16);
  SelectObject(hdc, old_b);
  SelectObject(hdc, old_pen);
  DeleteObject(pen);

  HFONT font = CreateFontW(-13, 0, 0, 0, FW_MEDIUM, FALSE, FALSE, FALSE,
                           DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                           CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                           DEFAULT_PITCH | FF_SWISS, L"Microsoft YaHei UI");
  HFONT old_f = static_cast<HFONT>(SelectObject(hdc, font));
  SetBkMode(hdc, TRANSPARENT);
  SetTextColor(hdc, kBtnText);
  RECT tr = rc;
  DrawTextW(hdc, label.c_str(), -1, &tr,
            DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
  SelectObject(hdc, old_f);
  DeleteObject(font);
}

void DesktopNotificationWindow::Paint(HWND hwnd, HDC hdc) {
  SetBkMode(hdc, TRANSPARENT);

  // ── 顶部：铃铛圆形图标 ──
  const RECT icon_rc = {16, 12, 46, 42};
  FillSolidCircle(hdc, icon_rc, kIconBg);
  DrawBell(hdc, 31, 27, kTextWhite);

  // ── 顶部：标题「系统通知」+ 副标题「刚刚」 ──
  const int text_left = 56;
  const int text_right = rc_close_.left - 8;
  {
    HFONT font = CreateFontW(-14, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
                             DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                             CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                             DEFAULT_PITCH | FF_SWISS,
                             L"Microsoft YaHei UI");
    HFONT old = static_cast<HFONT>(SelectObject(hdc, font));
    SetTextColor(hdc, kTextWhite);
    RECT r = {text_left, 10, text_right, 30};
    DrawTextW(hdc, L"\u7CFB\u7EDF\u901A\u77E5" /*系统通知*/, -1, &r,
              DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
    SelectObject(hdc, old);
    DeleteObject(font);
  }
  {
    HFONT font = CreateFontW(-12, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                             DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                             CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                             DEFAULT_PITCH | FF_SWISS,
                             L"Microsoft YaHei UI");
    HFONT old = static_cast<HFONT>(SelectObject(hdc, font));
    SetTextColor(hdc, kTextSub);
    RECT r = {text_left, 28, text_right, 44};
    DrawTextW(hdc, L"\u521A\u521A" /*刚刚*/, -1, &r,
              DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
    SelectObject(hdc, old);
    DeleteObject(font);
  }

  // ── 顶部：右侧圆形关闭钮 ──
  FillSolidCircle(hdc, rc_close_, hover_id_ == 1 ? kCloseBgHover : kCloseBg);
  DrawCloseGlyph(hdc, rc_close_, kTextWhite);

  // ── 分隔线 ──
  DrawLine(hdc, 16, 52, kWindowWidth - 16, 52, kDividerColor, 1);

  // ── 中部：粗体标题 ──
  {
    HFONT font = CreateFontW(-16, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
                             DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                             CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                             DEFAULT_PITCH | FF_SWISS,
                             L"Microsoft YaHei UI");
    HFONT old = static_cast<HFONT>(SelectObject(hdc, font));
    SetTextColor(hdc, kTextWhite);
    RECT r = {16, 62, kWindowWidth - 16, 86};
    DrawTextW(hdc, title_.c_str(), -1, &r,
              DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
    SelectObject(hdc, old);
    DeleteObject(font);
  }

  // ── 中部：正文描述 ──
  if (!message_.empty()) {
    HFONT font = CreateFontW(-13, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                             DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                             CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                             DEFAULT_PITCH | FF_SWISS,
                             L"Microsoft YaHei UI");
    HFONT old = static_cast<HFONT>(SelectObject(hdc, font));
    SetTextColor(hdc, kTextBody);
    RECT r = {16, 90, kWindowWidth - 16, 122};
    DrawTextW(hdc, message_.c_str(), -1, &r,
              DT_LEFT | DT_WORDBREAK | DT_END_ELLIPSIS | DT_NOPREFIX);
    SelectObject(hdc, old);
    DeleteObject(font);
  }

  // ── 底部右侧：双按钮（稍后 / 我知道了），透明底 + 浅灰描边 ──
  if (show_confirm_button_) {
    DrawOutlineButton(hdc, rc_dismiss_,
                      L"\u7A0D\u540E" /*稍后*/, hover_id_ == 2);
  }
  DrawOutlineButton(hdc, rc_confirm_, confirm_text_, hover_id_ == 3);
}

// ═══════════════════════════════ 消息处理 ══════════════════════════════

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
      // Acrylic 层是背景，绝不用画刷擦除（否则黑底/闪烁）
      return 1;

    case WM_TIMER:
      if (wparam == kAutoCloseTimerId) {
        StopTimer();
        if (on_timeout_) on_timeout_();
        Hide();
        return 0;
      }
      break;

    case WM_MOUSEMOVE: {
      POINT pt = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
      const int id = HitTest(pt);
      if (id != hover_id_) {
        hover_id_ = id;
        Repaint();
      }
      if (!mouse_tracking_) {
        TRACKMOUSEEVENT tme = {sizeof(tme)};
        tme.dwFlags = TME_LEAVE;
        tme.hwndTrack = hwnd;
        TrackMouseEvent(&tme);
        mouse_tracking_ = true;
      }
      return 0;
    }

    case WM_MOUSELEAVE:
      mouse_tracking_ = false;
      if (hover_id_ != 0) {
        hover_id_ = 0;
        Repaint();
      }
      return 0;

    case WM_SETCURSOR:
      if (LOWORD(lparam) == HTCLIENT) {
        POINT pt;
        GetCursorPos(&pt);
        ScreenToClient(hwnd, &pt);
        SetCursor(LoadCursor(nullptr,
                             HitTest(pt) ? IDC_HAND : IDC_ARROW));
        return TRUE;
      }
      break;

    case WM_LBUTTONUP: {
      POINT pt = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
      const int id = HitTest(pt);
      if (id == 3) {
        if (on_confirm_) on_confirm_();
        Hide();
        return 0;
      }
      if (id == 1 || id == 2) {
        if (on_dismiss_) on_dismiss_();
        Hide();
        return 0;
      }
      break;
    }

    case WM_DESTROY:
      StopTimer();
      SetWindowLongPtr(hwnd, GWLP_USERDATA, 0);
      window_handle_ = nullptr;
      return 0;
  }
  return DefWindowProc(hwnd, message, wparam, lparam);
}
