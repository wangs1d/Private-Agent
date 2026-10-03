#ifndef RUNNER_CALL_VISUALS_H_
#define RUNNER_CALL_VISUALS_H_

// 电话弹窗家族共享视觉层（真透明深卡 · 纯平圆盘 · 瓷白/曜石按钮）。
//
// 三个 Win32 悬浮窗（incoming / outgoing / connected）共用同一套绘制原语，
// 保证同一设计语言。全部头文件内联实现，不新增 CMake 源文件。
//
// 透明底做法：窗口挂 WS_EX_LAYERED，整卡画进 premultiplied ARGB 表面后
// UpdateLayeredWindow 上屏，卡片本体是恒定半透明的深渐变，由 DWM 实时
// 合成——窗口拖到任何背景上，透出的都是当下画面（此前的做法是显示前
// 抓拍落点桌面像素当假玻璃，拖动后背景永远停在抓拍那一帧，已废）。
// 系统.Acrylic 在部分 Win11 失效不可靠，逐像素 alpha 是全版本确定路径。
// 窗口无子控件（全部自绘 + 手动命中），玻璃表面连续不被实色按钮打补丁。
//
// 绘制纪律：
//   - 形状（盘、胶囊、波形、描边、光环）一律 GDI+ 抗锯齿画进 PARGB
//     表面（alpha 写入正确）；禁止 GDI Region/FillRgn 硬边与裸 GDI 直画
//     （GDI 会把 alpha 写脏）。
//   - 文字走 GDI 遮罩：黑底白字灰度 AA 渲染后亮度即覆盖率，再以文字色
//     src-over 叠进表面——保住 GDI 度量与省略号行为，布局零漂移。
//     （ClearType 在半透明面上无意义，统一灰度 AA。）
//   - 盘面一律纯平色（参考稿明确无光源：不渐变、不偏心高光）。
//
// 尺寸对齐微信语音通话弹窗：窗宽 300，头像盘 76，主按钮 54。

#include <windows.h>
#include <gdiplus.h>

#include <algorithm>
#include <cmath>
#include <string>

#pragma comment(lib, "msimg32.lib")

namespace call_vis {

// ── 卡片底色（恒定半透明，DWM 实时合成） ──
constexpr COLORREF kCardTop = RGB(0x1C, 0x1C, 0x21);     // 顶部压暗色
constexpr BYTE kCardTopA = 195;                           // 顶部不透明度 ~76%
constexpr COLORREF kCardBottom = RGB(0x10, 0x10, 0x13);  // 底部压暗色
constexpr BYTE kCardBottomA = 178;                        // 底部不透明度 ~70%
constexpr COLORREF kRimColor = RGB(0xFF, 0xFF, 0xFF);  // 玻璃高光描边
constexpr BYTE kRimAlpha = 66;
constexpr int kRimRadius = 7;  // 跟随系统圆角（DWMWCP_ROUND ≈8px）

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

// GDI+ 颜色（通道用位运算取，Get*Value 宏对常量折叠会触发 C4310）
inline Gdiplus::Color GpColor(COLORREF c, BYTE a = 255) {
  return Gdiplus::Color(a, (c >> 0) & 0xFF, (c >> 8) & 0xFF,
                        (c >> 16) & 0xFF);
}

inline HFONT MakeFont(int size, int weight, const wchar_t* family) {
  // 灰度 AA（非 ClearType）：文字以遮罩方式合成进半透明表面
  return CreateFontW(-size, 0, 0, 0, weight, FALSE, FALSE, FALSE,
                     DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                     ANTIALIASED_QUALITY, DEFAULT_PITCH | FF_SWISS, family);
}

inline void EnsureGdiplus() {
  static bool inited = []() {
    ULONG_PTR token = 0;
    Gdiplus::GdiplusStartupInput input;
    return Gdiplus::GdiplusStartup(&token, &input, nullptr) == Gdiplus::Ok;
  }();
}

// ── 半透明合成表面（premultiplied ARGB，供 UpdateLayeredWindow） ──
//
// 主表面与文字遮罩暂存同尺寸同坐标系。三个通话窗同线程轮流使用
// SharedGlassSurface：每次完整重绘后立即整窗上屏。
struct GlassSurface {
  int w = 0;
  int h = 0;
  HDC dc = nullptr;    // 选入 dib 的内存 DC（UpdateLayeredWindow 的源）
  HBITMAP dib = nullptr;
  BYTE* bits = nullptr;  // premultiplied BGRA，top-down
  Gdiplus::Bitmap* bitmap = nullptr;  // 包裹 bits 的 PARGB 视图（不拷贝）
  Gdiplus::Graphics* gfx = nullptr;   // 形状画这里（alpha 写入正确）

  // 文字遮罩暂存：黑底白字灰度 AA，亮度通道 = 覆盖率
  HDC mask_dc = nullptr;
  HBITMAP mask_dib = nullptr;
  BYTE* mask_bits = nullptr;

  bool Ensure(int width, int height) {
    if (dc && w == width && h == height) return true;
    EnsureGdiplus();
    Free();
    w = width;
    h = height;

    BITMAPINFO bmi = {};
    bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bmi.bmiHeader.biWidth = w;
    bmi.bmiHeader.biHeight = -h;  // top-down
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB;
    dib = CreateDIBSection(nullptr, &bmi, DIB_RGB_COLORS,
                           reinterpret_cast<void**>(&bits), nullptr, 0);
    mask_dib = CreateDIBSection(nullptr, &bmi, DIB_RGB_COLORS,
                                reinterpret_cast<void**>(&mask_bits), nullptr,
                                0);
    if (!dib || !mask_dib) {
      Free();
      return false;
    }
    dc = CreateCompatibleDC(nullptr);
    SelectObject(dc, dib);
    mask_dc = CreateCompatibleDC(nullptr);
    SelectObject(mask_dc, mask_dib);

    bitmap = new Gdiplus::Bitmap(w, h, w * 4, PixelFormat32bppPARGB, bits);
    gfx = Gdiplus::Graphics::FromImage(bitmap);
    if (!gfx) {
      Free();
      return false;
    }
    gfx->SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
    gfx->SetPixelOffsetMode(Gdiplus::PixelOffsetModeHighQuality);
    return true;
  }

  void Free() {
    delete gfx;
    gfx = nullptr;
    delete bitmap;
    bitmap = nullptr;
    if (mask_dc) {
      DeleteDC(mask_dc);
      mask_dc = nullptr;
    }
    if (mask_dib) {
      DeleteObject(mask_dib);
      mask_dib = nullptr;
    }
    if (dc) {
      DeleteDC(dc);
      dc = nullptr;
    }
    if (dib) {
      DeleteObject(dib);
      dib = nullptr;
    }
    bits = nullptr;
    mask_bits = nullptr;
    w = 0;
    h = 0;
  }
};

inline GlassSurface& SharedGlassSurface(int w, int h) {
  static GlassSurface surface;
  surface.Ensure(w, h);
  return surface;
}

// 文字遮罩合成：先在遮罩暂存上黑底白字渲染（draw 回调只管选字体 + 画），
// 再把亮度当覆盖率、以 color 为源色 src-over 叠进主表面。
template <typename DrawFn>
inline void DrawTextOver(GlassSurface& s, const RECT& rc, COLORREF color,
                         DrawFn&& draw) {
  if (!s.mask_dc) return;
  const int x0 = (std::max)(0, static_cast<int>(rc.left));
  const int y0 = (std::max)(0, static_cast<int>(rc.top));
  const int x1 = (std::min)(s.w, static_cast<int>(rc.right));
  const int y1 = (std::min)(s.h, static_cast<int>(rc.bottom));
  if (x0 >= x1 || y0 >= y1) return;

  const RECT fill = {x0, y0, x1, y1};
  FillRect(s.mask_dc, &fill,
           static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH)));
  SetBkMode(s.mask_dc, TRANSPARENT);
  SetTextColor(s.mask_dc, RGB(255, 255, 255));
  draw(s.mask_dc);

  const int stride = s.w * 4;
  const BYTE cb = GetBValue(color);
  const BYTE cg = GetGValue(color);
  const BYTE cr = GetRValue(color);
  for (int y = y0; y < y1; ++y) {
    const BYTE* src = s.mask_bits + y * stride + x0 * 4;
    BYTE* dst = s.bits + y * stride + x0 * 4;
    for (int x = 0; x < x1 - x0; ++x) {
      const int cov = src[x * 4 + 1];  // 白字黑底：G 通道即覆盖率
      if (!cov) continue;
      BYTE* px = dst + x * 4;  // B G R A（premultiplied）
      const int inv = 255 - cov;
      px[0] = static_cast<BYTE>((cb * cov + px[0] * inv + 127) / 255);
      px[1] = static_cast<BYTE>((cg * cov + px[1] * inv + 127) / 255);
      px[2] = static_cast<BYTE>((cr * cov + px[2] * inv + 127) / 255);
      px[3] = static_cast<BYTE>(cov + (px[3] * inv + 127) / 255);
    }
  }
}

// 整窗上屏（位置不变，仅内容；半透明区域由 DWM 实时合成）
inline void PresentLayered(HWND hwnd, const GlassSurface& s, HDC hdc_dst) {
  BLENDFUNCTION bf = {AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
  POINT src = {0, 0};
  SIZE size = {s.w, s.h};
  UpdateLayeredWindow(hwnd, hdc_dst, nullptr, &size, s.dc, &src, 0, &bf,
                      ULW_ALPHA);
}

// 纯平抗锯齿圆盘
inline void FillDisc(Gdiplus::Graphics& g, int cx, int cy, int r,
                     COLORREF fill) {
  Gdiplus::SolidBrush brush(GpColor(fill));
  g.FillEllipse(&brush, static_cast<Gdiplus::REAL>(cx - r),
                static_cast<Gdiplus::REAL>(cy - r),
                static_cast<Gdiplus::REAL>(r * 2),
                static_cast<Gdiplus::REAL>(r * 2));
}

// 半透明抗锯齿圆盘（呼吸光环用）
inline void FillDiscAlpha(Gdiplus::Graphics& g, int cx, int cy, int r,
                          COLORREF fill, BYTE alpha) {
  Gdiplus::SolidBrush brush(GpColor(fill, alpha));
  g.FillEllipse(&brush, static_cast<Gdiplus::REAL>(cx - r),
                static_cast<Gdiplus::REAL>(cy - r),
                static_cast<Gdiplus::REAL>(r * 2),
                static_cast<Gdiplus::REAL>(r * 2));
}

// ── 玻璃底（GDI+，恒定半透明）──

inline void RoundedRectPath(Gdiplus::GraphicsPath& path, Gdiplus::REAL x,
                            Gdiplus::REAL y, Gdiplus::REAL w, Gdiplus::REAL h,
                            Gdiplus::REAL r) {
  path.AddArc(x, y, r * 2.0f, r * 2.0f, 180.0f, 90.0f);
  path.AddArc(x + w - r * 2.0f, y, r * 2.0f, r * 2.0f, 270.0f, 90.0f);
  path.AddArc(x + w - r * 2.0f, y + h - r * 2.0f, r * 2.0f, r * 2.0f, 0.0f,
              90.0f);
  path.AddArc(x, y + h - r * 2.0f, r * 2.0f, r * 2.0f, 90.0f, 90.0f);
  path.CloseFigure();
}

// 玻璃底两层：半透明深渐变圆角卡 + 白色高光描边。不画任何不透明像素，
// 背景透出永远由 DWM 实时合成（拖动/背后内容变化都是活的）。
inline void DrawGlassBase(GlassSurface& s) {
  Gdiplus::Graphics& g = *s.gfx;
  // 表面跨帧复用，必须先清成全透明：半透明底逐帧 src-over 会把 alpha
  // 一层层叠饱和（195→241→255），整卡几帧内就变成不透明。
  g.Clear(Gdiplus::Color(0, 0, 0, 0));
  const Gdiplus::RectF full(0, 0, static_cast<Gdiplus::REAL>(s.w),
                            static_cast<Gdiplus::REAL>(s.h));

  Gdiplus::GraphicsPath card;
  RoundedRectPath(card, 0.0f, 0.0f, full.Width, full.Height,
                  static_cast<Gdiplus::REAL>(kRimRadius));
  // 顶部略深托住标题栏文字对比度
  Gdiplus::LinearGradientBrush base(
      full,
      Gdiplus::Color(kCardTopA, (kCardTop >> 0) & 0xFF, (kCardTop >> 8) & 0xFF,
                     (kCardTop >> 16) & 0xFF),
      Gdiplus::Color(kCardBottomA, (kCardBottom >> 0) & 0xFF,
                     (kCardBottom >> 8) & 0xFF,
                     (kCardBottom >> 16) & 0xFF),
      90.0f);
  g.FillPath(&base, &card);

  // 玻璃高光描边（内缩 1px），增强「玻璃片」轮廓
  Gdiplus::GraphicsPath rim;
  RoundedRectPath(rim, 1.0f, 1.0f, full.Width - 2.0f, full.Height - 2.0f,
                  static_cast<Gdiplus::REAL>(kRimRadius));
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
inline void DrawSignalIcon(Gdiplus::Graphics& g, int x_left, int baseline_y,
                           COLORREF color) {
  Gdiplus::SolidBrush brush(GpColor(color));
  constexpr int kHeights[4] = {4, 7, 10, 13};
  int x = x_left;
  for (int h : kHeights) {
    g.FillRectangle(&brush, static_cast<Gdiplus::REAL>(x),
                    static_cast<Gdiplus::REAL>(baseline_y - h), 3.0f,
                    static_cast<Gdiplus::REAL>(h));
    x += 5;
  }
}

inline void DrawGlyph(GlassSurface& s, const RECT& rc, wchar_t glyph,
                      COLORREF color, int font_size,
                      const wchar_t* font_family) {
  DrawTextOver(s, rc, color, [&](HDC hdc) {
    HFONT f = MakeFont(font_size, FW_NORMAL, font_family);
    HFONT old = static_cast<HFONT>(SelectObject(hdc, f));
    RECT r = rc;
    DrawTextW(hdc, &glyph, 1, &r,
              DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    SelectObject(hdc, old);
    DeleteObject(f);
  });
}

// 挂断样式图标：电话字形 + 斜线（斜线走 GDI+ AA）
inline void DrawPhoneOffGlyph(GlassSurface& s, const RECT& rc, COLORREF color,
                              int font_size) {
  DrawGlyph(s, rc, kGlyphPhone, color, font_size, L"Segoe MDL2 Assets");
  Gdiplus::Pen pen(GpColor(color), 1.6f);
  const Gdiplus::REAL cx = static_cast<Gdiplus::REAL>((rc.left + rc.right) / 2);
  const Gdiplus::REAL cy = static_cast<Gdiplus::REAL>((rc.top + rc.bottom) / 2);
  const Gdiplus::REAL off = static_cast<Gdiplus::REAL>(font_size) / 3.0f;
  s.gfx->DrawLine(&pen, cx + off, cy + off, cx - off, cy - off);
}

inline void PaintTitleBar(GlassSurface& s, int width, bool hover_min,
                          bool hover_close) {
  DrawSignalIcon(*s.gfx, 20, 26, kTitleText);

  RECT title_rc = {42, 7, width - 86, 33};
  DrawTextOver(s, title_rc, kTitleText, [&](HDC hdc) {
    HFONT f = MakeFont(12, FW_NORMAL, L"Microsoft YaHei UI");
    HFONT old = static_cast<HFONT>(SelectObject(hdc, f));
    DrawTextW(hdc, L"Nextbot 通话", -1, &title_rc,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    SelectObject(hdc, old);
    DeleteObject(f);
  });

  const TitleRects tr = TitleRectsFor(width);
  DrawGlyph(s, tr.minimize, kGlyphMinimize,
            hover_min ? kNameColor : kSubColor, 10, L"Segoe MDL2 Assets");
  DrawGlyph(s, tr.close, kGlyphClose, hover_close ? kNameColor : kSubColor,
            10, L"Segoe MDL2 Assets");
}

// ── 内容元素 ──

// 小波形：5 根圆角竖条（phase < 0 为静态），AA
inline void DrawWaveBars(Gdiplus::Graphics& g, int cx, int cy, int max_h,
                         COLORREF color, int phase) {
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
inline void PaintAvatarDisc(GlassSurface& s, int cx, int cy, int r,
                            const std::wstring& initial) {
  FillDisc(*s.gfx, cx, cy, r, kAvatarBg);
  if (!initial.empty()) {
    RECT rc = {cx - r, cy - r, cx + r, cy + r};
    DrawGlyph(s, rc, initial[0], kAvatarGlyph,
              static_cast<int>(r * 0.62), L"Microsoft YaHei UI");
    return;
  }
  DrawWaveBars(*s.gfx, cx, cy, static_cast<int>(r * 0.42), kGlyphWhite, -1);
}

// 一行居中文本（返回实际文本宽度）
inline int DrawCenteredText(GlassSurface& s, const RECT& rc,
                            const std::wstring& text, COLORREF color, int size,
                            int weight, const wchar_t* family) {
  int width = 0;
  DrawTextOver(s, rc, color, [&](HDC hdc) {
    HFONT f = MakeFont(size, weight, family);
    HFONT old = static_cast<HFONT>(SelectObject(hdc, f));
    RECT r = rc;
    DrawTextW(hdc, text.c_str(), -1, &r,
              DT_CENTER | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
    SIZE sz = {0, 0};
    GetTextExtentPoint32W(hdc, text.c_str(),
                          static_cast<int>(text.size()), &sz);
    width = sz.cx;
    SelectObject(hdc, old);
    DeleteObject(f);
  });
  return width;
}

// 分隔线（横向，两端留白，半透明淡线）
inline void DrawDivider(Gdiplus::Graphics& g, int width, int y) {
  Gdiplus::Pen pen(GpColor(RGB(0xFF, 0xFF, 0xFF), 26), 1.0f);
  g.DrawLine(&pen, static_cast<Gdiplus::REAL>(28),
             static_cast<Gdiplus::REAL>(y) + 0.5f,
             static_cast<Gdiplus::REAL>(width - 28),
             static_cast<Gdiplus::REAL>(y) + 0.5f);
}

// 胶囊挂断钮（图标 + 「挂断」），AA 圆角
inline void DrawPillButton(GlassSurface& s, const RECT& rc, bool hovered) {
  Gdiplus::Graphics& g = *s.gfx;
  Gdiplus::SolidBrush brush(GpColor(hovered ? kPillBgHover : kPillBg));
  const Gdiplus::REAL rx = static_cast<Gdiplus::REAL>(rc.left);
  const Gdiplus::REAL ry = static_cast<Gdiplus::REAL>(rc.top);
  const Gdiplus::REAL rw = static_cast<Gdiplus::REAL>(rc.right - rc.left);
  const Gdiplus::REAL rh = static_cast<Gdiplus::REAL>(rc.bottom - rc.top);
  Gdiplus::GraphicsPath path;
  path.AddArc(rx, ry, rh, rh, 90.0f, 180.0f);
  path.AddArc(rx + rw - rh, ry, rh, rh, 270.0f, 180.0f);
  path.CloseFigure();
  g.FillPath(&brush, &path);

  const int cx = (rc.left + rc.right) / 2;
  const int cy = (rc.top + rc.bottom) / 2;
  RECT glyph_rc = {cx - 36, cy - 11, cx - 12, cy + 11};
  DrawPhoneOffGlyph(s, glyph_rc, kGlyphWhite, 14);

  RECT text_rc = {cx - 10, cy - 10, cx + 48, cy + 10};
  DrawTextOver(s, text_rc, kNameColor, [&](HDC hdc) {
    HFONT f = MakeFont(13, FW_NORMAL, L"Microsoft YaHei UI");
    HFONT old = static_cast<HFONT>(SelectObject(hdc, f));
    DrawTextW(hdc, L"挂断", -1, &text_rc,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    SelectObject(hdc, old);
    DeleteObject(f);
  });
}

// 纯平圆形按钮（曜石深 / 瓷白激活），glyph 可带斜线
inline void DrawSphereButton(GlassSurface& s, const RECT& rc, wchar_t glyph,
                             bool light, bool glyph_off, bool hovered,
                             double glyph_scale = 0.70) {
  const int cx = (rc.left + rc.right) / 2;
  const int cy = (rc.top + rc.bottom) / 2;
  const int r = (rc.right - rc.left) / 2;

  if (light) {
    FillDisc(*s.gfx, cx, cy, r, hovered ? kDiscLightHover : kDiscLight);
  } else {
    FillDisc(*s.gfx, cx, cy, r, hovered ? kDiscDarkHover : kDiscDark);
  }

  const COLORREF glyph_color = light ? kGlyphDark : kGlyphWhite;
  const int font_size = static_cast<int>(r * glyph_scale);
  RECT icon_rc = {cx - r / 2, cy - r / 2, cx + r / 2, cy + r / 2};
  if (glyph_off) {
    DrawPhoneOffGlyph(s, icon_rc, glyph_color, font_size);
  } else {
    DrawGlyph(s, icon_rc, glyph, glyph_color, font_size,
              L"Segoe MDL2 Assets");
  }
}

}  // namespace call_vis

#endif  // RUNNER_CALL_VISUALS_H_
