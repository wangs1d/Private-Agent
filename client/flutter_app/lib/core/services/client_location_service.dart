import "dart:convert";

import "package:geolocator/geolocator.dart";
import "package:http/http.dart" as http;

import "../config/api_config.dart";

/// 前端 GPS 定位结果（随 chat.user_message 上报；服务端用经纬度逆地理，不用 IP）。
class ClientLocationPayload {
  const ClientLocationPayload({
    required this.latitude,
    required this.longitude,
    this.city,
    this.district,
    this.region,
    this.country,
    this.timezone,
    this.label,
  });

  final double latitude;
  final double longitude;
  final String? city;
  final String? district;
  final String? region;
  final String? country;
  final String? timezone;
  final String? label;

  Map<String, dynamic> toJson() => <String, dynamic>{
        "latitude": latitude,
        "longitude": longitude,
        if (city != null && city!.isNotEmpty) "city": city,
        if (district != null && district!.isNotEmpty) "district": district,
        if (region != null && region!.isNotEmpty) "region": region,
        if (country != null && country!.isNotEmpty) "country": country,
        if (timezone != null && timezone!.isNotEmpty) "timezone": timezone,
        if (label != null && label!.isNotEmpty) "label": label,
      };

  factory ClientLocationPayload.fromJson(Map<String, dynamic> json) {
    return ClientLocationPayload(
      latitude: (json["latitude"] as num).toDouble(),
      longitude: (json["longitude"] as num).toDouble(),
      city: json["city"] as String?,
      district: json["district"] as String?,
      region: json["region"] as String?,
      country: json["country"] as String?,
      timezone: json["timezone"] as String?,
      label: json["label"] as String?,
    );
  }
}

typedef LocationPrefsReader = Future<dynamic> Function(String key);
typedef LocationPrefsWriter = Future<void> Function(String key, dynamic value);

/// 根据当前网络出口 IP 解析的大致位置（仅展示，不上报 Agent）。
class NetworkLocationHint {
  const NetworkLocationHint({
    required this.ip,
    required this.label,
    this.city,
    this.region,
    this.country,
    this.timezone,
  });

  final String ip;
  final String label;
  final String? city;
  final String? region;
  final String? country;
  final String? timezone;

  factory NetworkLocationHint.fromJson(Map<String, dynamic> json) {
    return NetworkLocationHint(
      ip: json["ip"] as String? ?? "",
      label: json["label"] as String? ?? "",
      city: json["city"] as String?,
      region: json["region"] as String?,
      country: json["country"] as String?,
      timezone: json["timezone"] as String?,
    );
  }
}

class ClientLocationService {
  ClientLocationService._();

  static const String _prefsKey = "clientLocationCache";
  static const String _consentKey = "clientLocationConsent";
  static ClientLocationPayload? _cached;
  static DateTime? _cachedAt;
  static const Duration _cacheTtl = Duration(minutes: 10);

  static LocationPrefsReader? _readPref;
  static LocationPrefsWriter? _writePref;
  /// `null` 尚未询问；`true`/`false` 用户已选择。
  static bool? _locationConsent;

  /// 注入本地持久化（如 IsarLocalHistoryStore.savePreference）。
  static void bindPreferences({
    required LocationPrefsReader read,
    required LocationPrefsWriter write,
  }) {
    _readPref = read;
    _writePref = write;
  }

  static Future<bool?> getLocationConsent() async {
    if (_locationConsent != null) return _locationConsent;
    if (_readPref == null) return null;
    final dynamic raw = await _readPref!(_consentKey);
    if (raw == null) return null;
    _locationConsent = raw == true;
    return _locationConsent;
  }

  static Future<void> setLocationConsent(bool allowed) async {
    _locationConsent = allowed;
    if (_writePref != null) {
      await _writePref!(_consentKey, allowed);
    }
    if (!allowed) {
      clearCache();
    }
  }

  /// 调用服务端 `/geo/ip`，根据当前连接的网络 IP 解析大致地址。
  static Future<NetworkLocationHint?> fetchNetworkLocationHint() async {
    final Uri uri = Uri.parse("${ApiConfig.httpBase}/geo/ip");
    try {
      final http.Response res = await http
          .get(uri, headers: const <String, String>{"Accept": "application/json"})
          .timeout(const Duration(seconds: 12));
      if (res.statusCode != 200) {
        print("[ClientLocationService] IP 定位 HTTP ${res.statusCode}");
        return null;
      }
      final Map<String, dynamic> body =
          jsonDecode(res.body) as Map<String, dynamic>;
      if (body["ok"] != true) return null;
      final Map<String, dynamic>? loc =
          (body["location"] as Map?)?.cast<String, dynamic>();
      if (loc == null) return null;
      return NetworkLocationHint.fromJson(loc);
    } catch (e) {
      print("[ClientLocationService] IP 定位失败: $e");
      return null;
    }
  }

  static Future<ClientLocationPayload?> getCurrentLocation() async {
    if (_locationConsent != true) {
      final bool? consent = await getLocationConsent();
      if (consent != true) {
        return _cached ?? await _loadFromDisk();
      }
    }
    final DateTime now = DateTime.now();
    if (_cached != null &&
        _cachedAt != null &&
        now.difference(_cachedAt!) < _cacheTtl) {
      return _cached;
    }

    final ClientLocationPayload? disk = await _loadFromDisk();
    if (disk != null &&
        _cachedAt != null &&
        now.difference(_cachedAt!) < _cacheTtl) {
      _cached = disk;
      return disk;
    }

    try {
      final LocationPermission permission = await _ensurePermission();
      if (permission == LocationPermission.denied ||
          permission == LocationPermission.deniedForever) {
        print("[ClientLocationService] 定位权限未授予，使用上次缓存");
        return disk ?? _cached;
      }

      final Position position = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 20),
        ),
      );

      final ClientLocationPayload? resolved = await _reverseGeocodeViaServer(
        position.latitude,
        position.longitude,
      );

      if (resolved != null) {
        await _remember(resolved);
        return resolved;
      }

      final ClientLocationPayload coordsOnly = ClientLocationPayload(
        latitude: position.latitude,
        longitude: position.longitude,
        timezone: "Asia/Shanghai",
        label: "${position.latitude.toStringAsFixed(4)}, ${position.longitude.toStringAsFixed(4)}",
      );
      await _remember(coordsOnly);
      return coordsOnly;
    } catch (e) {
      print("[ClientLocationService] 获取定位失败: $e");
      return _cached ?? disk;
    }
  }

  /// 用户同意定位后预拉 GPS；未同意时不请求系统权限。
  static Future<void> warmUpGpsIfConsented() async {
    final bool? consent = await getLocationConsent();
    if (consent == true) {
      await getCurrentLocation();
    }
  }

  static void clearCache() {
    _cached = null;
    _cachedAt = null;
  }

  static Future<ClientLocationPayload?> _reverseGeocodeViaServer(
    double lat,
    double lon,
  ) async {
    final Uri uri = Uri.parse("${ApiConfig.httpBase}/geo/reverse").replace(
      queryParameters: <String, String>{
        "latitude": lat.toString(),
        "longitude": lon.toString(),
      },
    );
    final http.Response res = await http
        .get(uri, headers: const <String, String>{"Accept": "application/json"})
        .timeout(const Duration(seconds: 12));
    if (res.statusCode != 200) {
      print("[ClientLocationService] 逆地理失败 HTTP ${res.statusCode}");
      return null;
    }
    final Map<String, dynamic> body =
        jsonDecode(res.body) as Map<String, dynamic>;
    if (body["ok"] != true) return null;
    final Map<String, dynamic>? loc =
        (body["location"] as Map?)?.cast<String, dynamic>();
    if (loc == null) return null;

    return ClientLocationPayload(
      latitude: lat,
      longitude: lon,
      city: loc["city"] as String?,
      district: loc["district"] as String?,
      region: loc["region"] as String?,
      country: loc["country"] as String?,
      timezone: loc["timezone"] as String?,
      label: loc["label"] as String?,
    );
  }

  static Future<void> _remember(ClientLocationPayload payload) async {
    _cached = payload;
    _cachedAt = DateTime.now();
    print("[ClientLocationService] 定位: ${payload.label ?? payload.city}");
    if (_writePref != null) {
      await _writePref!(_prefsKey, payload.toJson());
    }
  }

  static Future<ClientLocationPayload?> _loadFromDisk() async {
    if (_readPref == null) return null;
    try {
      final dynamic raw = await _readPref!(_prefsKey);
      if (raw is Map) {
        final ClientLocationPayload payload =
            ClientLocationPayload.fromJson(raw.cast<String, dynamic>());
        _cached = payload;
        _cachedAt = DateTime.now();
        return payload;
      }
    } catch (e) {
      print("[ClientLocationService] 读取缓存失败: $e");
    }
    return null;
  }

  static Future<LocationPermission> _ensurePermission() async {
    if (!await Geolocator.isLocationServiceEnabled()) {
      return LocationPermission.denied;
    }
    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }
    return permission;
  }

  /// 在用户于弹窗中选择「开启定位」后调用。
  static Future<void> requestGpsAfterConsent() async {
    await setLocationConsent(true);
    await getCurrentLocation();
  }
}
