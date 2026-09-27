import "dart:convert";

import "package:flutter/foundation.dart";
import "package:http/http.dart" as http;

import "../config/api_config.dart";
import "access_auth_api.dart";

// ═══════════════════════════════════════════════════════════════════
// 账号资料：displayName 查询与得体化（原 daily_briefing_window.dart 收口）。
// ═══════════════════════════════════════════════════════════════════

/// 单字常见姓氏（与 server appellation.ts 同源的启发式子集）：
/// 用于把"连名带姓的 displayName"得体化为「姓氏+先生」。
const String _kCommonSingleSurnames =
    "王李张刘陈杨黄赵吴周徐孙马朱胡郭何林罗高郑梁谢宋唐许韩冯邓曹彭曾肖田董"
    "潘袁蔡蒋余于杜叶程魏苏吕丁任卢姚沈钟姜崔谭陆范汪廖石金韦贾夏付方邹熊白"
    "孟秦邱侯江尹薛闫段雷龙黎史陶贺毛郝顾龚邵万钱严覃武戴莫孔向汤温康施文柯"
    "柴倪凌米谷代桂";

/// 常见复姓（ displayName 以复姓开头时截复姓）。
const List<String> _kCompoundSurnames = [
  "欧阳", "司马", "上官", "诸葛", "东方", "夏侯", "皇甫", "尉迟", "公孙",
  "令狐", "慕容", "司徒", "长孙", "宇文", "南宫", "西门", "独孤", "司空",
];

/// 尾缀称谓词（王哥/王总/王先生/老王…）或昵称前缀（老王/小张/阿强）→
/// 本身就是得体称呼，原样保留。
final RegExp _kHonorificTail =
    RegExp(r"(先生|女士|小姐|老师|教授|博士|医生|大夫|老板|同学|哥|姐|弟|妹|叔|姨|伯|婶|舅|总|工|师)$");
final RegExp _kNicknameHead = RegExp(r"^(老|小|阿|大)");

/// 注册 displayName 得体化（业务硬规则：问候绝不直呼大名）。
/// 「王铭川」→「王先生」、「欧阳文山」→「欧阳先生」；已是称呼（王哥/老王/
/// Tony…）原样返回；无法判断时原样返回（宁可不改也不误伤用户指定的称呼）。
String politeDisplayName(String raw) {
  final v = raw.trim().replaceAll(RegExp(r"\s+"), "");
  if (v.isEmpty) return v;
  if (_kHonorificTail.hasMatch(v) || _kNicknameHead.hasMatch(v)) return v;
  final cjk = RegExp(r"^[\u4e00-\u9fff]{2,4}$");
  if (!cjk.hasMatch(v)) return v;

  for (final compound in _kCompoundSurnames) {
    if (v.startsWith(compound)) {
      return v.length >= 3 ? "$compound先生" : v;
    }
  }
  final head = v.substring(0, 1);
  if (!_kCommonSingleSurnames.contains(head)) return v;
  if (v.length == 2) {
    final tail = v.substring(1);
    if (_kHonorificTail.hasMatch(tail)) return v;
  }
  return "$head先生";
}

/// 账号资料查询（GET /accounts/me）。
class AccountProfileApi {
  AccountProfileApi._();

  /// 称呼缓存（账号 displayName）：进程内只查一次，失败记空串不再重试。
  static String? _appellationCache;

  /// 用户称呼：取账号注册的 displayName，如「王先生」。
  /// 未注册 / 接口失败 → 空串（问候退化为不带称呼）。
  static Future<String> resolveAppellation() async {
    final String? cached = _appellationCache;
    if (cached != null) return cached;
    try {
      final Uri uri = Uri
          .parse("${ApiConfig.httpBase}/accounts/me")
          .replace(queryParameters: ApiConfig.accountAuthQuery);
      final http.Response res = await http
          .get(uri, headers: AccessCredentialStore.instance.authHeaders)
          .timeout(const Duration(seconds: 4));
      if (res.statusCode == 200) {
        final Map<String, dynamic> data =
            jsonDecode(res.body) as Map<String, dynamic>;
        final Object? rawAccount = data["account"];
        if (data["registered"] == true && rawAccount is Map) {
          final String name =
              (rawAccount.cast<String, dynamic>()["displayName"] ?? "")
                  .toString()
                  .trim();
          final String polite = politeDisplayName(name);
          _appellationCache = polite;
          return polite;
        }
      }
    } catch (e) {
      // 查询失败：本次不带称呼，不打断简报展示
      debugPrint("[AccountProfileApi] resolveAppellation failed: $e");
    }
    _appellationCache = "";
    return "";
  }
}
