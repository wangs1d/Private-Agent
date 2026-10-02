import "package:flutter/foundation.dart";

import "profile_manage_api.dart";

// ═══════════════════════════════════════════════════════════════════
// 用户称呼解析（简报卡问候用）。
//
// 称呼方向铁律：称呼 = agent 叫用户（如「王哥」）；agent 网络名 =
// 用户叫 agent（账号 displayName）。两者绝不可混——2026-10-02 事故：
// 简报问候回退读 /accounts/me 的 displayName，而首启向导「agent 名字」
// 步骤会经 agent-identity/rename 把账号 displayName 改写成 agent 名，
// 导致简报拿 agent 名称呼了用户。现与聊天面空态问候同源：结构化事实库
// （GET /api/profile/manage）的「称呼」字段。
// ═══════════════════════════════════════════════════════════════════

/// 单字常见姓氏（与 server appellation.ts 同源的启发式子集）：
/// 用于把"连名带姓的大名"得体化为「姓氏+先生」。
const String _kCommonSingleSurnames =
    "王李张刘陈杨黄赵吴周徐孙马朱胡郭何林罗高郑梁谢宋唐许韩冯邓曹彭曾肖田董"
    "潘袁蔡蒋余于杜叶程魏苏吕丁任卢姚沈钟姜崔谭陆范汪廖石金韦贾夏付方邹熊白"
    "孟秦邱侯江尹薛闫段雷龙黎史陶贺毛郝顾龚邵万钱严覃武戴莫孔向汤温康施文柯"
    "柴倪凌米谷代桂";

/// 常见复姓（大名以复姓开头时截复姓）。
const List<String> _kCompoundSurnames = [
  "欧阳", "司马", "上官", "诸葛", "东方", "夏侯", "皇甫", "尉迟", "公孙",
  "令狐", "慕容", "司徒", "长孙", "宇文", "南宫", "西门", "独孤", "司空",
];

/// 尾缀称谓词（王哥/王总/王先生/老王…）或昵称前缀（老王/小张/阿强）→
/// 本身就是得体称呼，原样保留。
final RegExp _kHonorificTail =
    RegExp(r"(先生|女士|小姐|老师|教授|博士|医生|大夫|老板|同学|哥|姐|弟|妹|叔|姨|伯|婶|舅|总|工|师)$");
final RegExp _kNicknameHead = RegExp(r"^(老|小|阿|大)");

/// 称呼值得体化（业务硬规则：问候绝不直呼大名）。
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

/// 用户称呼查询。
class AccountProfileApi {
  AccountProfileApi._();

  /// 称呼缓存（事实库「称呼」字段）：进程内只查一次，失败记空串不再重试。
  static String? _appellationCache;

  /// 用户称呼：取结构化事实库「称呼」字段（与聊天面空态问候同源），
  /// 如「王哥」。无记录 / 接口失败 → 空串（问候退化为不带称呼，
  /// 绝不回退账号 displayName——那是 agent 的网络名）。
  static Future<String> resolveAppellation() async {
    final String? cached = _appellationCache;
    if (cached != null) return cached;
    try {
      final ProfileManageData? data = await ProfileManageApi().fetch();
      if (data != null) {
        for (final ProfileFactItem f in data.facts) {
          if (f.field == "称呼" && f.value.trim().isNotEmpty) {
            final String polite = politeDisplayName(f.value.trim());
            _appellationCache = polite;
            return polite;
          }
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
