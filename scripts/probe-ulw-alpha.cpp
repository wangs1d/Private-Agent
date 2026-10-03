// Probe: which UpdateLayeredWindow invocation actually applies per-pixel
// alpha? Self-contained: white bg window + layered window tinted with
// alpha=195 over it. Composited-over-white expectation:
//   alpha honored  -> ~81 luminance
//   alpha ignored  -> ~21 luminance (premultiplied color as opaque)
#include <windows.h>
#include <gdiplus.h>
#include <stdio.h>

#pragma comment(lib, "gdiplus.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "user32.lib")

namespace {

constexpr wchar_t kBgClass[] = L"ULWProbeBg";
constexpr wchar_t kFgClass[] = L"ULWProbeFg";

LRESULT CALLBACK Def(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  return DefWindowProcW(hwnd, msg, wp, lp);
}

float LumAt(HDC screen, int x, int y) {
  COLORREF c = GetPixel(screen, x, y);
  return 0.299f * GetRValue(c) + 0.587f * GetGValue(c) + 0.114f * GetBValue(c);
}

// Builds a 64x64 premultiplied ARGB DIB filled with Color(195,28,28,33).
HBITMAP MakeTintDib(BYTE** bits_out) {
  const int w = 64, h = 64;
  BITMAPINFO bmi = {};
  bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bmi.bmiHeader.biWidth = w;
  bmi.bmiHeader.biHeight = -h;
  bmi.bmiHeader.biPlanes = 1;
  bmi.bmiHeader.biBitCount = 32;
  bmi.bmiHeader.biCompression = BI_RGB;
  BYTE* bits = nullptr;
  HBITMAP dib = CreateDIBSection(nullptr, &bmi, DIB_RGB_COLORS,
                                 reinterpret_cast<void**>(&bits), nullptr, 0);
  if (!dib) return nullptr;
  memset(bits, 0, w * h * 4);
  Gdiplus::Bitmap bmp(w, h, w * 4, PixelFormat32bppPARGB, bits);
  Gdiplus::Graphics* g = Gdiplus::Graphics::FromImage(&bmp);
  g->SetSmoothingMode(Gdiplus::SmoothingModeNone);
  Gdiplus::SolidBrush brush(Gdiplus::Color(195, 0x1C, 0x1C, 0x21));
  g->FillRectangle(&brush, 0, 0, w, h);
  delete g;
  *bits_out = bits;
  return dib;
}

}  // namespace

int wmain() {
  ULONG_PTR token = 0;
  Gdiplus::GdiplusStartupInput input;
  Gdiplus::GdiplusStartup(&token, &input, nullptr);

  WNDCLASSW wc = {};
  wc.lpfnWndProc = Def;
  wc.hInstance = GetModuleHandle(nullptr);
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.hbrBackground = (HBRUSH)GetStockObject(WHITE_BRUSH);
  wc.lpszClassName = kBgClass;
  RegisterClassW(&wc);
  wc.hbrBackground = nullptr;
  wc.lpszClassName = kFgClass;
  RegisterClassW(&wc);

  // white background window at (60,60)
  CreateWindowExW(0, kBgClass, L"bg", WS_POPUP | WS_VISIBLE, 60, 60,
                  200, 200, nullptr, nullptr, GetModuleHandle(nullptr), nullptr);

  BYTE* bits = nullptr;
  HBITMAP dib = MakeTintDib(&bits);
  if (!dib) { wprintf(L"dib failed\n"); return 1; }
  HDC src_dc = CreateCompatibleDC(nullptr);
  SelectObject(src_dc, dib);

  // layered foreground on top of the white area
  HWND fg = CreateWindowExW(WS_EX_LAYERED, kFgClass, L"fg", WS_POPUP, 100, 100,
                            64, 64, nullptr, nullptr, GetModuleHandle(nullptr), nullptr);
  ShowWindow(fg, SW_SHOW);

  BLENDFUNCTION bf = {AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
  POINT src = {0, 0};
  SIZE size = {64, 64};

  struct Variant { const wchar_t* name; HWND hwnd; HDC hdc; POINT* ppt; };
  POINT keep_pos = {100, 100};

  // run 1: hdcDst = GetDC(NULL), pptDst = explicit
  HDC screen_dc = GetDC(nullptr);
  POINT ppt = keep_pos;
  BOOL ok = UpdateLayeredWindow(fg, screen_dc, &ppt, &size, src_dc, &src, 0,
                                &bf, ULW_ALPHA);
  Sleep(400);
  float lum = LumAt(screen_dc, 130, 130);
  wprintf(L"[GetDC(NULL)+ppt]  ulw=%d gle=%lu lum=%.0f %s\n", ok, ok ? 0 : GetLastError(),
          lum, lum > 50 ? L"ALPHA OK" : L"ALPHA IGNORED");

  // run 2: hdcDst = GetDC(fg), pptDst = NULL
  HDC fg_dc = GetDC(fg);
  ok = UpdateLayeredWindow(fg, fg_dc, nullptr, &size, src_dc, &src, 0, &bf,
                           ULW_ALPHA);
  Sleep(400);
  lum = LumAt(screen_dc, 130, 130);
  wprintf(L"[GetDC(fg)+null]   ulw=%d gle=%lu lum=%.0f %s\n", ok, ok ? 0 : GetLastError(),
          lum, lum > 50 ? L"ALPHA OK" : L"ALPHA IGNORED");
  ReleaseDC(fg, fg_dc);
  ReleaseDC(nullptr, screen_dc);

  wprintf(L"(white bg=255 expected; tint premul color=21; alpha195 over white=81)\n");
  return 0;
}
