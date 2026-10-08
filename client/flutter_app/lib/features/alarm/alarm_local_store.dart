/// 闹钟本地库 —— JSON 落盘（应用文档目录 alarm-clock.json）。
/// 本地调度是触发主路：App 被杀后由 Android AlarmManager / iOS 本地通知接管，
/// 本库是启动重建（rescheduleAll）与跨设备同步（alarm.sync）的落点。
library;

import "dart:convert";
import "dart:io";

import "package:path_provider/path_provider.dart";

import "alarm_models.dart";

class AlarmLocalStore {
  static AlarmLocalStore? _instance;
  static AlarmLocalStore get instance => _instance ??= AlarmLocalStore._();

  AlarmLocalStore._();

  final Map<String, Alarm> _alarms = {};
  File? _file;

  Future<void> load() async {
    try {
      final dir = await getApplicationDocumentsDirectory();
      _file = File("${dir.path}${Platform.pathSeparator}alarm-clock.json");
      if (await _file!.exists()) {
        final raw = jsonDecode(await _file!.readAsString()) as Map<dynamic, dynamic>;
        final list = (raw["alarms"] as List?) ?? const [];
        for (final item in list) {
          try {
            final a = Alarm.fromJson((item as Map).cast<String, dynamic>());
            _alarms[a.id] = a;
          } catch (_) {/* 单条脏数据不拖垮整体 */}
        }
      }
    } catch (_) {
      _file = null;
    }
  }

  Future<void> _flush() async {
    try {
      _file ??= File(
        "${(await getApplicationDocumentsDirectory()).path}${Platform.pathSeparator}alarm-clock.json",
      );
      await _file!.writeAsString(jsonEncode({
        "alarms": _alarms.values.map((a) => a.toJson()).toList(),
      }));
    } catch (_) {/* 磁盘不可写时静默，内存态仍可用 */}
  }

  List<Alarm> listActive() =>
      _alarms.values.where((a) => a.status == AlarmStatus.active).toList(growable: false);

  List<Alarm> listAll() => _alarms.values.toList(growable: false);

  Alarm? get(String id) => _alarms[id];

  /// 跨设备同步 upsert（服务端为事实源）
  Future<Alarm> upsertFromServer(Alarm alarm) async {
    _alarms[alarm.id] = alarm;
    await _flush();
    return alarm;
  }

  Future<void> cancel(String id) async {
    final a = _alarms[id];
    if (a == null) return;
    a.status = AlarmStatus.canceled;
    await _flush();
  }

  /// 本地触发后推进：重复闹钟按 RRULE 自算下一跳（与服务端双算互验），单次置 done
  Future<void> markFired(String id, {required DateTime now}) async {
    final a = _alarms[id];
    if (a == null) return;
    final anchor = DateTime.tryParse(a.fireAt);
    if (a.repeatRule != null && a.repeatRule!.isNotEmpty && anchor != null) {
      final next = nextRruleOccurrence(a.repeatRule!, anchor, now);
      a.nextFireAt = next?.toIso8601String();
      a.snoozeCount = 0;
      a.status = next != null ? AlarmStatus.active : AlarmStatus.done;
    } else {
      a.status = AlarmStatus.done;
      a.nextFireAt = null;
    }
    await _flush();
  }

  Future<void> applySnooze(String id, int minutes) async {
    final a = _alarms[id];
    if (a == null) return;
    final base = DateTime.tryParse(a.nextFireAt ?? a.fireAt) ?? DateTime.now();
    a.nextFireAt = base.add(Duration(minutes: minutes)).toIso8601String();
    a.snoozeCount += 1;
    await _flush();
  }
}
