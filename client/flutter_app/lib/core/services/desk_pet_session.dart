import "dart:io";

import "package:flutter/foundation.dart";

import "sphere_entity_controller.dart";
import "sphere_overlay_launcher.dart";

/// 桌宠会话：默认隐藏，用户点击“召唤桌宠”后才显示。
class DeskPetSession extends ChangeNotifier {
  DeskPetSession._();

  static final DeskPetSession instance = DeskPetSession._();

  bool _summoned = false;
  bool _bootstrapping = false;
  String? _error;

  bool get isSummoned => _summoned;
  bool get isBootstrapping => _bootstrapping;
  String? get error => _error;

  static bool get isSupported => kIsWeb || (!kIsWeb && Platform.isWindows);

  Future<bool> summon() async {
    if (!isSupported) {
      _error = "当前平台不支持桌宠。";
      notifyListeners();
      return false;
    }

    _bootstrapping = true;
    _error = null;
    notifyListeners();

    if (kIsWeb) {
      _summoned = true;
      _bootstrapping = false;
      notifyListeners();
      return true;
    }

    final String? setupIssue = SphereOverlayLauncher.electronUnavailableReason;
    if (setupIssue != null) {
      _bootstrapping = false;
      _error = setupIssue;
      notifyListeners();
      return false;
    }

    final bool ok = await launchElectronDeskPet();
    _bootstrapping = false;
    if (!ok) {
      _error ??= SphereOverlayLauncher.electronUnavailableReason ??
          "Electron 桌宠启动失败";
      notifyListeners();
      return false;
    }

    return true;
  }

  Future<void> dismiss() async {
    if (!_summoned && !_bootstrapping) return;

    _summoned = false;
    _bootstrapping = false;
    _error = null;

    if (!kIsWeb && Platform.isWindows) {
      await SphereOverlayLauncher.stop();
      SphereEntityController.instance.reset();
    }

    notifyListeners();
  }

  /// Windows 独立桌宠：召唤后直接使用可自由移动的透明桌宠窗口。
  Future<bool> launchElectronDeskPet() async {
    if (kIsWeb || !Platform.isWindows) return false;

    final bool ok = await SphereOverlayLauncher.launchElectron();
    if (ok) {
      _summoned = true;
      SphereEntityController.instance.markElectronReady();
      notifyListeners();
      return true;
    }

    _error = SphereOverlayLauncher.electronUnavailableReason ??
        "Electron 桌宠启动失败\n请确认 sphere-overlay 已 npm install，"
        "且 agent-sphere-avatar 已执行 npm run build（勿用 build:chat）。";
    notifyListeners();
    return false;
  }
}
