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

std::wstring Utf8ToWide(const std::string& s) {
  if (s.empty()) return L"";
  int len = MultiByteToWideChar(CP_UTF8, 0, s.c_str(),
                                static_cast<int>(s.size()), nullptr, 0);
  std::wstring out(len, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()),
                      out.data(), len);
  return out;
}

COLORREF ParseArgb(uint32_t argb) {
  return RGB((argb >> 16) & 0xFF, (argb >> 8) & 0xFF, argb & 0xFF);
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

// 挂断图标：电话字形 + 斜线（phone-off）
void DrawPhoneOffGlyph(HDC hdc, const RECT& rc, COLORREF color, int font_size) {
  DrawGlyph(hdc, rc, L'\uE717', color, font_size, L"Segoe MDL2 Assets");
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
  hangup_brush_ = CreateSolidBrush(RGB(255, 59, 48));
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
  // 挂断圆钮（居中偏下）
  constexpr int kBtnSize = 50;
  const int btn_x = (kWindowWidth - kBtnSize) / 2;
  const int btn_y = kWindowHeight - kBtnSize - 18;
  SetWindowPos(hangup_btn_, nullptr, btn_x, btn_y, kBtnSize, kBtnSize,
               SWP_NOZORDER | SWP_NOACTIVATE);
}

void OutgoingCallWindow::Show(const std::string& caller_name,
                              const std::string& subtitle,
                              const std::string& caller_initial,
                              uint32_t accent_color_hex) {
  caller_name_ = Utf8ToWide(caller_name);
  subtitle_ = Utf8ToWide(subtitle);
  caller_initial_ = Utf8ToWide(caller_initial);
  accent_color_ = accent_color_hex ? accent_color_hex : 0xFF34C759;
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
  if (hangup_brush_) DeleteObject(hangup_brush_);
  hangup_brush_ = nullptr;
  if (window_handle_ && IsWindow(window_handle_)) DestroyWindow(window_handle_);
  window_handle_ = nullptr;
}

void OutgoingCallWindow::Paint(HWND hwnd, HDC hdc) {
  RECT rc;
  GetClientRect(hwnd, &rc);
  HDC mem = CreateCompatibleDC(hdc);
  HBITMAP bmp = CreateCompatibleBitmap(hdc, rc.right, rc.bottom);
  HBITMAP old_bmp = static_cast<HBITMAP>(SelectObject(mem, bmp));

  // 白卡背景（Apple 风格，32px 大圆角，DWM 阴影区分层次）
  constexpr COLORREF kBg = RGB(0xFF, 0xFF, 0xFF);
  HBRUSH bg = CreateSolidBrush(kBg);
  FillRect(mem, &rc, bg);
  DeleteObject(bg);

  constexpr int kRadius = 32;
  HRGN clip_rgn = CreateRoundRectRgn(0, 0, rc.right + 1, rc.bottom + 1,
                                     kRadius, kRadius);
  SelectClipRgn(mem, clip_rgn);

  COLORREF accent = ParseArgb(accent_color_);
  SetBkMode(mem, TRANSPARENT);
  HFONT old_font = nullptr;

  // ── 名称（28px 偏大，空间受限取 24px Semibold） ──
  HFONT name_font = CreateFontW(-24, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
                                DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                                CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                                DEFAULT_PITCH | FF_SWISS,
                                L"Microsoft YaHei UI");
  old_font = static_cast<HFONT>(SelectObject(mem, name_font));
  SetTextColor(mem, RGB(0x1D, 0x1D, 0x1F));
  RECT name_rc = {20, 14, kWindowWidth - 20, 44};
  DrawTextW(mem, caller_name_.c_str(), -1, &name_rc,
            DT_CENTER | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
  SelectObject(mem, old_font);
  DeleteObject(name_font);

  // ── 状态（"正在呼叫…" 14px 中灰） ──
  HFONT sub_font = CreateFontW(-14, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                               DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                               CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                               DEFAULT_PITCH | FF_SWISS,
                               L"Microsoft YaHei UI");
  old_font = static_cast<HFONT>(SelectObject(mem, sub_font));
  SetTextColor(mem, RGB(0x6E, 0x6E, 0x73));
  RECT sub_rc = {20, 44, kWindowWidth - 20, 66};
  DrawTextW(mem, subtitle_.c_str(), -1, &sub_rc,
            DT_CENTER | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
  SelectObject(mem, old_font);
  DeleteObject(sub_font);

  // ── 中央电话圆 + 呼吸光环（scale 1 → 1.55，两层相位错开） ──
  const int cx = kWindowWidth / 2;
  const int cy = 122;
  const int base_r = 38;
  double t = (pulse_phase_ % 60) / 60.0;
  double t2 = fmod(t + 0.5, 1.0);

  // 光环 1
  {
    double scale = 1.0 + 0.55 * t;
    double fade = 0.35 * (1.0 - t);
    int r = static_cast<int>(base_r * scale);
    COLORREF ring = RGB(
        static_cast<int>(GetRValue(accent) * fade + 255 * (1 - fade)),
        static_cast<int>(GetGValue(accent) * fade + 255 * (1 - fade)),
        static_cast<int>(GetBValue(accent) * fade + 255 * (1 - fade)));
    FillCircle(mem, cx, cy, r, ring);
  }
  // 光环 2（错开半周期）
  {
    double scale = 1.0 + 0.55 * t2;
    double fade = 0.35 * (1.0 - t2);
    int r = static_cast<int>(base_r * scale);
    COLORREF ring = RGB(
        static_cast<int>(GetRValue(accent) * fade + 255 * (1 - fade)),
        static_cast<int>(GetGValue(accent) * fade + 255 * (1 - fade)),
        static_cast<int>(GetBValue(accent) * fade + 255 * (1 - fade)));
    FillCircle(mem, cx, cy, r, ring);
  }

  // 实心电话圆（accent 色 + 白色 Phone 图标）
  FillCircle(mem, cx, cy, base_r, accent);
  {
    RECT icon_rc = {cx - base_r, cy - base_r, cx + base_r, cy + base_r};
    DrawGlyph(mem, icon_rc, L'\uE717', RGB(255, 255, 255), 34,
              L"Segoe MDL2 Assets");
  }

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
        // 圆钮底色铺白，避免四角露出系统底色
        HBRUSH bg = CreateSolidBrush(RGB(0xFF, 0xFF, 0xFF));
        FillRect(dis->hDC, &dis->rcItem, bg);
        DeleteObject(bg);
        bool hovered = (dis->itemState & ODS_SELECTED) ||
                       (dis->itemState & ODS_HOTLIGHT);
        COLORREF fill = hovered ? RGB(0xE0, 0x33, 0x2A) : RGB(0xFF, 0x3B, 0x30);
        HRGN rgn = CreateEllipticRgn(dis->rcItem.left, dis->rcItem.top,
                                     dis->rcItem.right, dis->rcItem.bottom);
        HBRUSH brush = CreateSolidBrush(fill);
        FillRgn(dis->hDC, rgn, brush);
        DeleteObject(brush);
        DeleteObject(rgn);
        RECT icon_rc = dis->rcItem;
        DrawPhoneOffGlyph(dis->hDC, icon_rc, RGB(255, 255, 255), 24);
        return TRUE;
      }
      break;
    }
    case WM_NCHITTEST: {
      POINT pt = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
      ScreenToClient(hwnd, &pt);
      if (pt.y < 40) return HTCAPTION;
      return HTCLIENT;
    }
    case WM_DESTROY:
      StopPulse();
      SetWindowLongPtr(hwnd, GWLP_USERDATA, 0);
      window_handle_ = nullptr;
      return 0;
  }
  return DefWindowProc(hwnd, message, wparam, lparam);
}
