#include "desktop_notification_window.h"

#include <dwmapi.h>
#include <windowsx.h>
#include <gdiplus.h>

#include <algorithm>
#include <memory>

#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "gdiplus.lib")

namespace {

using namespace Gdiplus;

// ═══════════════════════════ 配色（实色近似，压在深色毛玻璃上） ═══════════════════════════
// 说明：Acrylic 层提供 rgba(30,30,30,0.72) 底色 + 桌面模糊；
// 这里的控件色 = 设计稿半透明色 与 毛玻璃底 混合后的“等效实色”，
// 保证绘制到窗口表面时视觉与设计稿一致。
constexpr COLORREF kTextWhite   = RGB(0xFF, 0xFF, 0xFF);
constexpr COLORREF kTextHeader  = RGB(0xF2, 0xF2, 0xF5);  // 顶部「系统通知」
constexpr COLORREF kTextSub     = RGB(0x99, 0x99, 0xA1);  // 「刚刚」≈ 白 60%
constexpr COLORREF kTextTitle   = RGB(0xF4, 0xF4, 0xF6);  // 正文粗标题
constexpr COLORREF kTextBody    = RGB(0xC9, 0xC9, 0xD0);  // 正文 ≈ 白 78%

constexpr COLORREF kBadgeTop    = RGB(0x52, 0x52, 0x5E);  // 图标徽章渐变顶
constexpr COLORREF kBadgeBottom = RGB(0x2C, 0x2C, 0x34);  // 图标徽章渐变底
constexpr COLORREF kBadgeLine   = RGB(0x5E, 0x5E, 0x6A);  // 徽章描边 ≈ 白 22%
constexpr COLORREF kBadgeGlyph  = RGB(0xEC, 0xEC, 0xF2);  // 铃铛

constexpr COLORREF kCloseIdle   = RGB(0xB4, 0xB4, 0xBC);  // 关闭 X
constexpr COLORREF kCloseBgHover= RGB(0x3D, 0x3D, 0x46);  // 关闭 hover 底

// ── 玻璃按钮（两颗同色：半透明白底 + 细描边，随背景透出玻璃感） ──
constexpr COLORREF kGlassWhite  = RGB(0xFF, 0xFF, 0xFF);
constexpr BYTE     kBtnFillA       = 30;  // 常态底 ≈ 白 12%
constexpr BYTE     kBtnFillHoverA  = 56;  // hover 底 ≈ 白 22%
constexpr BYTE     kBtnBorderA     = 70;  // 常态描边 ≈ 白 27%
constexpr BYTE     kBtnBorderHoverA = 110; // hover 描边 ≈ 白 43%
constexpr COLORREF kBtnText        = RGB(0xF2, 0xF2, 0xF5);

constexpr COLORREF kAccentNormal = RGB(0x7A, 0xA2, 0xFF);  // normal → 柔蓝
constexpr COLORREF kAccentHigh   = RGB(0xFF, 0xB0, 0x20);  // high → 琥珀
constexpr COLORREF kAccentUrgent = RGB(0xFF, 0x5C, 0x5C);  // urgent → 红

// ── DWM Acrylic（未公开 user32 接口，Win10 1803+ / Win11 稳定可用） ──
struct AccentPolicy {
  int   accent_state;
  int   flags;
  DWORD gradient_color;  // 0xAABBGGRR
  int   animation_id;
};
struct WindowCompositionAttributeData {
  int     attribute;
  PVOID   data;
  size_t  size;
};
using SetWindowCompositionAttributeFn =
    BOOL (WINAPI*)(HWND, WindowCompositionAttributeData*);

constexpr int kWcaAccentPolicy              = 19;
constexpr int kAccentEnableAcrylicBlurBehind = 4;
// rgba(18,18,24,0.25) → A=0x40, B=0x18, G=0x12, R=0x12
// 着色压到 25%：DWM 模糊后的桌面大面积透出，玻璃感来自这里；
// 可读性由 Paint 里的自绘渐变压暗层负责（不依赖系统“透明效果”开关）
constexpr DWORD kAcrylicTint = 0x40181212u;

constexpr int kDwmwaWindowCornerPreference = 33;
constexpr int kDwmwcpRound                 = 2;

// ── 自绘玻璃压暗层（GDI+ 半透明渐变，直接控制通透度与文字对比度） ──
constexpr COLORREF kScrimTop    = RGB(0x1A, 0x1C, 0x24);  // 顶部稍深
constexpr BYTE     kScrimTopA   = 88;
constexpr COLORREF kScrimBottom = RGB(0x0C, 0x0D, 0x12);  // 底部稍浅
constexpr BYTE     kScrimBottomA = 60;
constexpr COLORREF kRimColor    = RGB(0xFF, 0xFF, 0xFF);
constexpr BYTE     kRimAlpha    = 55;                     // 玻璃高光描边

// ── 布局常量 ──
constexpr int kSidePad    = 18;   // 左右留白
constexpr int kBadgeSize  = 38;   // 图标徽章边长
constexpr int kHeaderTop  = 14;   // 徽章顶
constexpr int kBodyTop    = 66;   // 正文区顶（徽章底 52 + 14）
constexpr int kBtnHeight  = 34;
constexpr int kBtnBottomPad = 18;
constexpr int kMsgMaxLines   = 4;

std::wstring Utf8ToWide(const std::string& s) {
  if (s.empty()) return L"";
  int len = MultiByteToWideChar(CP_UTF8, 0, s.c_str(),
                                static_cast<int>(s.size()), nullptr, 0);
  std::wstring out(len, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()),
                      out.data(), len);
  return out;
}

// 过滤 GDI 字体无法渲染的 emoji / 杂项符号（避免豆腐块 □）
std::wstring StripUnrenderable(std::wstring s) {
  std::wstring out;
  out.reserve(s.size());
  for (size_t i = 0; i < s.size(); ++i) {
    wchar_t c = s[i];
    if (c >= 0xD800 && c <= 0xDFFF) continue;   // 代理对（emoji 等）
    if (c == 0xFE0F || c == 0xFE0E) continue;   // 变体选择符
    if (c >= 0x2600 && c <= 0x27BF) continue;   // 杂项符号 / dingbats
    if (c >= 0x2B00 && c <= 0x2BFF) continue;   // 箭头补充
    out.push_back(c);
  }
  return out;
}

// 去掉正文开头的孤立标点/空白（服务端拼「标题：内容」但标题为空时会漏出「：」）
std::wstring TrimLeadingPunct(std::wstring s) {
  size_t i = 0;
  while (i < s.size()) {
    const wchar_t c = s[i];
    if (c == L' ' || c == L'\t' || c == L'\n' || c == L'\r' || c == 0x3000 ||
        c == L'\uFF1A' /*：*/ || c == L':' || c == L'\uFF0C' /*，*/ ||
        c == L',' || c == L'\u3001' /*、*/ || c == L'\uFF1B' /*；*/ ||
        c == L';') {
      ++i;
      continue;
    }
    break;
  }
  return i > 0 ? s.substr(i) : s;
}

// 顶部空白以下的按钮标题「稍后」
constexpr wchar_t kDismissLabel[] = L"\u7A0D\u540E" /*稍后*/;

HFONT MakeFont(int px, int weight) {
  return CreateFontW(-px, 0, 0, 0, weight, FALSE, FALSE, FALSE,
                     DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                     CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_SWISS,
                     L"Microsoft YaHei UI");
}

// Segoe Fluent Icons(Win11) / Segoe MDL2 Assets(Win10) 是否可用（含铃铛字形）
bool HasIconFont() {
  static const bool has = [] {
    HDC hdc = GetDC(nullptr);
    HFONT f = CreateFontW(-16, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                          DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                          CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                          DEFAULT_PITCH | FF_SWISS, L"Segoe Fluent Icons");
    HFONT old = static_cast<HFONT>(SelectObject(hdc, f));
    WORD gi = 0xFFFF;
    GetGlyphIndicesW(hdc, L"\uEA8F" /*Ringer*/, 1, &gi,
                     GGI_MARK_NONEXISTING_GLYPHS);
    SelectObject(hdc, old);
    DeleteObject(f);
    ReleaseDC(nullptr, hdc);
    return gi != 0xFFFF;
  }();
  return has;
}

// 圆角矩形路径
void AppendRoundRect(GraphicsPath* path, const RectF& rc, float radius) {
  const float d = radius * 2;
  path->AddArc(rc.X, rc.Y, d, d, 180, 90);
  path->AddArc(rc.X + rc.Width - d, rc.Y, d, d, 270, 90);
  path->AddArc(rc.X + rc.Width - d, rc.Y + rc.Height - d, d, d, 0, 90);
  path->AddArc(rc.X, rc.Y + rc.Height - d, d, d, 90, 90);
  path->CloseFigure();
}

Color ToGdiColorA(COLORREF c, BYTE alpha) {
  return Color(alpha, static_cast<BYTE>(c & 0xFF),
               static_cast<BYTE>((c >> 8) & 0xFF),
               static_cast<BYTE>((c >> 16) & 0xFF));
}

Color ToGdiColor(COLORREF c) {
  return ToGdiColorA(c, 255);
}

// ── 文字统一走 GDI+ 渲染 ──
// 关键原因：DWM 玻璃(系统亚克力/ExtendFrame)按预乘 alpha 合成窗口表面，
// GDI ClearType 文字的子像素混合会留下错误的 alpha，文字周围出现矩形色块；
// GDI+ 写入正确的预乘 alpha，形状与文字都不再有伪影。
// 字重/字号仍由 HFONT 描述（Font(hdc, hfont) 构造保留字重映射），渲染走 GDI+。
std::unique_ptr<Font> MakeGpFont(HDC hdc, int px, int weight) {
  HFONT hf = MakeFont(px, weight);
  if (!hf) return nullptr;
  Font* f = new Font(hdc, hf);
  DeleteObject(hf);
  return std::unique_ptr<Font>(f);
}

// ha/va：水平/垂直对齐；wrap=false 单行(超宽省略号)，wrap=true 自动换行
// (超出布局高度时末行省略号)
void DrawTextGp(Graphics& g, Font* font, const std::wstring& s,
                const RectF& rc, COLORREF color,
                StringAlignment ha = StringAlignmentNear,
                StringAlignment va = StringAlignmentNear,
                bool wrap = false) {
  if (!font || s.empty()) return;
  SolidBrush brush(ToGdiColor(color));
  StringFormat sf;
  sf.SetFormatFlags(wrap ? 0
                         : (INT)(StringFormatFlagsNoWrap |
                                 StringFormatFlagsMeasureTrailingSpaces));
  sf.SetTrimming(StringTrimmingEllipsisCharacter);
  sf.SetAlignment(ha);
  sf.SetLineAlignment(va);
  sf.SetHotkeyPrefix(HotkeyPrefixNone);
  g.DrawString(s.c_str(), (INT)s.size(), font, rc, &sf, &brush);
}

// 填充 + 描边圆角矩形（抗锯齿，支持半透明——玻璃按钮/进度条用）
void FillRoundRect(Graphics& g, const RectF& rc, float radius, COLORREF fill,
                   BYTE fill_alpha = 255, COLORREF stroke = 0,
                   BYTE stroke_alpha = 255, bool has_stroke = false) {
  GraphicsPath path;
  AppendRoundRect(&path, rc, radius);
  SolidBrush brush(ToGdiColorA(fill, fill_alpha));
  g.FillPath(&brush, &path);
  if (has_stroke) {
    Pen pen(ToGdiColorA(stroke, stroke_alpha));
    g.DrawPath(&pen, &path);
  }
}

bool PtIn(const POINT& pt, const RECT& rc) {
  return pt.x >= rc.left && pt.x < rc.right &&
         pt.y >= rc.top && pt.y < rc.bottom;
}

}  // namespace

DesktopNotificationWindow::DesktopNotificationWindow() {
  GdiplusStartupInput input;
  GdiplusStartup(&gdiplus_token_, &input, nullptr);
}

DesktopNotificationWindow::~DesktopNotificationWindow() {
  DestroyNativeWindow();
  if (gdiplus_token_) {
    GdiplusShutdown(gdiplus_token_);
    gdiplus_token_ = 0;
  }
}

void DesktopNotificationWindow::SetCallbacks(ConfirmCallback on_confirm,
                                             DismissCallback on_dismiss,
                                             TimeoutCallback on_timeout) {
  on_confirm_ = std::move(on_confirm);
  on_dismiss_ = std::move(on_dismiss);
  on_timeout_ = std::move(on_timeout);
}

void DesktopNotificationWindow::EnsureClassRegistered() {
  static bool registered = false;
  if (registered) return;
  WNDCLASSEXW wc = {};
  wc.cbSize        = sizeof(WNDCLASSEXW);
  wc.style         = CS_HREDRAW | CS_VREDRAW | CS_DBLCLKS;
  wc.lpfnWndProc   = DesktopNotificationWindow::WndProc;
  wc.hInstance     = GetModuleHandle(nullptr);
  wc.hCursor       = LoadCursor(nullptr, IDC_ARROW);
  wc.hbrBackground = nullptr;   // 背景由 Acrylic 层提供，绝不填充
  wc.lpszClassName = kClassName;
  RegisterClassExW(&wc);
  registered = true;
}

void DesktopNotificationWindow::ApplyAcrylicBlur(HWND hwnd) {
  HMODULE user32 = GetModuleHandleW(L"user32.dll");
  if (!user32) return;
  auto set_attr = reinterpret_cast<SetWindowCompositionAttributeFn>(
      reinterpret_cast<void*>(GetProcAddress(
          user32, "SetWindowCompositionAttribute")));
  if (!set_attr) return;

  AccentPolicy accent = {};
  accent.accent_state   = kAccentEnableAcrylicBlurBehind;
  accent.flags          = 2;
  accent.gradient_color = kAcrylicTint;
  accent.animation_id   = 0;

  WindowCompositionAttributeData data = {};
  data.attribute = kWcaAccentPolicy;
  data.data      = &accent;
  data.size      = sizeof(accent);
  set_attr(hwnd, &data);
}

void DesktopNotificationWindow::ApplyRoundedCorners(HWND hwnd) {
  // Win11：系统级圆角（带抗锯齿，Acrylic 自动跟随裁剪，无黑角）
  DWORD pref = kDwmwcpRound;
  DwmSetWindowAttribute(hwnd, kDwmwaWindowCornerPreference,
                        &pref, sizeof(pref));
}

bool DesktopNotificationWindow::CreateWindowIfNeeded() {
  if (window_handle_) return true;
  EnsureClassRegistered();

  // 注意：不要使用 WS_EX_LAYERED——它与 Acrylic 冲突且只会让整窗变淡。
  DWORD ex_style = WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
  DWORD style    = WS_POPUP;

  HWND hwnd = CreateWindowExW(
      ex_style, kClassName, L"", style, 0, 0, kWindowWidth, window_height_,
      nullptr, nullptr, GetModuleHandle(nullptr), this);
  if (!hwnd) return false;
  window_handle_ = hwnd;

  ApplyRoundedCorners(hwnd);
  // 玻璃背景：低透明度 Acrylic 模糊（不依赖系统“透明效果”开关），
  // 压暗与高光由 Paint 里的自绘渐变层负责，通透度完全可控
  ApplyAcrylicBlur(hwnd);
  return true;
}

int DesktopNotificationWindow::MeasureMessageHeight(HDC hdc) const {
  if (message_.empty()) return 0;
  Graphics g(hdc);
  auto font = MakeGpFont(hdc, 13, FW_NORMAL);
  if (!font) return 0;
  StringFormat sf;
  sf.SetTrimming(StringTrimmingNone);  // 测量自然换行总高
  RectF layout(0, 0, static_cast<float>(kWindowWidth - kSidePad * 2),
               100000.0f);
  RectF bound;
  g.MeasureString(message_.c_str(), (INT)message_.size(), font.get(), layout,
                  &sf, &bound);
  const float line_h = font->GetHeight(&g);
  const float max_h = kMsgMaxLines * line_h;
  return static_cast<int>(
      std::clamp(bound.Height > 0 ? bound.Height : line_h, line_h, max_h));
}

int DesktopNotificationWindow::MeasureButtonWidth(HDC hdc,
                                                  const std::wstring& label)
    const {
  Graphics g(hdc);
  auto font = MakeGpFont(hdc, 13, FW_SEMIBOLD);
  if (!font) return 88;
  StringFormat sf;
  sf.SetFormatFlags(StringFormatFlagsNoWrap |
                    StringFormatFlagsMeasureTrailingSpaces);
  RectF bound;
  g.MeasureString(label.c_str(), (INT)label.size(), font.get(), PointF(0, 0),
                  &sf, &bound);
  return static_cast<int>(std::max(88.0f, bound.Width + 44.0f));
}

void DesktopNotificationWindow::ComputeLayout() {
  // 顶部右侧：28×28 圆形关闭热区
  SetRect(&rc_close_, kWindowWidth - 10 - 28, 10,
          kWindowWidth - 10, 38);

  // 底部右侧：主按钮 + 可选次按钮
  const int btn_y = window_height_ - kBtnBottomPad - kBtnHeight;
  HDC hdc = GetDC(nullptr);
  const int confirm_w = MeasureButtonWidth(hdc, confirm_text_);
  const int dismiss_w = show_confirm_button_
                            ? MeasureButtonWidth(hdc, kDismissLabel)
                            : 0;
  ReleaseDC(nullptr, hdc);
  const int gap       = 10;
  const int confirm_x = kWindowWidth - kSidePad - confirm_w;
  const int dismiss_x = confirm_x - gap - dismiss_w;

  SetRect(&rc_confirm_, confirm_x, btn_y,
          confirm_x + confirm_w, btn_y + kBtnHeight);
  if (show_confirm_button_) {
    SetRect(&rc_dismiss_, dismiss_x, btn_y,
            dismiss_x + dismiss_w, btn_y + kBtnHeight);
  } else {
    SetRectEmpty(&rc_dismiss_);
  }
}

void DesktopNotificationWindow::PositionAtBottomRight() {
  if (!window_handle_) return;
  MONITORINFO mi = {sizeof(mi)};
  GetMonitorInfoW(MonitorFromWindow(window_handle_, MONITOR_DEFAULTTONEAREST),
                  &mi);
  const int x = mi.rcWork.right  - kWindowWidth - kMargin;
  const int y = mi.rcWork.bottom - window_height_ - kMargin;
  // 先显式置可见（NOACTIVATE，不抢焦点），再原子定位——避免仅靠
  // SWP_SHOWWINDOW 在个别环境下初始不可见的竞态
  ShowWindow(window_handle_, SW_SHOWNOACTIVATE);
  SetWindowPos(window_handle_, HWND_TOPMOST, x, y, kWindowWidth,
               window_height_, SWP_NOACTIVATE | SWP_SHOWWINDOW);
}

void DesktopNotificationWindow::Show(const std::string& title,
                                     const std::string& message,
                                     const std::string& priority,
                                     bool show_confirm_button,
                                     const std::string& confirm_text,
                                     int auto_close_ms) {
  title_              = StripUnrenderable(Utf8ToWide(title));
  message_            = TrimLeadingPunct(
      StripUnrenderable(Utf8ToWide(message)));
  confirm_text_       = StripUnrenderable(
      Utf8ToWide(confirm_text.empty() ? "\u6211\u77E5\u9053\u4E86"
                                      /*我知道了*/ : confirm_text));
  show_confirm_button_ = show_confirm_button;
  auto_close_ms_       = auto_close_ms;

  // 优先级 → 强调色（自动关闭进度条着色）
  if (priority == "urgent" || priority == "critical") {
    accent_color_ = kAccentUrgent;
  } else if (priority == "high") {
    accent_color_ = kAccentHigh;
  } else {
    accent_color_ = kAccentNormal;
  }

  // 按内容动态计算窗口高度：头部 + 可选粗标题 + 消息（≤4 行）+ 按钮区
  HDC hdc = GetDC(nullptr);
  const int msg_h = MeasureMessageHeight(hdc);
  ReleaseDC(nullptr, hdc);
  int y = kBodyTop;
  if (!title_.empty()) y += 24 + 6;
  y += msg_h;
  const int btn_y = std::max(y + 16, kBodyTop + 30);
  window_height_ = std::clamp(btn_y + kBtnHeight + kBtnBottomPad,
                              kMinHeight, kMaxHeight);

  // 每次都重建窗口：毛玻璃窗口从不擦除背景，复用旧窗口会残留上一次的
  // 像素（文字/高度变化时出现鬼影）；新建表面全零，视觉始终纯净。
  DestroyNativeWindow();
  if (!CreateWindowIfNeeded()) return;
  ComputeLayout();
  hover_id_ = 0;
  show_tick_ = GetTickCount64();  // 预绘制进度条需要正确的起点
  // 显示前先绘制完整第一帧，避免弹出瞬间出现无内容的纯毛玻璃帧
  {
    HDC wdc = GetWindowDC(window_handle_);
    Paint(window_handle_, wdc);
    ReleaseDC(window_handle_, wdc);
  }
  PositionAtBottomRight();
  StartTimer();
  Repaint();
}

void DesktopNotificationWindow::Hide() {
  StopTimer();
  if (window_handle_) ShowWindow(window_handle_, SW_HIDE);
}

bool DesktopNotificationWindow::IsVisible() const {
  return window_handle_ && IsWindowVisible(window_handle_);
}

void DesktopNotificationWindow::StartTimer() {
  StopTimer();
  if (window_handle_ && auto_close_ms_ > 0) {
    show_tick_ = GetTickCount64();
    SetTimer(window_handle_, kTickTimerId, 50, nullptr);
  }
}

void DesktopNotificationWindow::StopTimer() {
  if (window_handle_) KillTimer(window_handle_, kTickTimerId);
}

void DesktopNotificationWindow::DestroyNativeWindow() {
  StopTimer();
  if (window_handle_ && IsWindow(window_handle_)) DestroyWindow(window_handle_);
  window_handle_ = nullptr;
}

void DesktopNotificationWindow::Repaint() {
  if (!window_handle_) return;
  InvalidateRect(window_handle_, nullptr, FALSE);  // 不擦除，保护 Acrylic 底
}

int DesktopNotificationWindow::HitTest(const POINT& pt) const {
  if (PtIn(pt, rc_close_))   return 1;
  if (PtIn(pt, rc_dismiss_)) return 2;
  if (PtIn(pt, rc_confirm_)) return 3;
  return 0;
}

// ═══════════════════════════════ 绘制 ════════════════════════════════

// 铃铛：优先用 Segoe Fluent/MDL2 字形（矢量，GDI+ 渲染）；缺失时退回几何拼形
void DesktopNotificationWindow::DrawBellGlyph(HDC hdc, const RECT& rc,
                                              COLORREF color) {
  Graphics g(hdc);
  g.SetSmoothingMode(SmoothingModeAntiAlias);
  g.SetPixelOffsetMode(PixelOffsetModeHighQuality);
  const RectF rc_g(static_cast<float>(rc.left), static_cast<float>(rc.top),
                   static_cast<float>(rc.right - rc.left),
                   static_cast<float>(rc.bottom - rc.top));
  if (HasIconFont()) {
    const wchar_t* faces[] = {L"Segoe Fluent Icons", L"Segoe MDL2 Assets"};
    for (const wchar_t* face : faces) {
      HFONT hf = CreateFontW(-(kBadgeSize * 2 / 5), 0, 0, 0, FW_NORMAL,
                             FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                             OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                             ANTIALIASED_QUALITY, DEFAULT_PITCH | FF_SWISS,
                             face);
      if (!hf) break;
      WORD gi = 0xFFFF;
      HFONT old = static_cast<HFONT>(SelectObject(hdc, hf));
      const bool ok =
          GetGlyphIndicesW(hdc, L"\uEA8F" /*Ringer*/, 1, &gi,
                           GGI_MARK_NONEXISTING_GLYPHS) > 0 &&
          gi != 0xFFFF;
      SelectObject(hdc, old);
      if (!ok) {
        DeleteObject(hf);
        continue;
      }
      std::unique_ptr<Font> font(new Font(hdc, hf));
      DeleteObject(hf);
      if (!font) break;
      SolidBrush brush(ToGdiColor(color));
      StringFormat sf;
      sf.SetFormatFlags(StringFormatFlagsNoWrap |
                        StringFormatFlagsMeasureTrailingSpaces);
      sf.SetAlignment(StringAlignmentCenter);
      sf.SetLineAlignment(StringAlignmentCenter);
      g.DrawString(L"\uEA8F", 1, font.get(), rc_g, &sf, &brush);
      return;
    }
  }
  // 回退：几何铃铛（钟顶圆钮 + 半圆钟身 + 外撇裙 + 钟舌），GDI+ 抗锯齿
  const float cx = rc_g.X + rc_g.Width / 2.0f;
  const float cy = rc_g.Y + rc_g.Height / 2.0f;
  SolidBrush brush(ToGdiColor(color));
  g.FillEllipse(&brush, cx - 6.0f, cy - 9.0f, 12.0f, 12.0f);
  const PointF skirt[4] = {
      {cx - 9.0f, cy + 5.0f}, {cx - 6.0f, cy + 1.0f},
      {cx + 6.0f, cy + 1.0f}, {cx + 9.0f, cy + 5.0f}};
  g.FillPolygon(&brush, skirt, 4);
  g.FillEllipse(&brush, cx - 3.0f, cy + 3.0f, 6.0f, 6.0f);
  g.FillEllipse(&brush, cx - 2.0f, cy - 12.0f, 4.0f, 4.0f);
}

void DesktopNotificationWindow::Paint(HWND hwnd, HDC hdc) {
  Graphics g(hdc);
  g.SetSmoothingMode(SmoothingModeAntiAlias);
  g.SetPixelOffsetMode(PixelOffsetModeHighQuality);
  g.SetTextRenderingHint(TextRenderingHintAntiAliasGridFit);

  // ── 玻璃压暗层：半透明渐变盖在 Acrylic 模糊上，透出背景的同时保证
  //    文字对比度；透明度在此统一可调 ──
  {
    const RectF full(0, 0, static_cast<float>(kWindowWidth),
                     static_cast<float>(window_height_));
    LinearGradientBrush scrim(full, ToGdiColorA(kScrimTop, kScrimTopA),
                              ToGdiColorA(kScrimBottom, kScrimBottomA),
                              90.0f);
    g.FillRectangle(&scrim, full);

    // 玻璃高光描边（内缩 1px，跟随系统圆角），增强“玻璃片”轮廓
    GraphicsPath rim;
    AppendRoundRect(&rim,
                    RectF(1.0f, 1.0f, static_cast<float>(kWindowWidth) - 2.0f,
                          static_cast<float>(window_height_) - 2.0f),
                    7.0f);
    Pen rim_pen(ToGdiColorA(kRimColor, kRimAlpha));
    g.DrawPath(&rim_pen, &rim);
  }

  // ── 图标徽章：垂直渐变圆角方块 + 细描边 ──
  const RectF badge(kSidePad, static_cast<float>(kHeaderTop),
                    kBadgeSize, kBadgeSize);
  {
    GraphicsPath path;
    AppendRoundRect(&path, badge, 11);
    LinearGradientBrush brush(badge, ToGdiColor(kBadgeTop),
                              ToGdiColor(kBadgeBottom), 90.0f);
    g.FillPath(&brush, &path);
    Pen line(ToGdiColor(kBadgeLine));
    g.DrawPath(&line, &path);
  }

  // ── 关闭钮：hover 时浅色圆底 ──
  if (hover_id_ == 1) {
    const RectF crc(static_cast<float>(rc_close_.left),
                    static_cast<float>(rc_close_.top),
                    static_cast<float>(rc_close_.right - rc_close_.left),
                    static_cast<float>(rc_close_.bottom - rc_close_.top));
    SolidBrush brush(ToGdiColor(kCloseBgHover));
    g.FillEllipse(&brush, crc);
  }

  // ── 关闭 X：圆头细线 ──
  {
    const float cx = (rc_close_.left + rc_close_.right) / 2.0f;
    const float cy = (rc_close_.top + rc_close_.bottom) / 2.0f;
    const float s  = 4.5f;
    Pen pen(ToGdiColor(hover_id_ == 1 ? kTextWhite : kCloseIdle), 2.0f);
    pen.SetStartCap(LineCapRound);
    pen.SetEndCap(LineCapRound);
    g.DrawLine(&pen, cx - s, cy - s, cx + s, cy + s);
    g.DrawLine(&pen, cx + s, cy - s, cx - s, cy + s);
  }

  // ── 按钮底（两颗同色玻璃按钮：半透明白底 + 细描边，hover 增亮） ──
  auto draw_button_base = [&](const RECT& rc, bool hovered) {
    const RectF brc(static_cast<float>(rc.left),
                    static_cast<float>(rc.top),
                    static_cast<float>(rc.right - rc.left),
                    static_cast<float>(rc.bottom - rc.top));
    FillRoundRect(g, brc, 8, kGlassWhite,
                  hovered ? kBtnFillHoverA : kBtnFillA, kGlassWhite,
                  hovered ? kBtnBorderHoverA : kBtnBorderA, true);
  };
  if (show_confirm_button_) {
    draw_button_base(rc_dismiss_, hover_id_ == 2);
  }
  draw_button_base(rc_confirm_, hover_id_ == 3);

  // ── 自动关闭进度条：半透明轨道 + 剩余时间强调色填充 ──
  if (auto_close_ms_ > 0) {
    const float track_y = static_cast<float>(window_height_ - 6);
    const float track_w = static_cast<float>(kWindowWidth - kSidePad * 2);
    FillRoundRect(g, RectF(kSidePad, track_y, track_w, 3), 1.5f,
                  kGlassWhite, 30);
    const double elapsed =
        static_cast<double>(GetTickCount64() - show_tick_);
    double remain = 1.0;
    if (auto_close_ms_ > 0) {
      remain = 1.0 - elapsed / static_cast<double>(auto_close_ms_);
      remain = std::clamp(remain, 0.0, 1.0);
    }
    if (remain > 0.001) {
      FillRoundRect(g, RectF(kSidePad, track_y,
                             static_cast<float>(track_w * remain), 3),
                    1.5f, accent_color_, 235);
    }
  }

  // ══ 文字（GDI+ 渲染，与形状同一表面管线，玻璃上无 ClearType 矩形伪影） ══

  // ── 顶部：铃铛徽章字形 ──
  const RECT badge_rc = {kSidePad, kHeaderTop, kSidePad + kBadgeSize,
                         kHeaderTop + kBadgeSize};
  DrawBellGlyph(hdc, badge_rc, kBadgeGlyph);

  // ── 顶部：「系统通知」+ 右侧「刚刚」（与徽章垂直居中对齐） ──
  auto f_header = MakeGpFont(hdc, 14, FW_SEMIBOLD);
  auto f_sub    = MakeGpFont(hdc, 12, FW_NORMAL);
  auto f_title  = MakeGpFont(hdc, 15, FW_SEMIBOLD);
  auto f_body   = MakeGpFont(hdc, 13, FW_NORMAL);
  auto f_btn    = MakeGpFont(hdc, 13, FW_SEMIBOLD);

  const int header_left  = kSidePad + kBadgeSize + 12;
  const int header_right = rc_close_.left - 10;
  DrawTextGp(g, f_header.get(), L"\u7CFB\u7EDF\u901A\u77E5" /*系统通知*/,
             RectF(static_cast<float>(header_left),
                   static_cast<float>(kHeaderTop),
                   static_cast<float>(header_right - 44 - header_left),
                   static_cast<float>(kBadgeSize)),
             kTextHeader, StringAlignmentNear, StringAlignmentCenter);
  DrawTextGp(g, f_sub.get(), L"\u521A\u521A" /*刚刚*/,
             RectF(static_cast<float>(header_right - 44),
                   static_cast<float>(kHeaderTop), 44.0f,
                   static_cast<float>(kBadgeSize)),
             kTextSub, StringAlignmentFar, StringAlignmentCenter);

  // ── 正文：粗标题（可选） + 描述 ──
  int y = kBodyTop;
  if (!title_.empty()) {
    DrawTextGp(g, f_title.get(), title_,
               RectF(static_cast<float>(kSidePad),
                     static_cast<float>(y - 2),
                     static_cast<float>(kWindowWidth - kSidePad * 2), 26.0f),
               kTextTitle);
    y += 30;
  }
  if (!message_.empty() && f_body) {
    const float line_h = f_body->GetHeight(&g);
    DrawTextGp(g, f_body.get(), message_,
               RectF(static_cast<float>(kSidePad), static_cast<float>(y),
                     static_cast<float>(kWindowWidth - kSidePad * 2),
                     kMsgMaxLines * line_h + 4.0f),
               kTextBody, StringAlignmentNear, StringAlignmentNear, true);
  }

  // ── 按钮文字 ──
  auto rect_of = [](const RECT& rc) {
    return RectF(static_cast<float>(rc.left), static_cast<float>(rc.top),
                 static_cast<float>(rc.right - rc.left),
                 static_cast<float>(rc.bottom - rc.top));
  };
  if (show_confirm_button_) {
    DrawTextGp(g, f_btn.get(), kDismissLabel, rect_of(rc_dismiss_), kBtnText,
               StringAlignmentCenter, StringAlignmentCenter);
  }
  DrawTextGp(g, f_btn.get(), confirm_text_, rect_of(rc_confirm_), kBtnText,
             StringAlignmentCenter, StringAlignmentCenter);

  g.Flush(FlushIntentionSync);
}

// ═══════════════════════════════ 消息处理 ══════════════════════════════

LRESULT CALLBACK DesktopNotificationWindow::WndProc(HWND hwnd, UINT message,
                                                    WPARAM wparam,
                                                    LPARAM lparam) noexcept {
  if (message == WM_NCCREATE) {
    auto* cs = reinterpret_cast<CREATESTRUCT*>(lparam);
    SetWindowLongPtr(hwnd, GWLP_USERDATA,
                     reinterpret_cast<LONG_PTR>(cs->lpCreateParams));
  } else {
    auto* that = reinterpret_cast<DesktopNotificationWindow*>(
        GetWindowLongPtr(hwnd, GWLP_USERDATA));
    if (that) return that->HandleMessage(hwnd, message, wparam, lparam);
  }
  return DefWindowProc(hwnd, message, wparam, lparam);
}

LRESULT DesktopNotificationWindow::HandleMessage(HWND hwnd, UINT message,
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
      // Acrylic 层是背景，绝不用画刷擦除（否则黑底/闪烁）
      return 1;

    case WM_TIMER:
      if (wparam == kTickTimerId) {
        if (auto_close_ms_ > 0) {
          const ULONGLONG elapsed = GetTickCount64() - show_tick_;
          if (elapsed >= static_cast<ULONGLONG>(auto_close_ms_)) {
            StopTimer();
            if (on_timeout_) on_timeout_();
            Hide();
          } else {
            // 只刷新底部进度条区域，避免整窗重绘
            RECT strip = {0, window_height_ - 10, kWindowWidth,
                          window_height_};
            InvalidateRect(hwnd, &strip, FALSE);
          }
        }
        return 0;
      }
      break;

    case WM_MOUSEMOVE: {
      POINT pt = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
      const int id = HitTest(pt);
      if (id != hover_id_) {
        hover_id_ = id;
        Repaint();
      }
      if (!mouse_tracking_) {
        TRACKMOUSEEVENT tme = {sizeof(tme)};
        tme.dwFlags = TME_LEAVE;
        tme.hwndTrack = hwnd;
        TrackMouseEvent(&tme);
        mouse_tracking_ = true;
      }
      return 0;
    }

    case WM_MOUSELEAVE:
      mouse_tracking_ = false;
      if (hover_id_ != 0) {
        hover_id_ = 0;
        Repaint();
      }
      return 0;

    case WM_SETCURSOR:
      if (LOWORD(lparam) == HTCLIENT) {
        POINT pt;
        GetCursorPos(&pt);
        ScreenToClient(hwnd, &pt);
        SetCursor(LoadCursor(nullptr,
                             HitTest(pt) ? IDC_HAND : IDC_ARROW));
        return TRUE;
      }
      break;

    case WM_LBUTTONUP: {
      POINT pt = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
      const int id = HitTest(pt);
      if (id == 3) {
        if (on_confirm_) on_confirm_();
        Hide();
        return 0;
      }
      if (id == 1 || id == 2) {
        if (on_dismiss_) on_dismiss_();
        Hide();
        return 0;
      }
      break;
    }

    case WM_DESTROY:
      StopTimer();
      SetWindowLongPtr(hwnd, GWLP_USERDATA, 0);
      window_handle_ = nullptr;
      return 0;
  }
  return DefWindowProc(hwnd, message, wparam, lparam);
}
