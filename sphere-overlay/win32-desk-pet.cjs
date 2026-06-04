/**
 * 关闭 Win11 圆角矩形外框（避免「透明卡片」感）。
 * 不再用 SetWindowRgn 裁剪 — 椭圆裁剪会把球体切掉一半。
 */
function applyDeskPetShell(browserWindow) {
  if (process.platform !== "win32" || !browserWindow || browserWindow.isDestroyed()) {
    return false;
  }

  try {
    const koffi = require("koffi");
    const dwmapi = koffi.load("dwmapi.dll");
    const hwnd = koffi.decode(browserWindow.getNativeWindowHandle(), "intptr");

    const DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    const DWMWCP_DONOTROUND = 1;
    const DwmSetWindowAttribute = dwmapi.func(
      "HRESULT __stdcall DwmSetWindowAttribute(intptr hwnd, uint32 attr, void *value, uint32 size)",
    );
    const cornerPref = Buffer.alloc(4);
    cornerPref.writeInt32LE(DWMWCP_DONOTROUND, 0);
    DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, cornerPref, 4);
    return true;
  } catch (err) {
    console.warn("[desk-pet-shell] apply failed:", err?.message || err);
    return false;
  }
}

module.exports = { applyDeskPetShell };
