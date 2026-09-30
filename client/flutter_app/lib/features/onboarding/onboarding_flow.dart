import "dart:async";
import "dart:convert";
import "dart:developer" as developer;
import "dart:math" as math;
import "dart:ui" show lerpDouble;

import "package:flutter/foundation.dart";
import "package:flutter/material.dart";
import "package:http/http.dart" as http;
import "package:url_launcher/url_launcher.dart";

import "../../core/config/api_config.dart";
import "../../core/presentation/boot_animation.dart";
import "../../core/services/local_runtime_config.dart";
import "../../core/services/local_runtime_manager.dart";
import "../../core/services/mic_clip_recorder.dart";
import "../../core/services/model_api_tester.dart";
import "../../core/theme/app_theme.dart";
import "../../widgets/app_window_titlebar.dart";

/// 首启序列：进度条开机动画 + 四步配置向导（称呼 → agent 名字 → 声纹注册 →
/// 模型接入），黑白极简，完成后经 [onComplete] 切入主界面。
///
/// 动画期间做真实准备工作（runtime 探活 / 能力面板 / 声纹状态 / agent 名读取），
/// 进度条反映实际就绪度；向导步骤落点：
///   称呼   → POST /api/profile/manage/fact（结构化事实，prompt 现成通道）
///   名字   → POST /api/agent-identity/rename（账号+记忆KV+prefs 统一管道）
///   声纹   → /api/voice/voiceprint/*（本地 ONNX 说话人引擎）
///   模型   → %APPDATA%\PrivateAgent\config.env + runtime 重启 + 直连测试
class OnboardingFlow extends StatefulWidget {
  const OnboardingFlow({
    super.key,
    required this.onComplete,
    this.writePreference,
  });

  /// 全部完成（或 debug 跳过）后回调；持久化 onboarding 完成标记由宿主负责。
  final VoidCallback onComplete;

  /// 偏好落盘通道（声纹已注册标记等）；测试/预览可注入 mock。
  final Future<void> Function(String key, dynamic value)? writePreference;

  @override
  State<OnboardingFlow> createState() => _OnboardingFlowState();
}

enum _Phase { boot, appellation, agentName, voiceprint, model, done }

class _OnboardingFlowState extends State<OnboardingFlow> {
  // ── 配色（与注册门禁同套深色独占语言）──
  static const Color pageBg = Color(0xFF000000);
  static const Color cardBg = Color(0xFF141414);
  static const Color cardBorder = Color(0xFF232323);
  static const Color textPrimary = Color(0xFFF2F2F2);
  static const Color textSecondary = Color(0xFF9B9B9B);
  static const Color textMuted = Color(0xFF6B6B6B);
  static const Color errorRed = Color(0xFFF2604E);

  _Phase _phase = _Phase.boot;

  // ── 动画准备态 ──
  final ValueNotifier<double> _bootProgress = ValueNotifier<double>(0);
  String _bootStatus = "正在唤醒…";
  bool _prepDone = false;
  bool _voiceprintEngineReady = false;
  String? _currentAgentName;

  // ── 步骤 1：称呼 ──
  final TextEditingController _appellationCtrl = TextEditingController();

  // ── 步骤 2：agent 名字 ──
  final TextEditingController _agentNameCtrl = TextEditingController();

  // ── 步骤 3：声纹 ──
  final MicClipRecorder _recorder = MicClipRecorder();
  final List<Uint8List> _clips = <Uint8List>[];
  int _clipIndex = 0; // 0..2 待录，3=录完待提交
  bool _recording = false;
  double _recordElapsed = 0;
  Timer? _recordTimer;
  String? _voiceprintError;
  Map<String, dynamic>? _voiceprintResult; // {usedSamples, verifyScore}

  static const List<String> _clipPrompts = <String>[
    "随便说一句你日常会说的话",
    "例如：明天早上八点叫我起床",
    "最后一句，像平时聊天一样自然",
  ];
  static const Duration _clipDuration = Duration(seconds: 4);
  bool _voiceprintSkipped = false;

  // ── 步骤 4：模型 ──
  final TextEditingController _apiKeyCtrl = TextEditingController();
  final TextEditingController _baseUrlCtrl = TextEditingController();
  int _presetIndex = 0; // 默认 DeepSeek
  bool _obscureKey = true;
  bool _guidanceExpanded = false;
  ModelApiTestResult? _testResult;
  bool _testing = false;
  bool _saving = false;
  String? _saveError;

  static const List<({String label, String base, String consoleUrl, String guide})> _presets =
      <({String label, String base, String consoleUrl, String guide})>[
    (
      label: "DeepSeek 官方",
      base: "https://api.deepseek.com/v1",
      consoleUrl: "https://platform.deepseek.com/api_keys",
      guide: "打开 DeepSeek 开放平台 → 左侧「API Keys」→ 创建新 key → 复制粘贴到下方。新用户通常有免费额度。",
    ),
    (
      label: "Kimi（月之暗面）",
      base: "https://api.moonshot.cn/v1",
      consoleUrl: "https://platform.moonshot.cn/console/api-keys",
      guide: "打开 Moonshot 开放平台 → 「API Key 管理」→ 新建 key → 复制粘贴到下方。",
    ),
    (
      label: "MiniMax",
      base: "https://api.minimaxi.com/v1",
      consoleUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
      guide: "打开 MiniMax 开放平台 → 「接口密钥」→ 创建新密钥 → 复制粘贴到下方。",
    ),
    (
      label: "OpenAI",
      base: "https://api.openai.com/v1",
      consoleUrl: "https://platform.openai.com/api-keys",
      guide: "打开 OpenAI 平台 → 「API keys」→ Create new secret key → 复制粘贴到下方。",
    ),
    (
      label: "自定义（OpenAI 兼容）",
      base: "",
      consoleUrl: "",
      guide: "任何 OpenAI 兼容网关均可：填写其 Base URL（通常以 /v1 结尾）与对应 API Key。",
    ),
  ];

  // ── 完成页 ──
  String? _savedAppellation;
  String? _savedAgentName;
  ModelApiTestResult? _finalModelResult;

  @override
  void initState() {
    super.initState();
    _registerDebugExtensions();
    unawaited(_runBootPrep());
  }

  @override
  void dispose() {
    _recordTimer?.cancel();
    _recorder.dispose();
    _appellationCtrl.dispose();
    _agentNameCtrl.dispose();
    _apiKeyCtrl.dispose();
    _baseUrlCtrl.dispose();
    _bootProgress.dispose();
    super.dispose();
  }

  // ============================================================
  // 动画阶段：真实准备工作驱动进度条
  // ============================================================

  static const Duration _minBootDuration = Duration(milliseconds: 3000);

  Future<void> _runBootPrep() async {
    final Stopwatch sw = Stopwatch()..start();
    void tick(double p, String status) {
      _bootProgress.value = p.clamp(0.0, 1.0);
      _bootStatus = status;
    }

    tick(0.08, "正在唤醒…");
    final List<Future<void>> tasks = <Future<void>>[
      (() async {
        // runtime 探活/拉起（非捆绑形态跳过）
        if (!kIsWeb && LocalRuntimeManager.isBundled) {
          tick(0.2, "正在启动本地引擎…");
          try {
            await LocalRuntimeManager.ensureRunning().timeout(const Duration(seconds: 25));
          } catch (_) {/* 超时放行，向导步骤里还有兜底 */}
        }
        tick(0.45, "本地引擎就绪");
      }()),
      (() async {
        tick(0.3, "正在读取能力清单…");
        try {
          final http.Response res = await http
              .get(Uri.parse("${ApiConfig.httpBase}/api/capabilities"))
              .timeout(const Duration(seconds: 4));
          if (res.statusCode == 200) {
            final dynamic parsed = jsonDecode(res.body);
            if (parsed is Map && parsed["ok"] == true) tick(0.55, "能力清单就绪");
          }
        } catch (_) {/* best-effort */}
      }()),
      (() async {
        try {
          final Map<String, dynamic> status = await VoiceprintApi.status();
          _voiceprintEngineReady = status["engineReady"] == true;
        } catch (_) {
          _voiceprintEngineReady = false;
        }
      }()),
      (() async {
        // 现有 agent 名（重进向导时回显）
        try {
          final http.Response res = await http
              .get(Uri.parse(
                  "${ApiConfig.httpBase}/api/user-preferences?userId=${Uri.encodeComponent(ApiConfig.effectiveActorId)}"))
              .timeout(const Duration(seconds: 4));
          if (res.statusCode == 200) {
            final dynamic parsed = jsonDecode(res.body);
            final dynamic profile = parsed is Map ? parsed["agentProfile"] : null;
            final String? name = profile is Map ? profile["displayName"]?.toString() : null;
            if (name != null && name.isNotEmpty && mounted) {
              _currentAgentName = name;
              _agentNameCtrl.text = name;
            }
          }
        } catch (_) {/* best-effort */}
      }()),
    ];
    await Future.wait(tasks);
    tick(0.85, "正在准备你的专属配置…");

    // 电影感下限：准备再快也让动画走满最低时长
    final int remainMs = _minBootDuration.inMilliseconds - sw.elapsedMilliseconds;
    if (remainMs > 0) {
      await Future<void>.delayed(Duration(milliseconds: remainMs));
    }
    if (!mounted) return;
    tick(1.0, "就绪");
    await Future<void>.delayed(const Duration(milliseconds: 420));
    if (!mounted) return;
    setState(() => _prepDone = true);
    // 预填：已配置过 key 的重进用户（例如向导中断后重跑）
    if (LocalRuntimeConfig.hasApiKey) {
      final Map<String, String> cfg = LocalRuntimeConfig.readSync();
      _apiKeyCtrl.text = cfg["OPENAI_API_KEY"] ?? "";
      _baseUrlCtrl.text = cfg["OPENAI_BASE_URL"] ?? _presets[0].base;
    } else {
      _baseUrlCtrl.text = _presets[0].base;
    }
    _go(_Phase.appellation);
  }

  void _go(_Phase next) {
    setState(() => _phase = next);
  }

  // ============================================================
  // 步骤 1：称呼
  // ============================================================

  Future<bool> _saveAppellation(String value) async {
    try {
      final http.Response res = await http
          .post(
            Uri.parse("${ApiConfig.httpBase}/api/profile/manage/fact"),
            headers: <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, dynamic>{
              "actorId": ApiConfig.effectiveActorId,
              "field": "称呼",
              "value": value,
            }),
          )
          .timeout(const Duration(seconds: 6));
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  // ============================================================
  // 步骤 2：agent 名字
  // ============================================================

  Future<bool> _saveAgentName(String name) async {
    try {
      final http.Response res = await http
          .post(
            Uri.parse("${ApiConfig.httpBase}/api/agent-identity/rename"),
            headers: <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, dynamic>{
              "userId": ApiConfig.effectiveActorId,
              "displayName": name,
            }),
          )
          .timeout(const Duration(seconds: 6));
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  // ============================================================
  // 步骤 3：声纹注册
  // ============================================================

  Future<void> _startClip() async {
    if (_recording) return;
    final bool ok = await _recorder.start();
    if (!ok) {
      setState(() => _voiceprintError = "无法访问麦克风：请检查系统麦克风权限");
      return;
    }
    setState(() {
      _recording = true;
      _recordElapsed = 0;
      _voiceprintError = null;
    });
    _recordTimer?.cancel();
    const Duration tickDur = Duration(milliseconds: 100);
    _recordTimer = Timer.periodic(tickDur, (Timer t) {
      _recordElapsed += tickDur.inMilliseconds / 1000;
      if (_recordElapsed >= _clipDuration.inMilliseconds / 1000) {
        unawaited(_finishClip());
      } else if (mounted) {
        setState(() {});
      }
    });
  }

  Future<void> _finishClip() async {
    _recordTimer?.cancel();
    _recordTimer = null;
    final Uint8List clip = await _recorder.stop();
    if (!mounted) return;
    if (clip.length < 16000) {
      // <0.5s，视为无效
      setState(() {
        _recording = false;
        _voiceprintError = "录音太短，请长按说完一句话";
      });
      return;
    }
    setState(() {
      _recording = false;
      _clips.add(clip);
      _clipIndex = _clips.length;
    });
    if (_clips.length >= 3) {
      unawaited(_submitVoiceprint());
    }
  }

  Future<void> _submitVoiceprint() async {
    setState(() => _voiceprintError = null);
    try {
      final Map<String, dynamic> reg = await VoiceprintApi.register(_clips);
      if (reg["ok"] != true) {
        setState(() => _voiceprintError = reg["error"]?.toString() ?? "注册失败，请重试");
        return;
      }
      // 用第二段做一次自验证，给用户一个可信的「就绪」信号
      double? score;
      try {
        final Map<String, dynamic> verify = await VoiceprintApi.verify(_clips[1]);
        if (verify["ok"] == true) score = (verify["score"] as num?)?.toDouble();
      } catch (_) {/* 自验证 best-effort */}
      await widget.writePreference?.call("voiceprint.registeredV1", true);
      if (!mounted) return;
      setState(() => _voiceprintResult = <String, dynamic>{
            "usedSamples": reg["usedSamples"],
            "verifyScore": score,
          });
    } catch (e) {
      setState(() => _voiceprintError = "声纹服务不可达：$e");
    }
  }

  void _resetVoiceprint() {
    setState(() {
      _clips.clear();
      _clipIndex = 0;
      _voiceprintResult = null;
      _voiceprintError = null;
    });
  }

  // ============================================================
  // 步骤 4：模型接入
  // ============================================================

  void _selectPreset(int index) {
    setState(() {
      _presetIndex = index;
      _baseUrlCtrl.text = _presets[index].base;
      _testResult = null;
    });
  }

  Future<void> _runModelTest() async {
    if (_testing) return;
    setState(() {
      _testing = true;
      _testResult = null;
    });
    final ModelApiTestResult result =
        await ModelApiTester.test(_baseUrlCtrl.text, _apiKeyCtrl.text);
    if (!mounted) return;
    setState(() {
      _testing = false;
      _testResult = result;
    });
  }

  Future<void> _saveModelConfig() async {
    if (_saving) return;
    final String key = _apiKeyCtrl.text.trim();
    if (key.isEmpty) {
      setState(() => _saveError = "请先填写 API Key");
      return;
    }
    setState(() {
      _saving = true;
      _saveError = null;
    });
    try {
      // merge 写入（LocalRuntimeConfig.write 是整文件覆写，必须先读旧键）
      final Map<String, String> cfg = LocalRuntimeConfig.readSync();
      cfg["OPENAI_API_KEY"] = key;
      final String base = _baseUrlCtrl.text.trim();
      if (base.isNotEmpty) {
        cfg["OPENAI_BASE_URL"] = base;
      } else {
        cfg.remove("OPENAI_BASE_URL");
      }
      LocalRuntimeConfig.write(cfg);
      // 捆绑形态重启 runtime 使 key 即刻生效（kill+端口释放+拉起，最久 ~25s）
      if (!kIsWeb && LocalRuntimeManager.isBundled) {
        await LocalRuntimeManager.restart().timeout(const Duration(seconds: 30));
      }
      if (!mounted) return;
      _finalModelResult = _testResult ?? await ModelApiTester.test(base, key);
      _go(_Phase.done);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _saveError = "保存失败：$e";
      });
    }
  }

  // ============================================================
  // 步骤推进
  // ============================================================

  Future<void> _confirmAppellation() async {
    final String value = _appellationCtrl.text.trim();
    if (value.isEmpty || value.length > 12) return;
    _savedAppellation = value;
    unawaited(_saveAppellation(value)); // 失败不阻塞（后续对话里还能纠正）
    _go(_Phase.agentName);
  }

  Future<void> _confirmAgentName() async {
    final String value = _agentNameCtrl.text.trim();
    if (value.isEmpty || value.length > 12) return;
    _savedAgentName = value;
    unawaited(_saveAgentName(value));
    _go(_Phase.voiceprint);
  }

  // ============================================================
  // debug VM 扩展（E2E 驱动，照 registerFill 模式）
  // ============================================================

  static bool _debugRegistered = false;

  void _registerDebugExtensions() {
    if (!kDebugMode || _debugRegistered) return;
    _debugRegistered = true;
    developer.registerExtension("ext.pai.debug.onboardingFill", (String method, Map<String, String> params) async {
      final String? appellation = params["appellation"];
      final String? agentName = params["agentName"];
      final String? apiKey = params["apiKey"];
      final String? baseUrl = params["baseUrl"];
      final bool skipVoiceprint = params["skipVoiceprint"] != "0";
      final bool submit = params["submit"] == "1";
      if (appellation != null) _appellationCtrl.text = appellation;
      if (agentName != null) _agentNameCtrl.text = agentName;
      if (apiKey != null) _apiKeyCtrl.text = apiKey;
      if (baseUrl != null) _baseUrlCtrl.text = baseUrl;
      if (submit) {
        _savedAppellation = _appellationCtrl.text.trim().isNotEmpty ? _appellationCtrl.text.trim() : "(未填)";
        _savedAgentName = _agentNameCtrl.text.trim().isNotEmpty ? _agentNameCtrl.text.trim() : "(未填)";
        unawaited(_saveAppellation(_appellationCtrl.text.trim()));
        unawaited(_saveAgentName(_agentNameCtrl.text.trim()));
        if (skipVoiceprint) _voiceprintSkipped = true;
        if (_apiKeyCtrl.text.trim().isNotEmpty) {
          final Map<String, String> cfg = LocalRuntimeConfig.readSync();
          cfg["OPENAI_API_KEY"] = _apiKeyCtrl.text.trim();
          if (_baseUrlCtrl.text.trim().isNotEmpty) cfg["OPENAI_BASE_URL"] = _baseUrlCtrl.text.trim();
          LocalRuntimeConfig.write(cfg);
        }
        _finalModelResult = _testResult;
        if (mounted) _go(_Phase.done);
      }
      return developer.ServiceExtensionResponse.result('{"ok":true}');
    });
    developer.registerExtension("ext.pai.debug.onboardingSkip", (String method, Map<String, String> params) async {
      if (mounted) _go(_Phase.done);
      return developer.ServiceExtensionResponse.result('{"ok":true}');
    });
  }

  // ============================================================
  // build
  // ============================================================

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      // 向导用独立 navigatorKey 由宿主传入；此处不设 key（宿主包裹时给出），
      // 页面自绘标题栏，深色独占。
      title: "",
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        fontFamily: AppTheme.appFontFamily,
        scaffoldBackgroundColor: pageBg,
        brightness: Brightness.dark,
      ),
      home: Scaffold(
        backgroundColor: pageBg,
        body: Column(
          children: <Widget>[
            const AppWindowTitleBar(),
            Expanded(
              child: AnimatedSwitcher(
                duration: const Duration(milliseconds: 360),
                switchInCurve: Curves.easeOut,
                switchOutCurve: Curves.easeIn,
                child: KeyedSubtree(
                  key: ValueKey<_Phase>(_phase),
                  child: _buildPhase(),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildPhase() {
    switch (_phase) {
      case _Phase.boot:
        return _BootPane(progress: _bootProgress, status: _bootStatus, done: _prepDone);
      case _Phase.appellation:
        return _buildAppellationStep();
      case _Phase.agentName:
        return _buildAgentNameStep();
      case _Phase.voiceprint:
        return _buildVoiceprintStep();
      case _Phase.model:
        return _buildModelStep();
      case _Phase.done:
        return _buildDonePane();
    }
  }

  // ── 步骤页公共骨架 ──

  Widget _stepFrame({
    required int step,
    required String title,
    required String subtitle,
    required Widget child,
    Widget? footer,
  }) {
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              _StepIndicator(current: step, total: 4),
              const SizedBox(height: 28),
              Text(title, style: const TextStyle(color: textPrimary, fontSize: 26, fontWeight: FontWeight.w600, letterSpacing: 0.5)),
              const SizedBox(height: 8),
              Text(subtitle, style: const TextStyle(color: textSecondary, fontSize: 13.5, height: 1.6)),
              const SizedBox(height: 32),
              child,
              if (footer != null) ...<Widget>[const SizedBox(height: 20), footer],
            ],
          ),
        ),
      ),
    );
  }

  Widget _primaryButton(String label, VoidCallback onTap, {bool enabled = true, bool loading = false}) {
    final bool active = enabled && !loading;
    return SizedBox(
      height: 48,
      child: Opacity(
        opacity: active ? 1 : 0.35,
        child: FilledButton(
          style: FilledButtonTheme.of(context).style?.copyWith(
                backgroundColor: const WidgetStatePropertyAll<Color>(Colors.white),
                foregroundColor: const WidgetStatePropertyAll<Color>(Colors.black),
                shape: WidgetStatePropertyAll<RoundedRectangleBorder>(
                  RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
                ),
              ),
          onPressed: active ? onTap : null,
          child: loading
              ? const SizedBox(
                  width: 18, height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.black),
                )
              : Text(label, style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600)),
        ),
      ),
    );
  }

  // ── 步骤 1 ──

  Widget _buildAppellationStep() {
    final String text = _appellationCtrl.text.trim();
    final bool canNext = text.isNotEmpty && text.length <= 12;
    return _stepFrame(
      step: 1,
      title: "怎么称呼你？",
      subtitle: "我会记住这个称呼。之后对话里，它就是我对你的名字。",
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          _darkField(
            controller: _appellationCtrl,
            hint: "比如：老板、老王、小林…",
            autofocus: true,
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 28),
          _primaryButton("下一步", _confirmAppellation, enabled: canNext),
        ],
      ),
    );
  }

  // ── 步骤 2 ──

  Widget _buildAgentNameStep() {
    final String text = _agentNameCtrl.text.trim();
    final bool canNext = text.isNotEmpty && text.length <= 12;
    return _stepFrame(
      step: 2,
      title: "给我取个名字吧",
      subtitle: _currentAgentName == null
          ? "你现在叫它什么，它以后就是什么。也可以从下面挑一个。"
          : "它现在叫「$_currentAgentName」，你可以保留，或换一个新的。",
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: <Widget>[
              for (final String name in <String>["晨昏线", "小夜灯", "北极星", "阿澈"])
                _suggestionChip(name, () => setState(() => _agentNameCtrl.text = name)),
            ],
          ),
          const SizedBox(height: 16),
          _darkField(
            controller: _agentNameCtrl,
            hint: "给它起个名字（1-12 字）",
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 28),
          _primaryButton("下一步", _confirmAgentName, enabled: canNext),
        ],
      ),
    );
  }

  // ── 步骤 3：声纹 ──

  Widget _buildVoiceprintStep() {
    final Widget body;
    if (!_voiceprintEngineReady) {
      body = Column(
        children: <Widget>[
          _infoCard(
            "声纹引擎未随包就绪（models/speaker-cnceleb-resnet34 缺失）。\n"
            "语音对话与控制将在引擎可用后自动恢复声纹校验。",
          ),
          const SizedBox(height: 24),
          _primaryButton("继续", () => _go(_Phase.model)),
        ],
      );
    } else if (_voiceprintResult != null) {
      final double? score = (_voiceprintResult!["verifyScore"] as num?)?.toDouble();
      body = Column(
        children: <Widget>[
          const Icon(Icons.check_circle_outline, color: Colors.white, size: 44),
          const SizedBox(height: 14),
          Text(
            score != null ? "声纹已录入 · 自验相似度 ${score.toStringAsFixed(2)}" : "声纹已录入",
            style: const TextStyle(color: textPrimary, fontSize: 16, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 6),
          const Text("此后语音对话与语音控制只响应你的声音。", style: TextStyle(color: textSecondary, fontSize: 13)),
          const SizedBox(height: 26),
          _primaryButton("下一步", () => _go(_Phase.model)),
          const SizedBox(height: 12),
          _textLink("重新录入", _resetVoiceprint),
        ],
      );
    } else {
      body = Column(
        children: <Widget>[
          _infoCard(
            "录三句话，让我记住你的声音。\n"
            "语音对话与语音控制只响应录入声纹的人——包括你在内，别人说话我不会应答。",
          ),
          const SizedBox(height: 24),
          _RecordDots(count: _clips.length, total: 3),
          const SizedBox(height: 24),
          _recordButton(),
          const SizedBox(height: 16),
          if (_clipIndex < 3 && !_recording)
            Text(_clipIndex == 0 ? _clipPrompts[0] : _clipPrompts[_clipIndex], style: const TextStyle(color: textSecondary, fontSize: 13.5))
          else if (_recording)
            ValueListenableBuilder<double>(
              valueListenable: _recorder.level,
              builder: (BuildContext context, double level, _) => Text(
                "正在聆听… ${(_clipDuration.inMilliseconds / 1000 - _recordElapsed).ceil()}s",
                style: const TextStyle(color: textPrimary, fontSize: 13.5),
              ),
            ),
          if (_voiceprintError != null) ...<Widget>[
            const SizedBox(height: 12),
            Text(_voiceprintError!, style: const TextStyle(color: errorRed, fontSize: 12.5)),
          ],
          const SizedBox(height: 24),
          _primaryButton(
            _clipIndex >= 3 ? "提交声纹" : "下一步",
            _clipIndex >= 3 ? _submitVoiceprint : () => _go(_Phase.model),
            enabled: _clipIndex >= 3,
          ),
          const SizedBox(height: 12),
          _textLink("跳过，稍后在设置中录入", () {
            _voiceprintSkipped = true;
            _go(_Phase.model);
          }),
        ],
      );
    }
    return _stepFrame(step: 3, title: "声纹注册", subtitle: "你的声音，就是唤醒我的钥匙。", child: body);
  }

  Widget _recordButton() {
    return ValueListenableBuilder<double>(
      valueListenable: _recorder.level,
      builder: (BuildContext context, double level, _) {
        final double pulse = _recording ? 1.0 + level * 0.18 : 1.0;
        return GestureDetector(
          onTap: _recording ? _finishClip : _startClip,
          child: AnimatedScale(
            scale: pulse,
            duration: const Duration(milliseconds: 120),
            child: Container(
              width: 92,
              height: 92,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: _recording ? Colors.white : cardBg,
                border: Border.all(color: _recording ? Colors.white : cardBorder, width: 1.2),
              ),
              child: Icon(
                _recording ? Icons.stop_rounded : Icons.mic_none_rounded,
                size: 34,
                color: _recording ? Colors.black : textPrimary,
              ),
            ),
          ),
        );
      },
    );
  }

  // ── 步骤 4：模型接入 ──

  Widget _buildModelStep() {
    final ({String label, String base, String consoleUrl, String guide}) preset = _presets[_presetIndex];
    final bool canSave = _apiKeyCtrl.text.trim().isNotEmpty && !_saving;
    return _stepFrame(
      step: 4,
      title: "接入你的模型",
      subtitle: "填入你的 API Key，我才有大脑。数据只存在这台电脑上。",
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: <Widget>[
              for (int i = 0; i < _presets.length; i++)
                _presetChip(i, _presets[i].label, i == _presetIndex),
            ],
          ),
          const SizedBox(height: 18),
          _darkField(
            controller: _apiKeyCtrl,
            hint: "API Key（sk-…）",
            obscure: _obscureKey,
            onChanged: (_) => setState(() => _testResult = null),
            suffix: IconButton(
              icon: Icon(_obscureKey ? Icons.visibility_off_outlined : Icons.visibility_outlined, color: textMuted, size: 18),
              onPressed: () => setState(() => _obscureKey = !_obscureKey),
            ),
          ),
          const SizedBox(height: 12),
          _darkField(
            controller: _baseUrlCtrl,
            hint: "API Base URL（选预设自动填）",
            onChanged: (_) => setState(() => _testResult = null),
          ),
          const SizedBox(height: 14),
          // 获取 Key 引导（小白友好）
          _guideCard(preset),
          const SizedBox(height: 18),
          Row(
            children: <Widget>[
              Expanded(child: _primaryButton("测试连接", _runModelTest, enabled: _apiKeyCtrl.text.trim().isNotEmpty, loading: _testing)),
              const SizedBox(width: 12),
              Expanded(child: _primaryButton("保存并完成", _saveModelConfig, enabled: canSave, loading: _saving)),
            ],
          ),
          if (_testResult != null) ...<Widget>[
            const SizedBox(height: 14),
            _testResultCard(_testResult!),
          ],
          if (_saveError != null) ...<Widget>[
            const SizedBox(height: 10),
            Text(_saveError!, style: const TextStyle(color: errorRed, fontSize: 12.5)),
          ],
        ],
      ),
    );
  }

  Widget _guideCard(({String label, String base, String consoleUrl, String guide}) preset) {
    return Container(
      decoration: BoxDecoration(
        color: cardBg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: cardBorder),
      ),
      child: Column(
        children: <Widget>[
          InkWell(
            borderRadius: const BorderRadius.vertical(top: Radius.circular(12)),
            onTap: () => setState(() => _guidanceExpanded = !_guidanceExpanded),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              child: Row(
                children: <Widget>[
                  const Icon(Icons.help_outline_rounded, color: textSecondary, size: 16),
                  const SizedBox(width: 8),
                  const Expanded(
                    child: Text("没有 API Key？点这里，一步步教你获取", style: TextStyle(color: textSecondary, fontSize: 12.5)),
                  ),
                  Icon(_guidanceExpanded ? Icons.expand_less : Icons.expand_more, color: textMuted, size: 18),
                ],
              ),
            ),
          ),
          AnimatedCrossFade(
            duration: const Duration(milliseconds: 220),
            crossFadeState: _guidanceExpanded ? CrossFadeState.showFirst : CrossFadeState.showSecond,
            firstChild: Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(preset.guide, style: const TextStyle(color: textSecondary, fontSize: 12.5, height: 1.7)),
                  if (preset.consoleUrl.isNotEmpty) ...<Widget>[
                    const SizedBox(height: 10),
                    Align(
                      alignment: Alignment.centerLeft,
                      child: _textLink("打开获取页面 ↗", () {
                        unawaited(launchUrl(Uri.parse(preset.consoleUrl), mode: LaunchMode.externalApplication));
                      }),
                    ),
                  ],
                ],
              ),
            ),
            secondChild: const SizedBox(width: double.infinity),
          ),
        ],
      ),
    );
  }

  Widget _testResultCard(ModelApiTestResult result) {
    final Color color = result.ok ? Colors.white : errorRed;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: cardBg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: result.ok ? cardBorder : color.withValues(alpha: 0.4)),
      ),
      child: Row(
        children: <Widget>[
          Icon(result.ok ? Icons.check_circle_outline : Icons.error_outline_outlined, color: color, size: 18),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              result.summary,
              style: TextStyle(color: result.ok ? textPrimary : color, fontSize: 13),
            ),
          ),
        ],
      ),
    );
  }

  // ── 完成页 ──

  Widget _buildDonePane() {
    final String voiceLine = _voiceprintResult != null
        ? "已录入 · 仅你声纹可唤醒语音"
        : (_voiceprintSkipped ? "已跳过（可稍后在设置中录入）" : "未录入");
    final String modelLine = _finalModelResult?.ok == true
        ? _finalModelResult!.summary
        : "已保存（未测试连通）";
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 40),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              const SizedBox(height: 8),
              const _DoneMark(),
              const SizedBox(height: 26),
              const Text("一切就绪", textAlign: TextAlign.center,
                  style: TextStyle(color: textPrimary, fontSize: 26, fontWeight: FontWeight.w600, letterSpacing: 1)),
              const SizedBox(height: 30),
              _doneRow("称呼", _savedAppellation ?? "（未设置）"),
              _doneRow("名字", _savedAgentName ?? "（未设置）"),
              _doneRow("声纹", voiceLine),
              _doneRow("模型", modelLine),
              const SizedBox(height: 36),
              _primaryButton("开始使用", widget.onComplete),
            ],
          ),
        ),
      ),
    );
  }

  Widget _doneRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(
        children: <Widget>[
          SizedBox(width: 52, child: Text(label, style: const TextStyle(color: textMuted, fontSize: 12.5))),
          Expanded(child: Text(value, style: const TextStyle(color: textSecondary, fontSize: 13.5))),
        ],
      ),
    );
  }

  // ── 通用小件 ──

  Widget _darkField({
    required TextEditingController controller,
    required String hint,
    bool obscure = false,
    bool autofocus = false,
    Widget? suffix,
    ValueChanged<String>? onChanged,
  }) {
    return TextField(
      controller: controller,
      obscureText: obscure,
      autofocus: autofocus,
      style: const TextStyle(color: textPrimary, fontSize: 14),
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: const TextStyle(color: textMuted, fontSize: 13),
        filled: true,
        fillColor: cardBg,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        suffixIcon: suffix,
        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: cardBorder)),
        focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: Colors.white.withValues(alpha: 0.5))),
      ),
      onChanged: onChanged,
    );
  }

  Widget _suggestionChip(String label, VoidCallback onTap) {
    return ActionChip(
      backgroundColor: cardBg,
      side: const BorderSide(color: cardBorder),
      label: Text(label, style: const TextStyle(color: textSecondary, fontSize: 12.5)),
      onPressed: onTap,
    );
  }

  Widget _presetChip(int index, String label, bool selected) {
    return ActionChip(
      backgroundColor: selected ? Colors.white : cardBg,
      side: BorderSide(color: selected ? Colors.white : cardBorder),
      label: Text(label, style: TextStyle(color: selected ? Colors.black : textSecondary, fontSize: 12.5)),
      onPressed: () => _selectPreset(index),
    );
  }

  Widget _infoCard(String text) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: cardBg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: cardBorder),
      ),
      child: Text(text, style: const TextStyle(color: textSecondary, fontSize: 13, height: 1.8)),
    );
  }

  Widget _textLink(String label, VoidCallback onTap) {
    return Align(
      alignment: Alignment.center,
      child: TextButton(
        style: TextButtonTheme.of(context).style?.copyWith(
              foregroundColor: const WidgetStatePropertyAll<Color>(textMuted),
              textStyle: const WidgetStatePropertyAll<TextStyle>(TextStyle(fontSize: 12.5)),
            ),
        onPressed: onTap,
        child: Text(label),
      ),
    );
  }
}

// ============================================================
// 动画面板：N 标识 + 居中白色进度条
// ============================================================

class _BootPane extends StatelessWidget {
  const _BootPane({required this.progress, required this.status, required this.done});

  final ValueNotifier<double> progress;
  final String status;
  final bool done;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<double>(
      valueListenable: progress,
      builder: (BuildContext context, double value, _) {
        return AnimatedOpacity(
          opacity: done ? 0 : 1,
          duration: const Duration(milliseconds: 300),
          child: LayoutBuilder(
            builder: (BuildContext context, BoxConstraints constraints) {
              final double markSize = math.min(constraints.biggest.height * 0.18, 120);
              return Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: <Widget>[
                  // N 标识：进度条上方一点
                  CustomPaint(
                    size: Size(markSize, markSize / 2),
                    painter: _OnboardingMarkPainter(t: value),
                  ),
                  const SizedBox(height: 34),
                  // 居中白色进度条
                  SizedBox(
                    width: math.min(constraints.biggest.width * 0.42, 380),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(1.5),
                      child: Container(
                        height: 3,
                        color: const Color(0xFF232323),
                        child: FractionallySizedBox(
                          alignment: Alignment.centerLeft,
                          widthFactor: Curves.easeOutCubic.transform(value.clamp(0.0, 1.0)),
                          child: Container(color: Colors.white),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 18),
                  Text(status, style: const TextStyle(color: Color(0xFF6B6B6B), fontSize: 12, letterSpacing: 0.4)),
                ],
              );
            },
          ),
        );
      },
    );
  }
}

/// N 字标：随进度由暗到亮（描边 → 填充微光 → 完成时亮白），呼吸微动效。
class _OnboardingMarkPainter extends CustomPainter {
  _OnboardingMarkPainter({required this.t});

  final double t;

  @override
  void paint(Canvas canvas, Size size) {
    final Path path = buildNMarkOutlinePath();
    final double u = size.width / 32;
    canvas.save();
    canvas.translate(size.width / 2, size.height / 2);
    canvas.scale(u);
    canvas.translate(-16, -8); // 盒子中心 (16,16)（含 y 0-32）对准绘制中心

    // 呼吸：随时间的轻微信号（用 t 的整数哈希近似相位即可，无需动画器）
    final double breathe = 0.045 * math.sin(t * math.pi);
    final double fillAlpha = 0.10 + 0.80 * Curves.easeOutCubic.transform(t.clamp(0.0, 1.0)) + breathe;

    canvas.drawPath(
      path,
      Paint()
        ..style = PaintingStyle.fill
        ..color = Colors.white.withValues(alpha: fillAlpha.clamp(0.0, 1.0)),
    );
    canvas.drawPath(
      path,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 0.28
        ..color = Colors.white.withValues(alpha: lerpDouble(0.45, 0.95, t.clamp(0.0, 1.0))!),
    );
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _OnboardingMarkPainter oldDelegate) => oldDelegate.t != t;
}

class _StepIndicator extends StatelessWidget {
  const _StepIndicator({required this.current, required this.total});

  final int current;
  final int total;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        for (int i = 1; i <= total; i++)
          Expanded(
            child: Container(
              height: 2,
              margin: EdgeInsets.only(right: i == total ? 0 : 6),
              color: i <= current ? Colors.white : const Color(0xFF232323),
            ),
          ),
      ],
    );
  }
}

class _RecordDots extends StatelessWidget {
  const _RecordDots({required this.count, required this.total});

  final int count;
  final int total;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[
        for (int i = 0; i < total; i++)
          Container(
            width: 8,
            height: 8,
            margin: const EdgeInsets.symmetric(horizontal: 7),
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: i < count ? Colors.white : const Color(0xFF232323),
              border: Border.all(color: i < count ? Colors.white : const Color(0xFF333333)),
            ),
          ),
      ],
    );
  }
}

class _DoneMark extends StatelessWidget {
  const _DoneMark();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: CustomPaint(
        size: const Size(96, 48),
        painter: _OnboardingMarkPainter(t: 1),
      ),
    );
  }
}

