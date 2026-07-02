import "dart:async";
import "dart:convert";
import "dart:io";

import "package:path_provider/path_provider.dart";

/// 右抽屉与左聊天区的分屏比例持久化。
///
/// 默认 0.5(各占一半),拖动后会写盘,下次启动恢复。
/// 失败时(无 path_provider / 无写权限)退回默认,不抛异常。
class SplitRatioPreference {
  SplitRatioPreference._();

  /// 默认各占一半
  static const double defaultRatio = 0.5;

  /// 左聊天区最小宽度(像素)
  static const double minLeftWidth = 400;

  /// 右抽屉最小宽度(像素)
  static const double minRightWidth = 420;

  static const String _fileName = "split_ratio_preference.json";
  static const String _key = "leftRatio";

  static File? _file;
  static double? _cached;

  /// 加载分屏比例;返回 [defaultRatio] 时表示使用默认值。
  static Future<double> load() async {
    if (_cached != null) return _cached!;
    try {
      _file ??= await _resolveFile();
      final File? f = _file;
      if (f == null || !f.existsSync()) {
        _cached = defaultRatio;
        return _cached!;
      }
      final Object? raw = jsonDecode(f.readAsStringSync());
      if (raw is Map && raw[_key] is num) {
        final double v = (raw[_key] as num).toDouble();
        // 防御: 0~1 之间
        _cached = v.clamp(0.1, 0.9);
        return _cached!;
      }
      _cached = defaultRatio;
      return _cached!;
    } catch (e) {
      // 兜底: 任意 IO/解析错误,使用默认值
      _cached = defaultRatio;
      return _cached!;
    }
  }

  /// 保存分屏比例。
  static Future<void> save(double leftRatio) async {
    _cached = leftRatio;
    try {
      _file ??= await _resolveFile();
      final File? f = _file;
      if (f == null) return;
      await f.writeAsString(jsonEncode(<String, Object?>{_key: leftRatio}));
    } catch (_) {
      // 写失败忽略,下次再写
    }
  }

  static Future<File?> _resolveFile() async {
    try {
      final Directory dir = await getApplicationDocumentsDirectory();
      return File("${dir.path}/$_fileName");
    } catch (_) {
      return null;
    }
  }
}
