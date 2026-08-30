#include "incoming_call_window.h"

#include <mmsystem.h>   // PlaySound
#include <windowsx.h>   // GET_X_LPARAM / GET_Y_LPARAM
#include <dwmapi.h>     // DWM shadow
#include <stringapiset.h>

#include <algorithm>
#include <cmath>
#include <cwctype>

#ifndef CLR_NONE
#define CLR_NONE static_cast<COLORREF>(0xFFFFFFFFL)
#endif

#ifndef DWMNCR_ENABLED
#define DWMNCR_ENABLED 1
#endif

#pragma comment(lib, "winmm.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "dwmapi.lib")

namespace {

constexpr LPCWSTR kRingAliasIncoming = L"IncomingCall";
constexpr UINT kFlashCount = 6;
constexpr DWORD kFlashTimeoutMs = 0;

// ── 窗口尺寸（新版来电：紧凑横条，Apple 风格） ──
constexpr int kWindowWidth = 300;
constexpr int kWindowHeight = 88;
constexpr int kMargin = 20;       // 距屏幕边缘距离
constexpr int kCornerRadius = 32; // 卡片圆角（设计稿 radius-xl）

// ── 内部布局 ──
constexpr int kPadX = 16;         // 水平内边距
constexpr int kAvatarSize = 48;   // 头像直径（设计稿 w-12 h-12）
constexpr int kTextGap = 12;      // 头像与文字间距
constexpr int kTextLeft = kPadX + kAvatarSize + kTextGap;

// ── 圆形图标按钮规格 ──
constexpr int kBtnSize = 44;      // 直径（设计稿 w-11 h-11）
constexpr int kBtnGap = 12;       // 两按钮间距（设计稿 gap-3）
constexpr int kBtnRadius = kBtnSize / 2;

// ── 新版配色（Apple 风格） ──
constexpr COLORREF kBgColor     = RGB(0xFF, 0xFF, 0xFF);  // 白卡
constexpr COLORREF kNameColor   = RGB(0x1D, 0x1D, 0x1F);  // 名称近黑
constexpr COLORREF kMutedColor  = RGB(0x6E, 0x6E, 0x73);  // 副标题中灰
constexpr COLORREF kAcceptBg    = RGB(0x34, 0xC7, 0x59);  // 接听绿
constexpr COLORREF kAcceptHover = RGB(0x2E, 0xB0, 0x4F);  // 接听悬停深绿
constexpr COLORREF kDeclineBg   = RGB(0xFF, 0x3B, 0x30);  // 拒接红
constexpr COLORREF kDeclineHover= RGB(0xE0, 0x33, 0x2A);  // 拒接悬停深红
constexpr COLORREF kGlyphColor  = RGB(0xFF, 0xFF, 0xFF);  // 按钮白图标

// 字形（Segoe MDL2 Assets）：E717 = Phone
constexpr wchar_t kGlyphPhone = L'\uE717';

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

// 启用 DWM 圆角阴影（柔和投影）
void EnableDwmShadow(HWND hwnd) {
  DWMNCRENDERINGPOLICY policy = static_cast<DWMNCRENDERINGPOLICY>(DWMNCR_ENABLED);
  DwmSetWindowAttribute(hwnd, DWMWA_NCRENDERING_POLICY,
                        &policy, sizeof(policy));

  MARGINS margins = {0, 0, 0, 1};
  DwmExtendFrameIntoClientArea(hwnd, &margins);

  BOOL prefer_angular_corners = FALSE;
  DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE,
                        &prefer_angular_corners, sizeof(prefer_angular_corners));
}

void FlashForAttention(HWND hwnd) {
  if (!hwnd) return;
  FLASHWINFO flash = {};
  flash.cbSize = sizeof(flash);
  flash.hwnd = hwnd;
  flash.dwFlags = FLASHW_ALL | FLASHW_TIMERNOFG;
  flash.uCount = kFlashCount;
  flash.dwTimeout = kFlashTimeoutMs;
  FlashWindowEx(&flash);
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

  // 启用 DWM 阴影
  EnableDwmShadow(hwnd);

  // 自绘圆形图标按钮（BS_OWNERDRAW）
  accept_btn_ = CreateWindowExW(
      0, L"BUTTON", L"",
      WS_CHILD | WS_VISIBLE | BS_OWNERDRAW, 0, 0, 0, 0, hwnd,
      reinterpret_cast<HMENU>(1), GetModuleHandle(nullptr), nullptr);
  decline_btn_ = CreateWindowExW(
      0, L"BUTTON", L"",
      WS_CHILD | WS_VISIBLE | BS_OWNERDRAW, 0, 0, 0, 0, hwnd,
      reinterpret_cast<HMENU>(2), GetModuleHandle(nullptr), nullptr);

  HFONT ui_font = reinterpret_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT));
  SendMessage(accept_btn_, WM_SETFONT, reinterpret_cast<WPARAM>(ui_font), TRUE);
  SendMessage(decline_btn_, WM_SETFONT, reinterpret_cast<WPARAM>(ui_font), TRUE);

  accept_brush_ = CreateSolidBrush(kAcceptBg);
  decline_brush_ = CreateSolidBrush(kDeclineBg);
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

  // 圆形按钮靠右：拒接在左、接听在右（垂直居中）
  const int btn_y = (kWindowHeight - kBtnSize) / 2;
  const int total_btn_w = kBtnSize * 2 + kBtnGap;
  const int btn_x_start = kWindowWidth - kPadX - total_btn_w;
  SetWindowPos(decline_btn_, nullptr, btn_x_start, btn_y, kBtnSize, kBtnSize,
               SWP_NOZORDER | SWP_NOACTIVATE);
  SetWindowPos(accept_btn_, nullptr, btn_x_start + kBtnSize + kBtnGap, btn_y,
               kBtnSize, kBtnSize, SWP_NOZORDER | SWP_NOACTIVATE);

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
  accent_color_ = accent_color_hex ? accent_color_hex : 0xFF34C759;
  ring_timeout_ms_ = ring_timeout_ms > 0 ? ring_timeout_ms : 30000;

  if (!CreateWindowIfNeeded()) return;
  PositionAtBottomRight();
  FlashForAttention(window_handle_);

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
    if (IsWindow(accept_btn_)) DestroyWindow(accept_btn_);
    accept_btn_ = nullptr;
  }
  if (decline_btn_) {
    if (IsWindow(decline_btn_)) DestroyWindow(decline_btn_);
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
    if (IsWindow(window_handle_)) DestroyWindow(window_handle_);
    window_handle_ = nullptr;
  }
}

bool IncomingCallWindow::IsVisible() const {
  return window_handle_ && IsWindowVisible(window_handle_);
}

void IncomingCallWindow::StartRingtone() {
  if (!PlaySoundW(kRingAliasIncoming, nullptr,
                  SND_ALIAS_ID | SND_ASYNC | SND_LOOP | SND_NODEFAULT)) {
    MessageBeep(MB_ICONEXCLAMATION);
  }
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
}

void IncomingCallWindow::StopAcceptButtonGlow() { accept_glow_ = false; }

// ═════════════════════════════════ 绘制函数 ═════════════════════════════════

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
  }
  SelectObject(hdc, old_brush);
  SelectObject(hdc, old_pen);
  DeleteObject(brush);
  DeleteObject(pen);
}

void IncomingCallWindow::DrawGlyph(HDC hdc, const RECT& rc, wchar_t glyph,
                                   COLORREF color, int font_size,
                                   const wchar_t* font_family) {
  HFONT f = CreateFontW(-font_size, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                        DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                        CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                        DEFAULT_PITCH | FF_SWISS, font_family);
  HFONT old = static_cast<HFONT>(SelectObject(hdc, f));
  SetBkMode(hdc, TRANSPARENT);
  SetTextColor(hdc, color);
  RECT r = rc;
  DrawTextW(hdc, &glyph, 1, &r,
            DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
  SelectObject(hdc, old);
  DeleteObject(f);
}

void IncomingCallWindow::DrawPhoneOffGlyph(HDC hdc, const RECT& rc,
                                           COLORREF color, int font_size) {
  DrawGlyph(hdc, rc, kGlyphPhone, color, font_size, L"Segoe MDL2 Assets");
  // 斜线模拟挂断（phone-off）：从右下到左上穿过电话图标
  HPEN pen = CreatePen(PS_SOLID, 2, color);
  HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, pen));
  int cx = (rc.left + rc.right) / 2;
  int cy = (rc.top + rc.bottom) / 2;
  int off = font_size / 3;
  MoveToEx(hdc, cx + off, cy + off, nullptr);
  LineTo(hdc, cx - off, cy - off);
  SelectObject(hdc, old_pen);
  DeleteObject(pen);
}

void IncomingCallWindow::DrawAvatar(HDC hdc, const RECT& rc,
                                    const std::wstring& initial,
                                    COLORREF bg, COLORREF letter_color) {
  int cx = (rc.left + rc.right) / 2;
  int cy = (rc.top + rc.bottom) / 2;
  int base_r = (std::min)(rc.right - rc.left, rc.bottom - rc.top) / 2;

  // 实心圆形头像底色
  HRGN rgn = CreateEllipticRgn(rc.left, rc.top, rc.right, rc.bottom);
  HBRUSH bg_brush = CreateSolidBrush(bg);
  FillRgn(hdc, rgn, bg_brush);
  DeleteObject(bg_brush);
  DeleteObject(rgn);

  // 首字母
  if (!initial.empty()) {
    std::wstring s(1, static_cast<wchar_t>(std::towupper(initial[0])));
    int font_size = base_r - 2;
    HFONT f = CreateFontW(font_size, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                          DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                          CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                          DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
    HFONT old = static_cast<HFONT>(SelectObject(hdc, f));
    SetBkMode(hdc, TRANSPARENT);
    SetTextColor(hdc, letter_color);
    RECT tr = {cx - base_r, cy - base_r, cx + base_r, cy + base_r};
    DrawTextW(hdc, s.c_str(), 1, &tr, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    SelectObject(hdc, old);
    DeleteObject(f);
  }
}

// 绘制圆形图标按钮（设计稿：红拒接/绿接听圆钮 + 白色图标）
void IncomingCallWindow::DrawRoundIconButton(HDC hdc, const RECT& rc,
                                             wchar_t glyph, bool is_accept,
                                             bool hovered) {
  // 先把按钮矩形铺成白卡背景，避免圆形按钮四角露出系统底色
  RECT fill_rc = rc;
  HBRUSH bg_brush = CreateSolidBrush(kBgColor);
  FillRect(hdc, &fill_rc, bg_brush);
  DeleteObject(bg_brush);

  COLORREF bg = is_accept ? (hovered ? kAcceptHover : kAcceptBg)
                          : (hovered ? kDeclineHover : kDeclineBg);

  // 圆形背景
  HRGN rgn = CreateEllipticRgn(rc.left, rc.top, rc.right, rc.bottom);
  HBRUSH brush = CreateSolidBrush(bg);
  FillRgn(hdc, rgn, brush);
  DeleteObject(brush);
  DeleteObject(rgn);

  // 接听按钮呼吸发光效果
  if (is_accept && accept_glow_ && !hovered) {
    double phase = (pulse_phase_ % 30) / 30.0;
    int g = static_cast<int>(180 + 50 * std::sin(phase * 6.28318));
    RECT glow_rc = rc;
    InflateRect(&glow_rc, 2, 2);
    HPEN pen = CreatePen(PS_SOLID, 2, RGB(52, g, 89));
    HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, pen));
    HBRUSH null_brush = static_cast<HBRUSH>(GetStockObject(NULL_BRUSH));
    HBRUSH old_brush = static_cast<HBRUSH>(SelectObject(hdc, null_brush));
    Ellipse(hdc, glow_rc.left, glow_rc.top, glow_rc.right, glow_rc.bottom);
    SelectObject(hdc, old_brush);
    SelectObject(hdc, old_pen);
    DeleteObject(pen);
  }

  // 白色图标（拒接画 phone-off，接听画 phone）
  if (glyph == kGlyphPhone && !is_accept) {
    DrawPhoneOffGlyph(hdc, rc, kGlyphColor, kBtnSize / 2);
  } else {
    DrawGlyph(hdc, rc, glyph, kGlyphColor, kBtnSize / 2,
              L"Segoe MDL2 Assets");
  }
}

void IncomingCallWindow::Paint(HWND hwnd, HDC hdc) {
  RECT rc;
  GetClientRect(hwnd, &rc);

  HDC mem = CreateCompatibleDC(hdc);
  HBITMAP bmp = CreateCompatibleBitmap(hdc, rc.right, rc.bottom);
  HBITMAP old_bmp = static_cast<HBITMAP>(SelectObject(mem, bmp));

  // ── 白卡背景（无可见边框线，靠 DWM 阴影区分层次） ──
  HBRUSH bg_brush = CreateSolidBrush(kBgColor);
  FillRect(mem, &rc, bg_brush);
  DeleteObject(bg_brush);

  // 圆角裁剪区域（防止绘制溢出圆角）
  HRGN clip_rgn = CreateRoundRectRgn(0, 0, rc.right + 1, rc.bottom + 1,
                                     kCornerRadius, kCornerRadius);
  SelectClipRgn(mem, clip_rgn);

  // ── 头像（左侧垂直居中，浅色底 + accent 字母，贴合设计稿 primary/10） ──
  COLORREF accent = ParseArgb(accent_color_);
  const int av_top = (kWindowHeight - kAvatarSize) / 2;
  RECT avatar_rc = {kPadX, av_top, kPadX + kAvatarSize, av_top + kAvatarSize};
  // 浅色底 = 10% accent 混合 90% 白
  COLORREF avatar_bg = RGB(
      (GetRValue(accent) * 10 + 255 * 90) / 100,
      (GetGValue(accent) * 10 + 255 * 90) / 100,
      (GetBValue(accent) * 10 + 255 * 90) / 100);
  DrawAvatar(mem, avatar_rc, caller_initial_, avatar_bg, accent);

  // ── 文字区域（头像右侧垂直居中两行） ──
  const int total_btn_w = kBtnSize * 2 + kBtnGap;
  const int text_right = kWindowWidth - kPadX - total_btn_w - kBtnGap;
  SetBkMode(mem, TRANSPARENT);
  HFONT old_font = nullptr;

  // 名称 —— 16px 近黑 Semibold
  HFONT name_font = CreateFontW(-16, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
                                DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                                CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                                DEFAULT_PITCH | FF_SWISS,
                                L"Microsoft YaHei UI");
  old_font = static_cast<HFONT>(SelectObject(mem, name_font));
  SetTextColor(mem, kNameColor);
  RECT name_rc = {kTextLeft, 22, text_right, 44};
  DrawTextW(mem, caller_name_.c_str(), -1, &name_rc,
            DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
  SelectObject(mem, old_font);
  DeleteObject(name_font);

  // 副标题 —— 14px 中灰
  HFONT sub_font = CreateFontW(-14, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                               DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                               CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                               DEFAULT_PITCH | FF_SWISS,
                               L"Microsoft YaHei UI");
  old_font = static_cast<HFONT>(SelectObject(mem, sub_font));
  SetTextColor(mem, kMutedColor);
  RECT sub_rc = {kTextLeft, 44, text_right, 66};
  DrawTextW(mem, subtitle_.c_str(), -1, &sub_rc,
            DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
  SelectObject(mem, old_font);
  DeleteObject(sub_font);

  // 清除圆角裁剪
  SelectClipRgn(mem, nullptr);
  DeleteObject(clip_rgn);

  BitBlt(hdc, 0, 0, rc.right, rc.bottom, mem, 0, 0, SRCCOPY);
  SelectObject(mem, old_bmp);
  DeleteObject(bmp);
  DeleteDC(mem);
}

// ═════════════════════════════════ 消息处理 ═════════════════════════════════

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

    // 自绘按钮：绘制圆形图标
    case WM_DRAWITEM: {
      auto* dis = reinterpret_cast<DRAWITEMSTRUCT*>(lparam);
      if (dis->CtlType == ODT_BUTTON) {
        bool is_accept = (dis->CtlID == 1);
        bool hovered = (dis->itemState & ODS_SELECTED) ||
                       (dis->itemState & ODS_HOTLIGHT);
        if (is_accept) accept_hovered_ = hovered;
        else decline_hovered_ = hovered;
        DrawRoundIconButton(dis->hDC, dis->rcItem, kGlyphPhone, is_accept,
                            hovered);
        return TRUE;
      }
      break;
    }

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

    // 鼠标离开按钮时刷新悬停状态
    case WM_MOUSEMOVE: {
      TRACKMOUSEEVENT tme = {};
      tme.cbSize = sizeof(tme);
      tme.dwFlags = TME_LEAVE;
      tme.hwndTrack = hwnd;
      TrackMouseEvent(&tme);
      break;
    }
    case WM_MOUSELEAVE:
      if (accept_hovered_ || decline_hovered_) {
        accept_hovered_ = false;
        decline_hovered_ = false;
        InvalidateRect(hwnd, nullptr, FALSE);
      }
      break;

    case WM_NCHITTEST: {
      POINT pt = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
      ScreenToClient(hwnd, &pt);
      // 左侧（头像+文字）区域可拖动，右侧按钮区域不拖动
      const int total_btn_w = kBtnSize * 2 + kBtnGap;
      const int btn_x_start = kWindowWidth - kPadX - total_btn_w;
      if (pt.x < btn_x_start - 4) return HTCAPTION;
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
