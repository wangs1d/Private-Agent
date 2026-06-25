import "dart:async";
import "dart:io";

import "package:flutter/foundation.dart";

import "../config/api_config.dart";

/// 日程悬浮窗启动器 — 通过 Electron 启动**独立桌面窗口**（非应用内嵌）。
///
/// 使用方式：
/// 1. 用户在 UI 中点击"桌面悬浮模式" → 调用 [launch] 启动独立 Electron 窗口
/// 2. 用户再次点击或调用 [toggle] 切换显示/隐藏
/// 3. 偏好通过 [SchedulePreference] 持久化，下次启动自动恢复
class ScheduleFloatingLauncher {
  ScheduleFloatingLauncher._();

  static const String _electronCommandArgPrefix = "--pai-command=";

  static Process? _electronProcess;
  static bool _visible = false;
  static bool _created = false;

  /// 日程悬浮窗是否正在运行
  static bool get isRunning => _created && _visible;

  /// 是否已创建过（可能被隐藏）
  static bool get isCreated => _created;

  /// 当前活跃状态变化通知
  static final ValueNotifier<bool> activeNotifier = ValueNotifier<bool>(false);

  /// 更新通知监听器
  static void _notifyActive() {
    activeNotifier.value = isRunning;
  }

  /// 查找 sphere-overlay 目录
  static Directory? _findSphereOverlayDir() {
    final String? repoRoot = Platform.environment["PAI_REPO_ROOT"]?.trim();
    if (repoRoot != null && repoRoot.isNotEmpty) {
      final Directory fromEnv = Directory("$repoRoot/sphere-overlay");
      if (fromEnv.existsSync()) return fromEnv;
    }

    final List<String> seeds = <String>[
      Directory.current.path,
      File(Platform.resolvedExecutable).parent.path,
    ];

    for (final String seed in seeds) {
      Directory dir = Directory(seed);
      for (int i = 0; i < 15; i++) {
        final Directory candidate = Directory("${dir.path}/sphere-overlay");
        if (candidate.existsSync()) return candidate;
        final Directory sibling =
            Directory("${dir.path}${Platform.pathSeparator}sphere-overlay");
        if (sibling.existsSync()) return sibling;
        final Directory parent = dir.parent;
        if (parent.path == dir.path) break;
        dir = parent;
      }
    }
    return null;
  }

  /// 检查 Electron 是否可用
  static String? get electronUnavailableReason {
    if (kIsWeb || !Platform.isWindows) {
      return "当前平台不支持独立日程悬浮窗。";
    }

    final Directory? overlayDir = _findSphereOverlayDir();
    if (overlayDir == null) {
      return "未找到 sphere-overlay 目录。";
    }

    if (!File("${overlayDir.path}/package.json").existsSync()) {
      return "sphere-overlay 不完整。";
    }

    if (!Directory("${overlayDir.path}/node_modules").existsSync()) {
      return "请先安装依赖：cd sphere-overlay && npm install";
    }

    final File electronExe = File(
      "${overlayDir.path}/node_modules/electron/dist/electron.exe",
    );
    final File electronBin = File(
      "${overlayDir.path}/node_modules/.bin/electron.cmd",
    );
    if (!electronExe.existsSync() && !electronBin.existsSync()) {
      return "未找到 Electron 可执行文件。";
    }

    return null;
  }

  /// 向已运行的 Electron 进程发送命令
  static Future<bool> _sendElectronCommand(String command) async {
    final Directory? overlayDir = _findSphereOverlayDir();
    if (overlayDir == null) return false;

    final Map<String, String> env =
        Map<String, String>.from(Platform.environment);
    env["PAI_WS_URL"] = ApiConfig.wsUrl;
    env["PAI_SESSION_ID"] = ApiConfig.effectiveActorId;
    env["PAI_HTTP_BASE"] = ApiConfig.httpBase;
    env["PAI_REPO_ROOT"] = overlayDir.parent.path;

    final File electronBin = File(
      "${overlayDir.path}/node_modules/.bin/electron.cmd",
    );
    final File electronExe = File(
      "${overlayDir.path}/node_modules/electron/dist/electron.exe",
    );

    final List<String> args =
        <String>[".", "$_electronCommandArgPrefix$command"];

    try {
      if (electronExe.existsSync()) {
        await Process.start(
          electronExe.path,
          args,
          workingDirectory: overlayDir.path,
          environment: env,
        );
        unawaited(Process.start(electronExe.path, args, // nosem(avoid-dynamic-process-calls)
            workingDirectory: overlayDir.path, environment: env));
        return true;
      }
      if (electronBin.existsSync()) {
        await Process.start(
          "cmd",
          <String>["/c", electronBin.path, ...args],
          workingDirectory: overlayDir.path,
          environment: env,
        );
        return true;
      }
    } catch (e) {
      debugPrint("[ScheduleFloat] send command failed: $e");
    }

    return false;
  }

  /// 启动独立的日程悬浮窗 Electron 进程
  static Future<bool> _launchElectronScheduleWindow() async {
    final Directory? overlayDir = _findSphereOverlayDir();
    if (overlayDir == null) {
      debugPrint("[ScheduleFloat] sphere-overlay not found.");
      return false;
    }

    try {
      final Map<String, String> env =
          Map<String, String>.from(Platform.environment);
      env["PAI_WS_URL"] = ApiConfig.wsUrl;
      env["PAI_SESSION_ID"] = ApiConfig.effectiveActorId;
      env["PAI_HTTP_BASE"] = ApiConfig.httpBase;
      env["PAI_REPO_ROOT"] = overlayDir.parent.path;

      debugPrint(
        "[ScheduleFloat] launching schedule window from ${overlayDir.path}",
      );

      final File electronExe = File(
        "${overlayDir.path}/node_modules/electron/dist/electron.exe",
      );
      final File electronBin = File(
        "${overlayDir.path}/node_modules/.bin/electron.cmd",
      );

      if (electronExe.existsSync()) {
        await Process.start(
          electronExe.path,
          <String>[
            ".",
            "${_electronCommandArgPrefix}schedule:show",
          ],
          workingDirectory: overlayDir.path,
          environment: env,
          mode: ProcessStartMode.detached,
        );
      } else if (electronBin.existsSync()) {
        await Process.start(
          "cmd",
          <String>[
            "/c",
            electronBin.path,
            ".",
            "${_electronCommandArgPrefix}schedule:show",
          ],
          workingDirectory: overlayDir.path,
          environment: env,
          mode: ProcessStartMode.detached,
        );
      } else {
        debugPrint("[ScheduleFloat] No electron binary found");
        return false;
      }

      // detached 进程独立存活
      _electronProcess = null;
      _created = true;
      _visible = true;
      _notifyActive();
      return true;
    } catch (e) {
      debugPrint("[ScheduleFloat] launch failed: $e");
      _electronProcess = null;
      return false;
    }
  }

  /// 启动日程悬浮窗
  static Future<bool> launch() async {
    if (kIsWeb || !Platform.isWindows) return false;

    // 如果已经在运行，只需显示
    if (_created && _visible) return true;
    if (_created && !_visible) {
      return show();
    }

    return _launchElectronScheduleWindow();
  }

  /// 显示已隐藏的悬浮窗
  static Future<bool> show() async {
    if (!_created) return launch();
    final bool ok = await _sendElectronCommand("schedule:show");
    if (ok) {
      _visible = true;
      _notifyActive();
    }
    return ok;
  }

  /// 隐藏悬浮窗（不销毁）
  static Future<bool> hide() async {
    if (!_created) return false;
    final bool ok = await _sendElectronCommand("schedule:hide");
    if (ok) {
      _visible = false;
      _notifyActive();
    }
    return ok;
  }

  /// 切换显示/隐藏
  static Future<bool> toggle() async {
    if (!_created || !_visible) {
      return launch();
    }
    return hide();
  }

  /// 关闭悬浮窗进程
  static Future<void> close() async {
    await _sendElectronCommand("schedule:hide");
    if (_electronProcess != null) {
      try {
        _electronProcess!.kill();
      } catch (_) {}
      _electronProcess = null;
    }
    _created = false;
    _visible = false;
    _notifyActive();
  }

  /// 完全停止并重置
  static Future<void> stop() => close();
}
