import "dart:convert";

import "package:http/http.dart" as http;

import "../config/api_config.dart";

/// 用户作息偏好（分级提醒的习惯源）。
///
/// 服务端 `GET/PUT/DELETE /api/schedule/sleep-routine`。设一次「平时几点睡、
/// 几点起」，分级提醒策略即按此个性化睡前备忘与起床闹钟。小时为十进制本地
/// 小时（1.5 = 01:30）。
///
/// 作息有两条来源，设置页如实告知用户是哪一条：
///   - `routine`：用户自己填的（权威，优先）；
///   - `observed`：agent 观察「用户什么时候在线」推出来的（见
///     `server/src/rhythm/presence-footprint-store.ts`，需 ≥3 个有效夜）。
class SleepRoutine {
  const SleepRoutine({
    required this.sleepStartHour,
    required this.wakeHour,
    required this.source,
  });

  final double sleepStartHour;
  final double wakeHour;
  final String source;

  static SleepRoutine? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final Object? s = raw["sleepStartHour"];
    final Object? w = raw["wakeHour"];
    if (s is! num || w is! num) return null;
    return SleepRoutine(
      sleepStartHour: s.toDouble(),
      wakeHour: w.toDouble(),
      source: raw["source"]?.toString() ?? "explicit",
    );
  }
}

/// agent 被动观察到的作息（「用户在线 ⇒ 用户醒着」推出来的）。
class ObservedRoutine {
  const ObservedRoutine({
    required this.sleepStartHour,
    required this.wakeHour,
    required this.nightCount,
    required this.dayCount,
    required this.enoughNights,
  });

  /// 观察到的入睡点，null = 还没推出来
  final double? sleepStartHour;

  /// 观察到的起床点，null = 还没推出来（如白天不用 agent）
  final double? wakeHour;

  /// 有效夜数（凑够 3 个才采信）
  final int nightCount;

  /// 有记录的天数
  final int dayCount;
  final bool enoughNights;

  static ObservedRoutine? fromJson(Object? raw) {
    if (raw is! Map) return null;
    int intOf(Object? v) => v is num ? v.toInt() : 0;
    double? doubleOf(Object? v) => v is num ? v.toDouble() : null;
    return ObservedRoutine(
      sleepStartHour: doubleOf(raw["sleepStartHour"]),
      wakeHour: doubleOf(raw["wakeHour"]),
      nightCount: intOf(raw["nightCount"]),
      dayCount: intOf(raw["dayCount"]),
      enoughNights: raw["enoughNights"] == true,
    );
  }
}

/// 设置页一次性拿到：用户填的作息 + agent 观察到的作息。
class SleepRoutineSnapshot {
  const SleepRoutineSnapshot({this.routine, this.observed});

  final SleepRoutine? routine;
  final ObservedRoutine? observed;
}

class SleepRoutineApi {
  SleepRoutineApi({http.Client? client, String? baseUrl})
      : _client = client ?? http.Client(),
        baseUrl = baseUrl ?? ApiConfig.httpBase;

  final String baseUrl;
  final http.Client _client;

  static const Duration _timeout = Duration(seconds: 10);

  Uri _uri([Map<String, String>? query]) {
    final Uri root = Uri.parse(baseUrl);
    final Uri u = root.resolve("api/schedule/sleep-routine");
    return query == null ? u : u.replace(queryParameters: query);
  }

  Future<SleepRoutineSnapshot?> fetch() async {
    try {
      final http.Response r = await _client
          .get(_uri(<String, String>{"sessionId": ApiConfig.effectiveActorId}))
          .timeout(_timeout);
      if (r.statusCode < 200 || r.statusCode >= 300) return null;
      final Object? data = jsonDecode(utf8.decode(r.bodyBytes));
      if (data is Map && data["ok"] == true) {
        return SleepRoutineSnapshot(
          routine: SleepRoutine.fromJson(data["routine"]),
          observed: ObservedRoutine.fromJson(data["observed"]),
        );
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  Future<bool> save({
    required double sleepStartHour,
    required double wakeHour,
  }) async {
    try {
      final http.Response r = await _client
          .put(
            _uri(),
            headers: <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, Object>{
              "sessionId": ApiConfig.effectiveActorId,
              "sleepStartHour": sleepStartHour,
              "wakeHour": wakeHour,
            }),
          )
          .timeout(_timeout);
      return r.statusCode >= 200 && r.statusCode < 300;
    } catch (_) {
      return false;
    }
  }

  Future<bool> clear() async {
    try {
      final http.Response r = await _client
          .delete(
              _uri(<String, String>{"sessionId": ApiConfig.effectiveActorId}))
          .timeout(_timeout);
      return r.statusCode >= 200 && r.statusCode < 300;
    } catch (_) {
      return false;
    }
  }
}
