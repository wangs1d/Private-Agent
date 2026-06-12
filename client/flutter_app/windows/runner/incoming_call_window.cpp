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

// ── 窗口尺寸（仿微信PC来电：紧凑横条） ──
constexpr int kWindowWidth = 300;
constexpr int kWindowHeight = 88;
constexpr int kMargin = 20;       // 距屏幕边缘距离
constexpr int kCornerRadius = 12; // 卡片圆角

// ── 内部布局 ──
constexpr int kPadX = 16;         // 水平内边距
constexpr int kAvatarSize = 44;   // 头像直径（微信PC风格略大）
constexpr int kTextGap = 12;      // 头像与文字间距
constexpr int kTextLeft = kPadX + kAvatarSize + kTextGap;

// ── 按钮规格（药丸形） ──
constexpr int kBtnW = 64;
constexpr int kBtnH = 30;         // 按钮高度
constexpr int kBtnGap = 10;       // 两按钮间距
constexpr int kBtnRadius = kBtnH / 2; // 药丸形 = 半圆角
constexpr int kBtnBottom = 14;    // 按钮距底部

// ── 微信PC配色 ──
constexpr COLORREF kBgColor        = RGB(0xFF, 0xFF, 0xFF);  // 纯白背景
constexpr COLORREF kShadowColor    = RGB(0xC0, 0xC4, 0xCC);  // 投影色
constexpr COLORREF kNameColor      = RGB(0x1A, 0x1A, 0x1A);  // 名称：近黑
constexpr COLORREF kSubColor       = RGB(0x99, 0x9A, 0x9E);  // 副标题：中灰
constexpr COLORREF kAcceptBg       = RGB(0x07, 0xC1, 0x60);  // 接听绿（微信同款）
constexpr COLORREF kAcceptHover    = RGB(0x06, 0xAD, 0x56);  // 接听悬停深绿
constexpr COLORREF kDeclineBg      = RGB(0xE6, 0x4D, 0x4D);  // 挂断红
constexpr COLORREF kDeclineHover   = RGB(0xD4, 0x3B, 0x3B);  // 挂断悬停深红
constexpr COLORREF kBtnText        = RGB(0xFF, 0xFF, 0xFF);  // 按钮白字

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

// 启用 DWM 圆角阴影（仿微信PC的柔和投影）
void EnableDwmShadow(HWND hwnd) {
  // 开启非客户区渲染以获得阴影
  DWMNCRENDERINGPOLICY policy = static_cast<DWMNCRENDERINGPOLICY>(DWMNCR_ENABLED);
  DwmSetWindowAttribute(hwnd, DWMWA_NCRENDERING_POLICY,
                        &policy, sizeof(policy));

  // 扩展边框到客户端区域，让阴影包裹圆角
  MARGINS margins = {0, 0, 0, 1};
  DwmExtendFrameIntoClientArea(hwnd, &margins);

  // 使用圆角窗口模式（Win11）
  BOOL prefer_angular_corners = FALSE;
  DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE,
                        &prefer_angular_corners, sizeof(prefer_angular_corners));
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

  // 创建自绘按钮（BS_OWNERDRAW 实现药丸形状）
  accept_btn_ = CreateWindowExW(
      0, L"BUTTON", L"\u63A5\u542C",
      WS_CHILD | WS_VISIBLE | BS_OWNERDRAW, 0, 0, 0, 0, hwnd,
      reinterpret_cast<HMENU>(1), GetModuleHandle(nullptr), nullptr);
  decline_btn_ = CreateWindowExW(
      0, L"BUTTON", L"\u6302\u65AD",
      WS_CHILD | WS_VISIBLE | BS_OWNERDRAW, 0, 0, 0, 0, hwnd,
      reinterpret_cast<HMENU>(2), GetModuleHandle(nullptr), nullptr);

  // 设置按钮字体
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

  // 按钮靠右排列（仿微信PC：接听/挂断在右侧，药丸形）
  const int btn_y = kWindowHeight - kBtnH - kBtnBottom;
  const int total_btn_w = kBtnW * 2 + kBtnGap;
  const int btn_x_start = kWindowWidth - kPadX - total_btn_w;
  SetWindowPos(accept_btn_, nullptr, btn_x_start, btn_y, kBtnW, kBtnH,
               SWP_NOZORDER | SWP_NOACTIVATE);
  SetWindowPos(decline_btn_, nullptr, btn_x_start + kBtnW + kBtnGap, btn_y, kBtnW, kBtnH,
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
  accent_color_ = accent_color_hex ? accent_color_hex : 0xFF07C160;
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

void IncomingCallWindow::DrawAvatar(HDC hdc, const RECT& rc,
                                    const std::wstring& initial,
                                    COLORREF bg) {
  int cx = (rc.left + rc.right) / 2;
  int cy = (rc.top + rc.bottom) / 2;
  int base_r = (std::min)(rc.right - rc.left, rc.bottom - rc.top) / 2;

  // 呼吸光晕（头像外圈脉冲）
  if (pulse_phase_ > 0) {
    double t = pulse_phase_ / 30.0;
    int glow_r = base_r + static_cast<int>(6 * std::sin(t * 6.28318));
    // 微信风格光晕：淡绿色半透明感
    BYTE alpha = static_cast<BYTE>(40 + 30 * std::sin(t * 6.28318));
    HBRUSH glow_brush = CreateSolidBrush(RGB(
        (GetRValue(bg) * alpha + 255 * (255 - alpha)) / 255,
        (GetGValue(bg) * alpha + 255 * (255 - alpha)) / 255,
        (GetBValue(bg) * alpha + 255 * (255 - alpha)) / 255));
    HPEN null_pen = static_cast<HPEN>(GetStockObject(NULL_PEN));
    HBRUSH old_brush = static_cast<HBRUSH>(SelectObject(hdc, glow_brush));
    HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, null_pen));
    Ellipse(hdc, cx - glow_r, cy - glow_r, cx + glow_r, cy + glow_r);
    SelectObject(hdc, old_pen);
    SelectObject(hdc, old_brush);
    DeleteObject(glow_brush);
  }

  // 实心圆形头像底色
  HRGN rgn = CreateEllipticRgn(rc.left, rc.top, rc.right, rc.bottom);
  HBRUSH bg_brush = CreateSolidBrush(bg);
  FillRgn(hdc, rgn, bg_brush);
  DeleteObject(bg_brush);
  DeleteObject(rgn);

  // 首字母
  if (!initial.empty()) {
    std::wstring s(1, static_cast<wchar_t>(std::towupper(initial[0])));
    // 字号适配头像大小
    int font_size = base_r - 2;
    HFONT f = CreateFontW(font_size, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
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

// 绘制药丸形按钮（仿微信PC来电按钮）
void IncomingCallWindow::DrawPillButton(HDC hdc, const RECT& rc,
                                        const wchar_t* text,
                                        bool is_accept, bool hovered) {
  COLORREF bg = is_accept ? (hovered ? kAcceptHover : kAcceptBg)
                          : (hovered ? kDeclineHover : kDeclineBg);

  // 药丸形背景（圆角 = 高度的一半）
  DrawRoundedRect(hdc, rc, kBtnRadius, bg, CLR_NONE);

  // 接听按钮呼吸发光效果
  if (is_accept && accept_glow_ && !hovered) {
    double phase = (pulse_phase_ % 30) / 30.0;
    int g = static_cast<int>(180 + 50 * std::sin(phase * 6.28318));
    RECT glow_rc = rc;
    InflateRect(&glow_rc, 1, 1);
    HPEN pen = CreatePen(PS_SOLID, 1, RGB(7, g, 96));
    HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, pen));
    HBRUSH null_brush = static_cast<HBRUSH>(GetStockObject(NULL_BRUSH));
    HBRUSH old_brush = static_cast<HBRUSH>(SelectObject(hdc, null_brush));
    RoundRect(hdc, glow_rc.left, glow_rc.top, glow_rc.right, glow_rc.bottom,
              kBtnRadius + 1, kBtnRadius + 1);
    SelectObject(hdc, old_brush);
    SelectObject(hdc, old_pen);
    DeleteObject(pen);
  }

  // 白色文字居中
  HFONT f = CreateFontW(-13, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                        DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                        CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                        DEFAULT_PITCH | FF_SWISS, L"Microsoft YaHei UI");
  HFONT old = static_cast<HFONT>(SelectObject(hdc, f));
  SetBkMode(hdc, TRANSPARENT);
  SetTextColor(hdc, kBtnText);
  DrawTextW(hdc, text, -1, const_cast<RECT*>(&rc),
            DT_CENTER | DT_VCENTER | DT_SINGLELINE);
  SelectObject(hdc, old);
  DeleteObject(f);
}

void IncomingCallWindow::Paint(HWND hwnd, HDC hdc) {
  RECT rc;
  GetClientRect(hwnd, &rc);

  HDC mem = CreateCompatibleDC(hdc);
  HBITMAP bmp = CreateCompatibleBitmap(hdc, rc.right, rc.bottom);
  HBITMAP old_bmp = static_cast<HBITMAP>(SelectObject(mem, bmp));

  // ── 纯白背景（无可见边框线，靠DWM阴影区分层次） ──
  HBRUSH bg_brush = CreateSolidBrush(kBgColor);
  FillRect(mem, &rc, bg_brush);
  DeleteObject(bg_brush);

  // 圆角裁剪区域（防止绘制溢出圆角）
  HRGN clip_rgn = CreateRoundRectRgn(0, 0, rc.right + 1, rc.bottom + 1,
                                     kCornerRadius, kCornerRadius);
  SelectClipRgn(mem, clip_rgn);

  // ── 头像（左侧垂直居中） ──
  const int av_top = (kWindowHeight - kAvatarSize) / 2;
  RECT avatar_rc = {kPadX, av_top, kPadX + kAvatarSize, av_top + kAvatarSize};
  DrawAvatar(mem, avatar_rc, caller_initial_, ParseArgb(accent_color_));

  // ── 文字区域（头像右侧垂直居中） ──
  SetBkMode(mem, TRANSPARENT);
  HFONT old_font = nullptr;

  // 名称 —— 13pt 近黑色 Semibold（微信风格）
  HFONT name_font = CreateFontW(-13, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
                                DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                                CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                                DEFAULT_PITCH | FF_SWISS, L"Microsoft YaHei UI");
  old_font = static_cast<HFONT>(SelectObject(mem, name_font));
  SetTextColor(mem, kNameColor);
  const int text_top = av_top + 4;
  // 右侧留出按钮空间
  const int text_right = kWindowWidth - kPadX - kBtnW * 2 - kBtnGap - 10;
  RECT name_rc = {kTextLeft, text_top, text_right, text_top + 20};
  DrawTextW(mem, caller_name_.c_str(), -1, &name_rc,
            DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
  SelectObject(mem, old_font);
  DeleteObject(name_font);

  // 副标题 —— 11pt 中灰色（如"来电中"/"语音提醒"）
  HFONT sub_font = CreateFontW(-11, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                               DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                               CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                               DEFAULT_PITCH | FF_SWISS, L"Microsoft YaHei UI");
  old_font = static_cast<HFONT>(SelectObject(mem, sub_font));
  SetTextColor(mem, kSubColor);
  RECT sub_rc = {kTextLeft, text_top + 17, text_right, text_top + 33};
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

    // 自绘按钮：绘制药丸形状
    case WM_DRAWITEM: {
      auto* dis = reinterpret_cast<DRAWITEMSTRUCT*>(lparam);
      if (dis->CtlType == ODT_BUTTON) {
        bool is_accept = (dis->CtlID == 1);
        bool hovered = (dis->itemState & ODS_SELECTED) ||
                       (dis->itemState & ODS_HOTLIGHT);
        if (is_accept) accept_hovered_ = hovered;
        else decline_hovered_ = hovered;
        DrawPillButton(dis->hDC, dis->rcItem,
                       is_accept ? L"\u63A5\u542C" : L"\u6302\u65AD",
                       is_accept, hovered);
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
      // 按钮区域不拖动，其余区域可拖动
      if (pt.y < kWindowHeight - kBtnH - kBtnBottom) return HTCAPTION;
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
