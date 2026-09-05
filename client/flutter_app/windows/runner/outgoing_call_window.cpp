#include "outgoing_call_window.h"

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
constexpr COLORREF kBgColor       = RGB(0x1A, 0x1A, 0x1C);  // 卡片底
constexpr COLORREF kCircleColor   = RGB(0x2C, 0x2C, 0x2E);  // 波形圆底
constexpr COLORREF kNameColor     = RGB(0xFF, 0xFF, 0xFF);  // 名称白
constexpr COLORREF kMutedColor    = RGB(0x8E, 0x8E, 0x93);  // 副标题/标签灰
constexpr COLORREF kWhiteBtn      = RGB(0xFF, 0xFF, 0xFF);  // 取消白钮
constexpr COLORREF kWhiteBtnHover = RGB(0xE5, 0xE5, 0xEA);  // 取消悬停
constexpr COLORREF kGlyphOnWhite  = RGB(0x1A, 0x1A, 0x1C);  // 白钮上深图标

// ── 内部布局 ──
constexpr int kAvatarCx = 150;  // 波形圆心 x
constexpr int kAvatarCy = 84;   // 波形圆心 y
constexpr int kAvatarR = 32;    // 波形圆半径
constexpr int kNameTop = 126;   // 名称 top
constexpr int kSubTop = 154;    // 副标题 top
constexpr int kBtnSize = 56;    // 取消按钮直径
constexpr int kBtnCy = 212;     // 取消按钮圆心 y
constexpr int kLabelTop = 246;  // 标签 top

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

// 用指定字体画一个居中字形
void DrawGlyph(HDC hdc, const RECT& rc, wchar_t glyph, COLORREF color,
               int font_size, const wchar_t* font_family) {
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

// 在 hdc 上画一个实心圆
void FillCircle(HDC hdc, int cx, int cy, int r, COLORREF fill) {
  HRGN rgn = CreateEllipticRgn(cx - r, cy - r, cx + r, cy + r);
  HBRUSH brush = CreateSolidBrush(fill);
  FillRgn(hdc, rgn, brush);
  DeleteObject(brush);
  DeleteObject(rgn);
}

}  // namespace

OutgoingCallWindow::OutgoingCallWindow() = default;

OutgoingCallWindow::~OutgoingCallWindow() { DestroyNativeWindow(); }

void OutgoingCallWindow::SetCallbacks(HangUpCallback on_hangup) {
  on_hangup_ = std::move(on_hangup);
}

void OutgoingCallWindow::EnsureClassRegistered() {
  static bool registered = false;
  if (registered) return;
  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(WNDCLASSEXW);
  wc.lpfnWndProc = OutgoingCallWindow::WndProc;
  wc.hInstance = GetModuleHandle(nullptr);
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.hbrBackground = nullptr;
  wc.lpszClassName = kClassName;
  RegisterClassExW(&wc);
  registered = true;
}

bool OutgoingCallWindow::CreateWindowIfNeeded() {
  if (window_handle_) return true;
  EnsureClassRegistered();
  HWND hwnd = CreateWindowExW(
      WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, kClassName, L"",
      WS_POPUP | WS_CLIPCHILDREN, 0, 0, kWindowWidth, kWindowHeight, nullptr,
      nullptr, GetModuleHandle(nullptr), this);
  if (!hwnd) return false;
  window_handle_ = hwnd;

  // 自绘圆形图标按钮
  hangup_btn_ = CreateWindowExW(
      0, L"BUTTON", L"",
      WS_CHILD | WS_VISIBLE | BS_OWNERDRAW, 0, 0, 0, 0, hwnd,
      reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdHangup)),
      GetModuleHandle(nullptr), nullptr);
  HFONT font = reinterpret_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT));
  SendMessage(hangup_btn_, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
  EnableDwmShadow(hwnd);
  return true;
}

void OutgoingCallWindow::PositionAtBottomRight() {
  if (!window_handle_) return;
  MONITORINFO mi = {sizeof(mi)};
  GetMonitorInfoW(MonitorFromWindow(window_handle_, MONITOR_DEFAULTTONEAREST),
                  &mi);
  const int x = mi.rcWork.right - kWindowWidth - kMargin;
  const int y = mi.rcWork.bottom - kWindowHeight - kMargin;
  SetWindowPos(window_handle_, HWND_TOPMOST, x, y, kWindowWidth, kWindowHeight,
               SWP_NOACTIVATE | SWP_SHOWWINDOW);
  // 取消白钮（卡片底部居中）
  SetWindowPos(hangup_btn_, nullptr, (kWindowWidth - kBtnSize) / 2,
               kBtnCy - kBtnSize / 2, kBtnSize, kBtnSize,
               SWP_NOZORDER | SWP_NOACTIVATE);
}

void OutgoingCallWindow::Show(const std::string& caller_name,
                              const std::string& subtitle,
                              const std::string& /*caller_initial*/,
                              uint32_t /*accent_color_hex*/) {
  caller_name_ = Utf8ToWide(caller_name);
  subtitle_ = Utf8ToWide(subtitle);
  if (!CreateWindowIfNeeded()) return;
  PositionAtBottomRight();
  StartPulse();
  InvalidateRect(window_handle_, nullptr, TRUE);
}

void OutgoingCallWindow::Hide() {
  StopPulse();
  if (window_handle_) ShowWindow(window_handle_, SW_HIDE);
}

bool OutgoingCallWindow::IsVisible() const {
  return window_handle_ && IsWindowVisible(window_handle_);
}

void OutgoingCallWindow::StartPulse() {
  if (window_handle_) SetTimer(window_handle_, kPulseTimerId, 60, nullptr);
}

void OutgoingCallWindow::StopPulse() {
  if (window_handle_) KillTimer(window_handle_, kPulseTimerId);
}

void OutgoingCallWindow::DestroyNativeWindow() {
  StopPulse();
  if (hangup_btn_ && IsWindow(hangup_btn_)) DestroyWindow(hangup_btn_);
  hangup_btn_ = nullptr;
  if (window_handle_ && IsWindow(window_handle_)) DestroyWindow(window_handle_);
  window_handle_ = nullptr;
}

void OutgoingCallWindow::Paint(HWND hwnd, HDC hdc) {
  RECT rc;
  GetClientRect(hwnd, &rc);
  HDC mem = CreateCompatibleDC(hdc);
  HBITMAP bmp = CreateCompatibleBitmap(hdc, rc.right, rc.bottom);
  HBITMAP old_bmp = static_cast<HBITMAP>(SelectObject(mem, bmp));

  // 深色卡片背景（豆包风，28px 圆角，DWM 阴影区分层次）
  HBRUSH bg = CreateSolidBrush(kBgColor);
  FillRect(mem, &rc, bg);
  DeleteObject(bg);

  constexpr int kRadius = 28;
  HRGN clip_rgn = CreateRoundRectRgn(0, 0, rc.right + 1, rc.bottom + 1,
                                     kRadius, kRadius);
  SelectClipRgn(mem, clip_rgn);

  // ── 中央波形圆（静态） ──
  FillCircle(mem, kAvatarCx, kAvatarCy, kAvatarR, kCircleColor);
  DrawWaveform(mem, kAvatarCx, kAvatarCy, 18, RGB(0xFF, 0xFF, 0xFF), -1);

  // ── 名称（17px 白色 Semibold） ──
  SetBkMode(mem, TRANSPARENT);
  HFONT name_font = CreateFontW(-17, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
                                DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                                CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                                DEFAULT_PITCH | FF_SWISS,
                                L"Microsoft YaHei UI");
  HFONT old_font = static_cast<HFONT>(SelectObject(mem, name_font));
  SetTextColor(mem, kNameColor);
  RECT name_rc = {20, kNameTop, kWindowWidth - 20, kNameTop + 26};
  DrawTextW(mem, caller_name_.c_str(), -1, &name_rc,
            DT_CENTER | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
  SelectObject(mem, old_font);
  DeleteObject(name_font);

  // ── 副标题（13px 中灰；"正在接通"后追加动画点） ──
  std::wstring sub = subtitle_;
  if (sub == L"\u6B63\u5728\u63A5\u901A") {  // 正在接通
    const int dots = 1 + (pulse_phase_ / 15) % 3;
    sub += L" ";
    sub.append(dots, L'\u00B7');
  }
  HFONT sub_font = CreateFontW(-13, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                               DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                               CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                               DEFAULT_PITCH | FF_SWISS,
                               L"Microsoft YaHei UI");
  old_font = static_cast<HFONT>(SelectObject(mem, sub_font));
  SetTextColor(mem, kMutedColor);
  RECT sub_rc = {20, kSubTop, kWindowWidth - 20, kSubTop + 22};
  DrawTextW(mem, sub.c_str(), -1, &sub_rc,
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
  RECT label_rc = {kWindowWidth / 2 - 40, kLabelTop, kWindowWidth / 2 + 40,
                   kLabelTop + 18};
  DrawTextW(mem, L"\u53D6\u6D88", -1, &label_rc,  // 取消
            DT_CENTER | DT_SINGLELINE | DT_NOPREFIX);
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

LRESULT CALLBACK OutgoingCallWindow::WndProc(HWND hwnd, UINT message,
                                             WPARAM wparam,
                                             LPARAM lparam) noexcept {
  if (message == WM_NCCREATE) {
    auto* cs = reinterpret_cast<CREATESTRUCT*>(lparam);
    SetWindowLongPtr(hwnd, GWLP_USERDATA,
                     reinterpret_cast<LONG_PTR>(cs->lpCreateParams));
  } else {
    auto* that = reinterpret_cast<OutgoingCallWindow*>(
        GetWindowLongPtr(hwnd, GWLP_USERDATA));
    if (that) return that->HandleMessage(hwnd, message, wparam, lparam);
  }
  return DefWindowProc(hwnd, message, wparam, lparam);
}

LRESULT OutgoingCallWindow::HandleMessage(HWND hwnd, UINT message,
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
        pulse_phase_ = (pulse_phase_ + 1) % 60;
        InvalidateRect(hwnd, nullptr, FALSE);
        return 0;
      }
      break;
    case WM_COMMAND:
      if (LOWORD(wparam) == kIdHangup) {
        if (on_hangup_) on_hangup_();
        Hide();
        return 0;
      }
      break;
    case WM_DRAWITEM: {
      auto* dis = reinterpret_cast<DRAWITEMSTRUCT*>(lparam);
      if (dis->CtlType == ODT_BUTTON && dis->CtlID == kIdHangup) {
        // 取消白钮：圆钮底铺卡片底色，避免四角露出系统底色
        HBRUSH bg = CreateSolidBrush(kBgColor);
        FillRect(dis->hDC, &dis->rcItem, bg);
        DeleteObject(bg);
        bool hovered = (dis->itemState & ODS_SELECTED) ||
                       (dis->itemState & ODS_HOTLIGHT);
        COLORREF fill = hovered ? kWhiteBtnHover : kWhiteBtn;
        HRGN rgn = CreateEllipticRgn(dis->rcItem.left, dis->rcItem.top,
                                     dis->rcItem.right, dis->rcItem.bottom);
        HBRUSH brush = CreateSolidBrush(fill);
        FillRgn(dis->hDC, rgn, brush);
        DeleteObject(brush);
        DeleteObject(rgn);
        DrawGlyph(dis->hDC, dis->rcItem, kGlyphPhone, kGlyphOnWhite,
                  kBtnSize / 2 - 4, L"Segoe MDL2 Assets");
        return TRUE;
      }
      break;
    }
    case WM_NCHITTEST: {
      POINT pt = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
      ScreenToClient(hwnd, &pt);
      // 取消按钮区域外整卡可拖动
      const bool in_btn =
          pt.x >= (kWindowWidth - kBtnSize) / 2 &&
          pt.x <= (kWindowWidth + kBtnSize) / 2 &&
          pt.y >= kBtnCy - kBtnSize / 2 && pt.y <= kBtnCy + kBtnSize / 2;
      if (in_btn) return HTCLIENT;
      return HTCAPTION;
    }
    case WM_DESTROY:
      StopPulse();
      SetWindowLongPtr(hwnd, GWLP_USERDATA, 0);
      window_handle_ = nullptr;
      return 0;
  }
  return DefWindowProc(hwnd, message, wparam, lparam);
}
