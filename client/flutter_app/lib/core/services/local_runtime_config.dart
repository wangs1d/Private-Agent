import "dart:async";
import "dart:io";

/// 用户侧运行配置（byok 捆绑形态）：%APPDATA%\PrivateAgent\config.env
///
/// 为什么不放 server/.env：覆盖安装会冲掉、Program Files 下不可写。客户端启动器
/// 读取本文件并把键值注入 runtime 子进程环境（server 侧 dotenv 默认不覆盖已有
/// 进程变量，因此注入值始终生效，server 零改动）。
class LocalRuntimeConfig {
  LocalRuntimeConfig._();

  static String get _dir {
    final String appData =
        Platform.environment["APPDATA"] ?? Directory.systemTemp.path;
    return "$appData${Platform.pathSeparator}PrivateAgent";
  }

  static File get configFile =>
      File("$_dir${Platform.pathSeparator}config.env");

  /// 解析 KEY=VALUE 行（# 注释、空行忽略；值内不解析引号，保持字面）。
  static Map<String, String> parse(String text) {
    final Map<String, String> result = <String, String>{};
    for (final String rawLine in text.split("\n")) {
      final String line = rawLine.trim();
      if (line.isEmpty || line.startsWith("#")) continue;
      final int eq = line.indexOf("=");
      if (eq <= 0) continue;
      final String key = line.substring(0, eq).trim();
      final String value = line.substring(eq + 1).trim();
      if (key.isNotEmpty) result[key] = value;
    }
    return result;
  }

  static Map<String, String> readSync() {
    try {
      if (!configFile.existsSync()) return const <String, String>{};
      return parse(configFile.readAsStringSync());
    } catch (_) {
      return const <String, String>{};
    }
  }

  static Future<void> write(Map<String, String> values) async {
    await Directory(_dir).create(recursive: true);
    final StringBuffer sb = StringBuffer("# PrivateAgent 用户配置\n");
    for (final MapEntry<String, String> e in values.entries) {
      sb.write("${e.key}=${e.value}\n");
    }
    await configFile.writeAsString(sb.toString(), flush: true);
  }

  /// 是否已配置模型 key（runtime 聊天能力的最小前提）。
  static bool get hasApiKey {
    final String? key = readSync()["OPENAI_API_KEY"];
    return key != null && key.trim().isNotEmpty;
  }

  /// 模型接入三键合并写入（目录式选择的唯一落盘通道；write 是整文件覆写，
  /// 必须先读旧键再改）。[baseUrl]/[model] 传空则移除对应键，回落 runtime 默认。
  /// 消费方：resolve-provider.ts 的 openai 绑定（OPENAI_API_KEY/BASE_URL/MODEL）。
  static Future<void> writeModelConfig({
    required String apiKey,
    String? baseUrl,
    String? model,
  }) async {
    final Map<String, String> cfg = Map.of(readSync()); // readSync 返回不可变 map，须拷贝后改
    cfg["OPENAI_API_KEY"] = apiKey;
    final String base = (baseUrl ?? "").trim();
    if (base.isNotEmpty) {
      cfg["OPENAI_BASE_URL"] = base;
    } else {
      cfg.remove("OPENAI_BASE_URL");
    }
    final String m = (model ?? "").trim();
    if (m.isNotEmpty) {
      cfg["OPENAI_MODEL"] = m;
    } else {
      cfg.remove("OPENAI_MODEL");
    }
    await write(cfg);
  }
}
