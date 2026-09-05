#include "connected_call_window.h"

#include <dwmapi.h>
#include <windowsx.h>

#include <algorithm>
#include <cmath>
#include <cwctype>

#ifndef CLR_NONE
#define CLR_NONE static_cast<COLORREF>(0xFFFFFFFFL)
#endif

#ifndef DWMNCR_ENABLED
#define DWMNCR_ENABLED 1
#endif

#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "dwmapi.lib")

namespace {

// ── 配色（豆包风深色卡片） ──
constexpr COLORREF kBg            = RGB(0x1A, 0x1A, 0x1C);  // 卡片底
constexpr COLORREF kCircle        = RGB(0x2C, 0x2C, 0x2E);  // 波形圆底
constexpr COLORREF kNameColor     = RGB(0xFF, 0xFF, 0xFF);  // 名称白
constexpr COLORREF kMutedColor    = RGB(0x8E, 0x8E, 0x93);  // 状态/标签灰
constexpr COLORREF kWhiteBtn      = RGB(0xFF, 0xFF, 0xFF);  // 挂断白钮/激活态
constexpr COLORREF kWhiteBtnHover = RGB(0xE5, 0xE5, 0xEA);  // 白钮悬停
constexpr COLORREF kDarkBtn       = RGB(0x2C, 0x2C, 0x2E);  // 静音/免提深钮
constexpr COLORREF kDarkBtnHover  = RGB(0x3A, 0x3A, 0x3C);  // 深钮悬停
constexpr COLORREF kGlyphOnWhite  = RGB(0x1A, 0x1A, 0x1C);  // 白钮上深图标

// ── 内部布局 ──
constexpr int kAvatarCx  = 160;  // 波形圆心 x
constexpr int kAvatarCy  = 78;   // 波形圆心 y
constexpr int kAvatarR   = 36;   // 波形圆半径
constexpr int kNameTop   = 124;  // 名称 top
constexpr int kStatusTop = 152;  // 状态行 top
constexpr int kBtnCy     = 232;  // 按钮圆心 y
constexpr int kSideBtn   = 52;   // 静音/免提直径
constexpr int kMainBtn   = 60;   // 挂断直径
constexpr int kMuteCx    = 92;   // 静音圆心 x
constexpr int kHangupCx  = 160;  // 挂断圆心 x
constexpr int kSpeakerCx = 228;  // 免提圆心 x
constexpr int kLabelTop  = 266;  // 标签 top

// 字形（Segoe MDL2 Assets）：E717 = Phone, E720 = Mic, E767 = Volume
constexpr wchar_t kGlyphPhone   = L'\uE717';
constexpr wchar_t kGlyphMic     = L'\uE720';
constexpr wchar_t kGlyphVolume  = L'\uE767';

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

std::wstring Utf8ToWide(const std::string& s) {
  if (s.empty()) return L"";
  int len = MultiByteToWideChar(CP_UTF8, 0, s.c_str(),
                                 static_cast<int>(s.size()), nullptr, 0);
  std::wstring out(len, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()),
                      out.data(), len);
  return out;
}

std::wstring FormatDuration(int seconds) {
  if (seconds < 0) seconds = 0;
  int hh = seconds / 3600;
  int mm = (seconds % 3600) / 60;
  int ss = seconds % 60;
  wchar_t buf[20];
  swprintf_s(buf, L"%02d:%02d:%02d", hh, mm, ss);
  return std::wstring(buf);
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

void FillCircle(HDC hdc, int cx, int cy, int r, COLORREF fill) {
  HRGN rgn = CreateEllipticRgn(cx - r, cy - r, cx + r, cy + r);
  HBRUSH brush = CreateSolidBrush(fill);
  FillRgn(hdc, rgn, brush);
  DeleteObject(brush);
  DeleteObject(rgn);
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

  DWORD ex_style = WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
  DWORD style = WS_POPUP | WS_CLIPCHILDREN;

  HWND hwnd = CreateWindowExW(
      ex_style, kClassName, L"", style, 0, 0, kWindowWidth, kWindowHeight,
      nullptr, nullptr, GetModuleHandle(nullptr), this);
  if (!hwnd) {
    OutputDebugStringW(L"ConnectedCallWindow: CreateWindowExW failed");
    return false;
  }
  window_handle_ = hwnd;

  // 自绘圆形图标按钮
  mute_btn_ = CreateWindowExW(
      0, L"BUTTON", L"",
      WS_CHILD | WS_VISIBLE | BS_OWNERDRAW, 0, 0, 0, 0, hwnd,
      reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdMute)),
      GetModuleHandle(nullptr), nullptr);
  speaker_btn_ = CreateWindowExW(
      0, L"BUTTON", L"",
      WS_CHILD | WS_VISIBLE | BS_OWNERDRAW, 0, 0, 0, 0, hwnd,
      reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdSpeaker)),
      GetModuleHandle(nullptr), nullptr);
  hangup_btn_ = CreateWindowExW(
      0, L"BUTTON", L"",
      WS_CHILD | WS_VISIBLE | BS_OWNERDRAW, 0, 0, 0, 0, hwnd,
      reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdHangup)),
      GetModuleHandle(nullptr), nullptr);

  HFONT ui_font = reinterpret_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT));
  SendMessage(mute_btn_, WM_SETFONT, reinterpret_cast<WPARAM>(ui_font), TRUE);
  SendMessage(speaker_btn_, WM_SETFONT, reinterpret_cast<WPARAM>(ui_font), TRUE);
  SendMessage(hangup_btn_, WM_SETFONT, reinterpret_cast<WPARAM>(ui_font), TRUE);

  EnableDwmShadow(hwnd);
  return true;
}

void ConnectedCallWindow::RepositionChildren() {
  if (!window_handle_) return;
  // 底部三钮：静音（左）· 挂断（中，略大白钮）· 免提（右）+ 下方标签
  const int side_y = kBtnCy - kSideBtn / 2;
  if (mute_btn_) {
    SetWindowPos(mute_btn_, nullptr, kMuteCx - kSideBtn / 2, side_y,
                 kSideBtn, kSideBtn, SWP_NOZORDER | SWP_NOACTIVATE);
  }
  if (hangup_btn_) {
    SetWindowPos(hangup_btn_, nullptr, kHangupCx - kMainBtn / 2,
                 kBtnCy - kMainBtn / 2, kMainBtn, kMainBtn,
                 SWP_NOZORDER | SWP_NOACTIVATE);
  }
  if (speaker_btn_) {
    SetWindowPos(speaker_btn_, nullptr, kSpeakerCx - kSideBtn / 2, side_y,
                 kSideBtn, kSideBtn, SWP_NOZORDER | SWP_NOACTIVATE);
  }
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
  SetWindowPos(window_handle_, HWND_TOPMOST, x, y, kWindowWidth, kWindowHeight,
               SWP_NOACTIVATE | SWP_SHOWWINDOW);
  RepositionChildren();
}

void ConnectedCallWindow::Show(const std::string& caller_name,
                               const std::string& /*caller_initial*/,
                               uint32_t /*accent_color_hex*/) {
  caller_name_ = Utf8ToWide(caller_name);

  if (!CreateWindowIfNeeded()) return;
  PositionAtBottomRight();
  StartTimer();
  if (talking_) StartPulse();
  InvalidateRect(window_handle_, nullptr, TRUE);
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
  if (mute_btn_) {
    if (IsWindow(mute_btn_)) {
      DestroyWindow(mute_btn_);
    }
    mute_btn_ = nullptr;
  }
  if (speaker_btn_) {
    if (IsWindow(speaker_btn_)) {
      DestroyWindow(speaker_btn_);
    }
    speaker_btn_ = nullptr;
  }
  if (hangup_btn_) {
    if (IsWindow(hangup_btn_)) {
      DestroyWindow(hangup_btn_);
    }
    hangup_btn_ = nullptr;
  }
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
  if (window_handle_) InvalidateRect(window_handle_, nullptr, TRUE);
}

void ConnectedCallWindow::SetSpeaker(bool on) {
  if (speaker_on_ == on) return;
  speaker_on_ = on;
  if (window_handle_) InvalidateRect(window_handle_, nullptr, TRUE);
}

void ConnectedCallWindow::SetTalking(bool talking) {
  if (talking_ == talking) return;
  talking_ = talking;
  if (talking_) StartPulse();
  else StopPulse();
  if (window_handle_) InvalidateRect(window_handle_, nullptr, TRUE);
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

void ConnectedCallWindow::DrawRoundedRect(HDC hdc, const RECT& rc, int radius,
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
    // null_brush is a stock object.
  }
  SelectObject(hdc, old_brush);
  SelectObject(hdc, old_pen);
  DeleteObject(brush);
  DeleteObject(pen);
}

void ConnectedCallWindow::DrawGlyph(HDC hdc, const RECT& rc, wchar_t glyph,
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

// 圆形动作按钮：白卡矩形铺底 + 实心圆 + 居中字形（可选斜线表示 off）
void ConnectedCallWindow::DrawRoundActionButton(HDC hdc, const RECT& rc,
                                                wchar_t glyph,
                                                COLORREF fill,
                                                COLORREF glyph_color,
                                                bool draw_off_slash) {
  HBRUSH bg = CreateSolidBrush(kBg);
  FillRect(hdc, &rc, bg);
  DeleteObject(bg);

  HRGN rgn = CreateEllipticRgn(rc.left, rc.top, rc.right, rc.bottom);
  HBRUSH brush = CreateSolidBrush(fill);
  FillRgn(hdc, rgn, brush);
  DeleteObject(brush);
  DeleteObject(rgn);

  const int font_size = (rc.right - rc.left) / 2;
  RECT icon_rc = rc;
  DrawGlyph(hdc, icon_rc, glyph, glyph_color, font_size,
            L"Segoe MDL2 Assets");

  if (draw_off_slash) {
    HPEN pen = CreatePen(PS_SOLID, 2, glyph_color);
    HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, pen));
    int cx = (rc.left + rc.right) / 2;
    int cy = (rc.top + rc.bottom) / 2;
    int off = font_size / 3;
    MoveToEx(hdc, cx + off, cy + off, nullptr);
    LineTo(hdc, cx - off, cy - off);
    SelectObject(hdc, old_pen);
    DeleteObject(pen);
  }
}

void ConnectedCallWindow::Paint(HWND hwnd, HDC hdc) {
  RECT rc;
  GetClientRect(hwnd, &rc);

  HDC mem = CreateCompatibleDC(hdc);
  HBITMAP bmp = CreateCompatibleBitmap(hdc, rc.right, rc.bottom);
  HBITMAP old_bmp = static_cast<HBITMAP>(SelectObject(mem, bmp));

  // 深色卡片背景（豆包风，28px 圆角，DWM 阴影）
  HBRUSH bg_brush = CreateSolidBrush(kBg);
  FillRect(mem, &rc, bg_brush);
  DeleteObject(bg_brush);

  constexpr int kRadius = 28;
  HRGN clip_rgn = CreateRoundRectRgn(0, 0, rc.right + 1, rc.bottom + 1,
                                     kRadius, kRadius);
  SelectClipRgn(mem, clip_rgn);

  // ── 中央波形圆 + 播报呼吸光环（双层相位错开） ──
  if (talking_) {
    double t = (pulse_phase_ % 30) / 30.0;
    double t2 = fmod(t + 0.5, 1.0);
    for (int i = 0; i < 2; ++i) {
      const double tt = (i == 0) ? t : t2;
      const int r = kAvatarR + 6 + static_cast<int>(16 * tt);
      FillCircle(mem, kAvatarCx, kAvatarCy, r,
                 MixColor(kBg, kCircle, 0.5 * (1 - tt)));
    }
  }
  FillCircle(mem, kAvatarCx, kAvatarCy, kAvatarR, kCircle);
  DrawWaveform(mem, kAvatarCx, kAvatarCy, 20, RGB(0xFF, 0xFF, 0xFF),
               talking_ ? pulse_phase_ : -1);

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

  // ── 状态 + 计时（13px 中灰） ──
  std::wstring status_text = muted_ ? L"\u5DF2\u9759\u97F3"   // 已静音
                                    : L"\u901A\u8BDD\u4E2D";  // 通话中
  std::wstring status_line =
      status_text + L" \u00B7 " + FormatDuration(elapsed_seconds_);
  HFONT status_font = CreateFontW(-13, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                                  DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                                  CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                                  DEFAULT_PITCH | FF_SWISS,
                                  L"Microsoft YaHei UI");
  old_font = static_cast<HFONT>(SelectObject(mem, status_font));
  SetTextColor(mem, kMutedColor);
  RECT status_rc = {20, kStatusTop, rc.right - 20, kStatusTop + 22};
  DrawTextW(mem, status_line.c_str(), -1, &status_rc,
            DT_CENTER | DT_SINGLELINE | DT_NOPREFIX);
  SelectObject(mem, old_font);
  DeleteObject(status_font);

  // ── 底部按钮标签（12px 中灰） ──
  HFONT label_font = CreateFontW(-12, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                                 DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                                 CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                                 DEFAULT_PITCH | FF_SWISS,
                                 L"Microsoft YaHei UI");
  old_font = static_cast<HFONT>(SelectObject(mem, label_font));
  SetTextColor(mem, kMutedColor);
  RECT labels[3] = {
      {kMuteCx - 40, kLabelTop, kMuteCx + 40, kLabelTop + 18},
      {kHangupCx - 40, kLabelTop, kHangupCx + 40, kLabelTop + 18},
      {kSpeakerCx - 40, kLabelTop, kSpeakerCx + 40, kLabelTop + 18}};
  const wchar_t* label_texts[3] = {L"\u9759\u97F3", L"\u6302\u65AD",
                                   L"\u514D\u63D0"};  // 静音/挂断/免提
  for (int i = 0; i < 3; ++i) {
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
    case WM_COMMAND: {
      int id = LOWORD(wparam);
      if (id == kIdMute) {
        muted_ = !muted_;
        InvalidateRect(hwnd, nullptr, FALSE);
        if (on_mute_toggle_) on_mute_toggle_(muted_);
        return 0;
      }
      if (id == kIdSpeaker) {
        speaker_on_ = !speaker_on_;
        InvalidateRect(hwnd, nullptr, FALSE);
        if (on_speaker_toggle_) on_speaker_toggle_(speaker_on_);
        return 0;
      }
      if (id == kIdHangup) {
        if (on_hangup_) on_hangup_();
        PostMessage(hwnd, kMsgDeferredHide, 0, 0);
        return 0;
      }
      break;
    }
    case WM_DRAWITEM: {
      auto* dis = reinterpret_cast<DRAWITEMSTRUCT*>(lparam);
      if (dis->CtlType == ODT_BUTTON) {
        bool hovered = (dis->itemState & ODS_SELECTED) ||
                       (dis->itemState & ODS_HOTLIGHT);
        if (dis->CtlID == kIdMute) {
          const bool active = muted_;
          DrawRoundActionButton(
              dis->hDC, dis->rcItem, kGlyphMic,
              active ? (hovered ? kWhiteBtnHover : kWhiteBtn)
                     : (hovered ? kDarkBtnHover : kDarkBtn),
              active ? kGlyphOnWhite : RGB(255, 255, 255), false);
          return TRUE;
        }
        if (dis->CtlID == kIdSpeaker) {
          const bool active = speaker_on_;
          DrawRoundActionButton(
              dis->hDC, dis->rcItem, kGlyphVolume,
              active ? (hovered ? kWhiteBtnHover : kWhiteBtn)
                     : (hovered ? kDarkBtnHover : kDarkBtn),
              active ? kGlyphOnWhite : RGB(255, 255, 255), false);
          return TRUE;
        }
        if (dis->CtlID == kIdHangup) {
          DrawRoundActionButton(dis->hDC, dis->rcItem, kGlyphPhone,
                                hovered ? kWhiteBtnHover : kWhiteBtn,
                                kGlyphOnWhite, true);
          return TRUE;
        }
      }
      break;
    }
    case WM_NCHITTEST: {
      POINT pt = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
      ScreenToClient(hwnd, &pt);

      // 按钮区域外整卡可拖动
      const int side_y = kBtnCy - kSideBtn / 2;
      const bool in_mute = pt.x >= kMuteCx - kSideBtn / 2 &&
                           pt.x <= kMuteCx + kSideBtn / 2 &&
                           pt.y >= side_y && pt.y <= side_y + kSideBtn;
      const bool in_speaker = pt.x >= kSpeakerCx - kSideBtn / 2 &&
                              pt.x <= kSpeakerCx + kSideBtn / 2 &&
                              pt.y >= side_y && pt.y <= side_y + kSideBtn;
      const bool in_hangup = pt.x >= kHangupCx - kMainBtn / 2 &&
                             pt.x <= kHangupCx + kMainBtn / 2 &&
                             pt.y >= kBtnCy - kMainBtn / 2 &&
                             pt.y <= kBtnCy + kMainBtn / 2;
      if (in_mute || in_speaker || in_hangup) return HTCLIENT;
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
