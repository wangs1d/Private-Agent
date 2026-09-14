// 行程地图桥接数据模型（web 面板 drawRoute 使用）。

/// 地图上的一个点（经纬度）。
class TravelMapPoint {
  const TravelMapPoint({required this.latitude, required this.longitude});

  final double latitude;
  final double longitude;

  Map<String, double> toJson() => <String, double>{
        "latitude": latitude,
        "longitude": longitude,
      };
}

/// 一段行程路线（按交通方式配色）。
class TravelRouteSegment {
  const TravelRouteSegment({
    required this.mode,
    required this.points,
    this.fromName = "",
    this.toName = "",
  });

  /// 交通方式：driving / taxi / transit / walking / cycling（决定配色）。
  final String mode;

  /// 路径折线点（至少两个有效点才会绘制）。
  final List<TravelMapPoint> points;

  final String fromName;
  final String toName;

  Map<String, dynamic> toJson() => <String, dynamic>{
        "mode": mode,
        "points": <Map<String, double>>[
          for (final TravelMapPoint p in points) p.toJson(),
        ],
        "fromName": fromName,
        "toName": toName,
      };
}
