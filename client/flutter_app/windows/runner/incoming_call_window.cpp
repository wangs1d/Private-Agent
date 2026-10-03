#include "incoming_call_window.h"

#include <mmsystem.h>   // PlaySound
#include <windowsx.h>   // GET_X_LPARAM / GET_Y_LPARAM
#include <dwmapi.h>     // DWM
#include <stringapiset.h>

#include <algorithm>
#include <cmath>
#include <cwctype>

#include "call_visuals.h"

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

// ── 窗口尺寸（真玻璃深卡，尺寸对齐微信语音通话弹窗） ──
constexpr int kWindowWidth = 300;
constexpr int kWindowHeight = 376;
constexpr int kMargin = 20;  // 距屏幕边缘距离

// ── 内部布局 ──
constexpr int kAvatarCx = kWindowWidth / 2;  // 头像盘圆心 x
constexpr int kAvatarCy = 122;               // 头像盘圆心 y
constexpr int kAvatarR = 38;                 // 头像盘半径
constexpr int kNameTop = 172;                // 名称 top
constexpr int kSubTop = 202;                 // 副标题 top
constexpr int kStatusTop = 226;              // 状态行 top
constexpr int kDividerY = 256;               // 分隔线 y
constexpr int kBtnSize = 54;                 // 圆形按钮直径
constexpr int kBtnCy = 306;                  // 按钮圆心 y
constexpr int kDeclineCx = 92;               // 拒接圆心 x
constexpr int kAcceptCx = 208;               // 接听圆心 x
constexpr int kLabelTop = 340;               // 按钮标签 top

RECT DeclineRect() {
  return {kDeclineCx - kBtnSize / 2, kBtnCy - kBtnSize / 2,
          kDeclineCx + kBtnSize / 2, kBtnCy + kBtnSize / 2};
}

RECT AcceptRect() {
  return {kAcceptCx - kBtnSize / 2, kBtnCy - kBtnSize / 2,
          kAcceptCx + kBtnSize / 2, kBtnCy + kBtnSize / 2};
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
  call_vis::EnsureGdiplus();

  // 无子控件：整窗一层玻璃自绘表面，按钮全靠命中测试。
  // WS_EX_LAYERED = 逐像素 alpha 半透明（见 call_visuals.h），首次
  // UpdateLayeredWindow 上屏前窗口不可见。
  DWORD ex_style = WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE |
                   WS_EX_LAYERED;
  DWORD style = WS_POPUP;

  HWND hwnd = CreateWindowExW(
      ex_style, kClassName, L"", style, 0, 0, kWindowWidth, kWindowHeight,
      nullptr, nullptr, GetModuleHandle(nullptr), this);
  if (!hwnd) {
    OutputDebugStringW(L"IncomingCallWindow: CreateWindowExW failed");
    return false;
  }
  window_handle_ = hwnd;

  call_vis::ApplyRoundedCorners(hwnd);
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
}

void IncomingCallWindow::Show(const std::string& caller_name,
                              const std::string& subtitle,
                              const std::string& caller_initial,
                              int ring_timeout_ms,
                              uint32_t /*accent_color_hex*/) {
  caller_name_ = Utf8ToWide(caller_name);
  subtitle_ = Utf8ToWide(subtitle);
  caller_initial_ = Utf8ToWide(caller_initial);
  ring_timeout_ms_ = ring_timeout_ms > 0 ? ring_timeout_ms : 30000;

  if (!CreateWindowIfNeeded()) return;
  PositionAtBottomRight();
  FlashForAttention(window_handle_);

  StartRingtone();
  StartPulseTimer();
  StartTimeoutTimer();
  ringing_ = true;

  InvalidateRect(window_handle_, nullptr, FALSE);
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

// 头像首字符：payload 未带时退回姓名首字
const wchar_t* IncomingCallWindow::AvatarInitial() const {
  if (!caller_initial_.empty()) return caller_initial_.c_str();
  if (!caller_name_.empty()) return caller_name_.c_str();
  return nullptr;
}

void IncomingCallWindow::Paint(HWND hwnd, HDC hdc) {
  call_vis::GlassSurface& s =
      call_vis::SharedGlassSurface(kWindowWidth, kWindowHeight);

  // ── 半透明玻璃底：逐像素 alpha 深卡 + 高光描边（DWM 系统圆角） ──
  call_vis::DrawGlassBase(s);

  // ── 标题栏：信号条 + Nextbot 通话 + 最小化/关闭 ──
  call_vis::PaintTitleBar(s, kWindowWidth, title_min_hover_,
                          title_close_hover_);

  // ── 金属盘头像 + 振铃呼吸扩散外环 ──
  if (ringing_) {
    const double t = (pulse_phase_ % 30) / 30.0;
    const int r = kAvatarR + 5 + static_cast<int>(10 * t);
    call_vis::FillDiscAlpha(*s.gfx, kAvatarCx, kAvatarCy, r, RGB(0xBE, 0xBE, 0xC4),
                            static_cast<BYTE>(call_vis::kHaloBaseA * (1 - t)));
  }
  const wchar_t* initial = AvatarInitial();
  call_vis::PaintAvatarDisc(s, kAvatarCx, kAvatarCy, kAvatarR,
                            initial ? std::wstring(initial) : std::wstring());

  // ── 名称（18px 白 Semibold） ──
  RECT name_rc = {20, kNameTop, kWindowWidth - 20, kNameTop + 26};
  call_vis::DrawCenteredText(s, name_rc, caller_name_, call_vis::kNameColor,
                             18, FW_SEMIBOLD, L"Microsoft YaHei UI");

  // ── 副标题（12px 中灰） ──
  RECT sub_rc = {20, kSubTop, kWindowWidth - 20, kSubTop + 18};
  call_vis::DrawCenteredText(s, sub_rc, subtitle_, call_vis::kSubColor, 12,
                             FW_NORMAL, L"Microsoft YaHei UI");

  // ── 状态行（12px 暗灰）：来电 ──
  RECT status_rc = {20, kStatusTop, kWindowWidth - 20, kStatusTop + 18};
  call_vis::DrawCenteredText(s, status_rc, L"来电", call_vis::kStatusColor,
                             12, FW_NORMAL, L"Microsoft YaHei UI");

  // ── 分隔线 ──
  call_vis::DrawDivider(*s.gfx, kWindowWidth, kDividerY);

  // ── 接听钮呼吸光环（画在玻璃上，无子控件裁剪） ──
  if (ringing_ && accept_glow_) {
    const double t = (pulse_phase_ % 30) / 30.0;
    const Gdiplus::REAL r =
        static_cast<Gdiplus::REAL>(kBtnSize / 2 + 2 + 3 * t);
    Gdiplus::Pen pen(call_vis::GpColor(RGB(0xFF, 0xFF, 0xFF),
                                       static_cast<BYTE>(110 * (1 - t))),
                     1.5f);
    s.gfx->DrawEllipse(&pen, static_cast<Gdiplus::REAL>(kAcceptCx) - r,
                       static_cast<Gdiplus::REAL>(kBtnCy) - r, r * 2.0f,
                       r * 2.0f);
  }

  // ── 按钮：瓷白接听 / 曜石拒接（自绘，无子控件） ──
  const RECT decline_rc = DeclineRect();
  const RECT accept_rc = AcceptRect();
  call_vis::DrawSphereButton(s, decline_rc, call_vis::kGlyphPhone, false,
                             true, decline_hovered_);
  call_vis::DrawSphereButton(s, accept_rc, call_vis::kGlyphPhone, true,
                             false, accept_hovered_);

  // ── 按钮标签（11px 中灰） ──
  RECT labels[2] = {
      {kDeclineCx - 40, kLabelTop, kDeclineCx + 40, kLabelTop + 16},
      {kAcceptCx - 40, kLabelTop, kAcceptCx + 40, kLabelTop + 16}};
  const wchar_t* label_texts[2] = {L"拒接", L"接听"};
  for (int i = 0; i < 2; ++i) {
    call_vis::DrawCenteredText(s, labels[i], label_texts[i],
                               call_vis::kSubColor, 11, FW_NORMAL,
                               L"Microsoft YaHei UI");
  }

  call_vis::PresentLayered(hwnd, s, hdc);
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

namespace {

// 标题钮 / 拒接 / 接听悬停态刷新（有变化才重绘）
template <typename HoverState>
bool UpdateHover(HoverState& state, const RECT& rc, const POINT& pt) {
  const bool hover = call_vis::PointInRect(rc, pt);
  if (hover != state) {
    state = hover;
    return true;
  }
  return false;
}

}  // namespace

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

    case WM_MOUSEMOVE: {
      TRACKMOUSEEVENT tme = {};
      tme.cbSize = sizeof(tme);
      tme.dwFlags = TME_LEAVE;
      tme.hwndTrack = hwnd;
      TrackMouseEvent(&tme);

      POINT pt = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
      bool changed = false;
      const call_vis::TitleRects tr = call_vis::TitleRectsFor(kWindowWidth);
      changed |= UpdateHover(title_min_hover_, tr.minimize, pt);
      changed |= UpdateHover(title_close_hover_, tr.close, pt);
      changed |= UpdateHover(decline_hovered_, DeclineRect(), pt);
      changed |= UpdateHover(accept_hovered_, AcceptRect(), pt);
      if (changed) InvalidateRect(hwnd, nullptr, FALSE);
      break;
    }
    case WM_MOUSELEAVE:
      if (accept_hovered_ || decline_hovered_ || title_min_hover_ ||
          title_close_hover_) {
        accept_hovered_ = false;
        decline_hovered_ = false;
        title_min_hover_ = false;
        title_close_hover_ = false;
        InvalidateRect(hwnd, nullptr, FALSE);
      }
      break;

    case WM_LBUTTONUP: {
      POINT pt = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
      const call_vis::TitleRects tr = call_vis::TitleRectsFor(kWindowWidth);
      if (call_vis::PointInRect(tr.close, pt)) {
        // 关闭 = 拒接
        StopRingtone();
        if (on_decline_) on_decline_();
        PostMessage(hwnd, kMsgDeferredHide, 0, 0);
        return 0;
      }
      if (call_vis::PointInRect(tr.minimize, pt)) {
        // 最小化 = 收起窗口（振铃继续，超时仍会走 on_timeout）
        ShowWindow(hwnd, SW_HIDE);
        return 0;
      }
      if (call_vis::PointInRect(DeclineRect(), pt)) {
        StopRingtone();
        if (on_decline_) on_decline_();
        PostMessage(hwnd, kMsgDeferredHide, 0, 0);
        return 0;
      }
      if (call_vis::PointInRect(AcceptRect(), pt)) {
        StopRingtone();
        if (on_accept_) on_accept_();
        PostMessage(hwnd, kMsgDeferredHide, 0, 0);
        return 0;
      }
      break;
    }

    case WM_NCHITTEST: {
      POINT pt = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
      ScreenToClient(hwnd, &pt);
      // 标题栏钮与圆形按钮可点击，其余整卡可拖动
      const call_vis::TitleRects tr = call_vis::TitleRectsFor(kWindowWidth);
      if (call_vis::PointInRect(tr.minimize, pt) ||
          call_vis::PointInRect(tr.close, pt) ||
          call_vis::PointInRect(DeclineRect(), pt) ||
          call_vis::PointInRect(AcceptRect(), pt)) {
        return HTCLIENT;
      }
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
