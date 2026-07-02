#ifndef RUNNER_WINDOW_POSITION_STORE_H_
#define RUNNER_WINDOW_POSITION_STORE_H_

#include <windows.h>
#include <shlobj.h>
#include <string>

/// 窗口位置持久化存储（INI 文件，header-only）。
///
/// 文件路径：%APPDATA%\PrivateAgent\window_positions.ini
/// 每个 section 对应一个窗口，保存 x / y / width / height。
///
/// 用法：
///   window_position_store::LoadRect(L"schedule_floating", rc);
///   window_position_store::SaveRect(L"schedule_floating", rc);
namespace window_position_store {

/// 获取 INI 文件完整路径（确保目录存在）。
inline std::wstring GetIniPath() {
  wchar_t path[MAX_PATH] = {};
  if (SUCCEEDED(SHGetFolderPathW(nullptr, CSIDL_APPDATA, nullptr, 0, path))) {
    std::wstring dir = std::wstring(path) + L"\\PrivateAgent";
    CreateDirectoryW(dir.c_str(), nullptr);
    return dir + L"\\window_positions.ini";
  }
  return L"window_positions.ini";
}

/// 检查矩形是否至少部分落在某个显示器上（防止显示器配置变更后窗口跑到屏幕外）。
inline bool IsOnScreen(const RECT& rc) {
  // 用矩形中心点判断
  POINT center = {(rc.left + rc.right) / 2, (rc.top + rc.bottom) / 2};
  HMONITOR mon = MonitorFromPoint(center, MONITOR_DEFAULTTONULL);
  if (mon) return true;
  // 中心点不在任何显示器上，再用左上角试一次
  POINT tl = {rc.left, rc.top};
  return MonitorFromPoint(tl, MONITOR_DEFAULTTONULL) != nullptr;
}

/// 从 INI 加载已保存的窗口矩形。
/// 返回 true 表示加载成功且位置有效（在屏幕内）。
inline bool LoadRect(const wchar_t* section, RECT& out) {
  std::wstring ini = GetIniPath();
  int x = GetPrivateProfileIntW(section, L"x", -1, ini.c_str());
  int y = GetPrivateProfileIntW(section, L"y", -1, ini.c_str());
  int w = GetPrivateProfileIntW(section, L"width", -1, ini.c_str());
  int h = GetPrivateProfileIntW(section, L"height", -1, ini.c_str());
  if (x < 0 || y < 0 || w <= 0 || h <= 0) return false;
  out = {x, y, x + w, y + h};
  return IsOnScreen(out);
}

/// 保存窗口矩形到 INI。
inline void SaveRect(const wchar_t* section, const RECT& rc) {
  std::wstring ini = GetIniPath();
  WritePrivateProfileStringW(section, L"x",
      std::to_wstring(rc.left).c_str(), ini.c_str());
  WritePrivateProfileStringW(section, L"y",
      std::to_wstring(rc.top).c_str(), ini.c_str());
  WritePrivateProfileStringW(section, L"width",
      std::to_wstring(rc.right - rc.left).c_str(), ini.c_str());
  WritePrivateProfileStringW(section, L"height",
      std::to_wstring(rc.bottom - rc.top).c_str(), ini.c_str());
}

/// 获取主显示器工作区（不含任务栏）。
inline RECT GetPrimaryWorkArea() {
  RECT work{};
  SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
  return work;
}

}  // namespace window_position_store

#endif  // RUNNER_WINDOW_POSITION_STORE_H_
