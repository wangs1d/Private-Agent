// Probe: does GDI+ write the alpha byte correctly into a PARGB bitmap
// wrapped over external DIB memory? Prints raw BGRA of a few pixels.
#include <windows.h>
#include <gdiplus.h>
#include <stdio.h>

#pragma comment(lib, "gdiplus.lib")
#pragma comment(lib, "gdi32.lib")

int wmain() {
  ULONG_PTR token = 0;
  Gdiplus::GdiplusStartupInput input;
  Gdiplus::GdiplusStartup(&token, &input, nullptr);

  const int w = 8, h = 1;
  BYTE* bits = nullptr;
  BITMAPINFO bmi = {};
  bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bmi.bmiHeader.biWidth = w;
  bmi.bmiHeader.biHeight = -h;
  bmi.bmiHeader.biPlanes = 1;
  bmi.bmiHeader.biBitCount = 32;
  bmi.bmiHeader.biCompression = BI_RGB;
  HBITMAP dib = CreateDIBSection(nullptr, &bmi, DIB_RGB_COLORS,
                                 reinterpret_cast<void**>(&bits), nullptr, 0);
  if (!dib) { wprintf(L"dib failed\n"); return 1; }
  memset(bits, 0, w * 4 * h);  // clean transparent dest

  Gdiplus::Bitmap bmp(w, h, w * 4, PixelFormat32bppPARGB, bits);
  Gdiplus::Graphics* g = Gdiplus::Graphics::FromImage(&bmp);
  g->SetSmoothingMode(Gdiplus::SmoothingModeNone);
  g->SetPixelOffsetMode(Gdiplus::PixelOffsetModeHalf);

  // 1) solid brush with alpha 195 (the card base path), exact pixel
  Gdiplus::SolidBrush solid(Gdiplus::Color(195, 0x1C, 0x1C, 0x21));
  g->FillRectangle(&solid, 0, 0, 2, 1);
  // 2) linear gradient brush with alpha 195 (DrawGlassBase path), exact pixel
  const Gdiplus::RectF full(2.0f, 0.0f, 2.0f, 1.0f);
  Gdiplus::LinearGradientBrush grad(
      full, Gdiplus::Color(195, 0x1C, 0x1C, 0x21),
      Gdiplus::Color(178, 0x10, 0x10, 0x13), 90.0f);
  g->FillRectangle(&grad, full);
  // 3) opaque disc (content path), exact pixel
  Gdiplus::SolidBrush opaque(Gdiplus::Color(255, 0xF2, 0xF2, 0xF4));
  g->FillRectangle(&opaque, 4, 0, 2, 1);
  delete g;

  for (int x = 0; x < w; ++x) {
    const BYTE* px = bits + x * 4;
    wprintf(L"px%d: B=%3d G=%3d R=%3d A=%3d\n", x, px[0], px[1], px[2], px[3]);
  }
  wprintf(L"expect px0-1: 21,21,28,195 | px2-3: gradient ~21..11 alpha ~195..178 | px4-5: 242,242,242,255 | px6-7: 0,0,0,0\n");
  return 0;
}
