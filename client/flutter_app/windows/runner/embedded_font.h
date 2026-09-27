#ifndef RUNNER_EMBEDDED_FONT_H_
#define RUNNER_EMBEDDED_FONT_H_

#include <windows.h>

#include <string>
#include <vector>

// 与 in-app 主字体同源（pubspec.yaml 内嵌的 MiSans）。
// GDI 用不了 Flutter 的 asset 字体，这里从 flutter_assets 目录把
// MiSans 各字重 OTF 以进程私有方式注册进 GDI；资源缺失时回退
// in-app 字体回退链的 Windows 项（Microsoft YaHei，app_theme.dart）。
// 不回退 Segoe UI：它无中文字形，中文会落到宋体，与主界面观感割裂。
// （原属 schedule_floating_window.cpp；悬浮窗删除后由灵动岛窗口沿用。）

inline bool g_misans_ready = false;  // 至少成功注册一个 MiSans 字重

inline void LoadEmbeddedMiSans() {
  static bool tried = false;
  if (tried) return;
  tried = true;
  wchar_t exe_path[MAX_PATH]{};
  if (GetModuleFileNameW(nullptr, exe_path, MAX_PATH) == 0) return;
  std::wstring dir(exe_path);
  const size_t slash = dir.find_last_of(L"\\/");
  if (slash == std::wstring::npos) return;
  dir.resize(slash + 1);
  const wchar_t* kWeightFiles[] = {
      L"MiSans-Regular.otf", L"MiSans-Medium.otf",
      L"MiSans-Semibold.otf", L"MiSans-Bold.otf"};
  for (const wchar_t* name : kWeightFiles) {
    HANDLE file = CreateFileW(
        (dir + L"data\\flutter_assets\\assets\\fonts\\" + name).c_str(),
        GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) continue;
    LARGE_INTEGER size{};
    if (GetFileSizeEx(file, &size) && size.QuadPart > 0 &&
        size.QuadPart < 64 * 1024 * 1024) {
      std::vector<unsigned char> buf(static_cast<size_t>(size.QuadPart));
      DWORD read = 0;
      if (ReadFile(file, buf.data(), static_cast<DWORD>(buf.size()), &read,
                   nullptr) &&
          read == buf.size()) {
        DWORD count = 0;
        // 进程私有注册（无需 RemoveFontMemResourceEx，随进程退出释放）
        if (AddFontMemResourceEx(buf.data(), read, nullptr, &count) != nullptr) {
          g_misans_ready = true;
        }
      }
    }
    CloseHandle(file);
  }
}

inline const wchar_t* UiFontFamily() {
  return g_misans_ready ? L"MiSans" : L"Microsoft YaHei";
}

inline bool g_noto_ready = false;  // 思源黑体至少成功注册一个字重（岛专用）

// 岛专用：从 assets/fonts/noto 加载思源黑体（Regular/Medium/Bold）。
// 与 MiSans 机制相同（AddFontMemResourceEx 进程私有注册）。
inline void LoadIslandNotoFonts() {
  static bool tried = false;
  if (tried) return;
  tried = true;
  wchar_t exe_path[MAX_PATH]{};
  if (GetModuleFileNameW(nullptr, exe_path, MAX_PATH) == 0) return;
  std::wstring dir(exe_path);
  const size_t slash = dir.find_last_of(L"\\/");
  if (slash == std::wstring::npos) return;
  dir.resize(slash + 1);
  const wchar_t* kWeightFiles[] = {
      L"NotoSansSC-Regular.otf", L"NotoSansSC-Medium.otf",
      L"NotoSansSC-Bold.otf"};
  for (const wchar_t* name : kWeightFiles) {
    HANDLE file = CreateFileW(
        (dir + L"data\\flutter_assets\\assets\\fonts\\noto\\" + name).c_str(),
        GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) continue;
    LARGE_INTEGER size{};
    if (GetFileSizeEx(file, &size) && size.QuadPart > 0 &&
        size.QuadPart < 64 * 1024 * 1024) {
      std::vector<unsigned char> buf(static_cast<size_t>(size.QuadPart));
      DWORD read = 0;
      if (ReadFile(file, buf.data(), static_cast<DWORD>(buf.size()), &read,
                   nullptr) &&
          read == buf.size()) {
        DWORD count = 0;
        if (AddFontMemResourceEx(buf.data(), read, nullptr, &count) != nullptr) {
          g_noto_ready = true;
        }
      }
    }
    CloseHandle(file);
  }
}

inline const wchar_t* IslandFontFamily() {
  LoadIslandNotoFonts();
  // 注意：GDI 枚举族名是 "Noto Sans SC"（Regular/Bold 按字重匹配），
  // 不是 DirectWrite 视角的 "Noto Sans CJK SC"——用后者 DrawString 会静默画空。
  if (g_noto_ready) return L"Noto Sans SC";
  return UiFontFamily();  // 回退 MiSans → Microsoft YaHei
}

#endif  // RUNNER_EMBEDDED_FONT_H_
