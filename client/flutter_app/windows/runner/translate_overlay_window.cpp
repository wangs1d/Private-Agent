#include "translate_overlay_window.h"

#include <algorithm>

#include <windowsx.h>

#include "window_position_store.h"

namespace {

constexpr COLORREF kBgBlack = RGB(0, 0, 0);
constexpr COLORREF kSurfaceBg = RGB(10, 10, 12);
constexpr COLORREF kCardBg = RGB(18, 18, 22);
constexpr COLORREF kBorderColor = RGB(32, 32, 38);
constexpr COLORREF kTextPrimary = RGB(228, 228, 236);
constexpr COLORREF kTextSecondary = RGB(136, 136, 148);
constexpr COLORREF kAccentBlue = RGB(74, 164, 255);
constexpr COLORREF kDangerRed = RGB(255, 72, 72);

constexpr UINT_PTR kButtonCloseId = 1001;
constexpr UINT_PTR kButtonClearId = 1002;
constexpr UINT_PTR kButtonLangId = 1003;
constexpr UINT_PTR kButtonSubtitleId = 1005;

struct LangOption {
  const wchar_t* code;
  const wchar_t* label;
};
constexpr LangOption kLangOptions[] = {
    {L"zh", L"中文"},
    {L"en", L"English"},
    {L"ja", L"日本語"},
    {L"ko", L"한국어"},
    {L"fr", L"Français"},
    {L"de", L"Deutsch"},
    {L"es", L"Español"},
    {L"ru", L"Русский"},
    {L"zh-Hant", L"繁體"},
    {L"auto", L"自动检测"},
};
constexpr int kLangOptionCount = sizeof(kLangOptions) / sizeof(kLangOptions[0]);

constexpr int kCardPadding = 8;
constexpr int kCardSpacing = 6;
constexpr int kCardRadius = 8;
constexpr int kCardHeaderHeight = 18;
constexpr int kCardMinBodyHeight = 32;
constexpr int kCardMaxBodyHeight = 100;
constexpr int kScrollMarginBottom = 10;

}  // namespace

TranslateOverlayWindow::TranslateOverlayWindow() = default;
TranslateOverlayWindow::~TranslateOverlayWindow() { Destroy(); }

std::wstring TranslateOverlayWindow::Utf8ToWide(const std::string& s) const {
  if (s.empty()) return L"";
  int len = MultiByteToWideChar(CP_UTF8, 0, s.c_str(),
                                static_cast<int>(s.size()), nullptr, 0);
  std::wstring out(len, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()),
                      out.data(), len);
  return out;
}

std::string TranslateOverlayWindow::WideToUtf8(const std::wstring& w) const {
  if (w.empty()) return "";
  int len = WideCharToMultiByte(CP_UTF8, 0, w.c_str(),
                                static_cast<int>(w.size()), nullptr, 0,
                                nullptr, nullptr);
  std::string out(len, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()),
                      out.data(), len, nullptr, nullptr);
  return out;
}

void TranslateOverlayWindow::EnsureClassRegistered() {
  static bool registered = false;
  if (registered) return;
  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(WNDCLASSEXW);
  wc.style = CS_HREDRAW | CS_VREDRAW;
  wc.lpfnWndProc = TranslateOverlayWindow::WndProc;
  wc.hInstance = GetModuleHandle(nullptr);
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.hbrBackground = nullptr;
  wc.lpszClassName = kClassName;
  RegisterClassExW(&wc);
  registered = true;
}

void TranslateOverlayWindow::EnsureButtons() {
  if (!window_handle_) return;
  if (font_ui_ == nullptr) {
    font_ui_ = CreateFontW(14, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                           DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                           CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                           DEFAULT_PITCH | FF_SWISS, L"Microsoft YaHei UI");
    font_title_ = CreateFontW(15, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
                              DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                              CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                              DEFAULT_PITCH | FF_SWISS, L"Microsoft YaHei UI");
  }

  if (btn_subtitle_ == nullptr) {
    btn_subtitle_ = CreateWindowExW(
        0, L"BUTTON", L"", WS_CHILD | BS_PUSHBUTTON | BS_FLAT, 0, 0, 0, 0,
        window_handle_,
        reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kButtonSubtitleId)),
        GetModuleHandle(nullptr), nullptr);
    SendMessage(btn_subtitle_, WM_SETFONT,
                reinterpret_cast<WPARAM>(font_ui_), TRUE);
    SetWindowTextW(btn_subtitle_, subtitle_on_ ? L"\U0001F3AC 字幕开" : L"\U0001F3AC 字幕关");
  }
  if (btn_lang_ == nullptr) {
    btn_lang_ = CreateWindowExW(
        0, L"BUTTON", L"", WS_CHILD | BS_PUSHBUTTON | BS_FLAT, 0, 0, 0, 0,
        window_handle_,
        reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kButtonLangId)),
        GetModuleHandle(nullptr), nullptr);
    SendMessage(btn_lang_, WM_SETFONT, reinterpret_cast<WPARAM>(font_ui_), TRUE);
    std::wstring lang_text = L"\U0001F310 " + Utf8ToWide(target_lang_label_) + L" \u25BE";
    SetWindowTextW(btn_lang_, lang_text.c_str());
  }
  if (btn_clear_ == nullptr) {
    btn_clear_ = CreateWindowExW(
        0, L"BUTTON", L"清空", WS_CHILD | BS_PUSHBUTTON | BS_FLAT, 0, 0, 0, 0,
        window_handle_,
        reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kButtonClearId)),
        GetModuleHandle(nullptr), nullptr);
    SendMessage(btn_clear_, WM_SETFONT, reinterpret_cast<WPARAM>(font_ui_), TRUE);
  }
  if (btn_close_ == nullptr) {
    btn_close_ = CreateWindowExW(
        0, L"BUTTON", L"\u2715", WS_CHILD | BS_PUSHBUTTON | BS_FLAT,
        0, 0, 0, 0, window_handle_,
        reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kButtonCloseId)),
        GetModuleHandle(nullptr), nullptr);
    SendMessage(btn_close_, WM_SETFONT,
                reinterpret_cast<WPARAM>(font_title_), TRUE);
  }
}

void TranslateOverlayWindow::ApplyWindowRgn() {
  if (!window_handle_) return;
  RECT rc;
  GetWindowRect(window_handle_, &rc);
  int w = rc.right - rc.left;
  int h = rc.bottom - rc.top;
  HRGN hRgn = CreateRoundRectRgn(0, 0, w + 1, h + 1, kCornerRadius,
                                 kCornerRadius);
  SetWindowRgn(window_handle_, hRgn, TRUE);
}

bool TranslateOverlayWindow::Create() {
  if (window_handle_) return true;
  EnsureClassRegistered();

  DWORD ex_style = WS_EX_TOPMOST | WS_EX_TOOLWINDOW;
  DWORD style = WS_POPUP | WS_THICKFRAME | WS_CLIPCHILDREN;

  HWND hwnd = CreateWindowExW(
      ex_style, kClassName, L"", style, CW_USEDEFAULT, CW_USEDEFAULT,
      kDefaultWidth, kDefaultHeight, nullptr, nullptr,
      GetModuleHandle(nullptr), this);
  if (!hwnd) return false;
  window_handle_ = hwnd;
  on_top_ = true;

  EnsureButtons();

  int w = kDefaultWidth;
  int h = kDefaultHeight;
  int x, y;
  RECT saved;
  if (window_position_store::LoadRect(L"translate_overlay", saved)) {
    x = saved.left;
    y = saved.top;
    w = std::max(kMinWidth, static_cast<int>(saved.right - saved.left));
    h = std::max(kMinHeight, static_cast<int>(saved.bottom - saved.top));
  } else {
    RECT work = window_position_store::GetPrimaryWorkArea();
    x = (work.left + work.right - w) / 2;
    y = work.bottom - h - 10;
  }
  SetWindowPos(window_handle_, nullptr, x, y, w, h,
               SWP_NOZORDER | SWP_NOACTIVATE);
  ApplyWindowRgn();
  LayoutChildren();
  return true;
}

void TranslateOverlayWindow::Destroy() {
  if (window_handle_ && IsWindow(window_handle_)) {
    RECT rc;
    if (GetWindowRect(window_handle_, &rc)) {
      window_position_store::SaveRect(L"translate_overlay", rc);
    }
  }
  if (font_ui_) { DeleteObject(font_ui_); font_ui_ = nullptr; }
  if (font_title_) { DeleteObject(font_title_); font_title_ = nullptr; }
  if (btn_close_ && IsWindow(btn_close_)) {
    DestroyWindow(btn_close_); btn_close_ = nullptr;
  }
  if (btn_clear_ && IsWindow(btn_clear_)) {
    DestroyWindow(btn_clear_); btn_clear_ = nullptr;
  }
  if (btn_lang_ && IsWindow(btn_lang_)) {
    DestroyWindow(btn_lang_); btn_lang_ = nullptr;
  }
  if (btn_subtitle_ && IsWindow(btn_subtitle_)) {
    DestroyWindow(btn_subtitle_); btn_subtitle_ = nullptr;
  }
  if (window_handle_ && IsWindow(window_handle_)) {
    DestroyWindow(window_handle_);
  }
  window_handle_ = nullptr;
}

void TranslateOverlayWindow::Show() {
  if (!window_handle_) return;
  ShowWindow(window_handle_, SW_SHOW);
  SetForegroundWindow(window_handle_);
}

void TranslateOverlayWindow::Hide() {
  if (!window_handle_) return;
  RECT rc;
  if (GetWindowRect(window_handle_, &rc)) {
    window_position_store::SaveRect(L"translate_overlay", rc);
  }
  ShowWindow(window_handle_, SW_HIDE);
}

bool TranslateOverlayWindow::IsVisible() const {
  return window_handle_ && IsWindowVisible(window_handle_);
}

void TranslateOverlayWindow::SetOnTop(bool on_top) {
  on_top_ = on_top;
  if (!window_handle_) return;
  SetWindowPos(window_handle_,
               on_top ? HWND_TOPMOST : HWND_NOTOPMOST,
               0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

void TranslateOverlayWindow::SetBounds(int x, int y, int width, int height) {
  if (!window_handle_) return;
  width = std::max(kMinWidth, width);
  height = std::max(kMinHeight, height);
  SetWindowPos(window_handle_, nullptr, x, y, width, height,
               SWP_NOZORDER | SWP_NOACTIVATE);
  LayoutChildren();
}

RECT TranslateOverlayWindow::GetBounds() const {
  RECT r{};
  if (window_handle_) GetWindowRect(window_handle_, &r);
  return r;
}

void TranslateOverlayWindow::SetTargetLanguage(const std::string& lang_code,
                                               const std::string& lang_label) {
  target_lang_code_ = lang_code;
  target_lang_label_ = lang_label;
  if (btn_lang_) {
    std::wstring text = L"\U0001F310 " + Utf8ToWide(target_lang_label_) +
                        L" \u25BE";
    SetWindowTextW(btn_lang_, text.c_str());
  }
  if (window_handle_) InvalidateRect(window_handle_, nullptr, FALSE);
}

void TranslateOverlayWindow::SetDisplayFont(const std::string& font_name) {
  font_name_ = font_name;
}

void TranslateOverlayWindow::SetSubtitleMode(bool on) {
  subtitle_on_ = on;
  if (btn_subtitle_) {
    SetWindowTextW(btn_subtitle_,
                   subtitle_on_ ? L"\U0001F3AC 字幕开"
                                : L"\U0001F3AC 字幕关");
  }
}

void TranslateOverlayWindow::SetCards(std::vector<Card> cards) {
  cards_ = std::move(cards);
  if (window_handle_) InvalidateRect(window_handle_, nullptr, FALSE);
}

void TranslateOverlayWindow::AppendCard(const Card& card) {
  cards_.insert(cards_.begin(), card);
  if (window_handle_) InvalidateRect(window_handle_, nullptr, FALSE);
}

void TranslateOverlayWindow::UpdateCard(const Card& card) {
  for (auto& c : cards_) {
    if (c.card_id == card.card_id) {
      c = card;
      if (window_handle_) InvalidateRect(window_handle_, nullptr, FALSE);
      return;
    }
  }
  AppendCard(card);
}

void TranslateOverlayWindow::ClearCards() {
  cards_.clear();
  if (window_handle_) InvalidateRect(window_handle_, nullptr, FALSE);
}

void TranslateOverlayWindow::SetLoading(const std::string& card_id,
                                        const std::string& message) {
  for (auto& kv : loading_) {
    if (kv.first == card_id) {
      kv.second = message;
      if (window_handle_) InvalidateRect(window_handle_, nullptr, FALSE);
      return;
    }
  }
  loading_.emplace_back(card_id, message);
  if (window_handle_) InvalidateRect(window_handle_, nullptr, FALSE);
}

void TranslateOverlayWindow::ClearLoading(const std::string& card_id) {
  auto before = loading_.size();
  loading_.erase(
      std::remove_if(loading_.begin(), loading_.end(),
                     [&](const auto& kv) { return kv.first == card_id; }),
      loading_.end());
  if (loading_.size() != before && window_handle_) {
    InvalidateRect(window_handle_, nullptr, FALSE);
  }
}

void TranslateOverlayWindow::LayoutChildren() {
  if (!window_handle_) return;
  RECT rc;
  GetClientRect(window_handle_, &rc);
  const int width = rc.right - rc.left;
  const int btn_h = 26;

  int right_x = width - 30;
  if (btn_close_) {
    SetWindowPos(btn_close_, nullptr, right_x,
                 (kTitleBarHeight - btn_h) / 2, btn_h, btn_h,
                 SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
  }
  right_x -= 52;
  if (btn_clear_) {
    SetWindowPos(btn_clear_, nullptr, right_x,
                 (kTitleBarHeight - btn_h) / 2, 46, btn_h,
                 SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
  }
  right_x -= 130;
  if (btn_lang_) {
    SetWindowPos(btn_lang_, nullptr, right_x,
                 (kTitleBarHeight - btn_h) / 2, 124, btn_h,
                 SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
  }

  int left_x = 10;
  if (btn_subtitle_) {
    SetWindowPos(btn_subtitle_, nullptr, left_x,
                 (kTitleBarHeight - btn_h) / 2, 80, btn_h,
                 SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
  }
}

void TranslateOverlayWindow::DrawRoundedRect(HDC hdc, const RECT& rc,
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

void TranslateOverlayWindow::DrawUiText(HDC hdc, const RECT& rc,
                                        const std::wstring& text, HFONT font,
                                        COLORREF color, UINT flags) {
  SetBkMode(hdc, TRANSPARENT);
  SetTextColor(hdc, color);
  HFONT old_font = static_cast<HFONT>(SelectObject(hdc, font));
  RECT out = rc;
  ::DrawTextW(hdc, text.c_str(), -1, &out, flags);
  SelectObject(hdc, old_font);
}

void TranslateOverlayWindow::Paint(HWND hwnd, HDC hdc) {
  RECT rc;
  GetClientRect(hwnd, &rc);

  HBRUSH bg = CreateSolidBrush(kBgBlack);
  FillRect(hdc, &rc, bg);
  DeleteObject(bg);

  RECT title_rc = {0, 0, rc.right, kTitleBarHeight};
  HBRUSH tb = CreateSolidBrush(kSurfaceBg);
  FillRect(hdc, &title_rc, tb);
  DeleteObject(tb);

  HPEN pen = CreatePen(PS_SOLID, 1, kBorderColor);
  HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, pen));
  MoveToEx(hdc, 0, kTitleBarHeight, nullptr);
  LineTo(hdc, rc.right, kTitleBarHeight);
  SelectObject(hdc, old_pen);
  DeleteObject(pen);

  int y = kTitleBarHeight + 8;

  for (const auto& card : cards_) {
    int body_h = kCardMinBodyHeight;
    body_h +=
        std::min<int>(kCardMaxBodyHeight - kCardMinBodyHeight,
                      static_cast<int>(card.target_text.size()) * 2);
    int card_h =
        kCardHeaderHeight + body_h + kCardPadding * 2 + kCardMinBodyHeight / 2;
    if (card.show_source && !card.source_text.empty()) {
      card_h += kCardMinBodyHeight;
    }
    if (y + card_h + kCardSpacing > rc.bottom - kScrollMarginBottom) {
      break;
    }

    RECT card_rc = {kCardPadding, y, rc.right - kCardPadding, y + card_h};
    DrawRoundedRect(hdc, card_rc, kCardRadius, kCardBg, kBorderColor);

    RECT head_rc = {card_rc.left + 10, card_rc.top + 4, card_rc.right - 10,
                    card_rc.top + kCardHeaderHeight + 4};
    std::wstring head =
        Utf8ToWide(card.mode) + L" \u00B7 " + Utf8ToWide(card.lang_label);
    DrawUiText(hdc, head_rc, head, font_ui_, kTextSecondary,
               DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS);

    RECT tgt_rc = {card_rc.left + 10, card_rc.top + kCardHeaderHeight + 6,
                   card_rc.right - 10,
                   card_rc.top + kCardHeaderHeight + 6 + body_h};
    DrawUiText(hdc, tgt_rc, Utf8ToWide(card.target_text), font_title_,
               kTextPrimary, DT_LEFT | DT_TOP | DT_WORDBREAK | DT_END_ELLIPSIS);

    int after_body = card_rc.top + kCardHeaderHeight + 6 + body_h;
    if (card.show_source && !card.source_text.empty()) {
      RECT src_rc = {card_rc.left + 10, after_body + 2, card_rc.right - 10,
                     after_body + 2 + kCardMinBodyHeight};
      DrawUiText(hdc, src_rc, Utf8ToWide(card.source_text), font_ui_,
                 kTextSecondary,
                 DT_LEFT | DT_TOP | DT_WORDBREAK | DT_END_ELLIPSIS);
    }
    y += card_h + kCardSpacing;
  }

  for (const auto& kv : loading_) {
    RECT card_rc = {kCardPadding, y, rc.right - kCardPadding, y + 56};
    DrawRoundedRect(hdc, card_rc, kCardRadius, kCardBg, kBorderColor);
    RECT msg_rc = {card_rc.left + 10, card_rc.top + 8, card_rc.right - 10,
                   card_rc.bottom - 8};
    DrawUiText(hdc, msg_rc, Utf8ToWide(kv.second), font_ui_, kTextSecondary,
               DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS);
    y += 56 + kCardSpacing;
    if (y > rc.bottom - kScrollMarginBottom) break;
  }

  if (cards_.empty() && loading_.empty()) {
    RECT empty_rc = {0, kTitleBarHeight + 60, rc.right, rc.bottom};
    DrawUiText(
        hdc, empty_rc,
        L"\u9f20\u6807\u60ac\u505c\u5728\u6587\u5b57\u4e0a\n\u81ea\u52a8\u7ffb\u8bd1\u5230\u6b64\u5904",
        font_title_, kTextSecondary, DT_CENTER | DT_WORDBREAK);
  }
}

void TranslateOverlayWindow::FireEvent(EventType type,
                                       const std::string& payload) {
  if (event_callback_) event_callback_(type, payload);
}

LRESULT TranslateOverlayWindow::WndProc(HWND hwnd, UINT message, WPARAM wparam,
                                        LPARAM lparam) noexcept {
  if (message == WM_NCCREATE) {
    auto* cs = reinterpret_cast<CREATESTRUCT*>(lparam);
    SetWindowLongPtr(hwnd, GWLP_USERDATA,
                     reinterpret_cast<LONG_PTR>(cs->lpCreateParams));
  } else {
    auto* that = reinterpret_cast<TranslateOverlayWindow*>(
        GetWindowLongPtr(hwnd, GWLP_USERDATA));
    if (that) return that->HandleMessage(hwnd, message, wparam, lparam);
  }
  return DefWindowProc(hwnd, message, wparam, lparam);
}

LRESULT TranslateOverlayWindow::HandleMessage(HWND hwnd, UINT message,
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
    case WM_SIZE: {
      LayoutChildren();
      ApplyWindowRgn();
      InvalidateRect(hwnd, nullptr, FALSE);
      return 0;
    }
    case WM_EXITSIZEMOVE: {
      RECT rc;
      if (GetWindowRect(hwnd, &rc)) {
        window_position_store::SaveRect(L"translate_overlay", rc);
      }
      return 0;
    }
    case WM_NCHITTEST: {
      POINT pt = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};

      RECT wr;
      GetWindowRect(hwnd, &wr);
      const int border = 6;

      if (pt.x < wr.left + border && pt.y < wr.top + border) return HTTOPLEFT;
      if (pt.x > wr.right - border && pt.y < wr.top + border) return HTTOPRIGHT;
      if (pt.x < wr.left + border && pt.y > wr.bottom - border) return HTBOTTOMLEFT;
      if (pt.x > wr.right - border && pt.y > wr.bottom - border) return HTBOTTOMRIGHT;
      if (pt.x < wr.left + border) return HTLEFT;
      if (pt.x > wr.right - border) return HTRIGHT;
      if (pt.y < wr.top + border) return HTTOP;
      if (pt.y > wr.bottom - border) return HTBOTTOM;

      ScreenToClient(hwnd, &pt);
      if (pt.y < kTitleBarHeight) {
        RECT cr;
        GetClientRect(hwnd, &cr);
        if (pt.x > 90 && pt.x < cr.right - 210) {
          return HTCAPTION;
        }
      }
      return HTCLIENT;
    }
    case WM_COMMAND: {
      const int id = LOWORD(wparam);
      if (id == kButtonCloseId) {
        Hide();
        FireEvent(EventType::kCloseClicked);
        return 0;
      }
      if (id == kButtonClearId) {
        ClearCards();
        FireEvent(EventType::kClearClicked);
        return 0;
      }
      if (id == kButtonLangId) {
        HMENU menu = CreatePopupMenu();
        std::wstring current_code = Utf8ToWide(target_lang_code_);
        for (int i = 0; i < kLangOptionCount; ++i) {
          std::wstring item = std::wstring(kLangOptions[i].label);
          if (kLangOptions[i].code == current_code) {
            item = L"\u2713 " + item;
          }
          AppendMenuW(menu, MF_STRING, i + 1, item.c_str());
        }
        RECT lb_rc;
        GetWindowRect(btn_lang_, &lb_rc);
        POINT pt = {lb_rc.left, lb_rc.bottom};
        int cmd = TrackPopupMenu(
            menu, TPM_RETURNCMD | TPM_NONOTIFY | TPM_LEFTALIGN | TPM_TOPALIGN,
            pt.x, pt.y, 0, window_handle_, nullptr);
        DestroyMenu(menu);
        if (cmd >= 1 && cmd <= kLangOptionCount) {
          const LangOption& picked = kLangOptions[cmd - 1];
          std::string new_code = WideToUtf8(picked.code);
          std::string new_label = WideToUtf8(picked.label);
          if (new_code != target_lang_code_) {
            SetTargetLanguage(new_code, new_label);
            FireEvent(EventType::kLangChanged, new_code);
          }
        }
        return 0;
      }
      if (id == kButtonSubtitleId) {
        SetSubtitleMode(!subtitle_on_);
        FireEvent(EventType::kSubtitleChanged, subtitle_on_ ? "true" : "false");
        return 0;
      }
      break;
    }
    case WM_CTLCOLORBTN: {
      HDC btn_dc = reinterpret_cast<HDC>(wparam);
      HWND btn = reinterpret_cast<HWND>(lparam);
      SetBkMode(btn_dc, TRANSPARENT);
      if (btn == btn_lang_) {
        SetTextColor(btn_dc, kAccentBlue);
      } else if (btn == btn_subtitle_) {
        SetTextColor(btn_dc, subtitle_on_ ? kAccentBlue : kTextSecondary);
      } else if (btn == btn_clear_) {
        SetTextColor(btn_dc, kTextSecondary);
      } else if (btn == btn_close_) {
        SetTextColor(btn_dc, kDangerRed);
      }
      return reinterpret_cast<INT_PTR>(GetStockObject(NULL_BRUSH));
    }
    case WM_DESTROY:
      SetWindowLongPtr(hwnd, GWLP_USERDATA, 0);
      window_handle_ = nullptr;
      return 0;
  }
  return DefWindowProc(hwnd, message, wparam, lparam);
}
