#include "agent_profile_overlay_window.h"

#include <algorithm>

#include <windowsx.h>

namespace {

constexpr COLORREF kBgColor = RGB(18, 18, 22);
constexpr COLORREF kTextPrimary = RGB(228, 228, 236);
constexpr COLORREF kTextSecondary = RGB(136, 136, 148);

COLORREF AvatarColor(const std::string& preset) {
  if (preset == "ember") return RGB(0xFF, 0xA2, 0x4B);
  if (preset == "tide") return RGB(0x62, 0xD6, 0xFF);
  if (preset == "eclipse") return RGB(0x8C, 0x7D, 0xFF);
  if (preset == "neon") return RGB(0xB8, 0xFF, 0x52);
  if (preset == "mist") return RGB(0xB0, 0xBE, 0xC5);
  return RGB(0x3D, 0xA4, 0xFF);
}

/// QQ 风格的状态模式
struct StatusMode {
  const wchar_t* label;  // "发呆中" / "emo中" / "在线"
  COLORREF color;        // 状态点颜色
};

StatusMode ResolveStatusMode(const std::string& mood_style,
                             const std::string& status_text) {
  // mood_style -> 默认状态模式
  if (mood_style == "funny") {
    return {L"\u6478\u9c7c\u4e2d", RGB(0xFF, 0xB0, 0x4D)};  // 摸鱼中
  }
  if (mood_style == "sad") {
    return {L"emo\u4e2d", RGB(0x80, 0x91, 0xA7)};
  }
  if (mood_style == "cool") {
    return {L"\u5fd9\u788c\u4e2d", RGB(0x7C, 0x73, 0xFF)};
  }
  if (mood_style == "energetic") {
    return {L"\u5728\u7ebf", RGB(0x3A, 0xE0, 0x6C)};
  }
  if (mood_style == "mysterious") {
    return {L"\u53d1\u5446\u4e2d", RGB(0x3F, 0x8C, 0xFF)};
  }
  // gentle / default
  if (!status_text.empty()) {
    // 让 status_text 后缀 "中" 形成类似 "发呆中" 的效果
    return {L"\u5728\u7ebf", RGB(0x3A, 0xE0, 0x6C)};
  }
  return {L"\u5728\u7ebf", RGB(0x3A, 0xE0, 0x6C)};
}

void DrawStatusDot(HDC hdc, const RECT& rc, COLORREF color) {
  HBRUSH brush = CreateSolidBrush(color);
  HPEN pen = CreatePen(PS_NULL, 0, 0);
  HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, pen));
  HBRUSH old_brush = static_cast<HBRUSH>(SelectObject(hdc, brush));
  Ellipse(hdc, rc.left, rc.top, rc.right, rc.bottom);
  SelectObject(hdc, old_pen);
  SelectObject(hdc, old_brush);
  DeleteObject(brush);
  DeleteObject(pen);
}

}  // namespace

AgentProfileOverlayWindow::AgentProfileOverlayWindow() = default;
AgentProfileOverlayWindow::~AgentProfileOverlayWindow() { Destroy(); }

std::wstring AgentProfileOverlayWindow::Utf8ToWide(const std::string& s) const {
  if (s.empty()) return L"";
  int len = MultiByteToWideChar(CP_UTF8, 0, s.c_str(),
                                static_cast<int>(s.size()), nullptr, 0);
  std::wstring out(len, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()),
                      out.data(), len);
  return out;
}

void AgentProfileOverlayWindow::EnsureClassRegistered() {
  static bool registered = false;
  if (registered) return;
  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(WNDCLASSEXW);
  wc.style = CS_HREDRAW | CS_VREDRAW;
  wc.lpfnWndProc = AgentProfileOverlayWindow::WndProc;
  wc.hInstance = GetModuleHandle(nullptr);
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.hbrBackground = nullptr;
  wc.lpszClassName = kClassName;
  RegisterClassExW(&wc);
  registered = true;
}

void AgentProfileOverlayWindow::EnsureFonts() {
  if (font_name_ != nullptr) return;
  font_name_ = CreateFontW(18, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
                           DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                           CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                           DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  font_handle_ = CreateFontW(14, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
                             DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                             CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                             DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  font_body_ = CreateFontW(14, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                           DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                           CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                           DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
}

void AgentProfileOverlayWindow::EnsureButtons() {
  if (!window_handle_) return;
  if (btn_close_ == nullptr) {
    btn_close_ = CreateWindowExW(
        0, L"BUTTON", L"\u2715", WS_CHILD | BS_PUSHBUTTON | BS_FLAT,
        0, 0, 0, 0, window_handle_,
        reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kButtonCloseId)),
        GetModuleHandle(nullptr), nullptr);
    SendMessage(btn_close_, WM_SETFONT,
                reinterpret_cast<WPARAM>(font_body_), TRUE);
  }
}

void AgentProfileOverlayWindow::ApplyWindowRgn() {
  if (!window_handle_) return;
  RECT rc;
  GetWindowRect(window_handle_, &rc);
  int w = rc.right - rc.left;
  int h = rc.bottom - rc.top;
  HRGN hRgn = CreateRoundRectRgn(0, 0, w + 1, h + 1, kCornerRadius,
                                 kCornerRadius);
  SetWindowRgn(window_handle_, hRgn, TRUE);
}

bool AgentProfileOverlayWindow::Create() {
  if (window_handle_) return true;
  EnsureClassRegistered();

  DWORD ex_style = WS_EX_TOPMOST | WS_EX_TOOLWINDOW;
  DWORD style = WS_POPUP | WS_CLIPCHILDREN;

  HWND hwnd = CreateWindowExW(
      ex_style, kClassName, L"", style,
      CW_USEDEFAULT, CW_USEDEFAULT, kDefaultWidth, kDefaultHeight,
      nullptr, nullptr, GetModuleHandle(nullptr), this);
  if (!hwnd) return false;
  window_handle_ = hwnd;
  on_top_ = true;

  EnsureFonts();
  EnsureButtons();

  SetWindowPos(window_handle_, nullptr, 0, 0, kDefaultWidth, kDefaultHeight,
               SWP_NOZORDER | SWP_NOACTIVATE);
  ApplyWindowRgn();
  return true;
}

void AgentProfileOverlayWindow::Destroy() {
  if (btn_close_ && IsWindow(btn_close_)) {
    DestroyWindow(btn_close_);
    btn_close_ = nullptr;
  }
  if (font_name_) { DeleteObject(font_name_); font_name_ = nullptr; }
  if (font_handle_) { DeleteObject(font_handle_); font_handle_ = nullptr; }
  if (font_body_) { DeleteObject(font_body_); font_body_ = nullptr; }
  if (window_handle_ && IsWindow(window_handle_)) {
    SetWindowLongPtr(window_handle_, GWLP_USERDATA, 0);
    DestroyWindow(window_handle_);
  }
  window_handle_ = nullptr;
}

void AgentProfileOverlayWindow::Show() {
  if (!window_handle_) return;
  ShowWindow(window_handle_, SW_SHOW);
}

void AgentProfileOverlayWindow::Hide() {
  if (!window_handle_) return;
  ShowWindow(window_handle_, SW_HIDE);
}

bool AgentProfileOverlayWindow::IsVisible() const {
  return window_handle_ && IsWindowVisible(window_handle_);
}

void AgentProfileOverlayWindow::SetOnTop(bool on_top) {
  on_top_ = on_top;
  if (!window_handle_) return;
  SetWindowPos(window_handle_,
               on_top ? HWND_TOPMOST : HWND_NOTOPMOST,
               0, 0, 0, 0,
               SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

void AgentProfileOverlayWindow::SetBounds(int x, int y, int width, int height) {
  if (!window_handle_) return;
  width = std::max(kMinWidth, width);
  height = std::max(120, height);
  SetWindowPos(window_handle_, nullptr, x, y, width, height,
               SWP_NOZORDER | SWP_NOACTIVATE);
}

RECT AgentProfileOverlayWindow::GetBounds() const {
  RECT r{};
  if (window_handle_) GetWindowRect(window_handle_, &r);
  return r;
}

void AgentProfileOverlayWindow::SetProfile(ProfileData data) {
  profile_ = std::move(data);
  if (!window_handle_) return;
  InvalidateRect(window_handle_, nullptr, FALSE);
}

void AgentProfileOverlayWindow::LayoutChildren() {
  if (!window_handle_) return;
  RECT rc;
  GetClientRect(window_handle_, &rc);
  const int width = rc.right - rc.left;
  const int btn_y = kPadding - 2;

  if (btn_close_) {
    SetWindowPos(btn_close_, nullptr, width - kCloseBtnSize - kPadding + 2,
                 btn_y, kCloseBtnSize, kCloseBtnSize,
                 SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
  }
}

void AgentProfileOverlayWindow::DrawRoundedRect(HDC hdc, const RECT& rc,
                                                 int radius, COLORREF fill,
                                                 COLORREF border) {
  HBRUSH fill_brush = CreateSolidBrush(fill);
  HPEN border_pen = CreatePen(PS_NULL, 0, 0);
  HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, border_pen));
  HBRUSH old_brush = static_cast<HBRUSH>(SelectObject(hdc, fill_brush));
  RoundRect(hdc, rc.left, rc.top, rc.right, rc.bottom, radius, radius);
  SelectObject(hdc, old_pen);
  SelectObject(hdc, old_brush);
  DeleteObject(fill_brush);
  DeleteObject(border_pen);
  if (border != 0) {
    HPEN pen = CreatePen(PS_SOLID, 1, border);
    HBRUSH null_brush = static_cast<HBRUSH>(GetStockObject(NULL_BRUSH));
    old_pen = static_cast<HPEN>(SelectObject(hdc, pen));
    old_brush = static_cast<HBRUSH>(SelectObject(hdc, null_brush));
    RoundRect(hdc, rc.left, rc.top, rc.right, rc.bottom, radius, radius);
    SelectObject(hdc, old_pen);
    SelectObject(hdc, old_brush);
    DeleteObject(pen);
  }
}

void AgentProfileOverlayWindow::DrawUiText(HDC hdc, const RECT& rc,
                                            const std::wstring& text,
                                            HFONT font, COLORREF color,
                                            UINT flags) {
  SetBkMode(hdc, TRANSPARENT);
  SetTextColor(hdc, color);
  HFONT old_font = static_cast<HFONT>(SelectObject(hdc, font));
  RECT out = rc;
  ::DrawTextW(hdc, text.c_str(), -1, &out, flags);
  SelectObject(hdc, old_font);
}

void AgentProfileOverlayWindow::Paint(HWND hwnd, HDC hdc) {
  RECT rc;
  GetClientRect(hwnd, &rc);
  const int w = rc.right - rc.left;

  HBRUSH bg = CreateSolidBrush(kBgColor);
  FillRect(hdc, &rc, bg);
  DeleteObject(bg);

  EnsureFonts();

  int y = kPadding + 6;

  // Avatar circle
  RECT avatar_rc = {kPadding, y, kPadding + kAvatarSize, y + kAvatarSize};
  COLORREF c1 = AvatarColor(profile_.avatar_preset);
  HBRUSH avatar_brush = CreateSolidBrush(c1);
  HPEN avatar_pen = CreatePen(PS_NULL, 0, 0);
  HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, avatar_pen));
  HBRUSH old_brush = static_cast<HBRUSH>(SelectObject(hdc, avatar_brush));
  Ellipse(hdc, avatar_rc.left, avatar_rc.top, avatar_rc.right, avatar_rc.bottom);
  SelectObject(hdc, old_pen);
  SelectObject(hdc, old_brush);
  DeleteObject(avatar_brush);
  DeleteObject(avatar_pen);

  // Avatar initial letter
  std::wstring initial = L"A";
  if (!profile_.display_name.empty()) {
    std::wstring name = Utf8ToWide(profile_.display_name);
    if (!name.empty()) initial = name.substr(0, 1);
  }
  RECT initial_rc = avatar_rc;
  DrawUiText(hdc, initial_rc, initial, font_name_, RGB(255, 255, 255),
             DT_CENTER | DT_SINGLELINE | DT_VCENTER);

  // Name + @handle next to avatar
  int text_x = kPadding + kAvatarSize + 14;
  int text_w = w - text_x - kPadding - kCloseBtnSize - 8;

  y += 4;
  RECT name_rc = {text_x, y, text_x + text_w, y + 24};
  DrawUiText(hdc, name_rc, Utf8ToWide(profile_.display_name), font_name_,
             kTextPrimary, DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);

  // Signature
  y = kPadding + kAvatarSize + 22;
  std::wstring sig_str = Utf8ToWide(profile_.signature);
  RECT sig_rc = {kPadding, y, w - kPadding, y + 44};
  DrawUiText(hdc, sig_rc, sig_str, font_body_, kTextSecondary,
             DT_LEFT | DT_WORDBREAK);
}

void AgentProfileOverlayWindow::FireEvent(EventType type,
                                           const std::string& payload) {
  if (event_callback_) event_callback_(type, payload);
}

LRESULT AgentProfileOverlayWindow::WndProc(HWND hwnd, UINT message,
                                             WPARAM wparam,
                                             LPARAM lparam) noexcept {
  if (message == WM_NCCREATE) {
    auto* cs = reinterpret_cast<CREATESTRUCT*>(lparam);
    SetWindowLongPtr(hwnd, GWLP_USERDATA,
                     reinterpret_cast<LONG_PTR>(cs->lpCreateParams));
  } else {
    auto* that = reinterpret_cast<AgentProfileOverlayWindow*>(
        GetWindowLongPtr(hwnd, GWLP_USERDATA));
    if (that) return that->HandleMessage(hwnd, message, wparam, lparam);
  }
  return DefWindowProc(hwnd, message, wparam, lparam);
}

LRESULT AgentProfileOverlayWindow::HandleMessage(HWND hwnd, UINT message,
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
    case WM_SIZE:
      LayoutChildren();
      ApplyWindowRgn();
      InvalidateRect(hwnd, nullptr, FALSE);
      return 0;
    case WM_ACTIVATE:
      if (LOWORD(wparam) == WA_INACTIVE) {
        Hide();
        FireEvent(EventType::kCloseClicked);
        return 0;
      }
      break;
    case WM_COMMAND: {
      const int id = LOWORD(wparam);
      if (id == kButtonCloseId) {
        Hide();
        FireEvent(EventType::kCloseClicked);
        return 0;
      }
      break;
    }
    case WM_CTLCOLORBTN: {
      HDC btn_dc = reinterpret_cast<HDC>(wparam);
      SetBkMode(btn_dc, TRANSPARENT);
      SetTextColor(btn_dc, kTextSecondary);
      return reinterpret_cast<INT_PTR>(GetStockObject(NULL_BRUSH));
    }
    case WM_DESTROY:
      SetWindowLongPtr(hwnd, GWLP_USERDATA, 0);
      window_handle_ = nullptr;
      return 0;
  }
  return DefWindowProc(hwnd, message, wparam, lparam);
}
