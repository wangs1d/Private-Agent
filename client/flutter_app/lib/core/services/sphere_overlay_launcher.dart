import "dart:convert";
import "dart:io";

import "package:flutter/foundation.dart";
import "package:path_provider/path_provider.dart";

import "../config/api_config.dart";
import "agent_sphere_mood_bridge.dart";

/// 启动桌面透明悬浮 Agent（Electron overlay，不受应用窗口限制）
class SphereOverlayLauncher {
  SphereOverlayLauncher._();

  static Process? _process;
  static File? _moodFile;

  static bool get isRunning => _process != null;

  static Future<File> _moodFilePath() async {
    if (_moodFile != null) return _moodFile!;
    final Directory temp = await getTemporaryDirectory();
    _moodFile = File("${temp.path}${Platform.pathSeparator}pai-sphere-mood.json");
    return _moodFile!;
  }

  /// 向悬浮窗写入 mood（Electron 轮询该文件）
  static Future<void> patchMood(AgentSpherePatch patch) async {
    if (kIsWeb || !Platform.isWindows) return;
    try {
      final File file = await _moodFilePath();
      await file.writeAsString(jsonEncode(patch.toJson()));
    } catch (e, st) {
      debugPrint("[SphereOverlay] patchMood failed: $e\n$st");
    }
  }

  /// 启动 sphere-overlay（仅 Windows 桌面；Web/其他平台返回 false）
  static Future<bool> launch({String? repoRoot}) async {
    if (kIsWeb || !Platform.isWindows) return false;
    if (_process != null) return true;

    final String root = repoRoot ?? _guessRepoRoot();
    final String script = "$root${Platform.pathSeparator}sphere-overlay${Platform.pathSeparator}start-overlay.ps1";
    final File scriptFile = File(script);
    if (!scriptFile.existsSync()) {
      debugPrint("[SphereOverlay] script not found: $script");
      return false;
    }

    try {
      final File moodFile = await _moodFilePath();
      _process = await Process.start(
        "powershell",
        <String>[
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
        ],
        environment: <String, String>{
          "PAI_WS_URL": ApiConfig.wsUrl,
          "PAI_SESSION_ID": ApiConfig.effectiveActorId,
          "PAI_MOOD_FILE": moodFile.path,
        },
        runInShell: true,
      );
      _process!.exitCode.then((int code) {
        debugPrint("[SphereOverlay] exited with code $code");
        _process = null;
      });
      return true;
    } catch (e, st) {
      debugPrint("[SphereOverlay] launch failed: $e\n$st");
      _process = null;
      return false;
    }
  }

  static Future<void> stop() async {
    _process?.kill();
    _process = null;
  }

  static String _guessRepoRoot() {
    final String cwd = Directory.current.path;
    if (File("$cwd${Platform.pathSeparator}sphere-overlay${Platform.pathSeparator}start-overlay.ps1").existsSync()) {
      return cwd;
    }
    final String parent = Directory(cwd).parent.path;
    if (File("$parent${Platform.pathSeparator}sphere-overlay${Platform.pathSeparator}start-overlay.ps1").existsSync()) {
      return parent;
    }
    return cwd;
  }
}
