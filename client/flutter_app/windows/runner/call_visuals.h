#ifndef RUNNER_CALL_VISUALS_H_
#define RUNNER_CALL_VISUALS_H_

// 电话弹窗家族共享视觉层（真玻璃深卡 · 纯平圆盘 · 瓷白/曜石按钮）。
//
// 三个 Win32 悬浮窗（incoming / outgoing / connected）共用同一套绘制原语，
// 保证同一设计语言。全部头文件内联实现，不新增 CMake 源文件。
//
// 玻璃底做法与 DesktopNotificationWindow 同源：系统 Acrylic 在部分 Win11
// 失效不可靠，真正的毛玻璃是 Show 前抓取落点桌面像素 + 1/8 降采样双三次
// 放大 = 大半径柔焦，再叠薄渐变 scrim 与白色高光描边。窗口无子控件
// （全部自绘 + 手动命中），玻璃表面连续不被实色按钮打补丁。
//
// 绘制纪律：
//   - 所有形状（盘、胶囊、波形、描边、光环）一律 GDI+ 抗锯齿，禁止
//     GDI Region/FillRgn 硬边（锯齿感 = 廉价感）。
//   - 盘面一律纯平色（参考稿明确无光源：不渐变、不偏心高光）。
//   - 文字走 GDI ClearType（中文渲染质量优于 GDI+）。
//
// 尺寸对齐微信语音通话弹窗：窗宽 300，头像盘 76，主按钮 54。

#include <windows.h>
#include <gdiplus.h>

#include <algorithm>
#include <cmath>
#include <string>

#pragma comment(lib, "msimg32.lib")

namespace call_vis {

// ── 卡片玻璃 ──
constexpr COLORREF kGlassScrimTop = RGB(0x1C, 0x1C, 0x21);     // 顶部压暗色
constexpr BYTE kGlassScrimTopA = 150;
constexpr COLORREF kGlassScrimBottom = RGB(0x10, 0x10, 0x13);  // 底部压暗色
constexpr BYTE kGlassScrimBottomA = 118;
constexpr COLORREF kRimColor = RGB(0xFF, 0xFF, 0xFF);  // 玻璃高光描边
constexpr BYTE kRimAlpha = 66;
constexpr int kRimRadius = 7;  // 跟随系统圆角（DWMWCP_ROUND ≈8px）
// 自适应压暗目标：模糊底平均亮度高于此值时按比例压暗（白字可读底线）
constexpr float kGlassTargetLuma = 90.0f;
constexpr float kGlassDimMin = 0.30f;

// ── 文字 ──
constexpr COLORREF kTitleText = RGB(0xB4, 0xB4, 0xB8);
constexpr COLORREF kNameColor = RGB(0xFA, 0xFA, 0xFA);
constexpr COLORREF kSubColor = RGB(0xA8, 0xA8, 0xAC);
constexpr COLORREF kStatusColor = RGB(0x94, 0x94, 0x98);

// ── 控件（纯平色，无光源） ──
constexpr COLORREF kDiscLight = RGB(0xF2, 0xF2, 0xF4);      // 瓷白盘
constexpr COLORREF kDiscLightHover = RGB(0xE4, 0xE4, 0xE7);  // 瓷白盘悬停
constexpr COLORREF kDiscDark = RGB(0x33, 0x33, 0x38);        // 曜石盘
constexpr COLORREF kDiscDarkHover = RGB(0x40, 0x40, 0x46);   // 曜石盘悬停
constexpr COLORREF kGlyphDark = RGB(0x20, 0x20, 0x23);       // 白盘上深图标
constexpr COLORREF kGlyphWhite = RGB(0xFF, 0xFF, 0xFF);
constexpr COLORREF kPillBg = RGB(0x30, 0x30, 0x35);          // 胶囊钮底
constexpr COLORREF kPillBgHover = RGB(0x3C, 0x3C, 0x41);     // 胶囊钮悬停
constexpr COLORREF kAvatarBg = RGB(0x9E, 0x9E, 0xA2);        // 头像盘
constexpr COLORREF kAvatarGlyph = RGB(0x2C, 0x2C, 0x2F);     // 头像字符
constexpr BYTE kHaloBaseA = 46;  // 呼吸光环基础透明度

constexpr wchar_t kGlyphPhone = L'\uE717';
constexpr wchar_t kGlyphMic = L'\uE720';
constexpr wchar_t kGlyphVolume = L'\uE767';
constexpr wchar_t kGlyphMinimize = L'\uE921';  // ChromeMinimize
constexpr wchar_t kGlyphClose = L'\uE8BB';     // ChromeClose

inline COLORREF MixColor(COLORREF a, COLORREF b, double t) {
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  return RGB(
      static_cast<int>(GetRValue(a) + (GetRValue(b) - GetRValue(a)) * t),
      static_cast<int>(GetGValue(a) + (GetGValue(b) - GetGValue(a)) * t),
      static_cast<int>(GetBValue(a) + (GetBValue(b) - GetBValue(a)) * t));
}

// GDI+ 颜色（通道用位运算取，Get*Value 宏对常量折叠会触发 C4310）
inline Gdiplus::Color GpColor(COLORREF c, BYTE a = 255) {
  return Gdiplus::Color(a, (c >> 0) & 0xFF, (c >> 8) & 0xFF,
                        (c >> 16) & 0xFF);
}

inline HFONT MakeFont(int size, int weight, const wchar_t* family) {
  return CreateFontW(-size, 0, 0, 0, weight, FALSE, FALSE, FALSE,
                     DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                     CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_SWISS, family);
}

// 带 AA 设置的局部 GDI+ 画布（Graphics 拷贝构造私有，只能作成员持有）
struct Gfx {
  Gdiplus::Graphics g;
  explicit Gfx(HDC hdc) : g(hdc) {
    g.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
    g.SetPixelOffsetMode(Gdiplus::PixelOffsetModeHighQuality);
  }
};

// 纯平抗锯齿圆盘
inline void FillDisc(HDC hdc, int cx, int cy, int r, COLORREF fill) {
  Gfx gfx{hdc};
  Gdiplus::SolidBrush brush(GpColor(fill));
  gfx.g.FillEllipse(&brush, static_cast<Gdiplus::REAL>(cx - r),
                    static_cast<Gdiplus::REAL>(cy - r),
                    static_cast<Gdiplus::REAL>(r * 2),
                    static_cast<Gdiplus::REAL>(r * 2));
}

// 半透明抗锯齿圆盘（呼吸光环用）
inline void FillDiscAlpha(HDC hdc, int cx, int cy, int r, COLORREF fill,
                          BYTE alpha) {
  Gfx gfx{hdc};
  Gdiplus::SolidBrush brush(GpColor(fill, alpha));
  gfx.g.FillEllipse(&brush, static_cast<Gdiplus::REAL>(cx - r),
                    static_cast<Gdiplus::REAL>(cy - r),
                    static_cast<Gdiplus::REAL>(r * 2),
                    static_cast<Gdiplus::REAL>(r * 2));
}

// ── 玻璃底（GDI+）──

inline void EnsureGdiplus() {
  static bool inited = []() {
    ULONG_PTR token = 0;
    Gdiplus::GdiplusStartupInput input;
    return Gdiplus::GdiplusStartup(&token, &input, nullptr) == Gdiplus::Ok;
  }();
}

// 模糊底平均亮度（BGRA DIB）
inline float MeanLuma(Gdiplus::Bitmap* img) {
  if (!img) return 80.0f;
  Gdiplus::BitmapData data;
  const Gdiplus::Rect rect(0, 0, img->GetWidth(), img->GetHeight());
  if (img->LockBits(&rect, Gdiplus::ImageLockModeRead, PixelFormat32bppARGB,
                    &data) != Gdiplus::Ok) {
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

// 抓取 (x,y) 起的 w×h 桌面像素，1/8 降采样 + 双三次放大 = 大半径柔焦。
// 在窗口可见前调用，画面干净。失败时 *out 为空，调用方退回深色实底。
inline void CaptureGlassBackdrop(int x, int y, int w, int h,
                                 Gdiplus::Bitmap** out, float* out_dim) {
  *out = nullptr;
  *out_dim = 1.0f;
  EnsureGdiplus();

  HDC screen = GetDC(nullptr);
  BITMAPINFO bmi = {};
  bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bmi.bmiHeader.biWidth = w;
  bmi.bmiHeader.biHeight = -h;  // top-down
  bmi.bmiHeader.biPlanes = 1;
  bmi.bmiHeader.biBitCount = 32;
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
  BitBlt(mem, 0, 0, w, h, screen, x, y, SRCCOPY);
  SelectObject(mem, old);
  DeleteDC(mem);
  ReleaseDC(nullptr, screen);

  // raw 只是包裹 DIB 缓冲的视图；降采样完成前不能释放 dib
  Gdiplus::Bitmap raw(w, h, w * 4, PixelFormat32bppARGB,
                      static_cast<BYTE*>(bits));

  const int sw = std::max(1, w / 8);
  const int sh = std::max(1, h / 8);
  Gdiplus::Bitmap downscaled(sw, sh, PixelFormat32bppARGB);
  {
    Gdiplus::Graphics gs(&downscaled);
    gs.SetInterpolationMode(Gdiplus::InterpolationModeHighQualityBicubic);
    gs.SetPixelOffsetMode(Gdiplus::PixelOffsetModeHighQuality);
    Gdiplus::ImageAttributes ia;
    ia.SetWrapMode(Gdiplus::WrapModeTileFlipXY);  // 边缘镜像采样，避免暗边
    gs.DrawImage(&raw, Gdiplus::RectF(0.0f, 0.0f, static_cast<Gdiplus::REAL>(sw),
                                      static_cast<Gdiplus::REAL>(sh)),
                 0.0f, 0.0f, static_cast<Gdiplus::REAL>(w),
                 static_cast<Gdiplus::REAL>(h), Gdiplus::UnitPixel, &ia);
  }
  DeleteObject(dib);  // 像素已复制进 downscaled

  // 自适应压暗：暗桌面不压（全通透），亮桌面压成深色贴膜（模糊纹理仍在）
  const float dim = std::clamp(kGlassTargetLuma / std::max(MeanLuma(&downscaled),
                                                           1.0f),
                               kGlassDimMin, 1.0f);

  auto* blurred = new Gdiplus::Bitmap(w, h, PixelFormat32bppARGB);
  {
    Gdiplus::Graphics gb(blurred);
    gb.SetInterpolationMode(Gdiplus::InterpolationModeHighQualityBicubic);
    gb.SetPixelOffsetMode(Gdiplus::PixelOffsetModeHighQuality);
    Gdiplus::ImageAttributes ia;
    ia.SetWrapMode(Gdiplus::WrapModeTileFlipXY);
    gb.DrawImage(&downscaled,
                 Gdiplus::RectF(0.0f, 0.0f, static_cast<Gdiplus::REAL>(w),
                                static_cast<Gdiplus::REAL>(h)),
                 0.0f, 0.0f, static_cast<Gdiplus::REAL>(sw),
                 static_cast<Gdiplus::REAL>(sh), Gdiplus::UnitPixel, &ia);
  }
  *out = blurred;
  *out_dim = dim;
}

// 玻璃底三层：模糊桌面（自适应压暗）→ 薄渐变 scrim → 白色高光描边。
// backdrop 为空（抓取失败）时退回深色实底，界面始终可用。
inline void DrawGlassBase(HDC hdc, Gdiplus::Bitmap* backdrop, float dim,
                          int w, int h) {
  Gfx gfx{hdc};
  Gdiplus::Graphics& g = gfx.g;

  if (backdrop) {
    if (dim < 0.999f) {
      Gdiplus::ColorMatrix dim_matrix = {{
          {dim, 0.0f, 0.0f, 0.0f, 0.0f},
          {0.0f, dim, 0.0f, 0.0f, 0.0f},
          {0.0f, 0.0f, dim, 0.0f, 0.0f},
          {0.0f, 0.0f, 0.0f, 1.0f, 0.0f},
          {0.0f, 0.0f, 0.0f, 0.0f, 1.0f},
      }};
      Gdiplus::ImageAttributes ia;
      ia.SetColorMatrix(&dim_matrix);
      g.DrawImage(backdrop, Gdiplus::RectF(0.0f, 0.0f, static_cast<Gdiplus::REAL>(w),
                                           static_cast<Gdiplus::REAL>(h)),
                  0.0f, 0.0f, static_cast<Gdiplus::REAL>(w),
                  static_cast<Gdiplus::REAL>(h), Gdiplus::UnitPixel, &ia);
    } else {
      g.DrawImage(backdrop, 0.0f, 0.0f, static_cast<Gdiplus::REAL>(w),
                  static_cast<Gdiplus::REAL>(h));
    }
  } else {
    Gdiplus::SolidBrush fallback(GpColor(RGB(0x1B, 0x1B, 0x1F)));
    g.FillRectangle(&fallback, 0, 0, w, h);
  }

  // 玻璃压暗层：极薄顶部→底部渐变，托住文字对比度
  const Gdiplus::RectF full(0, 0, static_cast<Gdiplus::REAL>(w),
                            static_cast<Gdiplus::REAL>(h));
  Gdiplus::LinearGradientBrush scrim(
      full,
      Gdiplus::Color(kGlassScrimTopA, (kGlassScrimTop >> 0) & 0xFF,
                     (kGlassScrimTop >> 8) & 0xFF, (kGlassScrimTop >> 16) & 0xFF),
      Gdiplus::Color(kGlassScrimBottomA, (kGlassScrimBottom >> 0) & 0xFF,
                     (kGlassScrimBottom >> 8) & 0xFF,
                     (kGlassScrimBottom >> 16) & 0xFF),
      90.0f);
  g.FillRectangle(&scrim, full);

  // 玻璃高光描边（内缩 1px，跟随系统圆角），增强「玻璃片」轮廓
  Gdiplus::GraphicsPath rim;
  rim.AddArc(1.0f, 1.0f, kRimRadius * 2.0f, kRimRadius * 2.0f, 180.0f, 90.0f);
  rim.AddArc(static_cast<Gdiplus::REAL>(w) - 1.0f - kRimRadius * 2.0f, 1.0f,
             kRimRadius * 2.0f, kRimRadius * 2.0f, 270.0f, 90.0f);
  rim.AddArc(static_cast<Gdiplus::REAL>(w) - 1.0f - kRimRadius * 2.0f,
             static_cast<Gdiplus::REAL>(h) - 1.0f - kRimRadius * 2.0f,
             kRimRadius * 2.0f, kRimRadius * 2.0f, 0.0f, 90.0f);
  rim.AddArc(1.0f, static_cast<Gdiplus::REAL>(h) - 1.0f - kRimRadius * 2.0f,
             kRimRadius * 2.0f, kRimRadius * 2.0f, 90.0f, 90.0f);
  rim.CloseFigure();
  Gdiplus::Pen rim_pen(Gdiplus::Color(kRimAlpha, 255, 255, 255));
  g.DrawPath(&rim_pen, &rim);
}

// Win11 系统圆角（抗锯齿，玻璃自动跟随裁剪）
inline void ApplyRoundedCorners(HWND hwnd) {
  constexpr int kDwmwaWindowCornerPreference = 33;
  constexpr DWORD kDwmwcpRound = 2;
  DWORD pref = kDwmwcpRound;
  DwmSetWindowAttribute(hwnd, kDwmwaWindowCornerPreference, &pref,
                        sizeof(pref));
}

// ── 标题栏 ──

struct TitleRects {
  RECT minimize;
  RECT close;
};

inline TitleRects TitleRectsFor(int width) {
  return {{width - 74, 7, width - 48, 33}, {width - 48, 7, width - 20, 33}};
}

inline bool PointInRect(const RECT& rc, const POINT& pt) {
  return pt.x >= rc.left && pt.x < rc.right && pt.y >= rc.top &&
         pt.y < rc.bottom;
}

// 阶梯信号条（4 根，底对齐，AA）
inline void DrawSignalIcon(HDC hdc, int x_left, int baseline_y,
                           COLORREF color) {
  Gfx gfx{hdc};
  Gdiplus::SolidBrush brush(GpColor(color));
  constexpr int kHeights[4] = {4, 7, 10, 13};
  int x = x_left;
  for (int h : kHeights) {
    gfx.g.FillRectangle(&brush, static_cast<Gdiplus::REAL>(x),
                        static_cast<Gdiplus::REAL>(baseline_y - h), 3.0f,
                        static_cast<Gdiplus::REAL>(h));
    x += 5;
  }
}

inline void DrawGlyph(HDC hdc, const RECT& rc, wchar_t glyph, COLORREF color,
                      int font_size, const wchar_t* font_family) {
  HFONT f = MakeFont(font_size, FW_NORMAL, font_family);
  HFONT old = static_cast<HFONT>(SelectObject(hdc, f));
  SetBkMode(hdc, TRANSPARENT);
  SetTextColor(hdc, color);
  RECT r = rc;
  DrawTextW(hdc, &glyph, 1, &r,
            DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
  SelectObject(hdc, old);
  DeleteObject(f);
}

// 挂断样式图标：电话字形 + 斜线（斜线走 GDI+ AA）
inline void DrawPhoneOffGlyph(HDC hdc, const RECT& rc, COLORREF color,
                              int font_size) {
  DrawGlyph(hdc, rc, kGlyphPhone, color, font_size, L"Segoe MDL2 Assets");
  Gfx gfx{hdc};
  Gdiplus::Pen pen(GpColor(color), 1.6f);
  const Gdiplus::REAL cx = static_cast<Gdiplus::REAL>((rc.left + rc.right) / 2);
  const Gdiplus::REAL cy = static_cast<Gdiplus::REAL>((rc.top + rc.bottom) / 2);
  const Gdiplus::REAL off = static_cast<Gdiplus::REAL>(font_size) / 3.0f;
  gfx.g.DrawLine(&pen, cx + off, cy + off, cx - off, cy - off);
}

inline void PaintTitleBar(HDC hdc, int width, bool hover_min,
                          bool hover_close) {
  DrawSignalIcon(hdc, 20, 26, kTitleText);

  SetBkMode(hdc, TRANSPARENT);
  HFONT f = MakeFont(12, FW_NORMAL, L"Microsoft YaHei UI");
  HFONT old = static_cast<HFONT>(SelectObject(hdc, f));
  SetTextColor(hdc, kTitleText);
  RECT title_rc = {42, 7, width - 86, 33};
  DrawTextW(hdc, L"Nextbot 通话", -1, &title_rc,
            DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
  SelectObject(hdc, old);
  DeleteObject(f);

  const TitleRects tr = TitleRectsFor(width);
  DrawGlyph(hdc, tr.minimize, kGlyphMinimize,
            hover_min ? kNameColor : kSubColor, 10, L"Segoe MDL2 Assets");
  DrawGlyph(hdc, tr.close, kGlyphClose, hover_close ? kNameColor : kSubColor,
            10, L"Segoe MDL2 Assets");
}

// ── 内容元素 ──

// 小波形：5 根圆角竖条（phase < 0 为静态），AA
inline void DrawWaveBars(HDC hdc, int cx, int cy, int max_h, COLORREF color,
                         int phase) {
  Gfx gfx{hdc};
  Gdiplus::Graphics& g = gfx.g;
  Gdiplus::SolidBrush brush(GpColor(color));
  constexpr int kBarHeights[5] = {45, 100, 62, 100, 45};
  constexpr int kBarW = 3;
  constexpr int kGap = 3;
  const int total_w = 5 * kBarW + 4 * kGap;
  Gdiplus::REAL x = static_cast<Gdiplus::REAL>(cx - total_w / 2);
  for (int i = 0; i < 5; ++i) {
    double k = kBarHeights[i] / 100.0;
    if (phase >= 0) {
      k *= 0.82 + 0.18 * std::sin((phase + i * 6) * 6.28318 / 30.0);
    }
    const Gdiplus::REAL h =
        static_cast<Gdiplus::REAL>((std::max)(3, static_cast<int>(max_h * k)));
    const Gdiplus::REAL y = static_cast<Gdiplus::REAL>(cy) - h / 2.0f;
    Gdiplus::GraphicsPath bar;
    bar.AddArc(x, y, static_cast<Gdiplus::REAL>(kBarW),
               static_cast<Gdiplus::REAL>(kBarW), 90.0f, 180.0f);
    bar.AddArc(x, y + h - kBarW, static_cast<Gdiplus::REAL>(kBarW),
               static_cast<Gdiplus::REAL>(kBarW), 270.0f, 180.0f);
    bar.CloseFigure();
    g.FillPath(&brush, &bar);
    x += kBarW + kGap;
  }
}

// 纯平圆盘头像 + 首字符；无字符时退化为波形
inline void PaintAvatarDisc(HDC hdc, int cx, int cy, int r,
                            const std::wstring& initial) {
  FillDisc(hdc, cx, cy, r, kAvatarBg);
  if (!initial.empty()) {
    RECT rc = {cx - r, cy - r, cx + r, cy + r};
    DrawGlyph(hdc, rc, initial[0], kAvatarGlyph,
              static_cast<int>(r * 0.62), L"Microsoft YaHei UI");
    return;
  }
  DrawWaveBars(hdc, cx, cy, static_cast<int>(r * 0.42), kGlyphWhite, -1);
}

// 一行居中文本（返回实际文本宽度）
inline int DrawCenteredText(HDC hdc, const RECT& rc, const std::wstring& text,
                            COLORREF color, int size, int weight,
                            const wchar_t* family) {
  HFONT f = MakeFont(size, weight, family);
  HFONT old = static_cast<HFONT>(SelectObject(hdc, f));
  SetBkMode(hdc, TRANSPARENT);
  SetTextColor(hdc, color);
  RECT r = rc;
  DrawTextW(hdc, text.c_str(), -1, &r,
            DT_CENTER | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
  SIZE sz = {0, 0};
  GetTextExtentPoint32W(hdc, text.c_str(),
                        static_cast<int>(text.size()), &sz);
  SelectObject(hdc, old);
  DeleteObject(f);
  return sz.cx;
}

// 分隔线（横向，两端留白，半透明淡线）
inline void DrawDivider(HDC hdc, int width, int y) {
  Gfx gfx{hdc};
  Gdiplus::Pen pen(GpColor(RGB(0xFF, 0xFF, 0xFF), 26), 1.0f);
  gfx.g.DrawLine(&pen, static_cast<Gdiplus::REAL>(28),
                 static_cast<Gdiplus::REAL>(y) + 0.5f,
                 static_cast<Gdiplus::REAL>(width - 28),
                 static_cast<Gdiplus::REAL>(y) + 0.5f);
}

// 胶囊挂断钮（图标 + 「挂断」），AA 圆角
inline void DrawPillButton(HDC hdc, const RECT& rc, bool hovered) {
  Gfx gfx{hdc};
  Gdiplus::SolidBrush brush(GpColor(hovered ? kPillBgHover : kPillBg));
  const Gdiplus::REAL rx = static_cast<Gdiplus::REAL>(rc.left);
  const Gdiplus::REAL ry = static_cast<Gdiplus::REAL>(rc.top);
  const Gdiplus::REAL rw = static_cast<Gdiplus::REAL>(rc.right - rc.left);
  const Gdiplus::REAL rh = static_cast<Gdiplus::REAL>(rc.bottom - rc.top);
  Gdiplus::GraphicsPath path;
  path.AddArc(rx, ry, rh, rh, 90.0f, 180.0f);
  path.AddArc(rx + rw - rh, ry, rh, rh, 270.0f, 180.0f);
  path.CloseFigure();
  gfx.g.FillPath(&brush, &path);

  const int cx = (rc.left + rc.right) / 2;
  const int cy = (rc.top + rc.bottom) / 2;
  RECT glyph_rc = {cx - 36, cy - 11, cx - 12, cy + 11};
  DrawPhoneOffGlyph(hdc, glyph_rc, kGlyphWhite, 14);

  HFONT f = MakeFont(13, FW_NORMAL, L"Microsoft YaHei UI");
  HFONT old = static_cast<HFONT>(SelectObject(hdc, f));
  SetBkMode(hdc, TRANSPARENT);
  SetTextColor(hdc, kNameColor);
  RECT text_rc = {cx - 10, cy - 10, cx + 48, cy + 10};
  DrawTextW(hdc, L"挂断", -1, &text_rc,
            DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
  SelectObject(hdc, old);
  DeleteObject(f);
}

// 纯平圆形按钮（曜石深 / 瓷白激活），glyph 可带斜线
inline void DrawSphereButton(HDC hdc, const RECT& rc, wchar_t glyph,
                             bool light, bool glyph_off, bool hovered,
                             double glyph_scale = 0.70) {
  const int cx = (rc.left + rc.right) / 2;
  const int cy = (rc.top + rc.bottom) / 2;
  const int r = (rc.right - rc.left) / 2;

  if (light) {
    FillDisc(hdc, cx, cy, r, hovered ? kDiscLightHover : kDiscLight);
  } else {
    FillDisc(hdc, cx, cy, r, hovered ? kDiscDarkHover : kDiscDark);
  }

  const COLORREF glyph_color = light ? kGlyphDark : kGlyphWhite;
  const int font_size = static_cast<int>(r * glyph_scale);
  RECT icon_rc = {cx - r / 2, cy - r / 2, cx + r / 2, cy + r / 2};
  if (glyph_off) {
    DrawPhoneOffGlyph(hdc, icon_rc, glyph_color, font_size);
  } else {
    DrawGlyph(hdc, icon_rc, glyph, glyph_color, font_size,
              L"Segoe MDL2 Assets");
  }
}

}  // namespace call_vis

#endif  // RUNNER_CALL_VISUALS_H_
