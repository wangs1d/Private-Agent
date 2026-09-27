// 展示层触网门禁：lib/features、lib/mobile_ui、lib/widgets 下禁止直接
// import package:http —— 网络访问一律走 core/services 的 API 封装，
// 页面/组件只管渲染（业务逻辑与 UI 解耦的机制性保障）。
//
// 用法：dart run tool/check_no_http_imports.dart
//   违规（白名单之外出现 http import）→ 逐条打印并以非零码退出，
//   可直接挂 CI 或提交前手动执行。
//
// 存量欠账记在 _whitelist（按相对路径），随收口批次逐个移出；
// 新文件不在白名单内，import http 会直接被挡下。
import "dart:io";

const List<String> _scanRoots = <String>[
  "lib/features",
  "lib/mobile_ui",
  "lib/widgets",
];

/// 存量触网点白名单（相对 client/flutter_app 的正斜杠路径）。
/// 新增收口批次完成一个，就从这里移出一个。
const List<String> _whitelist = <String>[
  "lib/features/auth/register_page.dart",
  "lib/features/catalog/catalog_page.dart",
  "lib/features/chat/agent_home_page.dart",
  "lib/features/chat/travel_favorites.dart",
  "lib/features/gallery/gallery_page.dart",
  "lib/features/gallery/gallery_review_page.dart",
  "lib/features/settings/settings_page.dart",
  "lib/mobile_ui/mobile_chat_controller.dart",
];

void main() {
  final List<String> violations = <String>[];
  for (final String root in _scanRoots) {
    final Directory dir = Directory(root);
    if (!dir.existsSync()) continue;
    for (final FileSystemEntity entity
        in dir.listSync(recursive: true, followLinks: false)) {
      if (entity is! File || !entity.path.endsWith(".dart")) continue;
      final String rel = entity.path.replaceAll("\\", "/");
      if (_whitelist.contains(rel)) continue;
      final List<String> lines = entity.readAsLinesSync();
      for (int i = 0; i < lines.length; i++) {
        if (RegExp(r'''import\s+["']package:http/''').hasMatch(lines[i])) {
          violations.add("$rel:${i + 1}: ${lines[i].trim()}");
        }
      }
    }
  }
  if (violations.isEmpty) {
    stdout.writeln("check_no_http_imports: OK（展示层无新增触网点）");
    return;
  }
  stderr.writeln("check_no_http_imports: 发现 ${violations.length} 处展示层触网：");
  for (final String v in violations) {
    stderr.writeln("  $v");
  }
  stderr.writeln("请改走 core/services 的 API 封装；确需豁免请评审后加入白名单。");
  exit(1);
}
