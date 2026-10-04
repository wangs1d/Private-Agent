import "dart:async";

import "package:flutter/material.dart";
import "package:url_launcher/url_launcher.dart";

import "../../core/services/model_api_tester.dart";
import "model_provider_catalog.dart";

/// 卡片配色：向导深色独占语言传自有常量；缺省从当前 Theme 解析（设置页浅色）。
class ModelProviderCardColors {
  const ModelProviderCardColors({
    this.fieldBg,
    this.fieldBorder,
    this.focusedBorder,
    this.textPrimary,
    this.textSecondary,
    this.textMuted,
    this.error,
  });

  final Color? fieldBg;
  final Color? fieldBorder;
  final Color? focusedBorder;
  final Color? textPrimary;
  final Color? textSecondary;
  final Color? textMuted;
  final Color? error;

  factory ModelProviderCardColors.fromTheme(ThemeData theme) {
    final ColorScheme cs = theme.colorScheme;
    return ModelProviderCardColors(
      fieldBg: cs.surfaceContainerHighest.withValues(alpha: 0.45),
      fieldBorder: cs.outlineVariant,
      focusedBorder: cs.primary,
      textPrimary: cs.onSurface,
      textSecondary: cs.onSurfaceVariant,
      textMuted: cs.onSurfaceVariant.withValues(alpha: 0.75),
      error: cs.error,
    );
  }
}

/// 模型接入卡片（目录式选择）：选服务商 → 按引导拿 key → 选模型 → 填 key → 测试/保存。
///
/// 首启向导「模型接入」步骤与设置页「模型服务」卡共用一份 UI 与目录数据
/// （[ModelProviderCatalog.load]，服务端 config/model-providers.json 即配置）。
/// base URL 对目录商自动配置不可改（仅提示），只有「自定义」露出 base/模型名输入。
/// 保存经 [onSave] 交宿主落盘 config.env + 重启 runtime；本卡只负责收集与连通测试。
class ModelProviderCard extends StatefulWidget {
  const ModelProviderCard({
    super.key,
    required this.onSave,
    this.onSaved,
    this.onTestResult,
    this.saveLabel = "保存并生效",
    this.initialBaseUrl,
    this.initialModel,
    this.initialApiKey,
    this.autofocusKey = false,
    this.initiallyGuideOpen = false,
    this.colors,
  });

  /// 保存回调：拿 [ModelConfigDraft] 落盘；抛异常会被卡片捕获并展示。
  final Future<void> Function(ModelConfigDraft draft) onSave;

  /// 保存成功（未抛异常）后回调：向导用它跳完成页，设置页用它刷新头部状态。
  final VoidCallback? onSaved;

  /// 每次连通测试完成回调（含失败结果）：向导用它记最终测试结果。
  final ValueChanged<ModelApiTestResult>? onTestResult;

  final String saveLabel;
  final String? initialBaseUrl;
  final String? initialModel;
  final String? initialApiKey;
  final bool autofocusKey;
  /// 初始展开获取引导（截图/E2E 取证用）。
  final bool initiallyGuideOpen;
  final ModelProviderCardColors? colors;

  @override
  State<ModelProviderCard> createState() => ModelProviderCardState();
}

class ModelProviderCardState extends State<ModelProviderCard> {
  List<ModelProviderOption> _providers = ModelProviderCatalog.baked;
  String _selectedId = ModelProviderCatalog.customId; // initState 立即重解析
  String _model = "";
  late final TextEditingController _keyCtrl;
  late final TextEditingController _baseCtrl;
  late final TextEditingController _modelCtrl;
  bool _obscure = true;
  bool _guideOpen = false; // initState 里按 initiallyGuideOpen 置位
  bool _testing = false;  bool _saving = false;
  bool _userTouched = false;
  bool _customSeeded = false;
  ModelApiTestResult? _testResult;
  List<String> _liveModels = const <String>[]; // 测试成功后端点返回的模型清单
  String? _error;
  String? _savedMsg;

  late ModelProviderCardColors _c;

  bool get _isCustom => _selectedId == ModelProviderCatalog.customId;

  ModelProviderOption? get _provider {
    for (final ModelProviderOption p in _providers) {
      if (p.id == _selectedId) return p;
    }
    return null;
  }

  @override
  void initState() {
    super.initState();
    _guideOpen = widget.initiallyGuideOpen;
    _keyCtrl = TextEditingController(text: widget.initialApiKey ?? "");
    _baseCtrl = TextEditingController(text: widget.initialBaseUrl ?? "");
    _modelCtrl = TextEditingController(text: widget.initialModel ?? "");
    final (String? base, String? model) = _initialArgs;
    _applySelection(resolveModelSelection(providers: _providers, baseUrl: base, model: model));
    unawaited(_loadCatalog());
  }

  /// 初始解析参数：无任何已有配置（全新用户，首启主路径）默认选第一个目录商，
  /// 不落「自定义」；有 base 则按 base 回显（匹配不到才落自定义保留原样）。
  (String?, String?) get _initialArgs {
    final bool noBase = (widget.initialBaseUrl ?? "").trim().isEmpty;
    if (noBase && _providers.isNotEmpty) {
      return (_providers.first.baseUrl, null);
    }
    return (widget.initialBaseUrl, widget.initialModel);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _c = widget.colors ?? ModelProviderCardColors.fromTheme(Theme.of(context));
  }

  Future<void> _loadCatalog() async {
    final List<ModelProviderOption> list = await ModelProviderCatalog.load();
    if (!mounted || _userTouched || identical(list, ModelProviderCatalog.baked)) return;
    // 服务端目录到达：按初始配置重新解析一次（用户尚未交互）
    final (String? base, String? model) = _initialArgs;
    _applySelection(resolveModelSelection(providers: list, baseUrl: base, model: model));
    setState(() => _providers = list);
  }

  void _applySelection(
      ({ModelProviderOption? provider, String model, String baseUrl, bool custom}) r) {
    if (r.custom) {
      _selectedId = ModelProviderCatalog.customId;
      _model = r.model;
      _baseCtrl.text = r.baseUrl;
      _modelCtrl.text = r.model;
      _customSeeded = true;
    } else {
      _selectedId = r.provider!.id;
      _model = r.model;
    }
  }

  void _selectProvider(String id) {
    if (id == _selectedId) return;
    setState(() {
      _userTouched = true;
      _selectedId = id;
      _testResult = null;
      _liveModels = const <String>[];
      _error = null;
      _savedMsg = null;
      if (id == ModelProviderCatalog.customId) {
        // 首次切到自定义：回显初始配置（老用户手填 base 的形态），之后保留草稿
        if (!_customSeeded) {
          _baseCtrl.text = widget.initialBaseUrl ?? "";
          _modelCtrl.text = widget.initialModel ?? "";
          _customSeeded = true;
        }
        _model = _modelCtrl.text;
      } else {
        final ModelProviderOption p = _provider!;
        final bool baseMatches = p.matchesBaseUrl(widget.initialBaseUrl);
        _model = baseMatches && (widget.initialModel ?? "").isNotEmpty
            ? widget.initialModel!
            : p.defaultModel;
      }
    });
  }

  ModelConfigDraft _buildDraft() {
    if (_isCustom) {
      return ModelConfigDraft(
        providerId: ModelProviderCatalog.customId,
        baseUrl: _baseCtrl.text.trim(),
        model: _modelCtrl.text.trim(),
        apiKey: _keyCtrl.text.trim(),
      );
    }
    final ModelProviderOption p = _provider!;
    return ModelConfigDraft(
      providerId: p.id,
      baseUrl: p.baseUrl,
      model: _model,
      apiKey: _keyCtrl.text.trim(),
    );
  }

  /// 供宿主（E2E debug 通道）读取当前草稿；校验失败返回 null 并把原因写进错误行。
  ModelConfigDraft? buildDraft() {
    final ModelConfigDraft draft = _buildDraft();
    final String? problem = _validate(draft);
    if (problem != null) {
      setState(() => _error = problem);
      return null;
    }
    return draft;
  }

  /// 供宿主（E2E debug 通道）从外部填充；可在卡片未挂载前由宿主缓存后转交。
  void debugFill({String? apiKey, String? baseUrl, String? model, String? providerId}) {
    if (apiKey != null) _keyCtrl.text = apiKey;
    if (providerId != null &&
        (providerId == ModelProviderCatalog.customId ||
            _providers.any((ModelProviderOption p) => p.id == providerId))) {
      _selectProvider(providerId);
    } else if (baseUrl != null && baseUrl.trim().isNotEmpty) {
      final ModelProviderOption? match =
          _providers.where((ModelProviderOption p) => p.matchesBaseUrl(baseUrl)).firstOrNull;
      if (match != null) {
        _selectProvider(match.id);
      } else {
        _selectProvider(ModelProviderCatalog.customId);
        _baseCtrl.text = baseUrl;
      }
    }
    if (baseUrl != null && baseUrl.trim().isNotEmpty && _isCustom) {
      _baseCtrl.text = baseUrl;
    }
    if (model != null && model.trim().isNotEmpty) {
      if (_isCustom) {
        _modelCtrl.text = model;
        setState(() => _model = model);
      } else {
        setState(() => _model = model);
      }
    }
  }

  String? _validate(ModelConfigDraft draft) {
    if (draft.apiKey.isEmpty) return "请先填写 API Key";
    if (_isCustom) {
      if (draft.baseUrl.isEmpty) return "自定义接入需要填写 API Base URL";
      if (draft.model.isEmpty) return "请填写模型名称";
    }
    return null;
  }

  Future<void> _runTest() async {
    if (_testing) return;
    final ModelConfigDraft draft = _buildDraft();
    if (draft.apiKey.length < 8) {
      setState(() => _error = "请先填写 API Key");
      return;
    }
    if (_isCustom && draft.baseUrl.isEmpty) {
      setState(() => _error = "自定义接入需要填写 API Base URL");
      return;
    }
    setState(() {
      _testing = true;
      _testResult = null;
      _error = null;
      _savedMsg = null;
    });
    final ModelApiTestResult result =
        await ModelApiTester.test(draft.baseUrl, draft.apiKey, model: draft.model);
    if (!mounted) return;
    setState(() {
      _testing = false;
      _testResult = result;
      if (result.ok && result.modelIds.isNotEmpty) {
        _liveModels = result.modelIds;
      }
    });
    widget.onTestResult?.call(result);
  }

  Future<void> _save() async {
    if (_saving) return;
    final ModelConfigDraft draft = _buildDraft();
    final String? problem = _validate(draft);
    if (problem != null) {
      setState(() => _error = problem);
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
      _savedMsg = null;
    });
    try {
      await widget.onSave(draft);
      if (!mounted) return;
      setState(() => _savedMsg = "已保存并生效");
      widget.onSaved?.call();
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = "保存失败：$e");
    } finally {
      if (mounted && _saving) setState(() => _saving = false);
    }
  }

  @override
  void dispose() {
    _keyCtrl.dispose();
    _baseCtrl.dispose();
    _modelCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ModelProviderOption? provider = _provider;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        _buildProviderChips(),
        const SizedBox(height: 4),
        if (!_isCustom && provider != null) ...<Widget>[
          const SizedBox(height: 8),
          Text(
            "接口地址已自动配置：${provider.baseUrl}",
            style: TextStyle(color: _c.textMuted, fontSize: 12),
          ),
          const SizedBox(height: 12),
          _buildGuideCard(provider),
          const SizedBox(height: 12),
          _buildModelDropdown(provider),
        ] else ...<Widget>[
          const SizedBox(height: 12),
          _buildGuideCard(null),
          const SizedBox(height: 12),
          _field(
            controller: _baseCtrl,
            label: "API Base URL",
            hint: "OpenAI 兼容网关，通常以 /v1 结尾",
            onChanged: (_) => setState(() => _testResult = null),
          ),
          const SizedBox(height: 12),
          _field(
            controller: _modelCtrl,
            label: "模型名称",
            hint: "如 deepseek-flash",
            onChanged: (_) => setState(() => _testResult = null),
          ),
        ],
        const SizedBox(height: 12),
        _field(
          controller: _keyCtrl,
          label: "API Key",
          hint: "粘贴服务商控制台创建的 key",
          obscure: _obscure,
          autofocus: widget.autofocusKey,
          onChanged: (_) => setState(() => _testResult = null),
          suffix: IconButton(
            icon: Icon(
              _obscure ? Icons.visibility_off_outlined : Icons.visibility_outlined,
              color: _c.textMuted,
              size: 18,
            ),
            onPressed: () => setState(() => _obscure = !_obscure),
          ),
        ),
        const SizedBox(height: 16),
        Row(
          children: <Widget>[
            Expanded(
              child: OutlinedButton(
                style: OutlinedButton.styleFrom(
                  foregroundColor: _c.textSecondary,
                  side: BorderSide(color: _c.fieldBorder ?? Colors.grey),
                  padding: const EdgeInsets.symmetric(vertical: 13),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
                ),
                onPressed: _testing ? null : _runTest,
                child: _testing
                    ? SizedBox(
                        width: 16, height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2, color: _c.textMuted),
                      )
                    : const Text("测试连接", style: TextStyle(fontSize: 13.5)),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(child: _buildSaveButton()),
          ],
        ),
        if (_testResult != null) ...<Widget>[
          const SizedBox(height: 14),
          _resultRow(
            icon: _testResult!.ok ? Icons.check_circle_outline : Icons.error_outline_outlined,
            color: _testResult!.ok
                ? (_c.textPrimary ?? Theme.of(context).colorScheme.primary)
                : (_c.error ?? Theme.of(context).colorScheme.error),
            text: _testResult!.summary,
          ),
        ],
        if (_savedMsg != null) ...<Widget>[
          const SizedBox(height: 10),
          _resultRow(
            icon: Icons.check_circle_outline,
            color: _c.textPrimary ?? Theme.of(context).colorScheme.primary,
            text: _savedMsg!,
          ),
        ],
        if (_error != null) ...<Widget>[
          const SizedBox(height: 10),
          _resultRow(icon: Icons.error_outline_outlined, color: _c.error ?? Colors.red, text: _error!),
        ],
      ],
    );
  }

  Widget _buildSaveButton() {
    // 主钮=微填充（accent ~12% 叠底 + 加重边框），不做实心黑白（2026-10-03 定调）
    final Color accent = _c.textPrimary ?? Theme.of(context).colorScheme.onSurface;
    return FilledButton(
      style: FilledButton.styleFrom(
        backgroundColor: accent.withValues(alpha: 0.12),
        foregroundColor: accent,
        disabledBackgroundColor: accent.withValues(alpha: 0.05),
        disabledForegroundColor: accent.withValues(alpha: 0.35),
        side: BorderSide(color: accent.withValues(alpha: _saving ? 0.3 : 0.55)),
        padding: const EdgeInsets.symmetric(vertical: 13),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
      ),
      // 始终可点：缺 key/缺 base 时按下给出明确提示（禁用无解释对小白不友好）
      onPressed: _saving ? null : _save,
      child: _saving
          ? SizedBox(
              width: 16, height: 16,
              child: CircularProgressIndicator(strokeWidth: 2, color: accent),
            )
          : Text(widget.saveLabel, style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600)),
    );
  }

  Widget _buildProviderChips() {
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: <Widget>[
        for (final ModelProviderOption p in _providers)
          _providerChip(p.id, p.name, p.id == _selectedId),
        _providerChip(
          ModelProviderCatalog.customId,
          "自定义（OpenAI 兼容）",
          _isCustom,
        ),
      ],
    );
  }

  Widget _providerChip(String id, String label, bool selected) {
    // 选中态=背景微变 + 文字提亮（2026-10-03 定调：不做黑白反转，太跳）
    final Color selectedBg = (_c.textPrimary ?? Colors.white).withValues(alpha: 0.10);
    final Color selectedBorder = (_c.textPrimary ?? Colors.white).withValues(alpha: 0.55);
    return ActionChip(
      backgroundColor: selected ? selectedBg : _c.fieldBg,
      side: BorderSide(color: selected ? selectedBorder : (_c.fieldBorder ?? Colors.grey)),
      label: Text(
        label,
        style: TextStyle(
          color: selected ? _c.textPrimary : _c.textSecondary,
          fontSize: 12.5,
          fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
        ),
      ),
      onPressed: () => _selectProvider(id),
    );
  }

  Widget _buildModelDropdown(ModelProviderOption provider) {
    final List<DropdownMenuItem<String>> items = <DropdownMenuItem<String>>[];
    final Set<String> seen = <String>{};
    for (final ModelChoice c in provider.models) {
      seen.add(c.id);
      items.add(DropdownMenuItem<String>(value: c.id, child: Text(c.displayLabel, style: const TextStyle(fontSize: 13.5))));
    }
    for (final String id in _liveModels) {
      if (seen.add(id)) {
        items.add(DropdownMenuItem<String>(value: id, child: Text(id, style: const TextStyle(fontSize: 13.5))));
      }
    }
    // 当前生效模型不在清单里（老配置/目录更新）：原样保留，绝不悄悄替换
    if (_model.isNotEmpty && !seen.contains(_model)) {
      items.add(DropdownMenuItem<String>(value: _model, child: Text("$_model（当前配置）", style: const TextStyle(fontSize: 13.5))));
    }
    if (_liveModels.isNotEmpty) {
      items.insert(
        provider.models.length,
        const DropdownMenuItem<String>(
          enabled: false,
          child: Text("—— 接口返回的模型 ——", style: TextStyle(fontSize: 12)),
        ),
      );
    }
    return InputDecorator(
      decoration: _decoration(label: "模型", hint: null),
      child: DropdownButtonHideUnderline(
        child: DropdownButton<String>(
          value: _model.isNotEmpty ? _model : provider.defaultModel,
          isExpanded: true,
          isDense: true,
          items: items,
          onChanged: (String? v) {
            if (v == null) return;
            setState(() {
              _userTouched = true;
              _model = v;
              _testResult = null;
            });
          },
        ),
      ),
    );
  }

  Widget _buildGuideCard(ModelProviderOption? provider) {
    final bool hasGuide = provider != null &&
        (provider.guide.isNotEmpty || (provider.consoleUrl ?? "").isNotEmpty);
    final String header = provider == null
        ? "自定义网关：填其 Base URL 与对应 API Key"
        : "没有 ${provider.name} 的 API Key？点开，一步步教你获取";
    return Container(
      decoration: BoxDecoration(
        color: _c.fieldBg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _c.fieldBorder ?? Colors.grey),
      ),
      child: Column(
        children: <Widget>[
          InkWell(
            borderRadius: const BorderRadius.vertical(top: Radius.circular(12)),
            onTap: hasGuide ? () => setState(() => _guideOpen = !_guideOpen) : null,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              child: Row(
                children: <Widget>[
                  Icon(Icons.help_outline_rounded, color: _c.textSecondary, size: 16),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(header, style: TextStyle(color: _c.textSecondary, fontSize: 12.5)),
                  ),
                  if (hasGuide)
                    Icon(
                      _guideOpen ? Icons.expand_less : Icons.expand_more,
                      color: _c.textMuted,
                      size: 18,
                    ),
                ],
              ),
            ),
          ),
          AnimatedCrossFade(
            duration: const Duration(milliseconds: 220),
            crossFadeState: _guideOpen ? CrossFadeState.showFirst : CrossFadeState.showSecond,
            firstChild: Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  if (provider != null && provider.tagline != null) ...<Widget>[
                    Text(
                      provider.tagline!,
                      style: TextStyle(color: _c.textMuted, fontSize: 12),
                    ),
                    const SizedBox(height: 8),
                  ],
                  if (provider != null)
                    for (int i = 0; i < provider.guide.length; i++)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 4),
                        child: Text(
                          "${i + 1}. ${provider.guide[i]}",
                          style: TextStyle(color: _c.textSecondary, fontSize: 12.5, height: 1.7),
                        ),
                      ),
                  if (provider?.note != null) ...<Widget>[
                    const SizedBox(height: 6),
                    Text("· ${provider!.note}", style: TextStyle(color: _c.textMuted, fontSize: 12, height: 1.6)),
                  ],
                  if ((provider?.consoleUrl ?? "").isNotEmpty) ...<Widget>[
                    const SizedBox(height: 10),
                    Align(
                      alignment: Alignment.centerLeft,
                      child: TextButton(
                        style: TextButton.styleFrom(
                          foregroundColor: _c.textPrimary,
                          textStyle: const TextStyle(fontSize: 12.5),
                        ),
                        onPressed: () => unawaited(launchUrl(
                          Uri.parse(provider!.consoleUrl!),
                          mode: LaunchMode.externalApplication,
                        )),
                        child: const Text("打开 API Key 获取页面 ↗"),
                      ),
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

  Widget _resultRow({required IconData icon, required Color color, required String text}) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: _c.fieldBg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _c.fieldBorder ?? Colors.grey),
      ),
      child: Row(
        children: <Widget>[
          Icon(icon, color: color, size: 18),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              text,
              style: TextStyle(
                color: color,
                fontSize: 13,
              ),
              overflow: TextOverflow.ellipsis,
              maxLines: 2,
            ),
          ),
        ],
      ),
    );
  }

  InputDecoration _decoration({required String label, required String? hint}) {
    return InputDecoration(
      labelText: label,
      hintText: hint,
      hintStyle: TextStyle(color: _c.textMuted, fontSize: 13),
      labelStyle: TextStyle(color: _c.textSecondary, fontSize: 13),
      filled: true,
      fillColor: _c.fieldBg,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      suffixIcon: null,
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: BorderSide(color: _c.fieldBorder ?? Colors.grey),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: BorderSide(color: _c.focusedBorder ?? Colors.blue),
      ),
    );
  }

  Widget _field({
    required TextEditingController controller,
    required String label,
    String? hint,
    bool obscure = false,
    bool autofocus = false,
    Widget? suffix,
    ValueChanged<String>? onChanged,
  }) {
    return TextField(
      controller: controller,
      obscureText: obscure,
      autofocus: autofocus,
      style: TextStyle(color: _c.textPrimary, fontSize: 14),
      decoration: _decoration(label: label, hint: hint).copyWith(suffixIcon: suffix),
      onChanged: onChanged,
    );
  }
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull {
    for (final T e in this) {
      return e;
    }
    return null;
  }
}
