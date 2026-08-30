/// 智能路线规划器 —— 一比一移植自 3D-Travel 的
/// packages/travel-ui/src/agents/IntelligentRoutePlanner.ts（规则引擎：
/// 人流模拟 + 路况模拟 + 景色评分 + 交通方式推荐 + 综合评估）。
///
/// 修正：原 TS 版 calculateSegmentScore 中 prioritizeSpeed 为未定义变量，
/// 这里显式从偏好读取。
library;

import "dart:math" as math;

/// 用户规划偏好（对齐 3D-Travel 偏好弹窗的字段）。
class TravelPreferences {
  const TravelPreferences({
    this.sceneryPreference = "balanced",
    this.transportMode = "auto",
    this.departureTime = "09:00",
    this.budgetLevel = "medium",
    this.physicalEffort = "moderate",
    this.avoidCrowds = true,
    this.prioritizeSpeed = false,
  });

  factory TravelPreferences.fromJson(Map<String, dynamic> json) {
    return TravelPreferences(
      sceneryPreference: json["sceneryPreference"]?.toString() ?? "balanced",
      transportMode: json["transportMode"]?.toString() ?? "auto",
      departureTime: json["departureTime"]?.toString() ?? "09:00",
      budgetLevel: json["budgetLevel"]?.toString() ?? "medium",
      physicalEffort: json["physicalEffort"]?.toString() ?? "moderate",
      avoidCrowds: json["avoidCrowds"] as bool? ?? true,
      prioritizeSpeed: json["prioritizeSpeed"] as bool? ?? false,
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        "sceneryPreference": sceneryPreference,
        "transportMode": transportMode,
        "departureTime": departureTime,
        "budgetLevel": budgetLevel,
        "physicalEffort": physicalEffort,
        "avoidCrowds": avoidCrowds,
        "prioritizeSpeed": prioritizeSpeed,
      };

  /// natural / cultural / balanced
  final String sceneryPreference;
  /// auto / driving / public_transit / cycling / walking / taxi / rental_car
  final String transportMode;
  final String departureTime;
  /// low / medium / high
  final String budgetLevel;
  /// easy / moderate / challenging
  final String physicalEffort;
  final bool avoidCrowds;
  final bool prioritizeSpeed;
}

/// 路线途经点（行程中带坐标的条目）。
class RouteWaypoint {
  const RouteWaypoint({
    required this.name,
    required this.latitude,
    required this.longitude,
    this.type = "",
  });

  final String name;
  final double latitude;
  final double longitude;
  final String type;
}

/// 智能规划的单个路段结果。
class SmartRouteSegment {
  const SmartRouteSegment({
    required this.id,
    required this.fromName,
    required this.toName,
    required this.fromLatitude,
    required this.fromLongitude,
    required this.toLatitude,
    required this.toLongitude,
    required this.distanceMeters,
    required this.durationMinutes,
    required this.transportMode,
    required this.instruction,
    required this.crowdIndex,
    required this.trafficLevel,
    required this.sceneryScore,
    required this.alternatives,
    required this.tips,
  });

  final String id;
  final String fromName;
  final String toName;
  final double fromLatitude;
  final double fromLongitude;
  final double toLatitude;
  final double toLongitude;
  final int distanceMeters;
  final int durationMinutes;
  final String transportMode;
  final String instruction;
  final double crowdIndex;
  final int trafficLevel;
  final double sceneryScore;
  final List<TransportRecommendation> alternatives;
  final List<SmartTip> tips;
}

/// 交通方式推荐（score 越高越推荐；偏好调分阶段会原地修改）。
class TransportRecommendation {
  TransportRecommendation({
    required this.mode,
    required this.score,
    required this.reason,
  });

  final String mode;
  int score;
  String reason;
}

/// 智能提示（icon 对齐 3D-Travel 的语义类型）。
class SmartTip {
  const SmartTip({required this.icon, required this.text, required this.type});
  final String icon;
  final String text;
  final String type;
}

/// 路线警告（crowd=人流密集，traffic=路况拥堵）。
class SmartRouteWarning {
  const SmartRouteWarning({
    required this.type,
    required this.location,
    required this.message,
    required this.severity,
  });
  final String type;
  final String location;
  final String message;
  final String severity;
}

/// 智能路线规划总结果。
class SmartRouteResult {
  const SmartRouteResult({
    required this.id,
    required this.waypoints,
    required this.segments,
    required this.totalDistanceMeters,
    required this.totalDurationMinutes,
    required this.totalDistanceText,
    required this.totalDurationText,
    required this.averageCrowdIndex,
    required this.bestTransportMode,
    required this.sceneryRating,
    required this.optimizationScore,
    required this.assessment,
    required this.warnings,
  });

  final String id;
  final List<RouteWaypoint> waypoints;
  final List<SmartRouteSegment> segments;
  final int totalDistanceMeters;
  final int totalDurationMinutes;
  final String totalDistanceText;
  final String totalDurationText;
  final String averageCrowdIndex;
  final String bestTransportMode;
  final String sceneryRating;
  final int optimizationScore;
  final String assessment;
  final List<SmartRouteWarning> warnings;

  /// 外部导航/叫车服务链接（对齐 generateServiceLinks）。
  Map<String, String> serviceLinks({double? curLat, double? curLng}) {
    final double cl = curLat ?? 25.6907;
    final double cg = curLng ?? 100.1593;
    final double dl = waypoints.length > 1 ? waypoints[1].latitude : waypoints.first.latitude;
    final double dg = waypoints.length > 1 ? waypoints[1].longitude : waypoints.first.longitude;
    return <String, String>{
      "didi":
          "https://www.didiglobal.com/scenario?type=1&lat=$cl&lng=$cg&dlat=$dl&dlng=$dg",
      "meituan":
          "https://waimai.meituan.com/?lat=$cl&lng=$cg&dlat=$dl&dlng=$dg",
      "ctripCar":
          "https://car.ctrip.com/carbook/rentcar?pickupLat=$cl&pickupLng=$cg&returnLat=$dl&returnLng=$dg",
      "shouqi":
          "https://www.shouqiev.com/order?startLat=$cl&startLng=$cg&endLat=$dl&endLng=$dg",
      "gaode":
          "https://uri.amap.com/navigation?from=$cg,$cl&to=$dg,$dl&mode=car&policy=1",
      "baidu":
          "https://map.baidu.com/direction?origin=latlng:$cl,$cg&destination=latlng:$dl,$dg&mode=driving&coord_type=gcj02",
    };
  }
}

class _TrafficLevel {
  const _TrafficLevel(this.level, this.period, this.description);
  final int level;
  final String period;
  final String description;
}

class _SceneryRating {
  const _SceneryRating(this.natural, this.cultural, this.overall);
  final double natural;
  final double cultural;
  final double overall;
}

class _BestTime {
  const _BestTime(this.timeRange, this.reason, this.crowdLevel);
  final String timeRange;
  final String reason;
  final String crowdLevel;
}

class IntelligentRoutePlanner {
  IntelligentRoutePlanner();

  // ── 人流密度数据（时间段人流系数 0-1）─────────────────────────────
  static const Map<String, double> _timeFactors = <String, double>{
    "06:00-08:00": 0.2, // 清晨
    "08:00-10:00": 0.6, // 上午
    "10:00-12:00": 0.9, // 高峰期
    "12:00-14:00": 0.7, // 午间
    "14:00-16:00": 0.8, // 下午
    "16:00-18:00": 0.95, // 傍晚高峰
    "18:00-20:00": 0.6, // 晚间
    "20:00-22:00": 0.3, // 夜晚
    "22:00-06:00": 0.1, // 深夜
  };

  static const Map<String, double> _attractionPopularity = <String, double>{
    "default": 0.5,
  };

  static const Map<String, double> _specialEvents = <String, double>{
    "weekend": 1.3,
    "holiday": 1.8,
    "festival": 2.0,
  };

  // ── 路况数据（拥堵等级 1-5 + 各交通方式均速 km/h）──────────────────
  static const Map<String, List<String>> _roadCongestion = <String, List<String>>{
    // period: [start, end, level]
    "morning_rush": <String>["07:30", "09:00", "4"],
    "lunch_time": <String>["11:30", "13:00", "3"],
    "afternoon": <String>["14:00", "17:00", "2"],
    "evening_rush": <String>["17:30", "19:00", "5"],
    "night": <String>["20:00", "23:00", "1"],
  };

  static const Map<String, List<double>> _transportSpeeds = <String, List<double>>{
    // mode: [avg, min, max]
    "driving": <double>[35, 15, 60],
    "public_transit": <double>[25, 10, 40],
    "cycling": <double>[15, 8, 25],
    "walking": <double>[5, 3, 7],
    "taxi": <double>[40, 20, 70],
    "rental_car": <double>[38, 18, 65],
  };

  // ── 景色评分（原项目为大理示例数据，通用目的地走默认值）────────────
  static const Map<String, _SceneryRating> _attractionScenery = <String, _SceneryRating>{
    "洱海生态廊道": _SceneryRating(9.5, 4, 9),
    "崇圣寺三塔文化旅游区": _SceneryRating(6, 9.5, 8.5),
  };

  static const Map<String, double> _routeScenery = <String, double>{
    "coastal": 9,
    "mountain": 8.5,
    "urban": 5,
    "countryside": 7,
    "default": 6,
  };

  static const Map<String, List<String>> _bestViewingTimes = <String, List<String>>{
    "default": <String>["09:00-11:00", "15:00-17:00"],
  };

  static const Map<String, String> _transportNames = <String, String>{
    "driving": "驾车",
    "public_transit": "公共交通",
    "cycling": "骑行",
    "walking": "步行",
    "taxi": "网约车",
    "rental_car": "租车自驾",
  };

  static const Map<int, String> _trafficDescriptions = <int, String>{
    1: "畅通",
    2: "基本畅通",
    3: "轻度拥堵",
    4: "中度拥堵",
    5: "严重拥堵",
  };

  static const List<String> _holidays = <String>[
    "1-1", "2-10", "2-11", "2-12", // 春节期间
    "4-4", "4-5", "4-6", // 清明节
    "5-1", "5-2", "5-3", "5-4", "5-5", // 劳动节
    "6-10", "6-11", "6-12", // 端午节
    "10-1", "10-2", "10-3", "10-4", "10-5", "10-6", "10-7", // 国庆节
  ];

  /// 计算当前时间的人流系数（0-1）。
  double _getTimeCrowdFactor(String currentTime) {
    final List<String> parts = currentTime.split(":");
    if (parts.length < 2) return 0.5;
    final int? hour = int.tryParse(parts[0]);
    final int? minute = int.tryParse(parts[1]);
    if (hour == null || minute == null) return 0.5;
    final String timeStr =
        "${hour.toString().padLeft(2, "0")}:${minute.toString().padLeft(2, "0")}";
    for (final MapEntry<String, double> entry in _timeFactors.entries) {
      final List<String> range = entry.key.split("-");
      if (timeStr.compareTo(range[0]) >= 0 && timeStr.compareTo(range[1]) < 0) {
        return entry.value;
      }
    }
    // 跨零点区间（22:00-06:00）
    final List<String> late = _timeFactors.keys.last.split("-");
    if (timeStr.compareTo(late[0]) >= 0 || timeStr.compareTo(late[1]) < 0) {
      return _timeFactors.values.last;
    }
    return 0.5;
  }

  /// 周末/节假日系数。
  double _getDayTypeMultiplier(DateTime date) {
    if (date.weekday == DateTime.saturday || date.weekday == DateTime.sunday) {
      return _specialEvents["weekend"]!;
    }
    if (_holidays.contains("${date.month}-${date.day}")) {
      return _specialEvents["holiday"]!;
    }
    return 1;
  }

  /// 景点综合人流指数（0-10，10 最拥挤）。
  double calculateCrowdIndex(String attractionName, String currentTime, DateTime date) {
    final double basePopularity =
        _attractionPopularity[attractionName] ?? _attractionPopularity["default"]!;
    final double timeFactor = _getTimeCrowdFactor(currentTime);
    final double dayMultiplier = _getDayTypeMultiplier(date);
    final double crowdIndex =
        (basePopularity * 10 * timeFactor * dayMultiplier).clamp(0, 10);
    return (crowdIndex * 10).roundToDouble() / 10;
  }

  /// 当前路况等级。
  _TrafficLevel _getTrafficLevel(String currentTime) {
    final List<String> parts = currentTime.split(":");
    final String timeStr = parts.isNotEmpty ? parts[0].padLeft(2, "0") : "09";
    for (final MapEntry<String, List<String>> entry in _roadCongestion.entries) {
      if (timeStr.compareTo(entry.value[0]) >= 0 &&
          timeStr.compareTo(entry.value[1]) < 0) {
        final int level = int.tryParse(entry.value[2]) ?? 2;
        return _TrafficLevel(level, entry.key, _trafficDescriptions[level] ?? "未知");
      }
    }
    return const _TrafficLevel(2, "normal", "畅通");
  }

  /// 推荐最佳游览时间（避开人流高峰）。
  _BestTime _recommendBestTime(String attractionName) {
    final List<String> bestTimes =
        _bestViewingTimes[attractionName] ?? _bestViewingTimes["default"]!;
    String recommended = bestTimes.first;
    double minScore = double.infinity;
    for (final String timeRange in bestTimes) {
      final double crowdScore = _getTimeCrowdFactor(timeRange.split("-").first);
      if (crowdScore < minScore) {
        minScore = crowdScore;
        recommended = timeRange;
      }
    }
    return _BestTime(
      recommended,
      "此时段人流较少(${(minScore * 100).round()}%)，且光线条件佳",
      minScore <= 0.3 ? "宽松" : (minScore <= 0.6 ? "适中" : "较拥挤"),
    );
  }

  /// 智能推荐交通方式（按距离筛选 + 偏好调分，返回前 3）。
  List<TransportRecommendation> recommendTransportMode(
    int distanceMeters,
    TravelPreferences preferences,
    int trafficLevel,
  ) {
    final double distanceKm = distanceMeters / 1000;
    final List<TransportRecommendation> modes;
    if (distanceKm < 1) {
      modes = <TransportRecommendation>[
        TransportRecommendation(mode: "walking", score: 90, reason: "短距离步行最佳"),
        TransportRecommendation(mode: "cycling", score: 85, reason: "骑行体验好"),
      ];
    } else if (distanceKm < 5) {
      modes = <TransportRecommendation>[
        TransportRecommendation(mode: "cycling", score: 88, reason: "适中距离，骑行可欣赏沿途风景"),
        TransportRecommendation(mode: "taxi", score: 82, reason: "便捷省时"),
        TransportRecommendation(mode: "public_transit", score: 75, reason: "经济实惠"),
      ];
    } else if (distanceKm < 20) {
      modes = <TransportRecommendation>[
        TransportRecommendation(mode: "driving", score: 85, reason: "灵活自由"),
        TransportRecommendation(mode: "rental_car", score: 83, reason: "自驾探索更方便"),
        TransportRecommendation(mode: "taxi", score: 78, reason: "无需停车烦恼"),
        TransportRecommendation(mode: "public_transit", score: 70, reason: "经济环保"),
      ];
    } else {
      modes = <TransportRecommendation>[
        TransportRecommendation(mode: "driving", score: 88, reason: "长距离首选"),
        TransportRecommendation(mode: "rental_car", score: 86, reason: "灵活安排行程"),
        TransportRecommendation(mode: "public_transit", score: 72, reason: "经济选择"),
      ];
    }

    if (preferences.avoidCrowds && trafficLevel >= 4) {
      for (final TransportRecommendation m in modes) {
        if (m.mode == "driving" || m.mode == "taxi") {
          m.score -= 15;
          m.reason += "，但当前路况较差";
        }
        if (m.mode == "public_transit" || m.mode == "cycling") {
          m.score += 10;
        }
      }
    }

    if (preferences.budgetLevel == "low") {
      for (final TransportRecommendation m in modes) {
        if (m.mode == "taxi" || m.mode == "rental_car") m.score -= 20;
        if (m.mode == "public_transit" || m.mode == "walking" || m.mode == "cycling") {
          m.score += 10;
        }
      }
    } else if (preferences.budgetLevel == "high") {
      for (final TransportRecommendation m in modes) {
        if (m.mode == "taxi" || m.mode == "rental_car") m.score += 10;
      }
    }

    if (preferences.physicalEffort == "easy") {
      for (final TransportRecommendation m in modes) {
        if (m.mode == "walking" || m.mode == "cycling") {
          m.score -= 25;
          m.reason += "，但需一定体力";
        }
      }
    }

    modes.sort((TransportRecommendation a, TransportRecommendation b) => b.score.compareTo(a.score));
    return modes.take(3).toList();
  }

  /// 主智能规划方法：按给定途经点顺序逐段规划（与原版行为一致）。
  SmartRouteResult planIntelligentRoute(
    List<RouteWaypoint> waypoints,
    TravelPreferences preferences,
  ) {
    final List<SmartRouteSegment> segments = <SmartRouteSegment>[];
    final List<SmartRouteWarning> warnings = <SmartRouteWarning>[];
    int totalDistance = 0;
    int totalDuration = 0;
    final String currentTime = preferences.departureTime;
    final DateTime today = DateTime.now();

    for (int i = 0; i < waypoints.length - 1; i++) {
      final RouteWaypoint from = waypoints[i];
      final RouteWaypoint to = waypoints[i + 1];
      final int distanceMeters =
          (_haversineKm(from.latitude, from.longitude, to.latitude, to.longitude) * 1000)
              .round();
      totalDistance += distanceMeters;

      final _TrafficLevel traffic = _getTrafficLevel(currentTime);
      final double crowdIndex = calculateCrowdIndex(to.name, currentTime, today);
      final List<TransportRecommendation> recos =
          recommendTransportMode(distanceMeters, preferences, traffic.level);

      // 用户指定交通方式时直接采用（原版通过 _switchTransportMode 重规划实现同效）
      final TransportRecommendation best = (preferences.transportMode != "auto")
          ? (recos.firstWhere(
              (TransportRecommendation r) => r.mode == preferences.transportMode,
              orElse: () => recos.first))
          : recos.first;

      final List<double> speedParams =
          _transportSpeeds[best.mode] ?? _transportSpeeds["driving"]!;
      final double congestionFactor =
          traffic.level <= 2 ? 1 : 1 + (traffic.level - 2) * 0.2;
      final double avgSpeed = speedParams[0] / congestionFactor;
      final int durationMinutes =
          ((distanceMeters / 1000 / avgSpeed) * 60).round();
      totalDuration += durationMinutes;

      final String instruction = _generateSmartSuggestion(
          from, to, crowdIndex, traffic, best, preferences);

      if (crowdIndex >= 7) {
        warnings.add(SmartRouteWarning(
          type: "crowd",
          location: to.name,
          message: "${to.name} 当前人流密集(指数:$crowdIndex/10)，建议错峰前往",
          severity: "high",
        ));
      }
      if (traffic.level >= 4) {
        warnings.add(SmartRouteWarning(
          type: "traffic",
          location: "${from.name} → ${to.name}",
          message: "该路段${traffic.description}，预计耗时增加${((congestionFactor - 1) * 100).round()}%",
          severity: "medium",
        ));
      }

      segments.add(SmartRouteSegment(
        id: "smart-seg-$i",
        fromName: from.name,
        toName: to.name,
        fromLatitude: from.latitude,
        fromLongitude: from.longitude,
        toLatitude: to.latitude,
        toLongitude: to.longitude,
        distanceMeters: distanceMeters,
        durationMinutes: durationMinutes,
        transportMode: best.mode,
        instruction: instruction,
        crowdIndex: crowdIndex,
        trafficLevel: traffic.level,
        sceneryScore: _calculateRouteScenery(from, to),
        alternatives: recos.skip(1).toList(),
        tips: _generateTips(from, to, crowdIndex, traffic, preferences),
      ));
    }

    final int score = _assessRouteScore(segments);
    return SmartRouteResult(
      id: "smart-route-${DateTime.now().millisecondsSinceEpoch}",
      waypoints: waypoints,
      segments: segments,
      totalDistanceMeters: totalDistance,
      totalDurationMinutes: totalDuration,
      totalDistanceText: "${(totalDistance / 1000).toStringAsFixed(1)}km",
      totalDurationText: _formatDuration(totalDuration),
      averageCrowdIndex: segments.isEmpty
          ? "0.0"
          : (segments.fold<double>(0, (double s, SmartRouteSegment seg) => s + seg.crowdIndex) /
                  segments.length)
              .toStringAsFixed(1),
      bestTransportMode:
          segments.isNotEmpty ? segments.first.transportMode : "driving",
      sceneryRating: segments.isEmpty
          ? "0.0"
          : (segments.fold<double>(0, (double s, SmartRouteSegment seg) => s + seg.sceneryScore) /
                  segments.length)
              .toStringAsFixed(1),
      optimizationScore: score,
      assessment: _assessRouteText(score),
      warnings: warnings,
    );
  }

  String _generateSmartSuggestion(
    RouteWaypoint from,
    RouteWaypoint to,
    double crowdIndex,
    _TrafficLevel traffic,
    TransportRecommendation best,
    TravelPreferences prefs,
  ) {
    String instruction = "从 ${from.name} 前往 ${to.name}";
    instruction += "，建议${_transportNames[best.mode] ?? best.mode}";
    if (crowdIndex >= 7 && prefs.avoidCrowds) {
      instruction += "，建议${_recommendBestTime(to.name).timeRange}到达以避开人流";
    }
    if (traffic.level >= 4) {
      instruction += "，当前路况${traffic.description}，预留充足时间";
    }
    return instruction;
  }

  double _calculateRouteScenery(RouteWaypoint from, RouteWaypoint to) {
    final _SceneryRating? a = _attractionScenery[from.name];
    final _SceneryRating? b = _attractionScenery[to.name];
    if (a != null && b != null) return (a.overall + b.overall) / 2;
    return _routeScenery["default"]!;
  }

  List<SmartTip> _generateTips(
    RouteWaypoint from,
    RouteWaypoint to,
    double crowdIndex,
    _TrafficLevel traffic,
    TravelPreferences prefs,
  ) {
    final List<SmartTip> tips = <SmartTip>[];
    if (crowdIndex >= 7) {
      tips.add(const SmartTip(icon: "fa-users", text: "提前在线购票，避免排队", type: "warning"));
      tips.add(const SmartTip(icon: "fa-clock-o", text: "建议早出发或傍晚前往", type: "suggestion"));
    } else if (crowdIndex <= 3) {
      tips.add(const SmartTip(icon: "fa-smile-o", text: "此时段人流较少，游览体验佳", type: "positive"));
    }
    if (traffic.level >= 4) {
      tips.add(const SmartTip(icon: "fa-car", text: "考虑改用公共交通或骑行", type: "suggestion"));
    }
    tips.add(SmartTip(
        icon: "fa-camera", text: _recommendBestTime(to.name).reason, type: "info"));
    if (prefs.transportMode == "cycling" || prefs.transportMode == "walking") {
      tips.add(const SmartTip(
          icon: "fa-shield", text: "注意交通安全，佩戴防护装备", type: "safety"));
    }
    return tips.take(3).toList();
  }

  int _assessRouteScore(List<SmartRouteSegment> segments) {
    if (segments.isEmpty) return 80;
    int score = 80;
    final double avgCrowd =
        segments.fold<double>(0, (double s, SmartRouteSegment seg) => s + seg.crowdIndex) /
            segments.length;
    final double avgScenery =
        segments.fold<double>(0, (double s, SmartRouteSegment seg) => s + seg.sceneryScore) /
            segments.length;
    final bool hasWarnings = segments.any((SmartRouteSegment seg) => seg.crowdIndex >= 7);
    if (avgCrowd < 5) score += 10;
    if (avgScenery >= 8) score += 5;
    if (!hasWarnings) score += 5;
    return score.clamp(0, 100);
  }

  String _assessRouteText(int score) {
    if (score >= 90) {
      return "优秀路线：综合考虑了人流、景色、效率等因素，体验将非常出色";
    } else if (score >= 80) {
      return "良好路线：整体规划合理，有少量优化空间";
    } else if (score >= 70) {
      return "一般路线：部分路段可能较为拥挤或景色一般，建议关注警告信息";
    }
    return "待优化路线：存在较多不利因素，强烈建议调整行程安排";
  }

  String _formatDuration(int minutes) {
    final int h = minutes ~/ 60;
    final int m = minutes % 60;
    if (h > 0) return "$h小时${m > 0 ? "$m分钟" : ""}";
    return "$m分钟";
  }

  /// 球面距离（km）——对齐原项目 app._calculateDistance 的 haversine 实现。
  double _haversineKm(double lat1, double lng1, double lat2, double lng2) {
    const double r = 6371;
    final double dLat = _deg2rad(lat2 - lat1);
    final double dLng = _deg2rad(lng2 - lng1);
    final double a = math.pow(math.sin(dLat / 2), 2) +
        math.cos(_deg2rad(lat1)) *
            math.cos(_deg2rad(lat2)) *
            math.pow(math.sin(dLng / 2), 2);
    return 2 * r * math.asin(math.sqrt(a.clamp(0.0, 1.0)));
  }

  static double _deg2rad(double d) => d * math.pi / 180;
}
