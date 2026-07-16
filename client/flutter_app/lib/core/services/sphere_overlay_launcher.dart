import "dart:async";
import "dart:convert";
import "dart:io";

import "package:flutter/foundation.dart";
import "package:flutter/services.dart";

import "../config/api_config.dart";
import "agent_sphere_mood_bridge.dart";

/// Windows 桌宠启动器 — 默认 **Tauri** 或 **Flutter 内嵌 WebView**。
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
  static Process? _overlayProcess;
  static const String _commandArgPrefix = "--pai-command=";

  /// Tauri 桌宠是否已启动（UI 可据此隐藏内嵌 WebView 框）。
  static final ValueNotifier<bool> overlayActive = ValueNotifier<bool>(false);

  /// Tauri 不可用时的降级标记（显示内嵌透明 WebView）。
  static final ValueNotifier<bool> useEmbeddedFallback =
      ValueNotifier<bool>(false);

  static bool get isRunning => _created && _visible;
  static bool get isCreated => _created;
  static bool get usesOverlayProcess =>
      _overlayProcess != null || overlayActive.value;

  /// 进程内 Win32 WebView2 桌宠（非 Tauri、非内嵌 WebView）。
  static bool get isInProcessOverlayActive =>
      _created && _overlayProcess == null && !useEmbeddedFallback.value;

  /// Tauri 或进程内 overlay 任一就绪时，应隐藏 Flutter 内嵌 WebView。
  static bool get isDeskPetActive =>
      overlayActive.value || isInProcessOverlayActive;

  /// 是否已安装 Tauri 且 overlay 为 Tauri 可用的相对路径构建。
  static bool get isOverlayAvailable => overlayUnavailableReason == null;

  /// 桌宠不可用时的人类可读原因（用于 SnackBar）。
  static String? get overlayUnavailableReason {
    if (kIsWeb || !Platform.isWindows) {
      return "当前平台不支持 Tauri 桌宠。";
    }

    final Directory? overlayDir = _findTauriOverlayDir();
    if (overlayDir == null) {
      return "未找到 sphere-overlay-tauri 目录。\n"
          "请从仓库根目录启动客户端，或设置环境变量 PAI_REPO_ROOT 指向项目根目录。";
    }

    final String? overlayHtml = _findAvatarOverlayHtml(overlayDir);
    if (overlayHtml == null) {
      return "缺少 overlay.html。\n请执行：cd agent-sphere-avatar && npm run build";
    }

    if (_findTauriExe(overlayDir) == null) {
      return "未找到 Tauri 可执行文件。\n请执行：cd sphere-overlay-tauri && npm run tauri build";
    }

    return null;
  }

  static String? _findAvatarOverlayHtml(Directory overlayDir) {
    final File fromRepo = File(
      "${overlayDir.parent.path}/agent-sphere-avatar/dist/overlay.html",
    );
    if (fromRepo.existsSync()) return fromRepo.path;

    // 仅作兜底检测；build:chat 产物含 /chat 绝对路径。
    final File fromServerAssets = File(
      "${overlayDir.parent.path}/server/web/chat/assets/avatar/overlay.html",
    );
    if (fromServerAssets.existsSync()) return fromServerAssets.path;
    return null;
  }

  /// Tauri 可执行文件：优先 release，其次 debug。
  static File? _findTauriExe(Directory overlayDir) {
    final File release = File(
      "${overlayDir.path}/src-tauri/target/release/sphere-overlay-tauri.exe",
    );
    if (release.existsSync()) return release;
    final File debug = File(
      "${overlayDir.path}/src-tauri/target/debug/sphere-overlay-tauri.exe",
    );
    if (debug.existsSync()) return debug;
    return null;
  }

  static String _moodFilePath() =>
      "${Directory.systemTemp.path}${Platform.pathSeparator}pai-sphere-mood.json";

  static Future<bool> _sendOverlayCommand(String command) async {
    final Directory? overlayDir = _findTauriOverlayDir();
    if (overlayDir == null) return false;

    final File? tauriExe = _findTauriExe(overlayDir);
    if (tauriExe == null) return false;

    final Map<String, String> env =
        Map<String, String>.from(Platform.environment);
    env["PAI_WS_URL"] = ApiConfig.wsUrl;
    env["PAI_SESSION_ID"] = ApiConfig.effectiveActorId;
    env["PAI_HTTP_BASE"] = ApiConfig.httpBase;
    env["PAI_MOOD_FILE"] = _moodFilePath();
    env["PAI_REPO_ROOT"] = overlayDir.parent.path;

    try {
      final Process proc = await Process.start(
        tauriExe.path,
        <String>["$_commandArgPrefix$command"],
        workingDirectory: overlayDir.path,
        environment: env,
      );
      unawaited(proc.exitCode);
      return true;
    } catch (e) {
      debugPrint("[SphereOverlay] send overlay command failed: $e");
    }

    return false;
  }

  static Future<bool> isWebViewReady() async {
    if (!_created) return false;
    if (overlayActive.value || useEmbeddedFallback.value) return true;
    if (_overlayProcess != null) return true;
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
    if (_overlayProcess != null) return true;
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
    if (_created && electron && overlayActive.value) return true;

    if (electron) {
      return _launchTauriOverlay();
    }

    if (_useInProcessOverlay) {
      final bool native = await _createInProcess(overlayUrl: overlayUrl);
      if (native) return true;
    }

    return _enableEmbeddedFallback();
  }

  /// 在应用内嵌 WebView 槽位显示桌宠（无独立 HWND / Tauri）。
  static bool _enableEmbeddedFallback() {
    debugPrint(
      "[SphereOverlay] Using embedded Flutter WebView fallback in chat slot.",
    );
    _created = true;
    _visible = true;
    overlayActive.value = false;
    useEmbeddedFallback.value = true;
    return true;
  }

  /// 热重启后 Dart 静态变量会清零，但原生 overlay 可能仍在；先对齐状态。
  static Future<void> _resyncNativeOverlayState() async {
    if (_overlayProcess != null) return;
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

  /// AppBar 手动启动 Tauri 独立桌宠（会先关闭 Win32 原生窗）。
  static Future<bool> launchOverlay() async {
    if (kIsWeb || !Platform.isWindows) return false;

    if (overlayActive.value || _created) {
      final bool shown = await _sendOverlayCommand("show");
      if (shown) {
        _created = true;
        _visible = true;
        overlayActive.value = true;
        useEmbeddedFallback.value = false;
        return true;
      }
      debugPrint("[SphereOverlay] show command failed, relaunching Tauri…");
    }

    await destroy();
    overlayActive.value = false;
    _created = false;
    return _launchTauriOverlay();
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
        overlayActive.value = false;
      } else {
        debugPrint("[SphereOverlay] native create returned false");
      }
      return ok;
    } catch (e) {
      debugPrint("[SphereOverlay] in-process create failed: $e");
      return false;
    }
  }

  static Future<bool> _launchTauriOverlay() async {
    final Directory? overlayDir = _findTauriOverlayDir();
    if (overlayDir == null) {
      debugPrint("[SphereOverlay] sphere-overlay-tauri not found.");
      return false;
    }

    final File? tauriExe = _findTauriExe(overlayDir);
    if (tauriExe == null) {
      debugPrint(
        "[SphereOverlay] missing Tauri exe — run: "
        "cd sphere-overlay-tauri && npm run tauri build",
      );
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
      env["PAI_MOOD_FILE"] = _moodFilePath();
      env["PAI_REPO_ROOT"] = overlayDir.parent.path;

      debugPrint("[SphereOverlay] launching Tauri from ${overlayDir.path}");

      await Process.start(
        tauriExe.path,
        <String>["${_commandArgPrefix}show"],
        workingDirectory: overlayDir.path,
        environment: env,
        mode: ProcessStartMode.detached,
      );

      // detached 进程不可监听 exitCode；桌宠独立存活，热重启不拖垮主进程。
      _overlayProcess = null;
      _created = true;
      _visible = true;
      overlayActive.value = true;
      useEmbeddedFallback.value = false;
      return true;
    } catch (e) {
      debugPrint("[SphereOverlay] Tauri launch failed: $e");
      _overlayProcess = null;
      return false;
    }
  }

  static Directory? _findTauriOverlayDir() {
    final String? repoRoot = Platform.environment["PAI_REPO_ROOT"]?.trim();
    if (repoRoot != null && repoRoot.isNotEmpty) {
      final Directory fromEnv = Directory("$repoRoot/sphere-overlay-tauri");
      if (fromEnv.existsSync()) return fromEnv;
    }

    final List<String> seeds = <String>[
      Directory.current.path,
      File(Platform.resolvedExecutable).parent.path,
    ];

    for (final String seed in seeds) {
      Directory dir = Directory(seed);
      for (int i = 0; i < 15; i++) {
        final Directory candidate = Directory("${dir.path}/sphere-overlay-tauri");
        if (candidate.existsSync()) {
          return candidate;
        }
        final Directory sibling =
            Directory("${dir.path}${Platform.pathSeparator}sphere-overlay-tauri");
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
    if (_overlayProcess != null) return;
    try {
      await _channel.invokeMethod<bool>("show");
      _visible = true;
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] show failed: ${e.message}");
    }
  }

  static Future<void> hide() async {
    if (!_created) return;
    if (_overlayProcess != null) return;
    try {
      await _channel.invokeMethod<bool>("hide");
      _visible = false;
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] hide failed: ${e.message}");
    }
  }

  static Future<void> destroy() async {
    if (overlayActive.value) {
      await _sendOverlayCommand("close");
      overlayActive.value = false;
      _created = false;
      _visible = false;
      useEmbeddedFallback.value = false;
      return;
    }
    if (_overlayProcess != null) {
      try {
        _overlayProcess!.kill();
      } catch (_) {}
      _overlayProcess = null;
    }
    if (overlayActive.value && _overlayProcess == null) {
      overlayActive.value = false;
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
    if (!_created || _overlayProcess != null) return;
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
    if (!_created || _overlayProcess != null) return;
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
    if (!_created || _overlayProcess != null) return null;
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
    if (!_created || _overlayProcess != null) return;
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
    if (!_created || _overlayProcess != null) return;
    try {
      await _channel.invokeMethod("roam");
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] roam failed: ${e.message}");
    }
  }

  static Future<void> setIgnoreMouseEvents(bool ignore,
      {bool forward = true}) async {
    if (!_created || _overlayProcess != null) return;
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
    if (overlayActive.value) {
      try {
        final File moodFile = File(_moodFilePath());
        await moodFile.writeAsString(jsonEncode(patch.toJson()), flush: true);
      } catch (e) {
        debugPrint("[SphereOverlay] overlay patchMood failed: $e");
      }
      return;
    }
    if (_overlayProcess != null) return;
    try {
      await _channel.invokeMethod("patchMood",
          <String, dynamic>{"patch": jsonEncode(patch.toJson())});
    } on PlatformException catch (e) {
      debugPrint("[SphereOverlay] patchMood failed: ${e.message}");
    }
  }

  static Future<Map<String, int>?> getWorkArea() async {
    if (!_created || _overlayProcess != null) return null;
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

    if (_created && electron && overlayActive.value) return true;
    if (_created && !electron && useEmbeddedFallback.value) return true;

    // 旧版原生窗可能残留但 WebView2 已禁用，清掉后走内嵌降级。
    if (_created && !electron && !useEmbeddedFallback.value && !overlayActive.value) {
      await destroy();
    }

    if (electron) {
      return _launchTauriOverlay();
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
