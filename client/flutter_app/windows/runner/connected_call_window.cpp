#include "connected_call_window.h"

#include <dwmapi.h>
#include <windowsx.h>

#include <algorithm>
#include <cmath>
#include <cwctype>

#include "call_visuals.h"

#ifndef DWMNCR_ENABLED
#define DWMNCR_ENABLED 1
#endif

#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "dwmapi.lib")

namespace {

// ── 内部布局 ──
constexpr int kAvatarCx = ConnectedCallWindow::kWindowWidth / 2;  // 头像盘圆心 x
constexpr int kAvatarCy = 122;               // 头像盘圆心 y
constexpr int kAvatarR = 38;                 // 头像盘半径
constexpr int kNameTop = 172;                // 名称 top
constexpr int kStatusTop = 202;              // 状态行（波形+计时）top
constexpr int kStatusH = 18;                 // 状态行高
constexpr int kDividerY = 240;               // 分隔线 y
constexpr int kToggleSize = 46;              // 静音/免提直径
constexpr int kToggleCy = 272;               // 切换钮圆心 y
constexpr int kMuteCx = 110;                 // 静音圆心 x
constexpr int kSpeakerCx = 190;              // 免提圆心 x
constexpr int kPillLeft = 96;                // 挂断胶囊 left
constexpr int kPillTop = 306;                // 挂断胶囊 top
constexpr int kPillW = 108;
constexpr int kPillH = 38;

RECT MuteRect() {
  return {kMuteCx - kToggleSize / 2, kToggleCy - kToggleSize / 2,
          kMuteCx + kToggleSize / 2, kToggleCy + kToggleSize / 2};
}

RECT SpeakerRect() {
  return {kSpeakerCx - kToggleSize / 2, kToggleCy - kToggleSize / 2,
          kSpeakerCx + kToggleSize / 2, kToggleCy + kToggleSize / 2};
}

RECT PillRect() {
  return {kPillLeft, kPillTop, kPillLeft + kPillW, kPillTop + kPillH};
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

// 计时文案：不足 1 小时用 mm:ss，超过后 h:mm:ss
std::wstring FormatDuration(int seconds) {
  if (seconds < 0) seconds = 0;
  const int hh = seconds / 3600;
  const int mm = (seconds % 3600) / 60;
  const int ss = seconds % 60;
  wchar_t buf[20];
  if (hh > 0) {
    swprintf_s(buf, L"%d:%02d:%02d", hh, mm, ss);
  } else {
    swprintf_s(buf, L"%02d:%02d", mm, ss);
  }
  return std::wstring(buf);
}

bool UpdateHover(bool& state, const RECT& rc, const POINT& pt) {
  const bool hover = call_vis::PointInRect(rc, pt);
  if (hover != state) {
    state = hover;
    return true;
  }
  return false;
}

}  // namespace

void ConnectedCallWindow::EnsureClassRegistered() {
  static bool registered = false;
  if (registered) return;
  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(WNDCLASSEXW);
  wc.style = CS_HREDRAW | CS_VREDRAW | CS_DBLCLKS;
  wc.lpfnWndProc = ConnectedCallWindow::WndProc;
  wc.hInstance = GetModuleHandle(nullptr);
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.hbrBackground = nullptr;
  wc.lpszClassName = kClassName;
  RegisterClassExW(&wc);
  registered = true;
}

ConnectedCallWindow::ConnectedCallWindow() = default;

ConnectedCallWindow::~ConnectedCallWindow() { DestroyNativeWindow(); }

void ConnectedCallWindow::SetCallbacks(
    HangUpCallback on_hangup, MuteCallback on_mute_toggle,
    SpeakerCallback on_speaker_toggle) {
  on_hangup_ = std::move(on_hangup);
  on_mute_toggle_ = std::move(on_mute_toggle);
  on_speaker_toggle_ = std::move(on_speaker_toggle);
}

bool ConnectedCallWindow::CreateWindowIfNeeded() {
  if (window_handle_) return true;
  EnsureClassRegistered();
  call_vis::EnsureGdiplus();

  // 无子控件：整窗一层玻璃自绘表面，按钮全靠命中测试
  DWORD ex_style = WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
  DWORD style = WS_POPUP;

  HWND hwnd = CreateWindowExW(
      ex_style, kClassName, L"", style, 0, 0, kWindowWidth, kWindowHeight,
      nullptr, nullptr, GetModuleHandle(nullptr), this);
  if (!hwnd) {
    OutputDebugStringW(L"ConnectedCallWindow: CreateWindowExW failed");
    return false;
  }
  window_handle_ = hwnd;

  call_vis::ApplyRoundedCorners(hwnd);
  return true;
}

void ConnectedCallWindow::PositionAtBottomRight() {
  if (!window_handle_) return;
  HMONITOR mon = MonitorFromWindow(window_handle_, MONITOR_DEFAULTTONEAREST);
  MONITORINFO mi = {sizeof(mi)};
  GetMonitorInfoW(mon, &mi);
  const int work_w = mi.rcWork.right - mi.rcWork.left;
  const int work_h = mi.rcWork.bottom - mi.rcWork.top;
  const int x = mi.rcWork.left + (work_w - kWindowWidth - kMargin);
  const int y = mi.rcWork.top + (work_h - kWindowHeight - kMargin);

  // 玻璃底在窗口可见前抓拍；已可见（更新内容）则沿用旧底
  if (!IsWindowVisible(window_handle_)) {
    delete backdrop_;
    call_vis::CaptureGlassBackdrop(x, y, kWindowWidth, kWindowHeight,
                                   &backdrop_, &backdrop_dim_);
  }

  SetWindowPos(window_handle_, HWND_TOPMOST, x, y, kWindowWidth, kWindowHeight,
               SWP_NOACTIVATE | SWP_SHOWWINDOW);
}

void ConnectedCallWindow::Show(const std::string& caller_name,
                               const std::string& caller_initial,
                               uint32_t /*accent_color_hex*/) {
  caller_name_ = Utf8ToWide(caller_name);
  caller_initial_ = Utf8ToWide(caller_initial);

  if (!CreateWindowIfNeeded()) return;
  PositionAtBottomRight();
  StartTimer();
  if (talking_) StartPulse();
  InvalidateRect(window_handle_, nullptr, FALSE);
}

void ConnectedCallWindow::Hide() {
  StopTimer();
  StopPulse();
  if (window_handle_) {
    ShowWindow(window_handle_, SW_HIDE);
  }
}

void ConnectedCallWindow::DestroyNativeWindow() {
  StopTimer();
  StopPulse();
  delete backdrop_;
  backdrop_ = nullptr;
  if (window_handle_) {
    if (IsWindow(window_handle_)) {
      DestroyWindow(window_handle_);
    }
    window_handle_ = nullptr;
  }
}

bool ConnectedCallWindow::IsVisible() const {
  return window_handle_ && IsWindowVisible(window_handle_);
}

void ConnectedCallWindow::SetMute(bool muted) {
  if (muted_ == muted) return;
  muted_ = muted;
  if (window_handle_) InvalidateRect(window_handle_, nullptr, FALSE);
}

void ConnectedCallWindow::SetSpeaker(bool on) {
  if (speaker_on_ == on) return;
  speaker_on_ = on;
  if (window_handle_) InvalidateRect(window_handle_, nullptr, FALSE);
}

void ConnectedCallWindow::SetTalking(bool talking) {
  if (talking_ == talking) return;
  talking_ = talking;
  if (talking_) StartPulse();
  else StopPulse();
  if (window_handle_) InvalidateRect(window_handle_, nullptr, FALSE);
}

void ConnectedCallWindow::ResetDuration() {
  elapsed_seconds_ = 0;
  if (window_handle_) InvalidateRect(window_handle_, nullptr, FALSE);
}

void ConnectedCallWindow::SetElapsedSeconds(int seconds) {
  elapsed_seconds_ = seconds > 0 ? seconds : 0;
  if (window_handle_) InvalidateRect(window_handle_, nullptr, FALSE);
}

void ConnectedCallWindow::StartTimer() {
  if (!window_handle_) return;
  SetTimer(window_handle_, kTickTimerId, 1000, nullptr);
}

void ConnectedCallWindow::StopTimer() {
  if (window_handle_) KillTimer(window_handle_, kTickTimerId);
}

void ConnectedCallWindow::StartPulse() {
  if (!window_handle_) return;
  pulse_phase_ = 0;
  SetTimer(window_handle_, kPulseTimerId, 50, nullptr);
}

void ConnectedCallWindow::StopPulse() {
  if (window_handle_) KillTimer(window_handle_, kPulseTimerId);
}

void CALLBACK ConnectedCallWindow::TickProc(HWND, UINT, UINT_PTR,
                                            DWORD) noexcept {
  // WM_TIMER handler
}

// Drawing

void ConnectedCallWindow::Paint(HWND hwnd, HDC hdc) {
  RECT rc;
  GetClientRect(hwnd, &rc);

  HDC mem = CreateCompatibleDC(hdc);
  HBITMAP bmp = CreateCompatibleBitmap(hdc, rc.right, rc.bottom);
  HBITMAP old_bmp = static_cast<HBITMAP>(SelectObject(mem, bmp));

  // ── 玻璃底 ──
  call_vis::DrawGlassBase(mem, backdrop_, backdrop_dim_, kWindowWidth,
                          kWindowHeight);

  // ── 标题栏 ──
  call_vis::PaintTitleBar(mem, kWindowWidth, title_min_hover_,
                          title_close_hover_);

  // ── 金属盘头像 + 播报呼吸光环（双层相位错开） ──
  if (talking_) {
    const double t = (pulse_phase_ % 30) / 30.0;
    const double t2 = fmod(t + 0.5, 1.0);
    for (int i = 0; i < 2; ++i) {
      const double tt = (i == 0) ? t : t2;
      const int r = kAvatarR + 5 + static_cast<int>(12 * tt);
      call_vis::FillDiscAlpha(mem, kAvatarCx, kAvatarCy, r,
                              RGB(0xBE, 0xBE, 0xC4),
                              static_cast<BYTE>(call_vis::kHaloBaseA *
                                                (1 - tt)));
    }
  }
  const wchar_t* initial =
      !caller_initial_.empty()
          ? caller_initial_.c_str()
          : (!caller_name_.empty() ? caller_name_.c_str() : nullptr);
  call_vis::PaintAvatarDisc(mem, kAvatarCx, kAvatarCy, kAvatarR,
                            initial ? std::wstring(initial) : std::wstring());

  // ── 名称（18px 白 Semibold） ──
  RECT name_rc = {20, kNameTop, rc.right - 20, kNameTop + 26};
  call_vis::DrawCenteredText(mem, name_rc, caller_name_, call_vis::kNameColor,
                             18, FW_SEMIBOLD, L"Microsoft YaHei UI");

  // ── 状态行：小波形 + 计时（12px 中灰，居中成组） ──
  std::wstring status_text =
      (muted_ ? L"已静音 · " : L"") + FormatDuration(elapsed_seconds_);
  HFONT status_font =
      call_vis::MakeFont(12, FW_NORMAL, L"Microsoft YaHei UI");
  HFONT old_font = static_cast<HFONT>(SelectObject(mem, status_font));
  SIZE sz = {0, 0};
  GetTextExtentPoint32W(mem, status_text.c_str(),
                        static_cast<int>(status_text.size()), &sz);
  SelectObject(mem, old_font);
  DeleteObject(status_font);

  constexpr int kBarsW = 30;
  const int total_w = kBarsW + 10 + sz.cx;
  const int group_left = kAvatarCx - total_w / 2;
  const int status_cy = kStatusTop + kStatusH / 2;
  call_vis::DrawWaveBars(mem, group_left + kBarsW / 2, status_cy, 12,
                         call_vis::kSubColor, talking_ ? pulse_phase_ : -1);
  old_font = static_cast<HFONT>(SelectObject(mem, status_font =
      call_vis::MakeFont(12, FW_NORMAL, L"Microsoft YaHei UI")));
  SetBkMode(mem, TRANSPARENT);
  SetTextColor(mem, call_vis::kSubColor);
  RECT status_rc = {group_left + kBarsW + 10, kStatusTop, rc.right - 20,
                    kStatusTop + kStatusH};
  DrawTextW(mem, status_text.c_str(), -1, &status_rc,
            DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
  SelectObject(mem, old_font);
  DeleteObject(status_font);

  // ── 分隔线 ──
  call_vis::DrawDivider(mem, kWindowWidth, kDividerY);

  // ── 切换钮：静音 / 免提（激活=瓷白盘，自绘无子控件） ──
  call_vis::DrawSphereButton(mem, MuteRect(), call_vis::kGlyphMic, muted_,
                             muted_, mute_hover_);
  call_vis::DrawSphereButton(mem, SpeakerRect(), call_vis::kGlyphVolume,
                             speaker_on_, false, speaker_hover_);

  // ── 挂断胶囊 ──
  call_vis::DrawPillButton(mem, PillRect(), pill_hover_);

  BitBlt(hdc, 0, 0, rc.right, rc.bottom, mem, 0, 0, SRCCOPY);
  SelectObject(mem, old_bmp);
  DeleteObject(bmp);
  DeleteDC(mem);
}

// Message handling

LRESULT CALLBACK ConnectedCallWindow::WndProc(HWND hwnd, UINT message,
                                              WPARAM wparam,
                                              LPARAM lparam) noexcept {
  if (message == WM_NCCREATE) {
    auto* cs = reinterpret_cast<CREATESTRUCT*>(lparam);
    SetWindowLongPtr(hwnd, GWLP_USERDATA,
                     reinterpret_cast<LONG_PTR>(cs->lpCreateParams));
  } else {
    auto* that = reinterpret_cast<ConnectedCallWindow*>(
        GetWindowLongPtr(hwnd, GWLP_USERDATA));
    if (that) return that->HandleMessage(hwnd, message, wparam, lparam);
  }
  return DefWindowProc(hwnd, message, wparam, lparam);
}

LRESULT ConnectedCallWindow::HandleMessage(HWND hwnd, UINT message,
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
      if (wparam == kTickTimerId) {
        elapsed_seconds_++;
        InvalidateRect(hwnd, nullptr, FALSE);
        return 0;
      }
      if (wparam == kPulseTimerId) {
        pulse_phase_ = (pulse_phase_ + 1) % 30;
        InvalidateRect(hwnd, nullptr, FALSE);
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
      changed |= UpdateHover(mute_hover_, MuteRect(), pt);
      changed |= UpdateHover(speaker_hover_, SpeakerRect(), pt);
      changed |= UpdateHover(pill_hover_, PillRect(), pt);
      if (changed) InvalidateRect(hwnd, nullptr, FALSE);
      break;
    }
    case WM_MOUSELEAVE:
      if (title_min_hover_ || title_close_hover_ || mute_hover_ ||
          speaker_hover_ || pill_hover_) {
        title_min_hover_ = false;
        title_close_hover_ = false;
        mute_hover_ = false;
        speaker_hover_ = false;
        pill_hover_ = false;
        InvalidateRect(hwnd, nullptr, FALSE);
      }
      break;
    case WM_LBUTTONUP: {
      POINT pt = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
      const call_vis::TitleRects tr = call_vis::TitleRectsFor(kWindowWidth);
      if (call_vis::PointInRect(tr.close, pt)) {
        // 关闭 = 挂断
        if (on_hangup_) on_hangup_();
        PostMessage(hwnd, kMsgDeferredHide, 0, 0);
        return 0;
      }
      if (call_vis::PointInRect(tr.minimize, pt)) {
        // 最小化 = 收起窗口（通话继续，服务端结束时 Dart 侧仍会 Hide）
        ShowWindow(hwnd, SW_HIDE);
        return 0;
      }
      if (call_vis::PointInRect(MuteRect(), pt)) {
        muted_ = !muted_;
        InvalidateRect(hwnd, nullptr, FALSE);
        if (on_mute_toggle_) on_mute_toggle_(muted_);
        return 0;
      }
      if (call_vis::PointInRect(SpeakerRect(), pt)) {
        speaker_on_ = !speaker_on_;
        InvalidateRect(hwnd, nullptr, FALSE);
        if (on_speaker_toggle_) on_speaker_toggle_(speaker_on_);
        return 0;
      }
      if (call_vis::PointInRect(PillRect(), pt)) {
        if (on_hangup_) on_hangup_();
        PostMessage(hwnd, kMsgDeferredHide, 0, 0);
        return 0;
      }
      break;
    }
    case WM_NCHITTEST: {
      POINT pt = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
      ScreenToClient(hwnd, &pt);

      // 标题栏钮、切换钮与挂断胶囊可点击，其余整卡可拖动
      const call_vis::TitleRects tr = call_vis::TitleRectsFor(kWindowWidth);
      if (call_vis::PointInRect(tr.minimize, pt) ||
          call_vis::PointInRect(tr.close, pt) ||
          call_vis::PointInRect(MuteRect(), pt) ||
          call_vis::PointInRect(SpeakerRect(), pt) ||
          call_vis::PointInRect(PillRect(), pt)) {
        return HTCLIENT;
      }
      return HTCAPTION;
    }
    case kMsgDeferredHide:
      Hide();
      return 0;
    case WM_DESTROY:
      StopTimer();
      StopPulse();
      SetWindowLongPtr(hwnd, GWLP_USERDATA, 0);
      window_handle_ = nullptr;
      return 0;
  }
  return DefWindowProc(hwnd, message, wparam, lparam);
}
