import "dart:async";

import "package:flutter/foundation.dart";
import "package:flutter/material.dart";

import "../../core/config/api_config.dart";
import "../../core/db/isar_local_history_store.dart";
import "../../core/services/access_auth_api.dart";
import "../../core/services/app_auto_start.dart";
import "../../core/services/phone_bridge_service.dart";
import "../../core/services/phone_capture_service.dart";
import "../../core/services/user_preferences_api.dart";
import "../../core/theme/app_theme.dart";
import "../../widgets/app_window_titlebar.dart";

/// 设置分区（左侧侧栏一项对应右侧一块内容）。
enum _SettingsSection { briefing, security, phoneBridge, about }

/// 「设置」页 —— 全屏独立页（类似扣子的设置布局）：
/// 左侧分区侧栏 + 右侧内容区，顶部铺自绘标题栏保证窗口可拖拽/可关闭。
///
/// 分区：
///  - 早安简报：开关 / 时间 / 播报方式 / 内容板块（UserPreferencesApi）
///  - 设备绑定与安全：访问鉴权状态、配对码绑定、配对码签发、本机解绑
///  - 手机桥接（仅 Android）：Agent 远程访问本机 / 消息捕捉 / 定位回传
///  - 关于：服务地址、当前身份、本机设备标识
///
/// 凭据变化后通过 [onCredentialsChanged] 通知宿主（重连 WS 使新 token 生效）。
class SettingsPage extends StatefulWidget {
  const SettingsPage({
    super.key,
    this.api,
    this.authApi,
    this.onCredentialsChanged,
  });

  final UserPreferencesApi? api;
  final AccessAuthApi? authApi;

  /// 本机凭据发生变化（绑定成功 / 解绑）后回调，宿主应重连会话。
  final VoidCallback? onCredentialsChanged;

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  late final UserPreferencesApi _api;
  late final AccessAuthApi _authApi;

  /// 当前选中的分区（默认第一项）。
  _SettingsSection _section = _SettingsSection.briefing;

  // —— 简报设置（加载自服务端偏好） ——
  bool _briefingLoading = true;
  bool _briefingEnabled = true;
  String _briefingTime = "07:30";
  String _briefingMode = UserPreferencesApi.modeCard;
  Map<String, bool> _briefingSections = Map<String, bool>.from(
    UserPreferencesApi.defaultBriefingSections,
  );
  bool _savingBriefing = false;

  // —— 简报开机链路（仅 Windows，本地存储/注册表） ——
  /// 开机自动启动（简报随开机播报的前提）。
  bool _autoStart = false;
  /// 简报播报前摄像头在座检测；本地 consent 为 null（未设置过）视为开启。
  bool _presenceGate = true;
  bool get _isWindows =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.windows;
  final IsarLocalHistoryStore _localStore =
      IsarLocalHistoryStore(userPin: ApiConfig.localPin);

  late final TextEditingController _timeController;

  // —— 鉴权状态 ——
  AccessAuthStatus? _authStatus;
  bool _authLoading = true;
  final TextEditingController _pairCodeController = TextEditingController();
  bool _authBusy = false;

  // —— 消息捕捉（通知使用权 / 落盘队列 / 定位回传） ——
  bool _listenerEnabled = false;
  int _captureQueueSize = 0;
  bool _captureLoading = true;

  @override
  void initState() {
    super.initState();
    _api = widget.api ?? UserPreferencesApi(baseUrl: ApiConfig.httpBase);
    _authApi = widget.authApi ?? AccessAuthApi();
    _timeController = TextEditingController(text: _briefingTime);
    _loadBriefingPrefs();
    _loadLocalBriefingSettings();
    _refreshAuthStatus();
    _refreshCaptureState();
  }

  /// 加载开机自启与在座检测开关（Windows 本地状态）。
  Future<void> _loadLocalBriefingSettings() async {
    if (!_isWindows) return;
    try {
      final bool autoStart = await AppAutoStart.isEnabled();
      final bool? consent = await _localStore.getVisionCameraConsent();
      if (!mounted) return;
      setState(() {
        _autoStart = autoStart;
        _presenceGate = consent ?? true;
      });
    } catch (_) {
      // 本地设置加载失败不阻塞设置页
    }
  }

  Future<void> _toggleAutoStart(bool v) async {
    final bool ok = await AppAutoStart.setEnabled(v);
    if (!mounted) return;
    setState(() => _autoStart = ok ? v : _autoStart);
    _snack(ok
        ? (v ? "已开启开机自动启动" : "已关闭开机自动启动")
        : "设置失败，请重试");
  }

  Future<void> _togglePresenceGate(bool v) async {
    try {
      await _localStore.setVisionCameraConsent(v);
      if (!mounted) return;
      setState(() => _presenceGate = v);
    } catch (_) {
      if (mounted) _snack("设置失败，请重试");
    }
  }

  @override
  void dispose() {
    _timeController.dispose();
    _pairCodeController.dispose();
    super.dispose();
  }

  Future<void> _loadBriefingPrefs() async {
    try {
      final Map<String, dynamic> prefs =
          await _api.getPreferences(ApiConfig.effectiveActorId);
      if (!mounted) return;
      final Object? raw = prefs["morningBriefing"];
      if (raw is Map) {
        final Map<String, dynamic> b = raw.cast<String, dynamic>();
        setState(() {
          _briefingEnabled = b["enabled"] as bool? ?? _briefingEnabled;
          _briefingTime = b["time"]?.toString() ?? _briefingTime;
          _briefingMode = b["mode"]?.toString() ?? _briefingMode;
          final Object? sections = b["sections"];
          if (sections is Map) {
            final Map<String, dynamic> s = sections.cast<String, dynamic>();
            _briefingSections = _briefingSections.map(
              (String k, bool v) => MapEntry(k, s[k] as bool? ?? v),
            );
          }
          _timeController.text = _briefingTime;
          _briefingLoading = false;
        });
        return;
      }
      setState(() => _briefingLoading = false);
    } catch (_) {
      if (mounted) setState(() => _briefingLoading = false);
    }
  }

  /// 任一简报项变更后整体保存（服务端按 key 合并，未传字段保留原值）。
  Future<void> _saveBriefing() async {
    setState(() => _savingBriefing = true);
    try {
      await _api.updatePreferences(
        ApiConfig.effectiveActorId,
        enabled: _briefingEnabled,
        time: _briefingTime,
        mode: _briefingMode,
        sections: _briefingSections,
      );
      if (mounted) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          const SnackBar(content: Text("简报设置已保存"), duration: Duration(seconds: 1)),
        );
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          const SnackBar(content: Text("保存失败，请检查服务器连接")),
        );
      }
    } finally {
      if (mounted) setState(() => _savingBriefing = false);
    }
  }

  Future<void> _refreshAuthStatus() async {
    final result = await _authApi.status();
    if (!mounted) return;
    setState(() {
      _authLoading = false;
      _authStatus = result.value;
    });
  }

  Future<void> _bindDevice() async {
    final String code = _pairCodeController.text.trim();
    if (code.isEmpty) {
      _snack("请输入配对码");
      return;
    }
    setState(() => _authBusy = true);
    final result = await _authApi.bind(code: code);
    if (!mounted) return;
    setState(() => _authBusy = false);
    if (!result.ok || result.value == null) {
      _snack("绑定失败：${result.error}");
      return;
    }
    await AccessCredentialStore.instance.save(result.value!);
    _pairCodeController.clear();
    if (!mounted) return;
    _snack("本设备已绑定到用户 ${result.value!.userId}");
    widget.onCredentialsChanged?.call();
    _refreshAuthStatus();
  }

  Future<void> _issuePairingCodeForOtherDevice() async {
    setState(() => _authBusy = true);
    final result = await _authApi.issuePairingCode();
    if (!mounted) return;
    setState(() => _authBusy = false);
    if (!result.ok || result.value == null) {
      _snack("生成配对码失败：${result.error}");
      return;
    }
    await showDialog<void>(
      context: context,
      useRootNavigator: true,
      builder: (BuildContext ctx) => AlertDialog(
        title: const Text("新设备配对码"),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(
              result.value!,
              style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                    fontWeight: FontWeight.w700,
                    letterSpacing: 8,
                  ),
            ),
            const SizedBox(height: 12),
            const Text("在 10 分钟内于新设备的「设置 → 设备绑定」输入此码"),
          ],
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text("完成"),
          ),
        ],
      ),
    );
  }

  Future<void> _unbindThisDevice() async {
    final String? tokenId = AccessCredentialStore.instance.tokenId;
    if (tokenId == null) {
      _snack("本机没有已保存的凭据");
      return;
    }
    final bool? confirmed = await showDialog<bool>(
      context: context,
      useRootNavigator: true,
      builder: (BuildContext ctx) => AlertDialog(
        title: const Text("解绑本设备"),
        content: const Text("解绑后本设备将失去访问凭据，需要重新配对才能连接开启鉴权的服务器。"),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text("取消"),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text("解绑"),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _authBusy = true);
    final result = await _authApi.revoke(tokenId);
    if (!mounted) return;
    setState(() => _authBusy = false);
    if (!result.ok) {
      _snack("解绑失败：${result.error}");
      return;
    }
    await AccessCredentialStore.instance.clear();
    if (!mounted) return;
    _snack("本设备已解绑");
    widget.onCredentialsChanged?.call();
    _refreshAuthStatus();
  }

  void _snack(String text) {
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      SnackBar(content: Text(text), duration: const Duration(seconds: 2)),
    );
  }

  // ------------------------------------------------------------------ //
  // 全屏布局：标题栏 + 左侧分区侧栏 + 右侧内容区
  // ------------------------------------------------------------------ //

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Theme.of(context).colorScheme.surface,
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          const AppWindowTitleBar(),
          Expanded(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                _buildSidebar(),
                VerticalDivider(
                  width: 1,
                  thickness: 1,
                  color: AppPalette.resolveSidebarSeparator(
                    AppThemeController.instance.value,
                  ),
                ),
                Expanded(child: MainPanel(child: _buildSectionContent())),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// 左侧分区侧栏：背景与主界面左侧边栏同色（resolveSidebarPanel）。
  Widget _buildSidebar() {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final Color bg = AppPalette.resolveSidebarPanel(
      AppThemeController.instance.value,
    );
    final bool showPhoneBridge =
        !kIsWeb && defaultTargetPlatform == TargetPlatform.android;
    final List<(_SettingsSection, IconData, String)> sections = <(
      _SettingsSection,
      IconData,
      String
    )>[
      (_SettingsSection.briefing, Icons.wb_sunny_outlined, "早安简报"),
      (_SettingsSection.security, Icons.verified_user_outlined, "设备绑定与安全"),
      if (showPhoneBridge)
        (_SettingsSection.phoneBridge, Icons.smartphone_outlined, "手机桥接"),
      (_SettingsSection.about, Icons.info_outline, "关于"),
    ];
    return ColoredBox(
      color: bg,
      child: SizedBox(
        width: 232,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 16, 16, 8),
              child: Row(
                children: <Widget>[
                  IconButton(
                    icon: const Icon(Icons.arrow_back, size: 20),
                    tooltip: "返回对话",
                    visualDensity: VisualDensity.compact,
                    onPressed: () => Navigator.of(context).maybePop(),
                  ),
                  const SizedBox(width: 4),
                  Text(
                    "设置",
                    style: Theme.of(context)
                        .textTheme
                        .titleMedium
                        ?.copyWith(fontWeight: FontWeight.w600),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Column(
                children: <Widget>[
                  for (final (
                      _SettingsSection section,
                      IconData icon,
                      String label
                    ) in sections)
                    _navItem(cs, section, icon, label),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 侧栏导航项：选中时填充胶囊底 + 加重文字，未选中弱化。
  Widget _navItem(
    ColorScheme cs,
    _SettingsSection section,
    IconData icon,
    String label,
  ) {
    final bool selected = _section == section;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Material(
        color:
            selected ? cs.onSurface.withValues(alpha: 0.08) : Colors.transparent,
        borderRadius: BorderRadius.circular(10),
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: () => setState(() => _section = section),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: Row(
              children: <Widget>[
                Icon(
                  icon,
                  size: 18,
                  color: selected ? cs.onSurface : cs.onSurfaceVariant,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: selected ? cs.onSurface : cs.onSurfaceVariant,
                          fontWeight:
                              selected ? FontWeight.w600 : FontWeight.w400,
                        ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// 右侧内容区：分区大标题 + 对应表单卡片（限宽，避免超宽屏拉太长）。
  Widget _buildSectionContent() {
    final String title = switch (_section) {
      _SettingsSection.briefing => "早安简报",
      _SettingsSection.security => "设备绑定与安全",
      _SettingsSection.phoneBridge => "手机桥接",
      _SettingsSection.about => "关于",
    };
    final Widget card = switch (_section) {
      _SettingsSection.briefing => _buildBriefingCard(),
      _SettingsSection.security => _buildSecurityCard(),
      _SettingsSection.phoneBridge => _buildPhoneBridgeCard(),
      _SettingsSection.about => _buildAboutCard(),
    };
    return SingleChildScrollView(
      // key 随分区变化：切换分区时滚动位置复位到顶部。
      key: ValueKey<_SettingsSection>(_section),
      padding: const EdgeInsets.fromLTRB(32, 28, 32, 40),
      child: Align(
        alignment: Alignment.topCenter,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 760),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                title,
                style: Theme.of(context)
                    .textTheme
                    .titleLarge
                    ?.copyWith(fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 16),
              card,
            ],
          ),
        ),
      ),
    );
  }

  // ------------------------------------------------------------------ //
  // 手机桥接
  // ------------------------------------------------------------------ //

  /// 手机桥接卡：仅 Android 显示。开启后本机作为该用户的「手机执行器」
  /// 接收 Agent 的远程指令（当前支持拨号，拨号前必弹确认窗）。
  Widget _buildPhoneBridgeCard() {
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                const Icon(Icons.smartphone_outlined, size: 18),
                const SizedBox(width: 8),
                Text("手机桥接", style: Theme.of(context).textTheme.titleMedium),
                const Spacer(),
                ValueListenableBuilder<PhoneBridgeStatus>(
                  valueListenable: PhoneBridgeService.instance.status,
                  builder: (BuildContext context, PhoneBridgeStatus st, _) {
                    final (String text, Color color) = switch (st) {
                      PhoneBridgeStatus.online => ("已连接", const Color(0xFF22C55E)),
                      PhoneBridgeStatus.connecting => ("连接中", const Color(0xFFF59E0B)),
                      PhoneBridgeStatus.offline => ("未连接", const Color(0xFF9E9E9E)),
                      PhoneBridgeStatus.disabled => ("已关闭", const Color(0xFF9E9E9E)),
                    };
                    return Row(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        Container(
                          width: 8,
                          height: 8,
                          decoration: BoxDecoration(
                            color: color,
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: 6),
                        Text(text, style: Theme.of(context).textTheme.bodySmall),
                      ],
                    );
                  },
                ),
              ],
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text("允许 Agent 远程访问本机"),
              subtitle: const Text(
                "开启后 Agent 可查询本机信息；远程拨打电话前会先弹出确认窗，由你最终决定是否拨打。",
              ),
              value: PhoneBridgeService.instance.isEnabled,
              onChanged: (bool v) {
                setState(() {});
                unawaited(
                  v
                      ? PhoneBridgeService.instance.enable()
                      : PhoneBridgeService.instance.disable(),
                );
              },
            ),
            _buildCaptureTiles(),
          ],
        ),
      ),
    );
  }

  /// 消息捕捉与定位回传设置（仅桥接开启时展示）。
  Widget _buildCaptureTiles() {
    if (!PhoneBridgeService.instance.isEnabled) {
      return const SizedBox.shrink();
    }
    final String captureSubtitle;
    if (_captureLoading) {
      captureSubtitle = "正在检查通知使用权…";
    } else if (_listenerEnabled) {
      captureSubtitle = _captureQueueSize > 0
          ? "微信/QQ/飞书/短信通知将汇总给 Agent（待补报 $_captureQueueSize 条）"
          : "微信/QQ/飞书/短信通知将汇总给 Agent，Agent 仅在你询问或重要事项时查看";
    } else {
      captureSubtitle = "需要授予系统「通知使用权」后才能捕捉消息";
    }
    return Column(
      children: <Widget>[
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text("消息捕捉"),
          subtitle: Text(captureSubtitle),
          value: _listenerEnabled,
          onChanged: _listenerEnabled
              ? null // 已授权：捕捉随桥接开关生效，无需单独切换
              : (bool _) async {
                  await PhoneCaptureService.instance.openListenerSettings();
                },
        ),
        if (!_listenerEnabled && !_captureLoading)
          Align(
            alignment: Alignment.centerRight,
            child: TextButton(
              onPressed: () async {
                await PhoneCaptureService.instance.openListenerSettings();
                // 给用户留出操作时间，稍后自动刷新状态
                await Future<void>.delayed(const Duration(seconds: 3));
                if (mounted) unawaited(_refreshCaptureState());
              },
              child: const Text("去系统设置授权"),
            ),
          ),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text("定位低频回传"),
          subtitle: const Text("约 15 分钟一次向服务端回传当前位置，供 Agent 主动感知你的位置；关闭后仅按需定位。"),
          value: PhoneBridgeService.instance.isLocationReportEnabled,
          onChanged: (bool v) {
            setState(() {});
            unawaited(PhoneBridgeService.instance.setLocationReportEnabled(v));
          },
        ),
      ],
    );
  }

  Future<void> _refreshCaptureState() async {
    try {
      final bool enabled = await PhoneCaptureService.instance.isListenerEnabled();
      final int queueSize = await PhoneCaptureService.instance.queueSize();
      if (!mounted) return;
      setState(() {
        _listenerEnabled = enabled;
        _captureQueueSize = queueSize;
        _captureLoading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _captureLoading = false;
        _listenerEnabled = false;
      });
    }
  }

  // ------------------------------------------------------------------ //
  // 早安简报
  // ------------------------------------------------------------------ //

  Widget _buildBriefingCard() {
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                const Icon(Icons.wb_sunny_outlined, size: 18),
                const SizedBox(width: 8),
                Text("早安简报", style: Theme.of(context).textTheme.titleMedium),
                const Spacer(),
                if (_savingBriefing)
                  const SizedBox(
                    width: 14,
                    height: 14,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
              ],
            ),
            if (_briefingLoading)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 24),
                child: Center(child: CircularProgressIndicator()),
              )
            else ...<Widget>[
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text("每天推送早安简报"),
                value: _briefingEnabled,
                onChanged: (bool v) {
                  setState(() => _briefingEnabled = v);
                  _saveBriefing();
                },
              ),
              if (_isWindows) ...<Widget>[
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text("开机自动启动"),
                  subtitle: const Text("随电脑开机启动，简报在开机后播报"),
                  value: _autoStart,
                  onChanged: _toggleAutoStart,
                ),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text("简报前检测在座（摄像头）"),
                  subtitle: const Text(
                    "开机后等检测到你坐在电脑前才播报；无摄像头时开机直接播报",
                  ),
                  value: _presenceGate,
                  onChanged: _togglePresenceGate,
                ),
              ],
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text("推送时间"),
                subtitle: const Text("仅早上 05:00–11:59，例如 07:30"),
                trailing: SizedBox(
                  width: 88,
                  child: TextField(
                    controller: _timeController,
                    textAlign: TextAlign.center,
                    keyboardType: TextInputType.datetime,
                    onSubmitted: (String v) {
                      final String? parsed = _normalizeTime(v);
                      if (parsed == null) {
                        _snack("简报时间需为早上 05:00–11:59（HH:mm）");
                        _timeController.text = _briefingTime;
                        return;
                      }
                      setState(() => _briefingTime = parsed);
                      _timeController.text = parsed;
                      _saveBriefing();
                    },
                    decoration: const InputDecoration(hintText: "07:30"),
                  ),
                ),
              ),
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text("播报方式"),
                subtitle: Text(_modeLabel(_briefingMode)),
              ),
              SegmentedButton<String>(
                segments: const <ButtonSegment<String>>[
                  ButtonSegment<String>(
                    value: UserPreferencesApi.modeCard,
                    label: Text("聊天卡片"),
                    icon: Icon(Icons.chat_bubble_outline),
                  ),
                  ButtonSegment<String>(
                    value: UserPreferencesApi.modeWindow,
                    label: Text("独立窗口"),
                    icon: Icon(Icons.web_asset),
                  ),
                  ButtonSegment<String>(
                    value: UserPreferencesApi.modeVoice,
                    label: Text("语音播报"),
                    icon: Icon(Icons.graphic_eq),
                  ),
                ],
                selected: <String>{_briefingMode},
                onSelectionChanged: (Set<String> selection) {
                  setState(() => _briefingMode = selection.first);
                  _saveBriefing();
                },
              ),
              const SizedBox(height: 8),
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text("内容板块"),
              ),
              Wrap(
                spacing: 8,
                children: <Widget>[
                  _sectionChip("weather", "天气"),
                  _sectionChip("outfit", "穿搭"),
                  _sectionChip("schedule", "日程"),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _sectionChip(String key, String label) {
    final bool selected = _briefingSections[key] ?? false;
    return FilterChip(
      label: Text(label),
      selected: selected,
      onSelected: (bool v) {
        setState(() => _briefingSections[key] = v);
        _saveBriefing();
      },
    );
  }

  String _modeLabel(String mode) => switch (mode) {
        UserPreferencesApi.modeVoice => "语音播报（TTS 朗读）",
        UserPreferencesApi.modeWindow => "独立窗口（桌面弹窗）",
        _ => "聊天卡片（文本展示）",
      };

  /// 校验并归一化简报时间：HH:mm 且限定早间播报时段 05:00–11:59。
  String? _normalizeTime(String raw) {
    final String v = raw.trim();
    final RegExpMatch? m = RegExp(r"^(\d{1,2}):(\d{2})$").firstMatch(v);
    if (m == null) return null;
    final int hour = int.parse(m.group(1)!);
    final int minute = int.parse(m.group(2)!);
    if (hour > 23 || minute > 59) return null;
    if (hour < 5 || hour >= 12) return null;
    return "${hour.toString().padLeft(2, "0")}:${minute.toString().padLeft(2, "0")}";
  }

  // ------------------------------------------------------------------ //
  // 设备绑定与安全
  // ------------------------------------------------------------------ //

  Widget _buildSecurityCard() {
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                const Icon(Icons.verified_user_outlined, size: 18),
                const SizedBox(width: 8),
                Text("设备绑定与安全", style: Theme.of(context).textTheme.titleMedium),
              ],
            ),
            const SizedBox(height: 4),
            if (_authLoading)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 24),
                child: Center(child: CircularProgressIndicator()),
              )
            else ..._buildSecurityBody(),
          ],
        ),
      ),
    );
  }

  List<Widget> _buildSecurityBody() {
    final AccessAuthStatus? status = _authStatus;
    if (status == null) {
      return <Widget>[
        const Text("无法获取鉴权状态，请检查服务器连接。"),
      ];
    }
    // 服务器未开启鉴权：提示当前形态，不提供绑定入口。
    if (!status.authRequired) {
      return <Widget>[
        const SizedBox(height: 8),
        const Text(
          "服务器未开启访问鉴权：同一网络内任何客户端都可直接连接。\n"
          "如需启用，在服务器环境设置 ACCESS_AUTH_REQUIRED=1 后重启，"
          "首台设备的配对码会打印在服务器启动日志中。",
          style: TextStyle(height: 1.5),
        ),
      ];
    }
    final AccessCredentialStore store = AccessCredentialStore.instance;
    if (!store.hasCredentials) {
      // 鉴权开启 + 本机未绑定：输入配对码完成绑定。
      return <Widget>[
        const SizedBox(height: 8),
        const Text(
          "服务器已开启访问鉴权，本设备尚未绑定。\n"
          "请输入在其他已绑定设备（或服务器启动日志）中获取的 6 位配对码：",
          style: TextStyle(height: 1.5),
        ),
        const SizedBox(height: 12),
        Row(
          children: <Widget>[
            Expanded(
              child: TextField(
                controller: _pairCodeController,
                textCapitalization: TextCapitalization.characters,
                keyboardType: TextInputType.text,
                maxLength: 6,
                enabled: !_authBusy,
                decoration: const InputDecoration(
                  hintText: "例如 V47QGR",
                  counterText: "",
                  border: OutlineInputBorder(),
                ),
                onSubmitted: (_) => _bindDevice(),
              ),
            ),
            const SizedBox(width: 12),
            FilledButton(
              onPressed: _authBusy ? null : _bindDevice,
              child: _authBusy
                  ? const SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text("绑定"),
            ),
          ],
        ),
      ];
    }
    // 已绑定：展示身份 + 配对码签发 + 解绑。
    final String tokenId = store.tokenId ?? "";
    return <Widget>[
      const SizedBox(height: 8),
      ListTile(
        contentPadding: EdgeInsets.zero,
        leading: const Icon(Icons.check_circle, color: Colors.green),
        title: const Text("本设备已绑定"),
        subtitle: Text(
          "用户 ${store.userId ?? "-"} · 设备 ${store.deviceId}\n凭据 ${tokenId.length > 10 ? tokenId.substring(0, 10) : tokenId}…",
          style: const TextStyle(height: 1.4),
        ),
        isThreeLine: true,
      ),
      Row(
        children: <Widget>[
          OutlinedButton.icon(
            onPressed: _authBusy ? null : _issuePairingCodeForOtherDevice,
            icon: const Icon(Icons.add_link),
            label: const Text("新设备配对码"),
          ),
          const SizedBox(width: 12),
          OutlinedButton.icon(
            onPressed: _authBusy ? null : _unbindThisDevice,
            icon: const Icon(Icons.link_off),
            label: const Text("解绑本设备"),
          ),
        ],
      ),
    ];
  }

  // ------------------------------------------------------------------ //
  // 关于
  // ------------------------------------------------------------------ //

  Widget _buildAboutCard() {
    final AccessCredentialStore store = AccessCredentialStore.instance;
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                const Icon(Icons.info_outline, size: 18),
                const SizedBox(width: 8),
                Text("关于", style: Theme.of(context).textTheme.titleMedium),
              ],
            ),
            const SizedBox(height: 8),
            _kvRow("服务地址", ApiConfig.httpBase),
            _kvRow("当前身份", ApiConfig.effectiveActorId),
            _kvRow("本机设备标识", store.deviceId),
            _kvRow("客户端版本", "0.1.0"),
          ],
        ),
      ),
    );
  }

  Widget _kvRow(String key, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          SizedBox(
            width: 110,
            child: Text(
              key,
              style: TextStyle(color: Theme.of(context).hintColor),
            ),
          ),
          Expanded(
            child: SelectableText(value),
          ),
        ],
      ),
    );
  }
}
