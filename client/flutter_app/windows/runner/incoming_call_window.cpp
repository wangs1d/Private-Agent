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

// ── 窗口尺寸（豆包风深色卡片） ──
constexpr int kWindowWidth = 320;
constexpr int kWindowHeight = 336;
constexpr int kMargin = 20;       // 距屏幕边缘距离
constexpr int kCornerRadius = 28; // 卡片圆角

// ── 内部布局 ──
constexpr int kAvatarCx = kWindowWidth / 2;  // 波形圆心 x
constexpr int kAvatarCy = 92;                // 波形圆心 y
constexpr int kAvatarR = 40;                 // 波形圆半径
constexpr int kNameTop = 148;                // 名称 top
constexpr int kSubTop = 176;                 // 副标题 top
constexpr int kBtnSize = 56;                 // 圆形按钮直径
constexpr int kBtnCy = 250;                  // 按钮圆心 y
constexpr int kDeclineCx = 104;              // 拒接圆心 x
constexpr int kAcceptCx = 216;               // 接听圆心 x
constexpr int kLabelTop = 286;               // 按钮标签 top

// ── 配色（豆包风深色卡片） ──
constexpr COLORREF kBgColor       = RGB(0x1A, 0x1A, 0x1C);  // 卡片底
constexpr COLORREF kCircleColor   = RGB(0x2C, 0x2C, 0x2E);  // 波形圆底
constexpr COLORREF kNameColor     = RGB(0xFF, 0xFF, 0xFF);  // 名称白
constexpr COLORREF kMutedColor    = RGB(0x8E, 0x8E, 0x93);  // 副标题/标签灰
constexpr COLORREF kWhiteBtn      = RGB(0xFF, 0xFF, 0xFF);  // 接听白钮
constexpr COLORREF kWhiteBtnHover = RGB(0xE5, 0xE5, 0xEA);  // 接听悬停
constexpr COLORREF kDarkBtn       = RGB(0x2C, 0x2C, 0x2E);  // 拒接深钮
constexpr COLORREF kDarkBtnHover  = RGB(0x3A, 0x3A, 0x3C);  // 拒接悬停
constexpr COLORREF kGlyphOnWhite  = RGB(0x1A, 0x1A, 0x1C);  // 白钮上深图标
constexpr COLORREF kGlyphColor    = RGB(0xFF, 0xFF, 0xFF);  // 深钮上白图标

// 字形（Segoe MDL2 Assets）：E717 = Phone
constexpr wchar_t kGlyphPhone = L'\uE717';

COLORREF MixColor(COLORREF a, COLORREF b, double t) {
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  return RGB(
      static_cast<int>(GetRValue(a) + (GetRValue(b) - GetRValue(a)) * t),
      static_cast<int>(GetGValue(a) + (GetGValue(b) - GetGValue(a)) * t),
      static_cast<int>(GetBValue(a) + (GetBValue(b) - GetBValue(a)) * t));
}

// 在实心圆内画波形图标：5 根圆角竖条（phase < 0 为静态）
void DrawWaveform(HDC hdc, int cx, int cy, int max_h, COLORREF color,
                  int phase) {
  constexpr int kBarHeights[5] = {45, 100, 62, 100, 45};
  constexpr int kBarW = 4;
  constexpr int kGap = 4;
  const int total_w = 5 * kBarW + 4 * kGap;
  int x = cx - total_w / 2;
  for (int i = 0; i < 5; ++i) {
    double k = kBarHeights[i] / 100.0;
    if (phase >= 0) {
      k *= 0.82 + 0.18 * std::sin((phase + i * 6) * 6.28318 / 30.0);
    }
    const int h = (std::max)(3, static_cast<int>(max_h * k));
    RECT bar = {x, cy - h / 2, x + kBarW, cy + h / 2};
    HBRUSH brush = CreateSolidBrush(color);
    HPEN pen = CreatePen(PS_NULL, 0, 0);
    HBRUSH old_brush = static_cast<HBRUSH>(SelectObject(hdc, brush));
    HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, pen));
    RoundRect(hdc, bar.left, bar.top, bar.right, bar.bottom, kBarW, kBarW);
    SelectObject(hdc, old_brush);
    SelectObject(hdc, old_pen);
    DeleteObject(brush);
    DeleteObject(pen);
    x += kBarW + kGap;
  }
}

// 用实心圆填充（无描边）
void FillCircle(HDC hdc, int cx, int cy, int r, COLORREF fill) {
  HRGN rgn = CreateEllipticRgn(cx - r, cy - r, cx + r, cy + r);
  HBRUSH brush = CreateSolidBrush(fill);
  FillRgn(hdc, rgn, brush);
  DeleteObject(brush);
  DeleteObject(rgn);
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

  // 圆形按钮位于卡片底部：拒接（左）/ 接听（右）
  const int btn_y = kBtnCy - kBtnSize / 2;
  SetWindowPos(decline_btn_, nullptr, kDeclineCx - kBtnSize / 2, btn_y,
               kBtnSize, kBtnSize, SWP_NOZORDER | SWP_NOACTIVATE);
  SetWindowPos(accept_btn_, nullptr, kAcceptCx - kBtnSize / 2, btn_y,
               kBtnSize, kBtnSize, SWP_NOZORDER | SWP_NOACTIVATE);

  StartAcceptButtonGlow();
}

void IncomingCallWindow::Show(const std::string& caller_name,
                              const std::string& subtitle,
                              const std::string& /*caller_initial*/,
                              int ring_timeout_ms,
                              uint32_t /*accent_color_hex*/) {
  caller_name_ = Utf8ToWide(caller_name);
  subtitle_ = Utf8ToWide(subtitle);
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

// 绘制圆形图标按钮（豆包风：白底接听 / 深底拒接）
void IncomingCallWindow::DrawRoundIconButton(HDC hdc, const RECT& rc,
                                             wchar_t glyph, bool is_accept,
                                             bool hovered) {
  // 先把按钮矩形铺成卡片底色，避免圆形按钮四角露出系统底色
  RECT fill_rc = rc;
  HBRUSH bg_brush = CreateSolidBrush(kBgColor);
  FillRect(hdc, &fill_rc, bg_brush);
  DeleteObject(bg_brush);

  const COLORREF bg = is_accept ? (hovered ? kWhiteBtnHover : kWhiteBtn)
                                : (hovered ? kDarkBtnHover : kDarkBtn);

  // 圆形背景
  HRGN rgn = CreateEllipticRgn(rc.left, rc.top, rc.right, rc.bottom);
  HBRUSH brush = CreateSolidBrush(bg);
  FillRgn(hdc, rgn, brush);
  DeleteObject(brush);
  DeleteObject(rgn);

  // 接听按钮呼吸发光（白色柔环）
  if (is_accept && accept_glow_ && !hovered) {
    double phase = (pulse_phase_ % 30) / 30.0;
    COLORREF ring = MixColor(kBgColor, RGB(255, 255, 255), 0.45 * (1 - phase));
    RECT glow_rc = rc;
    InflateRect(&glow_rc, 2, 2);
    HPEN pen = CreatePen(PS_SOLID, 2, ring);
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
    DrawPhoneOffGlyph(hdc, rc, kGlyphColor, kBtnSize / 2 - 4);
  } else {
    DrawGlyph(hdc, rc, glyph, kGlyphOnWhite, kBtnSize / 2 - 4,
              L"Segoe MDL2 Assets");
  }
}

void IncomingCallWindow::Paint(HWND hwnd, HDC hdc) {
  RECT rc;
  GetClientRect(hwnd, &rc);

  HDC mem = CreateCompatibleDC(hdc);
  HBITMAP bmp = CreateCompatibleBitmap(hdc, rc.right, rc.bottom);
  HBITMAP old_bmp = static_cast<HBITMAP>(SelectObject(mem, bmp));

  // ── 深色卡片背景（无可见边框线，靠 DWM 阴影区分层次） ──
  HBRUSH bg_brush = CreateSolidBrush(kBgColor);
  FillRect(mem, &rc, bg_brush);
  DeleteObject(bg_brush);

  // 圆角裁剪区域（防止绘制溢出圆角）
  HRGN clip_rgn = CreateRoundRectRgn(0, 0, rc.right + 1, rc.bottom + 1,
                                     kCornerRadius, kCornerRadius);
  SelectClipRgn(mem, clip_rgn);

  // ── 中央波形圆 + 呼吸扩散外环 ──
  if (ringing_) {
    const double t = (pulse_phase_ % 30) / 30.0;
    const int r = kAvatarR + 6 + static_cast<int>(12 * t);
    FillCircle(mem, kAvatarCx, kAvatarCy, r,
               MixColor(kBgColor, kCircleColor, 0.55 * (1 - t)));
  }
  FillCircle(mem, kAvatarCx, kAvatarCy, kAvatarR, kCircleColor);
  DrawWaveform(mem, kAvatarCx, kAvatarCy, 22, RGB(0xFF, 0xFF, 0xFF), -1);

  // ── 名称（17px 白色 Semibold） ──
  SetBkMode(mem, TRANSPARENT);
  HFONT name_font = CreateFontW(-17, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
                                DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                                CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                                DEFAULT_PITCH | FF_SWISS,
                                L"Microsoft YaHei UI");
  HFONT old_font = static_cast<HFONT>(SelectObject(mem, name_font));
  SetTextColor(mem, kNameColor);
  RECT name_rc = {20, kNameTop, rc.right - 20, kNameTop + 26};
  DrawTextW(mem, caller_name_.c_str(), -1, &name_rc,
            DT_CENTER | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
  SelectObject(mem, old_font);
  DeleteObject(name_font);

  // ── 副标题（13px 中灰） ──
  HFONT sub_font = CreateFontW(-13, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                               DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                               CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                               DEFAULT_PITCH | FF_SWISS,
                               L"Microsoft YaHei UI");
  old_font = static_cast<HFONT>(SelectObject(mem, sub_font));
  SetTextColor(mem, kMutedColor);
  RECT sub_rc = {20, kSubTop, rc.right - 20, kSubTop + 22};
  DrawTextW(mem, subtitle_.c_str(), -1, &sub_rc,
            DT_CENTER | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
  SelectObject(mem, old_font);
  DeleteObject(sub_font);

  // ── 按钮标签（12px 中灰） ──
  HFONT label_font = CreateFontW(-12, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                                 DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                                 CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                                 DEFAULT_PITCH | FF_SWISS,
                                 L"Microsoft YaHei UI");
  old_font = static_cast<HFONT>(SelectObject(mem, label_font));
  SetTextColor(mem, kMutedColor);
  RECT labels[2] = {
      {kDeclineCx - 40, kLabelTop, kDeclineCx + 40, kLabelTop + 18},
      {kAcceptCx - 40, kLabelTop, kAcceptCx + 40, kLabelTop + 18}};
  const wchar_t* label_texts[2] = {L"\u62D2\u63A5", L"\u63A5\u542C"};  // 拒接/接听
  for (int i = 0; i < 2; ++i) {
    DrawTextW(mem, label_texts[i], -1, &labels[i],
              DT_CENTER | DT_SINGLELINE | DT_NOPREFIX);
  }
  SelectObject(mem, old_font);
  DeleteObject(label_font);

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
      // 按钮区域外整卡可拖动
      const int btn_y = kBtnCy - kBtnSize / 2;
      const bool in_decline =
          pt.x >= kDeclineCx - kBtnSize / 2 && pt.x <= kDeclineCx + kBtnSize / 2 &&
          pt.y >= btn_y && pt.y <= btn_y + kBtnSize;
      const bool in_accept =
          pt.x >= kAcceptCx - kBtnSize / 2 && pt.x <= kAcceptCx + kBtnSize / 2 &&
          pt.y >= btn_y && pt.y <= btn_y + kBtnSize;
      if (in_decline || in_accept) return HTCLIENT;
      return HTCAPTION;
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
