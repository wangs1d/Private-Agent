import "dart:convert";
import "package:http/http.dart" as http;

class MoodInferenceApi {
  MoodInferenceApi({required this.baseUrl});
  final String baseUrl;

  Future<Map<String, dynamic>> getDailyAggregates(String sessionId, {int days = 7}) async {
    final uri = Uri.parse("$baseUrl/api/mood-inferences/daily?sessionId=$sessionId&days=$days");
    final res = await http.get(uri).timeout(const Duration(seconds: 10));
    if (res.statusCode != 200) throw Exception("获取日均心情失败: ${res.statusCode}");
    final data = jsonDecode(res.body) as Map<String, dynamic>;
    return data;
  }

  Future<Map<String, dynamic>> getTodayMood(String sessionId) async {
    final uri = Uri.parse("$baseUrl/api/mood-inferences/today?sessionId=$sessionId");
    final res = await http.get(uri).timeout(const Duration(seconds: 10));
    if (res.statusCode != 200) throw Exception("获取今日心情失败: ${res.statusCode}");
    final data = jsonDecode(res.body) as Map<String, dynamic>;
    return data;
  }

  Future<Map<String, dynamic>> getRecentInferences(String sessionId, {int limit = 30}) async {
    final uri = Uri.parse("$baseUrl/api/mood-inferences?sessionId=$sessionId&limit=$limit");
    final res = await http.get(uri).timeout(const Duration(seconds: 10));
    if (res.statusCode != 200) throw Exception("获取心情历史失败: ${res.statusCode}");
    final data = jsonDecode(res.body) as Map<String, dynamic>;
    return data;
  }
}
