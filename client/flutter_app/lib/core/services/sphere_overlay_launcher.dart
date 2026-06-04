import "dart:async";
import "dart:convert";
import "dart:io";

import "package:flutter/foundation.dart";
import "package:flutter/services.dart";

import "../config/api_config.dart";
import "agent_sphere_mood_bridge.dart";

/// Windows 桌宠启动器 — 默认 **Electron** 或 **Flutter 内嵌 WebView**。
/// Runner 内不再链接第二套 WebView2（会与 webview_windows 冲突导致进程崩溃）。
class SphereOverlayLauncher {
  SphereOverlayLauncher._();

  static const MethodChannel _channel =
      MethodChannel("pai/sphere_overlay");

  static const bool _useInProcessOverlay = bool.fromEnvironment(
    "IN_PROCESS_SPHERE_OVERLAY",
    defaultValue: false,
  );

  static bool _created = false;
  static bool _visible = false;
  static Process? _electronProcess;
  static const String _electronCommandArgPrefix = "--pai-command=";

  /// Electron 桌宠是否已启动（UI 可据此隐藏内嵌 WebView 框）。
  static final ValueNotifier<bool> electronActive = ValueNotifier<bool>(false);

  /// Electron 不可用时的降级标记（显示内嵌透明 WebView）。
  static final ValueNotifier<bool> useEmbeddedFallback =
      ValueNotifier<bool>(false);

  static bool get isRunning => _created && _visible;
  static bool get isCreated => _created;
  static bool get usesElectron => _electronProcess != null || electronActive.value;

  /// 进程内 Win32 WebView2 桌宠（非 Electron、非内嵌 WebView）。
  static bool get isInProcessOverlayActive =>
      _created && _electronProcess == null && !useEmbeddedFallback.value;

  /// Electron 或进程内 overlay 任一就绪时，应隐藏 Flutter 内嵌 WebView。
  static bool get isDeskPetActive =>
      electronActive.value || isInProcessOverlayActive;

  /// 是否已安装 Electron 且 overlay 为 Electron 可用的相对路径构建。
  static bool get isElectronAvailable => electronUnavailableReason == null;

  /// 桌宠不可用时的人类可读原因（用于 SnackBar）。
  static String? get electronUnavailableReason {
    if (kIsWeb || !Platform.isWindows) {
      return "当前平台不支持 Electron 桌宠。";
    }

    final Directory? overlayDir = _findSphereOverlayDir();
    if (overlayDir == null) {
      return "未找到 sphere-overlay 目录。\n"
          "请从仓库根目录启动客户端，或设置环境变量 PAI_REPO_ROOT 指向项目根目录。";
    }

    if (!File("${overlayDir.path}/package.json").existsSync()) {
      return "sphere-overlay 不完整：缺少 package.json。";
    }

    if (!Directory("${overlayDir.path}/node_modules").existsSync()) {
      return "请先安装桌宠依赖：\ncd sphere-overlay && npm install";
    }

    final String? overlayHtml = _findAvatarOverlayHtml(overlayDir);
    if (overlayHtml == null) {
      return "缺少 overlay.html。\n请执行：cd agent-sphere-avatar && npm run build";
    }

    if (!_isElectronCompatibleOverlay(File(overlayHtml))) {
      return "overlay 构建路径不正确（当前为服务端 /chat 路径）。\n"
          "请重新构建桌宠资源：\ncd agent-sphere-avatar && npm run build\n"
          "（不要用 npm run build:chat）";
    }

    final File electronExe = File(
      "${overlayDir.path}/node_modules/electron/dist/electron.exe",
    );
    final File electronBin = File(
      "${overlayDir.path}/node_modules/.bin/electron.cmd",
    );
    if (!electronExe.existsSync() && !electronBin.existsSync()) {
      return "未找到 Electron 可执行文件。\n请执行：cd sphere-overlay && npm install";
    }

    return null;
  }

  /// Electron loadFile 需要 Vite base=./ 的构建（src="./assets/..."）。
  static bool _isElectronCompatibleOverlay(File html) {
    try {
      final String content = html.readAsStringSync();
      if (content.contains('src="./assets/') ||
          content.contains("src='./assets/")) {
        return true;
      }
      if (content.contains('src="/chat/assets/') ||
          content.contains("src='/chat/assets/")) {
        return false;
      }
      return content.contains('src="./') || content.contains("src='./");
    } catch (e) {
      debugPrint("[SphereOverlay] overlay.html read failed: $e");
      return false;
    }
  }

  static String? _findAvatarOverlayHtml(Directory overlayDir) {
    final File fromRepo = File(
      "${overlayDir.parent.path}/agent-sphere-avatar/dist/overlay.html",
    );
    if (fromRepo.existsSync()) return fromRepo.path;

    // 仅作兜底检测；build:chat 产物含 /chat 绝对路径，Electron loadFile 无法加载。
    final File fromServerAssets = File(
      "${overlayDir.parent.path}/server/web/chat/assets/avatar/overlay.html",
    );
    if (fromServerAssets.existsSync()) return fromServerAssets.path;
    return null;
  }

  static String _electronMoodFilePath() =>
      "${Directory.systemTemp.path}${Platform.pathSeparator}pai-sphere-mood.json";

  static Future<bool> _sendElectronCommand(String command) async {
    final Directory? overlayDir = _findSphereOverlayDir();
    if (overlayDir == null) return false;

    final Map<String, String> env =
        Map<String, String>.from(Platform.environment);
    env["PAI_WS_URL"] = ApiConfig.wsUrl;
    env["PAI_SESSION_ID"] = ApiConfig.effectiveActorId;
    env["PAI_HTTP_BASE"] = ApiConfig.httpBase;
    env["PAI_MOOD_FILE"] = _electronMoodFilePath();
    env["PAI_REPO_ROOT"] = overlayDir.parent.path;

    final File electronBin = File(
      "${overlayDir.path}/node_modules/.bin/electron.cmd",
    );
    final File electronExe = File(
      "${overlayDir.path}/node_modules/electron/dist/electron.exe",
    );
    final List<String> args = <String>[".", "$_electronCommandArgPrefix$command"];

    try {
      if (electronExe.existsSync()) {
        final Process proc = await Process.start(
          electronExe.path,
          args,
          workingDirectory: overlayDir.path,
          environment: env,
        );
        unawaited(proc.exitCode);
        return true;
      }
      if (electronBin.existsSync()) {
        final Process proc = await Process.start(
          "cmd",
          <String>["/c", electronBin.path, ...args],
          workingDirectory: overlayDir.path,
          environment: env,
        );
        unawaited(proc.exitCode);
        return true;
      }
    } catch (e) {
      debugPrint("[SphereOverlay] send electron command failed: $e");
    }

    return false;
  }

  static Future<bool> isWebViewReady() async {
    if (!_created) return false;
    if (electronActive.value || useEmbeddedFallback.value) return true;
    if (_electronProcess != null) return true;
    try {
      return await _channel.invokeMethod<bool>("isWebViewReady") ?? false;
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] isWebViewReady failed: ${e.message}");
      return false;
    } on MissingPluginException catch (e) {
      debugPrint("[SphereOverlay] isWebViewReady failed: $e");
      return false;
    }
  }

  static Future<bool> waitForWebViewReady({
    Duration timeout = const Duration(seconds: 15),
  }) async {
    if (_electronProcess != null) return true;
    final Stopwatch sw = Stopwatch()..start();
    while (sw.elapsed < timeout) {
      if (await isWebViewReady()) return true;
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
    return false;
  }

  static Future<bool> create({String? overlayUrl, bool electron = false}) async {
    if (kIsWeb || !Platform.isWindows) return false;

    await _resyncNativeOverlayState();
    if (_created && !electron && useEmbeddedFallback.value) return true;
    if (_created && electron && electronActive.value) return true;

    if (electron) {
      return _launchElectronOverlay();
    }

    if (_useInProcessOverlay) {
      final bool native = await _createInProcess(overlayUrl: overlayUrl);
      if (native) return true;
    }

    return _enableEmbeddedFallback();
  }

  /// 在应用内嵌 WebView 槽位显示桌宠（无独立 HWND / Electron）。
  static bool _enableEmbeddedFallback() {
    debugPrint(
      "[SphereOverlay] Using embedded Flutter WebView fallback in chat slot.",
    );
    _created = true;
    _visible = true;
    electronActive.value = false;
    useEmbeddedFallback.value = true;
    return true;
  }

  /// 热重启后 Dart 静态变量会清零，但原生 overlay 可能仍在；先对齐状态。
  static Future<void> _resyncNativeOverlayState() async {
    if (_electronProcess != null) return;
    try {
      final bool nativeUp =
          await _channel.invokeMethod<bool>("isCreated") ?? false;
      if (nativeUp) {
        _created = true;
        _visible = true;
        useEmbeddedFallback.value = false;
      }
    } catch (e) {
      debugPrint("[SphereOverlay] resync failed: $e");
    }
  }

  /// AppBar 手动启动 Electron 独立桌宠（会先关闭 Win32 原生窗）。
  static Future<bool> launchElectron() async {
    if (kIsWeb || !Platform.isWindows) return false;

    if (electronActive.value || _created) {
      final bool shown = await _sendElectronCommand("show");
      if (shown) {
        _created = true;
        _visible = true;
        electronActive.value = true;
        useEmbeddedFallback.value = false;
        return true;
      }
      debugPrint("[SphereOverlay] show command failed, relaunching Electron…");
    }

    await destroy();
    electronActive.value = false;
    _created = false;
    return _launchElectronOverlay();
  }

  static Future<bool> _createInProcess({String? overlayUrl}) async {
    try {
      final String url = overlayUrl ?? _buildOverlayUrl();
      debugPrint("[SphereOverlay] creating native overlay: $url");
      final bool ok = await _channel.invokeMethod<bool>("create", <String, dynamic>{
        "url": url,
      }) ??
          false;
      if (ok) {
        _created = true;
        useEmbeddedFallback.value = false;
        electronActive.value = false;
      } else {
        debugPrint("[SphereOverlay] native create returned false");
      }
      return ok;
    } catch (e) {
      debugPrint("[SphereOverlay] in-process create failed: $e");
      return false;
    }
  }

  static Future<bool> _launchElectronOverlay() async {
    final Directory? overlayDir = _findSphereOverlayDir();
    if (overlayDir == null) {
      debugPrint("[SphereOverlay] sphere-overlay not found.");
      return false;
    }

    final File packageJson = File("${overlayDir.path}/package.json");
    if (!packageJson.existsSync()) {
      debugPrint("[SphereOverlay] missing ${packageJson.path}");
      return false;
    }

    final Directory nodeModules = Directory("${overlayDir.path}/node_modules");
    if (!nodeModules.existsSync()) {
      debugPrint("[SphereOverlay] run: cd sphere-overlay && npm install");
      return false;
    }

    if (_findAvatarOverlayHtml(overlayDir) == null) {
      debugPrint(
        "[SphereOverlay] missing overlay.html — run: "
        "cd agent-sphere-avatar && npm run build",
      );
      return false;
    }

    try {
      final Map<String, String> env =
          Map<String, String>.from(Platform.environment);
      env["PAI_WS_URL"] = ApiConfig.wsUrl;
      env["PAI_SESSION_ID"] = ApiConfig.effectiveActorId;
      env["PAI_HTTP_BASE"] = ApiConfig.httpBase;
      env["PAI_MOOD_FILE"] = _electronMoodFilePath();
      env["PAI_REPO_ROOT"] = overlayDir.parent.path;

      debugPrint("[SphereOverlay] launching Electron from ${overlayDir.path}");

      final File electronBin = File(
        "${overlayDir.path}/node_modules/.bin/electron.cmd",
      );
      final File electronExe = File(
        "${overlayDir.path}/node_modules/electron/dist/electron.exe",
      );

      if (electronExe.existsSync()) {
        await Process.start(
          electronExe.path,
          <String>[".", "${_electronCommandArgPrefix}show"],
          workingDirectory: overlayDir.path,
          environment: env,
          mode: ProcessStartMode.detached,
        );
      } else if (electronBin.existsSync()) {
        await Process.start(
          "cmd",
          <String>["/c", electronBin.path, ".", "${_electronCommandArgPrefix}show"],
          workingDirectory: overlayDir.path,
          environment: env,
          mode: ProcessStartMode.detached,
        );
      } else {
        await Process.start(
          "cmd",
          <String>["/c", "npm", "start", "--", "${_electronCommandArgPrefix}show"],
          workingDirectory: overlayDir.path,
          environment: env,
          mode: ProcessStartMode.detached,
        );
      }

      // detached 进程不可监听 exitCode；桌宠独立存活，热重启不拖垮主进程。
      _electronProcess = null;
      _created = true;
      _visible = true;
      electronActive.value = true;
      useEmbeddedFallback.value = false;
      return true;
    } catch (e) {
      debugPrint("[SphereOverlay] Electron launch failed: $e");
      _electronProcess = null;
      return false;
    }
  }

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
        if (candidate.existsSync()) {
          return candidate;
        }
        final Directory sibling =
            Directory("${dir.path}${Platform.pathSeparator}sphere-overlay");
        if (sibling.existsSync()) {
          return sibling;
        }
        final Directory parent = dir.parent;
        if (parent.path == dir.path) break;
        dir = parent;
      }
    }
    return null;
  }

  static String _buildOverlayUrl() {
    final String wsUrl = ApiConfig.wsUrl;
    final String sessionId = ApiConfig.effectiveActorId;

    final Uri base = Uri.parse(ApiConfig.httpBase);
    final String path =
        "${base.path}/chat/assets/avatar/overlay.html".replaceAll("//", "/");

    return Uri(
      scheme: base.scheme,
      host: base.host,
      port: base.port,
      path: path,
      queryParameters: <String, String>{
        "ws": wsUrl,
        if (sessionId.isNotEmpty) "sessionId": sessionId,
      },
    ).toString();
  }

  static Future<void> show() async {
    if (!_created) return;
    if (_electronProcess != null) return;
    try {
      await _channel.invokeMethod<bool>("show");
      _visible = true;
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] show failed: ${e.message}");
    }
  }

  static Future<void> hide() async {
    if (!_created) return;
    if (_electronProcess != null) return;
    try {
      await _channel.invokeMethod<bool>("hide");
      _visible = false;
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] hide failed: ${e.message}");
    }
  }

  static Future<void> destroy() async {
    if (electronActive.value) {
      await _sendElectronCommand("close");
      electronActive.value = false;
      _created = false;
      _visible = false;
      useEmbeddedFallback.value = false;
      return;
    }
    if (_electronProcess != null) {
      try {
        _electronProcess!.kill();
      } catch (_) {}
      _electronProcess = null;
    }
    if (electronActive.value && _electronProcess == null) {
      electronActive.value = false;
    }
    if (!_created) return;
    try {
      await _channel.invokeMethod<bool>("destroy");
    } catch (e) {
      debugPrint("[SphereOverlay] destroy failed: $e");
    }
    _created = false;
    _visible = false;
    useEmbeddedFallback.value = false;
  }

  static Future<void> moveTo(int x, int y, {int durationMs = 0}) async {
    if (!_created || _electronProcess != null) return;
    try {
      await _channel.invokeMethod("moveTo", <String, dynamic>{
        "x": x,
        "y": y,
        "duration": durationMs,
      });
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] moveTo failed: ${e.message}");
    }
  }

  static Future<void> setBounds(
    int x,
    int y,
    int width,
    int height, {
    int durationMs = 0,
  }) async {
    if (!_created || _electronProcess != null) return;
    try {
      await _channel.invokeMethod("setBounds", <String, dynamic>{
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "duration": durationMs,
      });
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] setBounds failed: ${e.message}");
    }
  }

  static Future<Map<String, int>?> getAppBounds() async {
    if (kIsWeb || !Platform.isWindows) return null;
    try {
      final Map<dynamic, dynamic>? result =
          await _channel.invokeMapMethod("getAppBounds");
      if (result == null) return null;
      return result.map((k, v) => MapEntry(k.toString(), v as int));
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] getAppBounds failed: ${e.message}");
      return null;
    }
  }

  static Future<Map<String, int>?> getBounds() async {
    if (!_created || _electronProcess != null) return null;
    try {
      final Map<dynamic, dynamic>? result =
          await _channel.invokeMapMethod("getBounds");
      if (result == null) return null;
      return result.map((k, v) => MapEntry(k.toString(), v as int));
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] getBounds failed: ${e.message}");
      return null;
    }
  }

  static Future<void> moveBy(int dx, int dy) async {
    if (!_created || _electronProcess != null) return;
    try {
      await _channel.invokeMethod("moveBy", <String, dynamic>{
        "dx": dx,
        "dy": dy,
      });
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] moveBy failed: ${e.message}");
    }
  }

  static Future<void> roam() async {
    if (!_created || _electronProcess != null) return;
    try {
      await _channel.invokeMethod("roam");
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] roam failed: ${e.message}");
    }
  }

  static Future<void> setIgnoreMouseEvents(bool ignore,
      {bool forward = true}) async {
    if (!_created || _electronProcess != null) return;
    try {
      await _channel.invokeMethod("setIgnoreMouseEvents",
          <String, dynamic>{"ignore": ignore, "forward": forward});
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] setIgnoreMouseEvents failed: ${e.message}");
    }
  }

  static Future<void> patchMood(AgentSpherePatch patch) async {
    if (kIsWeb || !Platform.isWindows || !_created) {
      return;
    }
    if (electronActive.value) {
      try {
        final File moodFile = File(_electronMoodFilePath());
        await moodFile.writeAsString(jsonEncode(patch.toJson()), flush: true);
      } catch (e) {
        debugPrint("[SphereOverlay] electron patchMood failed: $e");
      }
      return;
    }
    if (_electronProcess != null) return;
    try {
      await _channel.invokeMethod("patchMood",
          <String, dynamic>{"patch": jsonEncode(patch.toJson())});
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] patchMood failed: ${e.message}");
    }
  }

  static Future<Map<String, int>?> getWorkArea() async {
    if (!_created || _electronProcess != null) return null;
    try {
      final Map<dynamic, dynamic>? result =
          await _channel.invokeMapMethod("getWorkArea");
      if (result == null) return null;
      return result.map((k, v) => MapEntry(k.toString(), v as int));
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] getWorkArea failed: ${e.message}");
      return null;
    }
  }

  static Future<bool> launch({String? repoRoot, bool electron = false}) async {
    if (kIsWeb || !Platform.isWindows) return false;
    await _resyncNativeOverlayState();

    if (_created && electron && electronActive.value) return true;
    if (_created && !electron && useEmbeddedFallback.value) return true;

    // 旧版原生窗可能残留但 WebView2 已禁用，清掉后走内嵌降级。
    if (_created && !electron && !useEmbeddedFallback.value && !electronActive.value) {
      await destroy();
    }

    if (electron) {
      return _launchElectronOverlay();
    }

    if (_useInProcessOverlay) {
      final bool native = await _createInProcess(overlayUrl: repoRoot);
      if (native) {
        await show();
        if (await waitForWebViewReady(
          timeout: const Duration(seconds: 15),
        )) {
          return true;
        }
        await destroy();
      }
    }

    return _enableEmbeddedFallback();
  }

  static Future<void> stop() => destroy();
}
