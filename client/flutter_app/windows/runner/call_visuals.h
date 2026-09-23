#ifndef RUNNER_CALL_VISUALS_H_
#define RUNNER_CALL_VISUALS_H_

// 电话弹窗家族共享视觉层（黑白极简玻璃深卡 · 金属球头像 · 瓷白/曜石按钮）。
//
// 三个 Win32 悬浮窗（incoming / outgoing / connected）共用同一套绘制原语，
// 保证同一设计语言。全部头文件内联实现，不新增 CMake 源文件。
//
// 设计语言（对齐 2026-09 参考稿）：
//   - 竖向渐变深色玻璃卡 + 极淡描边，DWM 阴影分层
//   - 统一标题栏：信号条图标 + 「Nextbot 通话」+ 最小化/关闭
//   - 头像为金属球（偏心高光径向渐变）+ 首字符
//   - 主按钮为球体（接听瓷白 / 拒接·挂断曜石深），次按钮为深色小圆
//   - 取消/挂断用胶囊按钮（图标 + 文字）

#include <windows.h>

#include <algorithm>
#include <cmath>
#include <string>

#pragma comment(lib, "msimg32.lib")

namespace call_vis {

// ── 卡片 ──
constexpr int kCardRadius = 24;                          // 卡片圆角
constexpr COLORREF kCardTop = RGB(0x26, 0x26, 0x2A);     // 顶部渐变
constexpr COLORREF kCardBottom = RGB(0x13, 0x13, 0x15);  // 底部渐变
constexpr COLORREF kCardBorder = RGB(0x35, 0x35, 0x39);  // 极淡描边
constexpr COLORREF kDivider = RGB(0x2D, 0x2D, 0x31);     // 分隔线

// ── 文字 ──
constexpr COLORREF kTitleText = RGB(0xB0, 0xB0, 0xB4);
constexpr COLORREF kNameColor = RGB(0xFA, 0xFA, 0xFA);
constexpr COLORREF kSubColor = RGB(0x9C, 0x9C, 0xA0);
constexpr COLORREF kStatusColor = RGB(0x88, 0x88, 0x8C);

// ── 控件 ──
constexpr COLORREF kSphereLightTop = RGB(0xF6, 0xF6, 0xF8);  // 瓷白球高光
constexpr COLORREF kSphereLightEdge = RGB(0x96, 0x96, 0x9A);  // 瓷白球边缘
constexpr COLORREF kSphereDarkTop = RGB(0x48, 0x48, 0x4C);   // 曜石球高光
constexpr COLORREF kSphereDarkEdge = RGB(0x1E, 0x1E, 0x20);  // 曜石球边缘
constexpr COLORREF kSphereDarkHover = RGB(0x54, 0x54, 0x58);
constexpr COLORREF kGlyphDark = RGB(0x1C, 0x1C, 0x1E);  // 白球上深图标
constexpr COLORREF kGlyphWhite = RGB(0xFF, 0xFF, 0xFF);
constexpr COLORREF kPillBg = RGB(0x2E, 0x2E, 0x32);       // 胶囊钮底
constexpr COLORREF kPillBgHover = RGB(0x3A, 0x3A, 0x3E);  // 胶囊钮悬停
constexpr COLORREF kAvatarEdge = RGB(0x52, 0x52, 0x56);   // 头像球边缘
constexpr COLORREF kAvatarHighlight = RGB(0xCB, 0xCB, 0xCF);  // 头像球高光
constexpr COLORREF kAvatarGlyph = RGB(0x30, 0x30, 0x33);      // 头像字符
constexpr COLORREF kHaloColor = RGB(0x45, 0x45, 0x49);        // 呼吸光环

constexpr wchar_t kGlyphPhone = L'\uE717';
constexpr wchar_t kGlyphMic = L'\uE720';
constexpr wchar_t kGlyphVolume = L'\uE767';
constexpr wchar_t kGlyphMinimize = L'\uE921';  // ChromeMinimize
constexpr wchar_t kGlyphClose = L'\uE8BB';     // ChromeClose

constexpr int kTitleBarH = 44;

inline COLORREF MixColor(COLORREF a, COLORREF b, double t) {
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  return RGB(
      static_cast<int>(GetRValue(a) + (GetRValue(b) - GetRValue(a)) * t),
      static_cast<int>(GetGValue(a) + (GetGValue(b) - GetGValue(a)) * t),
      static_cast<int>(GetBValue(a) + (GetBValue(b) - GetBValue(a)) * t));
}

// 卡片竖向渐变在 y 处的颜色（供按钮铺底，与渐变背景无缝衔接）
inline COLORREF CardColorAtY(int y, int height) {
  const double t =
      std::clamp(static_cast<double>(y) / static_cast<double>((std::max)(1, height)),
                 0.0, 1.0);
  return MixColor(kCardTop, kCardBottom, t);
}

inline HFONT MakeFont(int size, int weight, const wchar_t* family) {
  return CreateFontW(-size, 0, 0, 0, weight, FALSE, FALSE, FALSE,
                     DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                     CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_SWISS, family);
}

inline void FillCircle(HDC hdc, int cx, int cy, int r, COLORREF fill) {
  HRGN rgn = CreateEllipticRgn(cx - r, cy - r, cx + r, cy + r);
  HBRUSH brush = CreateSolidBrush(fill);
  FillRgn(hdc, rgn, brush);
  DeleteObject(brush);
  DeleteObject(rgn);
}

// 球体：偏心高光径向渐变（由外向内画同心圆环，高光点默认偏左上）
inline void FillSphere(HDC hdc, int cx, int cy, int r, COLORREF highlight,
                       COLORREF edge, double offset_x = -0.24,
                       double offset_y = -0.30) {
  HRGN clip = CreateEllipticRgn(cx - r, cy - r, cx + r, cy + r);
  SelectClipRgn(hdc, clip);
  const int hx = cx + static_cast<int>(r * offset_x);
  const int hy = cy + static_cast<int>(r * offset_y);
  const double max_d =
      r * (1.0 + std::sqrt(offset_x * offset_x + offset_y * offset_y)) + 2;
  for (int i = static_cast<int>(max_d); i >= 1; --i) {
    const double t = std::clamp(i / max_d, 0.0, 1.0);
    FillCircle(hdc, hx, hy, i, MixColor(highlight, edge, std::pow(t, 0.85)));
  }
  SelectClipRgn(hdc, nullptr);
  DeleteObject(clip);
}

// 竖向渐变卡片底 + 极淡描边（内容绘制前请按圆角 SelectClipRgn）
inline void PaintCardBase(HDC hdc, const RECT& rc) {
  TRIVERTEX vtx[2] = {};
  vtx[0] = {rc.left, rc.top, 0, 0, 0, 0};
  vtx[0].Red = static_cast<USHORT>(GetRValue(kCardTop) << 8);
  vtx[0].Green = static_cast<USHORT>(GetGValue(kCardTop) << 8);
  vtx[0].Blue = static_cast<USHORT>(GetBValue(kCardTop) << 8);
  vtx[0].Alpha = 0xFFFF;
  vtx[1] = {rc.right, rc.bottom, 0, 0, 0, 0};
  vtx[1].Red = static_cast<USHORT>(GetRValue(kCardBottom) << 8);
  vtx[1].Green = static_cast<USHORT>(GetGValue(kCardBottom) << 8);
  vtx[1].Blue = static_cast<USHORT>(GetBValue(kCardBottom) << 8);
  vtx[1].Alpha = 0xFFFF;
  GRADIENT_RECT gr = {0, 1};
  GradientFill(hdc, vtx, 2, &gr, 1, GRADIENT_FILL_RECT_V);

  HPEN pen = CreatePen(PS_SOLID, 1, kCardBorder);
  HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, pen));
  HBRUSH null_brush = static_cast<HBRUSH>(GetStockObject(NULL_BRUSH));
  HBRUSH old_brush = static_cast<HBRUSH>(SelectObject(hdc, null_brush));
  RoundRect(hdc, rc.left, rc.top, rc.right - 1, rc.bottom - 1, kCardRadius,
            kCardRadius);
  SelectObject(hdc, old_brush);
  SelectObject(hdc, old_pen);
  DeleteObject(pen);
}

// 圆角裁剪（RAII 不引入，调用方手动清除）
inline void ClipRoundCard(HDC hdc, const RECT& rc) {
  HRGN clip = CreateRoundRectRgn(rc.left, rc.top, rc.right + 1, rc.bottom + 1,
                                 kCardRadius, kCardRadius);
  SelectClipRgn(hdc, clip);
  DeleteObject(clip);
}

// ── 标题栏 ──

struct TitleRects {
  RECT minimize;
  RECT close;
};

inline TitleRects TitleRectsFor(int width) {
  return {{width - 78, 8, width - 50, 34}, {width - 48, 8, width - 20, 34}};
}

inline bool PointInRect(const RECT& rc, const POINT& pt) {
  return pt.x >= rc.left && pt.x < rc.right && pt.y >= rc.top &&
         pt.y < rc.bottom;
}

// 阶梯信号条（4 根，底对齐）
inline void DrawSignalIcon(HDC hdc, int x_left, int baseline_y,
                           COLORREF color) {
  constexpr int kHeights[4] = {4, 7, 10, 13};
  int x = x_left;
  HBRUSH brush = CreateSolidBrush(color);
  for (int h : kHeights) {
    RECT bar = {x, baseline_y - h, x + 3, baseline_y};
    FillRect(hdc, &bar, brush);
    x += 5;
  }
  DeleteObject(brush);
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

// 挂断样式图标：电话字形 + 右下→左上斜线
inline void DrawPhoneOffGlyph(HDC hdc, const RECT& rc, COLORREF color,
                              int font_size) {
  DrawGlyph(hdc, rc, kGlyphPhone, color, font_size, L"Segoe MDL2 Assets");
  HPEN pen = CreatePen(PS_SOLID, 2, color);
  HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, pen));
  const int cx = (rc.left + rc.right) / 2;
  const int cy = (rc.top + rc.bottom) / 2;
  const int off = font_size / 3;
  MoveToEx(hdc, cx + off, cy + off, nullptr);
  LineTo(hdc, cx - off, cy - off);
  SelectObject(hdc, old_pen);
  DeleteObject(pen);
}

inline void PaintTitleBar(HDC hdc, int width, int card_h, bool hover_min,
                          bool hover_close) {
  DrawSignalIcon(hdc, 22, 29, kTitleText);

  SetBkMode(hdc, TRANSPARENT);
  HFONT f = MakeFont(12, FW_NORMAL, L"Microsoft YaHei UI");
  HFONT old = static_cast<HFONT>(SelectObject(hdc, f));
  SetTextColor(hdc, kTitleText);
  RECT title_rc = {46, 8, width - 90, 34};
  DrawTextW(hdc, L"Nextbot 通话", -1, &title_rc,
            DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
  SelectObject(hdc, old);
  DeleteObject(f);

  const TitleRects tr = TitleRectsFor(width);
  if (hover_min || hover_close) {
    // 悬停铺一层极淡高亮（铺卡片同位色，避免盖穿渐变）
    if (hover_min) {
      HBRUSH b = CreateSolidBrush(
          MixColor(CardColorAtY(tr.minimize.top + 8, card_h), RGB(255, 255, 255), 0.10));
      FillRect(hdc, &tr.minimize, b);
      DeleteObject(b);
    }
    if (hover_close) {
      HBRUSH b = CreateSolidBrush(
          MixColor(CardColorAtY(tr.close.top + 8, card_h), RGB(255, 255, 255), 0.10));
      FillRect(hdc, &tr.close, b);
      DeleteObject(b);
    }
  }
  DrawGlyph(hdc, tr.minimize, kGlyphMinimize,
            hover_min ? kNameColor : kSubColor, 10, L"Segoe MDL2 Assets");
  DrawGlyph(hdc, tr.close, kGlyphClose, hover_close ? kNameColor : kSubColor,
            10, L"Segoe MDL2 Assets");
}

// ── 内容元素 ──

// 小波形：5 根圆角竖条（phase < 0 为静态）
inline void DrawWaveBars(HDC hdc, int cx, int cy, int max_h, COLORREF color,
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

// 金属球头像：偏心高光 + 首字符；无字符时退化为波形
inline void PaintAvatarSphere(HDC hdc, int cx, int cy, int r,
                              const std::wstring& initial) {
  FillSphere(hdc, cx, cy, r, kAvatarHighlight, kAvatarEdge);
  if (!initial.empty()) {
    RECT rc = {cx - r, cy - r, cx + r, cy + r};
    DrawGlyph(hdc, rc, initial[0], kAvatarGlyph,
              static_cast<int>(r * 0.78), L"Microsoft YaHei UI");
    return;
  }
  // 无首字符：退回波形标
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

// 分隔线（横向，两端留白）
inline void DrawDivider(HDC hdc, int width, int y) {
  RECT line = {28, y, width - 28, y + 1};
  HBRUSH brush = CreateSolidBrush(kDivider);
  FillRect(hdc, &line, brush);
  DeleteObject(brush);
}

// 胶囊挂断钮（图标 + 「挂断」），caller 负责铺底色
inline void DrawPillButton(HDC hdc, const RECT& rc, int card_h, bool hovered) {
  const int cy = (rc.top + rc.bottom) / 2;
  HBRUSH bg = CreateSolidBrush(CardColorAtY(cy, card_h));
  FillRect(hdc, &rc, bg);
  DeleteObject(bg);

  HBRUSH fill = CreateSolidBrush(hovered ? kPillBgHover : kPillBg);
  HPEN pen = CreatePen(PS_NULL, 0, 0);
  HBRUSH old_brush = static_cast<HBRUSH>(SelectObject(hdc, fill));
  HPEN old_pen = static_cast<HPEN>(SelectObject(hdc, pen));
  RoundRect(hdc, rc.left, rc.top, rc.right, rc.bottom,
            rc.bottom - rc.top, rc.bottom - rc.top);
  SelectObject(hdc, old_brush);
  SelectObject(hdc, old_pen);
  DeleteObject(fill);
  DeleteObject(pen);

  const int cx = (rc.left + rc.right) / 2;
  RECT glyph_rc = {cx - 40, cy - 12, cx - 14, cy + 12};
  DrawPhoneOffGlyph(hdc, glyph_rc, kGlyphWhite, 15);

  SetBkMode(hdc, TRANSPARENT);
  HFONT f = MakeFont(14, FW_NORMAL, L"Microsoft YaHei UI");
  HFONT old = static_cast<HFONT>(SelectObject(hdc, f));
  SetTextColor(hdc, kNameColor);
  RECT text_rc = {cx - 12, cy - 11, cx + 52, cy + 11};
  DrawTextW(hdc, L"挂断", -1, &text_rc,
            DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
  SelectObject(hdc, old);
  DeleteObject(f);
}

// 球体圆形按钮（曜石深 / 瓷白激活），glyph 可带斜线
inline void DrawSphereButton(HDC hdc, const RECT& rc, int card_h,
                             wchar_t glyph, bool light, bool glyph_off,
                             bool hovered) {
  const int cx = (rc.left + rc.right) / 2;
  const int cy = (rc.top + rc.bottom) / 2;
  const int r = (rc.right - rc.left) / 2;

  HBRUSH bg = CreateSolidBrush(CardColorAtY(cy, card_h));
  FillRect(hdc, &rc, bg);
  DeleteObject(bg);

  if (light) {
    FillSphere(hdc, cx, cy, r, kSphereLightTop, kSphereLightEdge);
  } else {
    FillSphere(hdc, cx, cy, r,
               hovered ? kSphereDarkHover : kSphereDarkTop, kSphereDarkEdge);
  }

  const COLORREF glyph_color = light ? kGlyphDark : kGlyphWhite;
  const int font_size = static_cast<int>(r * 0.62);
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
