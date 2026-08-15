import "dart:convert";

import "package:flutter_timezone/flutter_timezone.dart";
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

class ClientLocationService {
  ClientLocationService._();

  static const String _prefsKey = "clientLocationCache";
  static const String _consentKey = "clientLocationConsent";
  static ClientLocationPayload? _cached;
  static DateTime? _cachedAt;
  /// 仅供 App 启动预热使用；聊天发消息走 `getCurrentLocationForChat()` 实时拉取。
  static const Duration _cacheTtl = Duration(minutes: 10);

  static LocationPrefsReader? _readPref;
  static LocationPrefsWriter? _writePref;
  /// `null` 尚未询问；`true`/`false` 用户已选择。
  /// 默认 `true`：让 Agent 实时拿到用户位置；用户可在权限弹窗里显式「暂不允许」回退。
  static bool? _locationConsent = true;

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
    if (_readPref == null) return true;
    final dynamic raw = await _readPref!(_consentKey);
    if (raw == null) return true;
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

  /// 启动预热路径：使用 10 分钟缓存，避免重复请求系统定位。
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

    return _fetchFresh(disk);
  }

  /// 聊天发消息专用：每次都拉新 GPS，确保 Agent 拿到的是用户当下位置。
  /// 失败时回退到磁盘/内存缓存；不阻塞消息发送。
  static Future<ClientLocationPayload?> getCurrentLocationForChat() async {
    if (_locationConsent != true) {
      final bool? consent = await getLocationConsent();
      if (consent != true) {
        return _cached ?? await _loadFromDisk();
      }
    }
    final ClientLocationPayload? disk = await _loadFromDisk();
    return _fetchFresh(disk);
  }

  /// 读取设备真实 IANA 时区（如 America/New_York）；失败返回 null（不上报，交服务端判定）。
  static Future<String?> _deviceTimezone() async {
    try {
      final TimezoneInfo tzInfo = await FlutterTimezone.getLocalTimezone();
      final String tz = tzInfo.identifier;
      if (tz.trim().isNotEmpty) return tz.trim();
    } catch (e) {
      print("[ClientLocationService] 获取设备时区失败: $e");
    }
    return null;
  }

  /// 实际执行一次 GPS 抓取 + 逆地理；任何异常都返回磁盘/内存兜底。
  static Future<ClientLocationPayload?> _fetchFresh(
    ClientLocationPayload? disk,
  ) async {
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

      // 服务端逆地理失败兜底：上报设备真实时区（不再硬编码 Asia/Shanghai），
      // 让服务端拿到正确用户时区，避免「在美国却报北京时间」。
      final ClientLocationPayload coordsOnly = ClientLocationPayload(
        latitude: position.latitude,
        longitude: position.longitude,
        timezone: await _deviceTimezone(),
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
