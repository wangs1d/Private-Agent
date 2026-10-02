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

inline bool g_noto_ready = false;        // Regular+Bold 基础族至少注册成功
inline bool g_noto_medium_ready = false; // Medium 字重文件注册成功（独立 GDI 族名）

// 岛专用：从 assets/fonts/noto 加载思源黑体（Regular/Medium/Bold）。
// 必须用 AddFontResourceExW(0) 会话级全局加载，不能用 AddFontMemResourceEx
// 进程私有内存注册：岛的文字走 GDI+ DrawString，而 GDI+ 的族名解析不认
// 内存注册字体——构造出的 Font 静默画空（整岛无字，取证见
// build/island-font-ab.png 右列）；会话级加载 GDI/GDI+ 双侧可见，
// GdiplusStartup 之后追加也生效，随重启自然清理。
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
    const std::wstring full =
        dir + L"data\\flutter_assets\\assets\\fonts\\noto\\" + name;
    if (AddFontResourceExW(full.c_str(), 0, nullptr) > 0) {
      if (wcsstr(name, L"Medium") != nullptr) {
        g_noto_medium_ready = true;
      } else {
        g_noto_ready = true;
      }
    }
  }
}

inline bool g_harmonyos_ready = false;        // Bold 基础族注册成功
inline bool g_harmonyos_medium_ready = false; // Medium 独立族注册成功

// 岛专用主字体：HarmonyOS Sans SC（2026-10-01 用户定调换字体——比思源
// 黑体字腔大、x-height 高，小字号黑底更清晰饱满）。加载方式与 Noto 同：
// 必须 AddFontResourceExW(0) 会话级全局加载——GDI+ 族名解析不认进程私有
// 内存注册（画空，见 LoadIslandNotoFonts 注释）。
inline void LoadIslandHarmonyosFonts() {
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
      L"HarmonyOS_Sans_SC_Medium.ttf", L"HarmonyOS_Sans_SC_Bold.ttf"};
  for (const wchar_t* name : kWeightFiles) {
    const std::wstring full =
        dir + L"data\\flutter_assets\\assets\\fonts\\harmonyos\\" + name;
    if (AddFontResourceExW(full.c_str(), 0, nullptr) > 0) {
      if (wcsstr(name, L"Medium") != nullptr) {
        g_harmonyos_medium_ready = true;
      } else {
        g_harmonyos_ready = true;
      }
    }
  }
}

inline const wchar_t* IslandFontFamily() {
  LoadIslandHarmonyosFonts();
  LoadIslandNotoFonts();
  // 族名以字体文件 name 表为准（PrivateFontCollection 实测 2026-10-01）：
  // HarmonyOS Bold TTF 基础族 = "HarmonyOS Sans SC"（单 Bold 面，GDI
  // 任意字重请求都匹配到它）。
  if (g_harmonyos_ready) return L"HarmonyOS Sans SC";
  if (g_noto_ready) return L"Noto Sans CJK SC";
  return UiFontFamily();  // 回退 MiSans → Microsoft YaHei
}

// Medium 在 GDI 的 RIBBI 规则下是独立族名（nameID1，实测
// "HarmonyOS Sans SC Medium"）：基础族收到 <600 的字重请求不会选出
// Medium。<550 的字重文字必须显式点名这个族。
inline const wchar_t* IslandFontFamilyMedium() {
  LoadIslandHarmonyosFonts();
  LoadIslandNotoFonts();
  if (g_harmonyos_medium_ready) return L"HarmonyOS Sans SC Medium";
  if (g_noto_medium_ready) return L"Noto Sans CJK SC Medium";
  return IslandFontFamily();
}

#endif  // RUNNER_EMBEDDED_FONT_H_
