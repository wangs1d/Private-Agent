// 测试助手:path_provider 假实现,把应用目录指到系统临时目录。
// 供 IsarLocalHistoryStore 等依赖 path_provider 的存储在 widget 测试中落盘。
library;

import "dart:io";

import "package:path_provider_platform_interface/path_provider_platform_interface.dart";

/// 所有路径都落到 Dart 临时目录下的独立子目录(每次 new 一个新实例换新子目录)。
class TempPathProviderPlatform extends PathProviderPlatform {
  TempPathProviderPlatform() {
    final Directory root = Directory(
      "${Directory.systemTemp.path}/pai_test_${DateTime.now().microsecondsSinceEpoch}",
    );
    root.createSync(recursive: true);
    _root = root.path;
  }

  late final String _root;

  String _join(String name) {
    final Directory dir = Directory("$_root/$name");
    dir.createSync(recursive: true);
    return dir.path;
  }

  @override
  Future<String?> getApplicationSupportPath() async => _join("support");

  @override
  Future<String?> getApplicationDocumentsPath() async => _join("docs");

  @override
  Future<String?> getTemporaryPath() async => _join("tmp");

  @override
  Future<String?> getDownloadsPath() async => _join("downloads");
}
