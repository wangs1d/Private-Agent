#include "desktop_screen_capture.h"

#include <windows.h>
#include <gdiplus.h>

#include <cstdint>
#include <memory>
#include <sstream>

namespace {

ULONG_PTR g_gdiplus_token = 0;
bool g_gdiplus_started = false;

bool EnsureGdiplus() {
  if (g_gdiplus_started) return true;
  Gdiplus::GdiplusStartupInput input;
  if (Gdiplus::GdiplusStartup(&g_gdiplus_token, &input, nullptr) != Gdiplus::Ok) {
    return false;
  }
  g_gdiplus_started = true;
  return true;
}

int GetEncoderClsid(const WCHAR* format, CLSID* pClsid) {
  UINT num = 0;
  UINT size = 0;
  Gdiplus::GetImageEncodersSize(&num, &size);
  if (size == 0) return -1;
  auto codecs = std::make_unique<Gdiplus::ImageCodecInfo[]>(num);
  Gdiplus::GetImageEncoders(num, size, codecs.get());
  for (UINT i = 0; i < num; ++i) {
    if (wcscmp(codecs[i].MimeType, format) == 0) {
      *pClsid = codecs[i].Clsid;
      return static_cast<int>(i);
    }
  }
  return -1;
}

class IStreamWriter : public IStream {
 public:
  explicit IStreamWriter(std::vector<uint8_t>* out) : out_(out), ref_(1) {}

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == IID_IUnknown || riid == IID_IStream || riid == IID_ISequentialStream) {
      *ppv = static_cast<IStream*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }

  ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&ref_); }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG c = InterlockedDecrement(&ref_);
    if (c == 0) delete this;
    return c;
  }

  HRESULT STDMETHODCALLTYPE Read(void*, ULONG, ULONG*) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE Write(const void* pv, ULONG cb, ULONG* pcbWritten) override {
    const auto* bytes = static_cast<const uint8_t*>(pv);
    out_->insert(out_->end(), bytes, bytes + cb);
    if (pcbWritten) *pcbWritten = cb;
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE Seek(LARGE_INTEGER, DWORD, ULARGE_INTEGER*) override {
    return E_NOTIMPL;
  }
  HRESULT STDMETHODCALLTYPE SetSize(ULARGE_INTEGER) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE CopyTo(IStream*, ULARGE_INTEGER, ULARGE_INTEGER*,
                                 ULARGE_INTEGER*) override {
    return E_NOTIMPL;
  }
  HRESULT STDMETHODCALLTYPE Commit(DWORD) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE Revert() override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE LockRegion(ULARGE_INTEGER, ULARGE_INTEGER, DWORD) override {
    return E_NOTIMPL;
  }
  HRESULT STDMETHODCALLTYPE UnlockRegion(ULARGE_INTEGER, ULARGE_INTEGER, DWORD) override {
    return E_NOTIMPL;
  }
  HRESULT STDMETHODCALLTYPE Stat(STATSTG* p, DWORD) override {
    if (!p) return E_POINTER;
    p->type = STGTY_STREAM;
    p->cbSize.QuadPart = static_cast<ULONGLONG>(out_->size());
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE Clone(IStream**) override { return E_NOTIMPL; }

 private:
  std::vector<uint8_t>* out_;
  LONG ref_;
};

}  // namespace

std::optional<DesktopScreenshotResult> CaptureDesktopPng(
    std::optional<int> left,
    std::optional<int> top,
    std::optional<int> width,
    std::optional<int> height) {
  DesktopScreenshotResult result;
  if (!EnsureGdiplus()) {
    result.error = "GDI+ init failed";
    return result;
  }

  const int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
  const int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
  const int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
  const int vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);

  int cap_left = left.value_or(vx);
  int cap_top = top.value_or(vy);
  int cap_w = width.value_or(vw);
  int cap_h = height.value_or(vh);
  if (cap_w <= 0 || cap_h <= 0) {
    result.error = "invalid capture size";
    return result;
  }

  HDC screen_dc = GetDC(nullptr);
  if (!screen_dc) {
    result.error = "GetDC failed";
    return result;
  }

  HDC mem_dc = CreateCompatibleDC(screen_dc);
  if (!mem_dc) {
    ReleaseDC(nullptr, screen_dc);
    result.error = "CreateCompatibleDC failed";
    return result;
  }

  HBITMAP bmp = CreateCompatibleBitmap(screen_dc, cap_w, cap_h);
  if (!bmp) {
    DeleteDC(mem_dc);
    ReleaseDC(nullptr, screen_dc);
    result.error = "CreateCompatibleBitmap failed";
    return result;
  }

  HGDIOBJ old = SelectObject(mem_dc, bmp);
  if (!BitBlt(mem_dc, 0, 0, cap_w, cap_h, screen_dc, cap_left, cap_top, SRCCOPY)) {
    SelectObject(mem_dc, old);
    DeleteObject(bmp);
    DeleteDC(mem_dc);
    ReleaseDC(nullptr, screen_dc);
    result.error = "BitBlt failed";
    return result;
  }

  SelectObject(mem_dc, old);
  ReleaseDC(nullptr, screen_dc);
  DeleteDC(mem_dc);

  std::unique_ptr<Gdiplus::Bitmap> bitmap(
      Gdiplus::Bitmap::FromHBITMAP(bmp, nullptr));
  DeleteObject(bmp);
  if (!bitmap || bitmap->GetLastStatus() != Gdiplus::Ok) {
    result.error = "Bitmap::FromHBITMAP failed";
    return result;
  }

  CLSID png_clsid;
  if (GetEncoderClsid(L"image/png", &png_clsid) < 0) {
    result.error = "PNG encoder not found";
    return result;
  }

  std::vector<uint8_t> png;
  IStreamWriter* stream = new IStreamWriter(&png);
  if (bitmap->Save(stream, &png_clsid, nullptr) != Gdiplus::Ok) {
    stream->Release();
    result.error = "Bitmap::Save failed";
    return result;
  }
  stream->Release();

  if (png.empty()) {
    result.error = "empty PNG";
    return result;
  }

  result.ok = true;
  result.png_bytes = std::move(png);
  result.width = cap_w;
  result.height = cap_h;
  return result;
}
