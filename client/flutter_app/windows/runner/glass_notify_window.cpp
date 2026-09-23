#include "glass_notify_window.h"

#include <windowsx.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <memory>

#pragma comment(lib, "gdiplus.lib")

namespace {

using namespace Gdiplus;

// ═══════════ 配色：Meoo 玻璃态设计（黑白单色，暗色玻璃） ═══════════
constexpr COLORREF kInk          = RGB(0xFC, 0xFC, 0xFC);  // 主文字
constexpr COLORREF kInkSoft      = RGB(0xFF, 0xFF, 0xFF);  // 次文字（乘 66% alpha）
constexpr BYTE     kInkSoftA     = 168;
constexpr COLORREF kCardFill     = RGB(0x18, 0x18, 0x18);  // 玻璃卡深色膜
constexpr BYTE     kCardFillA    = 150;
constexpr BYTE     kCardLineA    = 46;                     // 边框 ≈ 白 18%
constexpr BYTE     kSheenA       = 92;                     // 顶部高光线 ≈ 白 36%
constexpr COLORREF kChipFill     = RGB(0x30, 0x30, 0x30);  // 图标徽章底
constexpr BYTE     kChipFillA    = 165;
constexpr BYTE     kChipLineA    = 84;                     // 徽章描边 ≈ 白 33%
constexpr COLORREF kPillFill     = RGB(0xFC, 0xFC, 0xFC);  // 确认胶囊
constexpr COLORREF kPillText     = RGB(0x0D, 0x0D, 0x0D);
constexpr BYTE     kProgressA    = 118;                    // 倒计时进度线
constexpr BYTE     kCloseA       = 145;                    // 关闭 X
constexpr BYTE     kNoiseA       = 13;                     // 噪点上限 alpha

// ── 布局常量（与 Flutter 端 glass_notify.dart 对齐，局部坐标） ──
constexpr int   kPadL        = 14;
constexpr int   kPadT        = 13;
constexpr int   kPadR        = 12;
constexpr int   kPadB        = 14;
constexpr int   kChipSize    = 36;
constexpr int   kTitleH      = 21;
constexpr int   kMsgGap      = 6;
constexpr int   kPillGap     = 12;
constexpr int   kPillH       = 28;
constexpr int   kMsgMaxLines = 4;
constexpr float kCardRadius  = 16.0f;
constexpr int   kProgressH   = 2;
constexpr int   kLineH       = 18;  // 13px 正文的近似行高

std::wstring Utf8ToWide(const std::string& s) {
  if (s.empty()) return L"";
  int len = MultiByteToWideChar(CP_UTF8, 0, s.c_str(),
                                static_cast<int>(s.size()), nullptr, 0);
  std::wstring out(len, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()),
                      out.data(), len);
  return out;
}

// 过滤 GDI 字体无法渲染的 emoji / 杂项符号（避免豆腐块）
std::wstring StripUnrenderable(std::wstring s) {
  std::wstring out;
  out.reserve(s.size());
  for (size_t i = 0; i < s.size(); ++i) {
    const wchar_t c = s[i];
    if (c >= 0xD800 && c <= 0xDFFF) continue;
    if (c == 0xFE0F || c == 0xFE0E) continue;
    if (c >= 0x2600 && c <= 0x27BF) continue;
    if (c >= 0x2B00 && c <= 0x2BFF) continue;
    out.push_back(c);
  }
  return out;
}

HFONT MakeFont(int px, int weight) {
  return CreateFontW(-px, 0, 0, 0, weight, FALSE, FALSE, FALSE,
                     DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                     CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_SWISS,
                     L"Microsoft YaHei UI");
}

// 文字统一 GDI+ 渲染（ULW 逐像素 alpha 表面，GDI ClearType 会留错误 alpha）
std::unique_ptr<Font> MakeGpFont(HDC hdc, int px, int weight) {
  HFONT hf = MakeFont(px, weight);
  if (!hf) return nullptr;
  Font* f = new Font(hdc, hf);
  DeleteObject(hf);
  return std::unique_ptr<Font>(f);
}

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

void DrawTextGp(Graphics& g, Font* font, const std::wstring& s,
                const RectF& rc, COLORREF color, BYTE alpha,
                StringAlignment ha = StringAlignmentNear,
                StringAlignment va = StringAlignmentNear,
                bool wrap = false) {
  if (!font || s.empty()) return;
  SolidBrush brush(ToGdiColorA(color, alpha));
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

bool PtIn(const POINT& pt, const RECT& rc) {
  return pt.x >= rc.left && pt.x < rc.right &&
         pt.y >= rc.top && pt.y < rc.bottom;
}

float MeanLuma(Bitmap* img) {
  BitmapData data;
  Rect full(0, 0, static_cast<INT>(img->GetWidth()),
            static_cast<INT>(img->GetHeight()));
  if (img->LockBits(&full, ImageLockModeRead, PixelFormat32bppARGB, &data) !=
      Ok) {
    return 80.0f;
  }
  float sum = 0.0f;
  int n = 0;
  for (UINT y = 0; y < data.Height; ++y) {
    const BYTE* row = static_cast<const BYTE*>(data.Scan0) + y * data.Stride;
    for (UINT x = 0; x < data.Width; ++x) {
      const BYTE* px = row + x * 4;  // BGRA
      sum += 0.299f * px[2] + 0.587f * px[1] + 0.114f * px[0];
      ++n;
    }
  }
  img->UnlockBits(&data);
  return n > 0 ? sum / n : 80.0f;
}

// Segoe Fluent(Win11)/MDL2(Win10) 图标字体是否可用
bool HasIconFont() {
  static const bool has = [] {
    HDC hdc = GetDC(nullptr);
    HFONT f = CreateFontW(-16, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                          DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                          CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                          DEFAULT_PITCH | FF_SWISS, L"Segoe Fluent Icons");
    HFONT old = static_cast<HFONT>(SelectObject(hdc, f));
    WORD gi = 0xFFFF;
    GetGlyphIndicesW(hdc, L"\uE946", 1, &gi, GGI_MARK_NONEXISTING_GLYPHS);
    SelectObject(hdc, old);
    DeleteObject(f);
    ReleaseDC(nullptr, hdc);
    return gi != 0xFFFF;
  }();
  return has;
}

void DrawIconChar(HDC hdc, Graphics& g, const RectF& rc, wchar_t ch,
                  BYTE alpha) {
  const wchar_t* faces[] = {L"Segoe Fluent Icons", L"Segoe MDL2 Assets"};
  for (const wchar_t* face : faces) {
    HFONT hf = CreateFontW(-(static_cast<int>(rc.Height * 0.5f)), 0, 0, 0,
                           FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                           OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                           ANTIALIASED_QUALITY, DEFAULT_PITCH | FF_SWISS,
                           face);
    if (!hf) break;
    WORD gi = 0xFFFF;
    HFONT old = static_cast<HFONT>(SelectObject(hdc, hf));
    const bool ok = GetGlyphIndicesW(hdc, &ch, 1, &gi,
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
    SolidBrush brush(ToGdiColorA(kInk, alpha));
    StringFormat sf;
    sf.SetFormatFlags(StringFormatFlagsNoWrap |
                      StringFormatFlagsMeasureTrailingSpaces);
    sf.SetAlignment(StringAlignmentCenter);
    sf.SetLineAlignment(StringAlignmentCenter);
    g.DrawString(&ch, 1, font.get(), rc, &sf, &brush);
    return;
  }
  // 回退：几何感叹号
  SolidBrush brush(ToGdiColorA(kInk, alpha));
  const float cx = rc.X + rc.Width / 2.0f;
  g.FillRectangle(&brush, cx - 1.5f, rc.Y + rc.Height * 0.22f, 3.0f,
                  rc.Height * 0.38f);
  g.FillEllipse(&brush, cx - 2.0f, rc.Y + rc.Height * 0.68f, 4.0f, 4.0f);
}

}  // namespace

GlassNotifyWindow::GlassNotifyWindow() {
  GdiplusStartupInput input;
  GdiplusStartup(&gdiplus_token_, &input, nullptr);
}

GlassNotifyWindow::~GlassNotifyWindow() {
  DestroyNativeWindow();
  if (gdiplus_token_) {
    GdiplusShutdown(gdiplus_token_);
    gdiplus_token_ = 0;
  }
}

void GlassNotifyWindow::SetEventCallback(EventCallback callback) {
  event_callback_ = std::move(callback);
}

void GlassNotifyWindow::EnsureClassRegistered() {
  static bool registered = false;
  if (registered) return;
  WNDCLASSEXW wc = {};
  wc.cbSize        = sizeof(WNDCLASSEXW);
  wc.style         = CS_HREDRAW | CS_VREDRAW;
  wc.lpfnWndProc   = GlassNotifyWindow::WndProc;
  wc.hInstance     = GetModuleHandle(nullptr);
  wc.hCursor       = LoadCursor(nullptr, IDC_ARROW);
  wc.hbrBackground = nullptr;
  wc.lpszClassName = kClassName;
  RegisterClassExW(&wc);
  registered = true;
}

bool GlassNotifyWindow::CreateWindowIfNeeded() {
  if (window_handle_) return true;
  EnsureClassRegistered();
  // ULW 逐像素 alpha：卡片间空隙真实透明，无需 Acrylic/DWM 圆角
  DWORD ex_style = WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE |
                   WS_EX_LAYERED;
  HWND hwnd = CreateWindowExW(ex_style, kClassName, L"", WS_POPUP, 0, 0,
                              kCardWidth, 10, nullptr, nullptr,
                              GetModuleHandle(nullptr), this);
  if (!hwnd) return false;
  window_handle_ = hwnd;
  return true;
}

void GlassNotifyWindow::DestroyNativeWindow() {
  if (window_handle_ && IsWindow(window_handle_)) {
    KillTimer(window_handle_, kTickTimerId);
    DestroyWindow(window_handle_);
  }
  window_handle_ = nullptr;
  cards_.clear();
  backdrop_.reset();
  hover_card_ = -1;
}

int GlassNotifyWindow::CardElapsedMs(const Card& card, ULONGLONG now) const {
  ULONGLONG elapsed = now - card.start_tick;
  ULONGLONG paused = card.paused_total_ms;
  if (card.hover_paused) {
    paused += now - card.pause_begin_tick;
  }
  elapsed = elapsed > paused ? elapsed - paused : 0;
  return static_cast<int>(elapsed);
}

void GlassNotifyWindow::PauseCard(Card* card, ULONGLONG now) {
  if (card->hover_paused) return;
  card->hover_paused = true;
  card->pause_begin_tick = now;
}

void GlassNotifyWindow::ResumeCard(Card* card, ULONGLONG now) {
  if (!card->hover_paused) return;
  card->paused_total_ms += now - card->pause_begin_tick;
  card->hover_paused = false;
}

int GlassNotifyWindow::MeasureMsgLines(const Card& card) const {
  if (card.message.empty()) return 0;
  HDC hdc = GetDC(nullptr);
  Graphics g(hdc);
  int lines = 1;
  if (auto font = MakeGpFont(hdc, 13, FW_NORMAL)) {
    StringFormat sf;
    sf.SetTrimming(StringTrimmingNone);
    RectF layout(0.0f, 0.0f,
                 static_cast<REAL>(kCardWidth - kPadL - kPadR), 100000.0f);
    RectF bound;
    g.MeasureString(card.message.c_str(), (INT)card.message.size(),
                    font.get(), layout, &sf, &bound);
    const float line_h = std::max(font->GetHeight(&g), 0.5f);
    lines = static_cast<int>(std::clamp(
        std::ceil(bound.Height / line_h), 1.0f,
        static_cast<float>(kMsgMaxLines)));
  }
  ReleaseDC(nullptr, hdc);
  return lines;
}

int GlassNotifyWindow::MeasurePillWidth(const Card& card) const {
  if (card.confirm_text.empty()) return 0;
  HDC hdc = GetDC(nullptr);
  Graphics g(hdc);
  int w = 88;
  if (auto font = MakeGpFont(hdc, 13, FW_SEMIBOLD)) {
    StringFormat sf;
    sf.SetFormatFlags(StringFormatFlagsNoWrap |
                      StringFormatFlagsMeasureTrailingSpaces);
    RectF bound;
    g.MeasureString(card.confirm_text.c_str(),
                    (INT)card.confirm_text.size(), font.get(), PointF(0, 0),
                    &sf, &bound);
    w = static_cast<int>(std::max(88.0f, bound.Width + 28.0f));
  }
  ReleaseDC(nullptr, hdc);
  return w;
}

void GlassNotifyWindow::ComputeLayout() {
  int y = 2;  // 顶部留 2px 给抗锯齿边
  for (size_t i = 0; i < cards_.size(); ++i) {
    Card& card = cards_[i];
    card.msg_lines = MeasureMsgLines(card);
    int h = kPadT + kChipSize + kMsgGap + card.msg_lines * kLineH;
    if (!card.confirm_text.empty()) {
      h += kPillGap + kPillH;
    }
    h += kPadB;
    card.card_height = h;

    // 热区：卡片局部坐标（未缩放）
    SetRect(&card.rc_close, kCardWidth - kPadR - 26, kPadT + 3,
            kCardWidth - kPadR, kPadT + 29);
    const int pill_w = MeasurePillWidth(card);
    SetRect(&card.rc_confirm, kCardWidth - kPadR - pill_w, h - kPadB - kPillH,
            kCardWidth - kPadR, h - kPadB);

    // 窗口坐标：整体缩放绕卡片中心，位置逐级上移
    const float scale = 1.0f - kDepthScale * static_cast<float>(i);
    const int cw = static_cast<int>(kCardWidth * scale);
    const int ch = static_cast<int>(h * scale);
    const int cx = (kCardWidth - cw) / 2;
    const int cy = y;
    SetRect(&card.rc_card, cx, cy, cx + cw, cy + ch);

    y = cy + ch + 4;  // 缩放后留 4px 视觉间隙
  }
}

POINT GlassNotifyWindow::TopRightOrigin() const {
  MONITORINFO mi = {sizeof(mi)};
  GetMonitorInfoW(MonitorFromWindow(window_handle_, MONITOR_DEFAULTTONEAREST),
                  &mi);
  POINT pt = {mi.rcWork.right - kCardWidth - kStackMargin,
              mi.rcWork.top + kStackMargin};
  return pt;
}

// 抓拍将覆盖的桌面像素，1/8 降采样再双三次放大 = 大半径柔焦（自绘毛玻璃底）
void GlassNotifyWindow::CaptureBackdrop(int origin_x, int origin_y, int w,
                                        int h) {
  backdrop_.reset();
  HDC screen = GetDC(nullptr);
  BITMAPINFO bmi = {};
  bmi.bmiHeader.biSize        = sizeof(BITMAPINFOHEADER);
  bmi.bmiHeader.biWidth       = w;
  bmi.bmiHeader.biHeight      = -h;
  bmi.bmiHeader.biPlanes      = 1;
  bmi.bmiHeader.biBitCount    = 32;
  bmi.bmiHeader.biCompression = BI_RGB;
  void* bits = nullptr;
  HBITMAP dib =
      CreateDIBSection(nullptr, &bmi, DIB_RGB_COLORS, &bits, nullptr, 0);
  if (!dib) {
    ReleaseDC(nullptr, screen);
    return;
  }
  HDC mem = CreateCompatibleDC(screen);
  HBITMAP old = static_cast<HBITMAP>(SelectObject(mem, dib));
  BitBlt(mem, 0, 0, w, h, screen, origin_x, origin_y, SRCCOPY);
  SelectObject(mem, old);
  DeleteDC(mem);
  ReleaseDC(nullptr, screen);

  Bitmap raw(w, h, w * 4, PixelFormat32bppARGB, static_cast<BYTE*>(bits));
  const int sw = std::max(1, w / 8);
  const int sh = std::max(1, h / 8);
  Bitmap downscaled(sw, sh, PixelFormat32bppARGB);
  {
    Graphics gs(&downscaled);
    gs.SetInterpolationMode(InterpolationModeHighQualityBicubic);
    gs.SetPixelOffsetMode(PixelOffsetModeHighQuality);
    ImageAttributes ia;
    ia.SetWrapMode(WrapModeTileFlipXY);
    gs.DrawImage(&raw, RectF(0.0f, 0.0f, static_cast<REAL>(sw),
                             static_cast<REAL>(sh)),
                 0.0f, 0.0f, static_cast<REAL>(w), static_cast<REAL>(h),
                 UnitPixel, &ia);
  }
  DeleteObject(dib);

  // 自适应压暗：亮桌面把玻璃压成深色贴膜保证白字可读，暗桌面全通透
  backdrop_dim_ = std::clamp(90.0f / std::max(MeanLuma(&downscaled), 1.0f),
                             0.34f, 1.0f);

  auto* blurred = new Bitmap(w, h, PixelFormat32bppARGB);
  {
    Graphics gb(blurred);
    gb.SetInterpolationMode(InterpolationModeHighQualityBicubic);
    gb.SetPixelOffsetMode(PixelOffsetModeHighQuality);
    ImageAttributes ia;
    ia.SetWrapMode(WrapModeTileFlipXY);
    gb.DrawImage(&downscaled, RectF(0.0f, 0.0f, static_cast<REAL>(w),
                                    static_cast<REAL>(h)),
                 0.0f, 0.0f, static_cast<REAL>(sw), static_cast<REAL>(sh),
                 UnitPixel, &ia);
  }
  backdrop_.reset(blurred);
}

void GlassNotifyWindow::EnsureNoiseTile() {
  if (noise_tile_) return;
  const int size = 48;
  auto* tile = new Bitmap(size, size, PixelFormat32bppARGB);
  Graphics g(tile);
  SolidBrush clear(Color(0, 0, 0, 0));
  g.FillRectangle(&clear, 0, 0, size, size);
  srand(20260921);
  for (int i = 0; i < 300; ++i) {
    SolidBrush dot(ToGdiColorA(kInk,
                               static_cast<BYTE>(kNoiseA / 2 +
                                                 rand() % kNoiseA)));
    g.FillEllipse(&dot, static_cast<REAL>(rand() % size),
                  static_cast<REAL>(rand() % size), 1.0f, 1.0f);
  }
  noise_tile_.reset(tile);
}

void GlassNotifyWindow::Show(const std::string& id,
                             const std::string& title,
                             const std::string& message,
                             const std::string& priority,
                             const std::string& confirm_text,
                             int duration_ms) {
  // 同 id 刷新 = 先移除旧卡再置顶插入
  for (size_t i = 0; i < cards_.size(); ++i) {
    if (cards_[i].id == id) {
      cards_.erase(cards_.begin() + i);
      break;
    }
  }

  Card card;
  card.id = id;
  card.title = StripUnrenderable(Utf8ToWide(title));
  card.message = StripUnrenderable(Utf8ToWide(message));
  card.confirm_text = StripUnrenderable(Utf8ToWide(confirm_text));
  card.duration_ms = duration_ms;
  card.start_tick = GetTickCount64();
  if (priority == "success") {
    card.icon_char = L'\uE73E';  // CheckMark
  } else if (priority == "warning" || priority == "high") {
    card.icon_char = L'\uE7BA';  // Warning
  } else if (priority == "error" || priority == "urgent") {
    card.icon_char = L'\uE783';  // Error
  } else {
    card.icon_char = L'\uE946';  // Info
  }

  cards_.insert(cards_.begin(), card);
  // 防御性上限：超出的最旧卡以 timeout 事件退出
  while (cards_.size() > static_cast<size_t>(kMaxCards)) {
    const std::string evicted = cards_.back().id;
    cards_.pop_back();
    if (event_callback_) event_callback_(evicted, "timeout");
  }

  const bool first_card = cards_.size() == 1;
  if (!CreateWindowIfNeeded()) return;
  dump_shots_ = 0;  // 新卡入栈重新允许调试出图
  ComputeLayout();

  if (first_card) {
    // 窗口未显示：先抓拍右上角目标位置的桌面做毛玻璃底
    const int total_h = cards_.back().rc_card.bottom + 2;
    const POINT origin = TopRightOrigin();
    CaptureBackdrop(origin.x, origin.y, kCardWidth, total_h);
  }
  // 窗口已在显示中：沿用旧抓拍底（模糊底下错位不可感），仅重排重绘

  SetTimer(window_handle_, kTickTimerId, 50, nullptr);
  Repaint();
  // ULW 只负责画内容，不负责显示窗口——必须显式 SHOWWINDOW。
  // 首卡定位到工作区右上角；后续卡片仅调高度（位置由每次 Repaint 的
  // UpdateLayeredWindow pptDst 维护）。
  const POINT origin = TopRightOrigin();
  SetWindowPos(window_handle_, HWND_TOPMOST, origin.x, origin.y, kCardWidth,
               cards_.back().rc_card.bottom + 2,
               SWP_NOACTIVATE | SWP_SHOWWINDOW);
}

void GlassNotifyWindow::Hide(const std::string& id) {
  for (size_t i = 0; i < cards_.size(); ++i) {
    if (cards_[i].id == id) {
      cards_.erase(cards_.begin() + i);
      break;
    }
  }
  if (cards_.empty()) {
    HideAll();
    return;
  }
  ComputeLayout();
  Repaint();
}

void GlassNotifyWindow::HideAll() {
  DestroyNativeWindow();
}

bool GlassNotifyWindow::IsVisible() const {
  return window_handle_ && !cards_.empty() && IsWindowVisible(window_handle_);
}

void GlassNotifyWindow::Repaint() {
  if (!window_handle_ || cards_.empty()) return;

  const int h = cards_.back().rc_card.bottom + 2;
  HDC screen = GetDC(nullptr);
  BITMAPINFO bmi = {};
  bmi.bmiHeader.biSize        = sizeof(BITMAPINFOHEADER);
  bmi.bmiHeader.biWidth       = kCardWidth;
  bmi.bmiHeader.biHeight      = -h;
  bmi.bmiHeader.biPlanes      = 1;
  bmi.bmiHeader.biBitCount    = 32;
  bmi.bmiHeader.biCompression = BI_RGB;
  void* bits = nullptr;
  HBITMAP dib =
      CreateDIBSection(nullptr, &bmi, DIB_RGB_COLORS, &bits, nullptr, 0);
  if (!dib) {
    ReleaseDC(nullptr, screen);
    return;
  }
  Bitmap surface(kCardWidth, h, kCardWidth * 4, PixelFormat32bppARGB,
                 static_cast<BYTE*>(bits));
  {
    Graphics g(&surface);
    g.SetSmoothingMode(SmoothingModeAntiAlias);
    g.SetPixelOffsetMode(PixelOffsetModeHighQuality);
    g.SetTextRenderingHint(TextRenderingHintAntiAliasGridFit);
    g.Clear(Color(0, 0, 0, 0));  // 卡片间隙全透明（ULW 命中穿透）
    PaintStack(g);
  }

  // 调试出图：GLASS_NOTIFY_DUMP=1 时把渲染结果存 PNG（真机验收证据）。
  // 必须在 DeleteObject(dib) 之前——surface 是 DIB 内存的视图，释放后即悬垂
  static const bool dump = [] {
    wchar_t buf[8] = {};
    const DWORD n = GetEnvironmentVariableW(L"GLASS_NOTIFY_DUMP", buf, 8);
    return n > 0 && n < 8 && wcscmp(buf, L"1") == 0;
  }();
  if (dump && dump_shots_ < 2) {  // 每次 Show 只出前 2 帧（进度条 20fps 重绘会刷屏）
    dump_shots_++;
    static int seq = 0;
    wchar_t temp[MAX_PATH];
    if (GetTempPathW(MAX_PATH, temp)) {
      wchar_t path[MAX_PATH];
      swprintf_s(path, L"%sglass_native_dump_%d.png", temp, seq++);
      CLSID png_clsid;
      CLSIDFromString(L"{557CF406-1A04-11D3-9A73-0000F81EF32E}", &png_clsid);
      surface.Save(path, &png_clsid, nullptr);
    }
  }

  HDC mem = CreateCompatibleDC(screen);
  HBITMAP old = static_cast<HBITMAP>(SelectObject(mem, dib));
  POINT src = {0, 0};
  POINT dst = TopRightOrigin();
  SIZE size = {kCardWidth, h};
  BLENDFUNCTION blend = {AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
  UpdateLayeredWindow(window_handle_, screen, &dst, &size, mem, &src, 0,
                      &blend, ULW_ALPHA);
  SelectObject(mem, old);
  DeleteDC(mem);
  DeleteObject(dib);
  ReleaseDC(nullptr, screen);
}

void GlassNotifyWindow::PaintStack(Graphics& g) {
  EnsureNoiseTile();
  // 先画后卡（下标大），前卡最后画盖在重叠处之上；间隙保持全透明
  for (int i = static_cast<int>(cards_.size()) - 1; i >= 0; --i) {
    PaintCard(g, cards_[i], i);
  }
}

void GlassNotifyWindow::PaintCard(Graphics& g, const Card& card, int index) {
  const float fade = std::max(0.35f, 1.0f - kDepthFade * index);
  const float scale = 1.0f - kDepthScale * index;
  const int h = card.card_height;

  GraphicsState state = g.Save();
  // 景深缩放绕卡片中心。注意 GDI+ 变换默认 MatrixOrderPrepend（前乘），
  // 三连 prepend 等价于 T(-c)·S·T(c)——后卡会被画到左上角、整张压在前卡
  // 底下（表现为"后卡不显示"）；必须 Append 才能得到 T(c)·S·T(-c)。
  const float cx = (card.rc_card.left + card.rc_card.right) / 2.0f;
  const float cy = (card.rc_card.top + card.rc_card.bottom) / 2.0f;
  g.TranslateTransform(cx, cy, MatrixOrderAppend);
  g.ScaleTransform(scale, scale, MatrixOrderAppend);
  g.TranslateTransform(-cx, -cy, MatrixOrderAppend);

  // ── 玻璃卡底：抓拍桌面区域 + 深色玻璃膜（裁到圆角路径） ──
  const RectF rc(0.0f, 0.0f, static_cast<REAL>(kCardWidth),
                 static_cast<REAL>(h));
  GraphicsPath card_path;
  AppendRoundRect(&card_path, rc, kCardRadius);
  if (backdrop_) {
    g.SetClip(&card_path);
    SolidBrush base(ToGdiColorA(kCardFill,
                                static_cast<BYTE>(kCardFillA *
                                    (0.75f + 0.25f * index))));
    g.FillRectangle(&base, rc);
    // 取窗口坐标里卡片对应的背景区域（缩放错位在模糊底上不可感）
    g.DrawImage(backdrop_.get(), rc,
                static_cast<REAL>(card.rc_card.left),
                static_cast<REAL>(card.rc_card.top), rc.Width, rc.Height,
                UnitPixel, nullptr);
    g.ResetClip();
  }
  SolidBrush scrim(ToGdiColorA(kCardFill,
                               static_cast<BYTE>(kCardFillA * fade)));
  g.FillPath(&scrim, &card_path);

  // ── 噪点：去塑料感 ──
  if (noise_tile_) {
    TextureBrush noise(noise_tile_.get(), WrapModeTile);
    g.FillPath(&noise, &card_path);
  }

  // ── 边框 + 顶部 1px 高光线 ──
  {
    GraphicsPath rim;
    AppendRoundRect(&rim, RectF(rc.X + 0.5f, rc.Y + 0.5f, rc.Width - 1.0f,
                                rc.Height - 1.0f),
                    kCardRadius - 0.5f);
    Pen rim_pen(ToGdiColorA(kInk, static_cast<BYTE>(kCardLineA * fade)));
    g.DrawPath(&rim_pen, &rim);

    const RectF sheen(rc.X + kCardRadius, rc.Y + 0.5f,
                      rc.Width - kCardRadius * 2.0f, 1.0f);
    LinearGradientBrush sheen_brush(sheen, ToGdiColorA(kInk, 0),
                                    ToGdiColorA(kInk,
                                                static_cast<BYTE>(kSheenA *
                                                                  fade)),
                                    0.0f);
    g.FillRectangle(&sheen_brush, sheen);
  }

  // ── 图标徽章 ──
  {
    const RectF chip(static_cast<REAL>(kPadL), static_cast<REAL>(kPadT),
                     static_cast<REAL>(kChipSize),
                     static_cast<REAL>(kChipSize));
    GraphicsPath chip_path;
    AppendRoundRect(&chip_path, chip, 10);
    SolidBrush chip_brush(ToGdiColorA(kChipFill,
                                      static_cast<BYTE>(kChipFillA * fade)));
    g.FillPath(&chip_brush, &chip_path);
    Pen chip_pen(ToGdiColorA(kInk,
                             static_cast<BYTE>(kChipLineA * fade)));
    g.DrawPath(&chip_pen, &chip_path);
    // 徽章字形（按 priority 选择的 Segoe 图标）
    HDC hdc_icon = GetDC(nullptr);
    DrawIconChar(hdc_icon, g, chip, card.icon_char,
                 static_cast<BYTE>(235 * fade));
    ReleaseDC(nullptr, hdc_icon);
  }

  // ── 关闭 X ──
  {
    const float x = (card.rc_close.left + card.rc_close.right) / 2.0f;
    const float y = (card.rc_close.top + card.rc_close.bottom) / 2.0f;
    const float s = 4.0f;
    Pen pen(ToGdiColorA(kInk, static_cast<BYTE>(kCloseA * fade)), 1.6f);
    pen.SetStartCap(LineCapRound);
    pen.SetEndCap(LineCapRound);
    g.DrawLine(&pen, x - s, y - s, x + s, y + s);
    g.DrawLine(&pen, x + s, y - s, x - s, y + s);
  }
  // ── 文字 ──
  HDC hdc = GetDC(nullptr);
  auto f_title = MakeGpFont(hdc, 15, FW_SEMIBOLD);
  auto f_body  = MakeGpFont(hdc, 13, FW_NORMAL);
  auto f_pill  = MakeGpFont(hdc, 13, FW_SEMIBOLD);

  const REAL text_x = static_cast<REAL>(kPadL + kChipSize + 10);
  DrawTextGp(g, f_title.get(), card.title,
             RectF(text_x, static_cast<REAL>(kPadT + 4),
                   static_cast<REAL>(kCardWidth - kPadR - 26 - text_x),
                   static_cast<REAL>(kTitleH)),
             kInk, static_cast<BYTE>(255 * fade));

  if (card.msg_lines > 0) {
    DrawTextGp(g, f_body.get(), card.message,
               RectF(static_cast<REAL>(kPadL),
                     static_cast<REAL>(kPadT + kChipSize + kMsgGap),
                     static_cast<REAL>(kCardWidth - kPadL - kPadR),
                     static_cast<REAL>(card.msg_lines * kLineH + 3)),
               kInkSoft, static_cast<BYTE>(kInkSoftA * fade),
               StringAlignmentNear, StringAlignmentNear, true);
  }

  // ── 确认胶囊（实心白） ──
  if (!card.confirm_text.empty()) {
    const RectF prc(static_cast<REAL>(card.rc_confirm.left),
                    static_cast<REAL>(card.rc_confirm.top),
                    static_cast<REAL>(card.rc_confirm.right -
                                      card.rc_confirm.left),
                    static_cast<REAL>(kPillH));
    SolidBrush pill_brush(ToGdiColor(kPillFill));
    GraphicsPath pill_path;
    AppendRoundRect(&pill_path, prc, static_cast<REAL>(kPillH / 2));
    g.FillPath(&pill_brush, &pill_path);
    DrawTextGp(g, f_pill.get(), card.confirm_text, prc, kPillText, 255,
               StringAlignmentCenter, StringAlignmentCenter);
  }
  ReleaseDC(nullptr, hdc);
  // ── 倒计时进度线：底部居中收缩的渐变细线 ──
  if (card.duration_ms > 0) {
    const double remain = std::clamp(
        1.0 - static_cast<double>(CardElapsedMs(card, GetTickCount64())) /
                  static_cast<double>(card.duration_ms),
        0.0, 1.0);
    if (remain > 0.001) {
      const float full = static_cast<float>(kCardWidth - kPadL - kPadR);
      const float w_now = static_cast<float>(full * remain);
      const RectF track((full - w_now) / 2.0f,
                        static_cast<REAL>(h - kProgressH - 1), w_now,
                        static_cast<REAL>(kProgressH));
      LinearGradientBrush track_brush(track, ToGdiColorA(kInk, 0),
                                      ToGdiColorA(kInk,
                                          static_cast<BYTE>(kProgressA *
                                                            fade)),
                                      0.0f);
      g.FillRectangle(&track_brush, track);
    }
  }
  g.Restore(state);
}

int GlassNotifyWindow::HitTestCard(const POINT& pt) const {
  // 下标小 = 更靠前，重叠处前卡优先
  for (int i = 0; i < static_cast<int>(cards_.size()); ++i) {
    if (PtIn(pt, cards_[i].rc_card)) return i;
  }
  return -1;
}

int GlassNotifyWindow::HitTestPart(const POINT& pt, int* part) const {
  *part = 0;
  for (int i = 0; i < static_cast<int>(cards_.size()); ++i) {
    if (!PtIn(pt, cards_[i].rc_card)) continue;
    // 点逆变换到卡片局部坐标（未缩放）再查热区
    const float scale = 1.0f - kDepthScale * static_cast<float>(i);
    const float cx = (cards_[i].rc_card.left + cards_[i].rc_card.right) / 2.0f;
    const float cy = (cards_[i].rc_card.top + cards_[i].rc_card.bottom) / 2.0f;
    const POINT local = {
        static_cast<LONG>((pt.x - cx) / scale + kCardWidth / 2.0f),
        static_cast<LONG>((pt.y - cy) / scale +
                          cards_[i].card_height / 2.0f)};
    if (PtIn(local, cards_[i].rc_close)) {
      *part = 1;
    } else if (PtIn(local, cards_[i].rc_confirm)) {
      *part = 2;
    }
    return i;  // 卡面其余区域 part=0（悬停暂停、点击不动作）
  }
  return -1;
}

LRESULT CALLBACK GlassNotifyWindow::WndProc(HWND hwnd, UINT message,
                                            WPARAM wparam,
                                            LPARAM lparam) noexcept {
  if (message == WM_NCCREATE) {
    auto* cs = reinterpret_cast<CREATESTRUCT*>(lparam);
    SetWindowLongPtr(hwnd, GWLP_USERDATA,
                     reinterpret_cast<LONG_PTR>(cs->lpCreateParams));
  } else {
    auto* that = reinterpret_cast<GlassNotifyWindow*>(
        GetWindowLongPtr(hwnd, GWLP_USERDATA));
    if (that) return that->HandleMessage(hwnd, message, wparam, lparam);
  }
  return DefWindowProc(hwnd, message, wparam, lparam);
}

LRESULT GlassNotifyWindow::HandleMessage(HWND hwnd, UINT message,
                                         WPARAM wparam,
                                         LPARAM lparam) noexcept {
  switch (message) {
    case WM_TIMER:
      if (wparam == kTickTimerId) {
        const ULONGLONG now = GetTickCount64();
        std::vector<std::string> expired;
        for (auto it = cards_.begin(); it != cards_.end();) {
          if (it->duration_ms > 0 &&
              CardElapsedMs(*it, now) >= it->duration_ms) {
            expired.push_back(it->id);
            it = cards_.erase(it);
          } else {
            ++it;
          }
        }
        for (const std::string& id : expired) {
          if (event_callback_) event_callback_(id, "timeout");
        }
        if (cards_.empty()) {
          DestroyNativeWindow();
        } else {
          ComputeLayout();
          Repaint();
        }
        return 0;
      }
      break;

    case WM_MOUSEMOVE: {
      POINT pt = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
      // 卡面任意位置悬停即暂停倒计时（与演示页 toast hover 行为一致）
      const int idx = HitTestCard(pt);
      const ULONGLONG now = GetTickCount64();
      if (idx != hover_card_) {
        if (hover_card_ >= 0 && hover_card_ < static_cast<int>(cards_.size())) {
          ResumeCard(&cards_[hover_card_], now);
        }
        hover_card_ = idx;
        if (idx >= 0) {
          PauseCard(&cards_[idx], now);
        }
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

    case WM_MOUSELEAVE: {
      mouse_tracking_ = false;
      const ULONGLONG now = GetTickCount64();
      if (hover_card_ >= 0 && hover_card_ < static_cast<int>(cards_.size())) {
        ResumeCard(&cards_[hover_card_], now);
      }
      hover_card_ = -1;
      Repaint();
      return 0;
    }

    case WM_SETCURSOR:
      if (LOWORD(lparam) == HTCLIENT) {
        POINT pt;
        GetCursorPos(&pt);
        ScreenToClient(hwnd, &pt);
        int part = 0;
        HitTestPart(pt, &part);
        SetCursor(LoadCursor(nullptr, part > 0 ? IDC_HAND : IDC_ARROW));
        return TRUE;
      }
      break;

    case WM_LBUTTONUP: {
      POINT pt = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
      int part = 0;
      const int idx = HitTestPart(pt, &part);
      if (idx < 0 || part == 0) break;  // 卡面空白处点击不动作
      const std::string id = cards_[idx].id;
      const std::string event = (part == 2) ? "confirm" : "dismiss";
      cards_.erase(cards_.begin() + idx);
      hover_card_ = -1;
      if (event_callback_) event_callback_(id, event);
      if (cards_.empty()) {
        DestroyNativeWindow();
      } else {
        ComputeLayout();
        Repaint();
      }
      return 0;
    }

    case WM_DESTROY:
      KillTimer(hwnd, kTickTimerId);
      SetWindowLongPtr(hwnd, GWLP_USERDATA, 0);
      window_handle_ = nullptr;
      return 0;
  }
  return DefWindowProc(hwnd, message, wparam, lparam);
}
