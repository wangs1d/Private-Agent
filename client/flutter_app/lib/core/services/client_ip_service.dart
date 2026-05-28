import 'dart:convert';
import 'package:http/http.dart' as http;

/// 客户端 IP 地址服务
/// 通过公网 API 获取用户的真实 IP 地址
class ClientIpService {
  static String? _cachedIp;
  static DateTime? _cachedAt;
  static const Duration _cacheTtl = Duration(minutes: 30);

  /// 获取客户端公网 IP 地址（带缓存）
  static Future<String?> getClientIp() async {
    final now = DateTime.now();
    
    // 如果缓存有效，直接返回
    if (_cachedIp != null && 
        _cachedAt != null && 
        now.difference(_cachedAt!) < _cacheTtl) {
      return _cachedIp;
    }

    try {
      // 尝试多个 IP 查询服务（按可靠性排序）
      final services = [
        'https://api.ipify.org?format=json',
        'https://ipinfo.io/json',
        'https://api.myip.com',
      ];

      for (final url in services) {
        try {
          final response = await http.get(Uri.parse(url)).timeout(
            const Duration(seconds: 3),
          );

          if (response.statusCode == 200) {
            final data = jsonDecode(response.body) as Map<String, dynamic>;
            
            // 不同 API 返回的字段名不同
            String? ip;
            if (data.containsKey('ip')) {
              ip = data['ip'] as String?;
            } else if (data.containsKey('query')) {
              ip = data['query'] as String?;
            }

            if (ip != null && ip.isNotEmpty) {
              _cachedIp = ip;
              _cachedAt = now;
              print('[ClientIpService] 获取到 IP: $ip');
              return ip;
            }
          }
        } catch (e) {
          print('[ClientIpService] 服务 $url 失败: $e');
          continue;
        }
      }

      print('[ClientIpService] 所有 IP 查询服务均失败');
      return null;
    } catch (e) {
      print('[ClientIpService] 获取 IP 异常: $e');
      return null;
    }
  }

  /// 清除缓存，强制重新获取
  static void clearCache() {
    _cachedIp = null;
    _cachedAt = null;
  }
}
