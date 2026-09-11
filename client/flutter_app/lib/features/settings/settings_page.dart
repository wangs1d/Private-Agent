import "dart:async";

import "package:flutter/foundation.dart";
import "package:flutter/material.dart";

import "../../core/config/api_config.dart";
import "../../core/services/access_auth_api.dart";
import "../../core/services/phone_bridge_service.dart";
import "../../core/services/user_preferences_api.dart";

/// 「设置」页 —— 嵌入右侧面板（面板顶栏已提供标题，本页不渲染 AppBar）。
///
/// 分区：
///  - 早安简报：开关 / 时间 / 播报方式 / 内容板块（UserPreferencesApi）
///  - 设备绑定与安全：访问鉴权状态、配对码绑定、配对码签发、本机解绑
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

  // —— 简报设置（加载自服务端偏好） ——
  bool _briefingLoading = true;
  bool _briefingEnabled = true;
  String _briefingTime = "07:30";
  String _briefingMode = UserPreferencesApi.modeCard;
  Map<String, bool> _briefingSections = Map<String, bool>.from(
    UserPreferencesApi.defaultBriefingSections,
  );
  bool _savingBriefing = false;

  late final TextEditingController _timeController;

  // —— 鉴权状态 ——
  AccessAuthStatus? _authStatus;
  bool _authLoading = true;
  final TextEditingController _pairCodeController = TextEditingController();
  bool _authBusy = false;

  @override
  void initState() {
    super.initState();
    _api = widget.api ?? UserPreferencesApi(baseUrl: ApiConfig.httpBase);
    _authApi = widget.authApi ?? AccessAuthApi();
    _timeController = TextEditingController(text: _briefingTime);
    _loadBriefingPrefs();
    _refreshAuthStatus();
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

  @override
  Widget build(BuildContext context) {
    final bool showPhoneBridge =
        !kIsWeb && defaultTargetPlatform == TargetPlatform.android;
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
      children: <Widget>[
        _buildBriefingCard(),
        const SizedBox(height: 16),
        _buildSecurityCard(),
        if (showPhoneBridge) ...<Widget>[
          const SizedBox(height: 16),
          _buildPhoneBridgeCard(),
        ],
        const SizedBox(height: 16),
        _buildAboutCard(),
      ],
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
          ],
        ),
      ),
    );
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
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text("推送时间"),
                subtitle: const Text("24 小时制，例如 07:30"),
                trailing: SizedBox(
                  width: 88,
                  child: TextField(
                    controller: _timeController,
                    textAlign: TextAlign.center,
                    keyboardType: TextInputType.datetime,
                    onSubmitted: (String v) {
                      final String? parsed = _normalizeTime(v);
                      if (parsed == null) {
                        _snack("时间格式应为 HH:mm");
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

  String? _normalizeTime(String raw) {
    final String v = raw.trim();
    final RegExpMatch? m = RegExp(r"^(\d{1,2}):(\d{2})$").firstMatch(v);
    if (m == null) return null;
    final int hour = int.parse(m.group(1)!);
    final int minute = int.parse(m.group(2)!);
    if (hour > 23 || minute > 59) return null;
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
