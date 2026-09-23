import "dart:async";

import "package:flutter/foundation.dart";
import "package:flutter/material.dart";

import "../../core/services/app_auto_start.dart";
import "../../core/services/phone_bridge_service.dart";
import "../../core/services/phone_capture_service.dart";
import "../../core/theme/app_theme.dart";
import "../../widgets/app_window_titlebar.dart";

/// 设置分区（左侧侧栏一项对应右侧一块内容）。
enum _SettingsSection { general, phoneBridge }

/// 「设置」页 —— 全屏独立页（类似扣子的设置布局）：
/// 左侧分区侧栏 + 右侧内容区，顶部铺自绘标题栏保证窗口可拖拽/可关闭。
///
/// 分区：
///  - 通用（仅 Windows）：开机自动启动（本地注册表，不依赖服务器）
///  - 手机桥接（仅 Android）：Agent 远程访问本机 / 消息捕捉 / 定位回传
class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key});

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  /// 当前选中的分区（Android 默认「手机桥接」，其余平台「通用」）。
  _SettingsSection _section = _SettingsSection.general;

  // —— Windows 本机设置（注册表，与服务器无关） ——
  /// 开机自动启动（「通用」分区）。
  bool _autoStart = false;
  bool get _isWindows =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.windows;

  // —— 消息捕捉（通知使用权 / 落盘队列 / 定位回传） ——
  bool _listenerEnabled = false;
  int _captureQueueSize = 0;
  bool _captureLoading = true;

  @override
  void initState() {
    super.initState();
    if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) {
      _section = _SettingsSection.phoneBridge;
    }
    _loadLocalDeviceSettings();
    _refreshCaptureState();
  }

  /// 加载 Windows 本机设置：开机自启（注册表）。
  Future<void> _loadLocalDeviceSettings() async {
    if (!_isWindows) return;
    try {
      final bool autoStart = await AppAutoStart.isEnabled();
      if (!mounted) return;
      setState(() => _autoStart = autoStart);
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
      if (_isWindows)
        (_SettingsSection.general, Icons.tune_outlined, "通用"),
      if (showPhoneBridge)
        (_SettingsSection.phoneBridge, Icons.smartphone_outlined, "手机桥接"),
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
      _SettingsSection.general => "通用",
      _SettingsSection.phoneBridge => "手机桥接",
    };
    final Widget card = switch (_section) {
      _SettingsSection.general => _buildGeneralCard(),
      _SettingsSection.phoneBridge => _buildPhoneBridgeCard(),
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
  // 通用（Windows 本机行为）
  // ------------------------------------------------------------------ //

  /// 通用卡：开机自动启动。注册表直读直写，不依赖任何服务器加载状态，
  /// 进页即可切；失败回滚开关并 toast。
  Widget _buildGeneralCard() {
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                const Icon(Icons.tune_outlined, size: 18),
                const SizedBox(width: 8),
                Text("本机行为", style: Theme.of(context).textTheme.titleMedium),
              ],
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text("开机自动启动"),
              subtitle: const Text(
                "登录 Windows 时自动启动应用",
              ),
              value: _autoStart,
              onChanged: _toggleAutoStart,
            ),
          ],
        ),
      ),
    );
  }
}
