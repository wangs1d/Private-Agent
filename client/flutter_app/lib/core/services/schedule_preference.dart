import "dart:convert";
import "dart:io";

import "package:flutter/foundation.dart";
import "package:path_provider/path_provider.dart";

/// 日程显示模式偏好
enum ScheduleDisplayMode {
  /// 应用内嵌（默认）— 日程显示在应用侧边栏/浮动面板中
  embedded,

  /// 桌面独立悬浮窗 — 通过 Electron 启动独立桌面窗口
  desktopFloating,
}

/// 用户日程显示偏好持久化
///
/// 使用 JSON 文件存储在应用数据目录，无需修改 Isar schema。
class SchedulePreference {
  SchedulePreference._();

  static const String _fileName = "schedule_preference.json";
  static ScheduleDisplayMode? _cachedMode;

  /// 获取用户选择的日程显示模式（带缓存）
  static Future<ScheduleDisplayMode> getDisplayMode() async {
    if (_cachedMode != null) return _cachedMode!;

    try {
      final File prefFile = await _getPrefFile();
      if (!await prefFile.exists()) {
        return ScheduleDisplayMode.embedded; // 默认值
      }

      final String raw = await prefFile.readAsString();
      final Map<String, dynamic> json = jsonDecode(raw) as Map<String, dynamic>;
      final String? modeStr = json["displayMode"] as String?;

      if (modeStr == "desktopFloating") {
        _cachedMode = ScheduleDisplayMode.desktopFloating;
      } else {
        _cachedMode = ScheduleDisplayMode.embedded;
      }
    } catch (e) {
      debugPrint("[SchedulePref] read failed: $e");
      _cachedMode = ScheduleDisplayMode.embedded;
    }

    return _cachedMode!;
  }

  /// 保存用户选择的日程显示模式
  static Future<void> setDisplayMode(ScheduleDisplayMode mode) async {
    _cachedMode = mode;

    try {
      final File prefFile = await _getPrefFile();
      final Directory parentDir = prefFile.parent;
      if (!await parentDir.exists()) {
        await parentDir.create(recursive: true);
      }

      final Map<String, String> json = <String, String>{
        "displayMode": mode == ScheduleDisplayMode.desktopFloating
            ? "desktopFloating"
            : "embedded",
        "updatedAt": DateTime.now().toIso8601String(),
      };

      await prefFile.writeAsString(
        const JsonEncoder.withIndent("  ").convert(json),
        flush: true,
      );
    } catch (e) {
      debugPrint("[SchedulePref] save failed: $e");
    }
  }

  /// 重置为默认（应用内嵌）
  static Future<void> reset() async {
    await setDisplayMode(ScheduleDisplayMode.embedded);
  }

  /// 是否为桌面悬浮窗模式
  static bool get isDesktopFloating => _cachedMode == ScheduleDisplayMode.desktopFloating;

  /// 获取偏好文件路径
  static Future<File> _getPrefFile() async {
    final Directory appDir = await getApplicationSupportDirectory();
    final String dirPath =
        "${appDir.path}${Platform.pathSeparator}private_ai_agent";
    return File("$dirPath${Platform.pathSeparator}$_fileName");
  }

  /// 清除缓存（用于测试或热重启后）
  static void clearCache() {
    _cachedMode = null;
  }
}
