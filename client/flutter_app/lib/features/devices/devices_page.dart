import "dart:async";

import "package:flutter/material.dart";

import "../../core/services/device_api_client.dart";

/// 「我的设备」页 —— 终端互连平台设备管理
///
/// 功能：
///  - 列出当前用户已绑定的所有设备（含在线状态）
///  - 「添加设备」：生成 6 位配对码，在新设备端输入完成绑定
///  - 解绑设备
///  - 点击设备卡片展开查看能力清单
class DevicesPage extends StatefulWidget {
  const DevicesPage({super.key, this.api});

  final DeviceApiClient? api;

  @override
  State<DevicesPage> createState() => _DevicesPageState();
}

class _DevicesPageState extends State<DevicesPage> {
  late final DeviceApiClient _api;
  List<DeviceInfo> _devices = const <DeviceInfo>[];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _api = widget.api ?? DeviceApiClient();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final result = await _api.listDevices();
    if (!mounted) return;
    setState(() {
      _loading = false;
      if (result.ok) {
        _devices = result.value ?? const <DeviceInfo>[];
      } else {
        _error = result.error;
      }
    });
  }

  Future<void> _showAddDeviceDialog() async {
    final result = await _api.generatePairingCode();
    if (!mounted) return;
    if (!result.ok || result.value == null) {
      _showSnack("生成配对码失败: ${result.error}");
      return;
    }
    final code = result.value!;

    if (!mounted) return;
    await showDialog<void>(
      context: context,
      useRootNavigator: true,
      builder: (BuildContext _) => _PairingCodeDialog(code: code),
    );
    // 关闭弹窗后刷新一次
    _refresh();
  }

  Future<void> _confirmUnbind(DeviceInfo device) async {
    final confirmed = await showDialog<bool>(
      context: context,
      useRootNavigator: true,
      builder: (BuildContext dialogCtx) => AlertDialog(
        title: const Text("解绑设备"),
        content: Text("确定要解绑「${device.name}」吗？解绑后设备需要重新配对才能使用。"),
        actions: <Widget>[
          TextButton(
            onPressed: () =>
                Navigator.of(dialogCtx, rootNavigator: true).pop(false),
            child: const Text("取消"),
          ),
          TextButton(
            onPressed: () =>
                Navigator.of(dialogCtx, rootNavigator: true).pop(true),
            style: TextButton.styleFrom(foregroundColor: Colors.redAccent),
            child: const Text("解绑"),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    final result = await _api.unbindDevice(device.deviceId);
    if (!mounted) return;
    if (result.ok && result.value == true) {
      _showSnack("已解绑「${device.name}」");
      _refresh();
    } else {
      _showSnack("解绑失败: ${result.error}");
    }
  }

  void _showSnack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), duration: const Duration(seconds: 2)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Scaffold(
      backgroundColor: cs.surface,
      appBar: AppBar(
        title: const Text("我的设备"),
        backgroundColor: cs.surface,
        elevation: 0,
        actions: <Widget>[
          IconButton(
            icon: const Icon(Icons.refresh),
            tooltip: "刷新",
            onPressed: _loading ? null : _refresh,
          ),
          IconButton(
            icon: const Icon(Icons.add),
            tooltip: "添加设备",
            onPressed: _showAddDeviceDialog,
          ),
        ],
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const Icon(Icons.error_outline, size: 48, color: Colors.redAccent),
            const SizedBox(height: 12),
            Text(_error!, textAlign: TextAlign.center),
            const SizedBox(height: 16),
            FilledButton(onPressed: _refresh, child: const Text("重试")),
          ],
        ),
      );
    }
    if (_devices.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(Icons.devices_other_outlined,
                size: 64, color: Colors.grey.withValues(alpha: 0.5)),
            const SizedBox(height: 16),
            const Text("还没有绑定任何设备", style: TextStyle(fontSize: 16)),
            const SizedBox(height: 8),
            const Text("点击右上角「+」添加你的第一台设备",
                style: TextStyle(color: Colors.grey)),
            const SizedBox(height: 20),
            FilledButton.icon(
              onPressed: _showAddDeviceDialog,
              icon: const Icon(Icons.add),
              label: const Text("添加设备"),
            ),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView.separated(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        itemCount: _devices.length,
        separatorBuilder: (_, __) => const SizedBox(height: 12),
        itemBuilder: (BuildContext _, int i) => _DeviceCard(
          device: _devices[i],
          onUnbind: () => _confirmUnbind(_devices[i]),
        ),
      ),
    );
  }
}

/// 单个设备卡片，点击展开能力清单。
class _DeviceCard extends StatefulWidget {
  const _DeviceCard({required this.device, required this.onUnbind});

  final DeviceInfo device;
  final VoidCallback onUnbind;

  @override
  State<_DeviceCard> createState() => _DeviceCardState();
}

class _DeviceCardState extends State<_DeviceCard> {
  bool _expanded = false;

  IconData _kindIcon(String kind) {
    switch (kind) {
      case "phone":
        return Icons.phone_android;
      case "tablet":
        return Icons.tablet_android;
      case "desktop":
        return Icons.desktop_windows;
      case "glasses":
        return Icons.visibility;
      case "camera":
        return Icons.videocam;
      case "home":
        return Icons.home;
      case "watch":
        return Icons.watch;
      case "vehicle":
        return Icons.directions_car;
      case "speaker":
        return Icons.speaker;
      default:
        return Icons.devices_other;
    }
  }

  String _kindLabel(String kind) {
    const map = <String, String>{
      "phone": "手机",
      "tablet": "平板",
      "desktop": "桌面",
      "glasses": "眼镜",
      "camera": "摄像头",
      "home": "家居",
      "watch": "手表",
      "vehicle": "车机",
      "speaker": "音箱",
      "generic": "设备",
    };
    return map[kind] ?? kind;
  }

  String _lastSeenLabel(int? ts) {
    if (ts == null) return "未知";
    final diff = DateTime.now().millisecondsSinceEpoch - ts;
    if (diff < 60 * 1000) return "刚刚";
    if (diff < 60 * 60 * 1000) return "${diff ~/ 60000} 分钟前";
    if (diff < 24 * 60 * 60 * 1000) return "${diff ~/ 3600000} 小时前";
    return "${diff ~/ 86400000} 天前";
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final d = widget.device;
    final online = d.online;

    return Card(
      elevation: 0,
      color: cs.surfaceContainer.withValues(alpha: 0.5),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () => setState(() => _expanded = !_expanded),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Row(
                children: <Widget>[
                  Container(
                    width: 44,
                    height: 44,
                    decoration: BoxDecoration(
                      color: (online ? Colors.green : Colors.grey)
                          .withValues(alpha: 0.15),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Icon(
                      _kindIcon(d.kind),
                      color: online ? Colors.green : Colors.grey,
                      size: 24,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Row(
                          children: <Widget>[
                            Text(
                              d.name,
                              style: const TextStyle(
                                fontSize: 15,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                            const SizedBox(width: 8),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 6,
                                vertical: 2,
                              ),
                              decoration: BoxDecoration(
                                color: (online ? Colors.green : Colors.grey)
                                    .withValues(alpha: 0.2),
                                borderRadius: BorderRadius.circular(4),
                              ),
                              child: Text(
                                online ? "在线" : "离线",
                                style: TextStyle(
                                  fontSize: 11,
                                  color: online ? Colors.green : Colors.grey,
                                  fontWeight: FontWeight.w500,
                                ),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 4),
                        Text(
                          "${_kindLabel(d.kind)} · ${d.capabilities.length} 项能力 · ${_lastSeenLabel(d.lastSeenAt)}",
                          style: TextStyle(
                            fontSize: 12,
                            color: cs.onSurface.withValues(alpha: 0.6),
                          ),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    icon: Icon(
                      _expanded
                          ? Icons.expand_less
                          : Icons.expand_more,
                      size: 20,
                    ),
                    onPressed: () => setState(() => _expanded = !_expanded),
                  ),
                ],
              ),
              if (_expanded) ...<Widget>[
                const SizedBox(height: 12),
                const Divider(height: 1),
                const SizedBox(height: 12),
                if (d.capabilities.isEmpty)
                  Text(
                    "无能力声明",
                    style: TextStyle(
                      fontSize: 12,
                      color: cs.onSurface.withValues(alpha: 0.5),
                    ),
                  )
                else
                  Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children: d.capabilities.map((c) {
                      final id = c["id"] as String? ?? "";
                      final actions = (c["actions"] as List<dynamic>?)
                              ?.map((e) => e as String)
                              .toList() ??
                          const <String>[];
                      return Chip(
                        materialTapTargetSize:
                            MaterialTapTargetSize.shrinkWrap,
                        visualDensity: VisualDensity.compact,
                        label: Text(
                          actions.isEmpty ? id : "$id (${actions.length})",
                          style: const TextStyle(fontSize: 11),
                        ),
                      );
                    }).toList(),
                  ),
                const SizedBox(height: 8),
                Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: <Widget>[
                    TextButton.icon(
                      onPressed: widget.onUnbind,
                      icon: const Icon(Icons.link_off, size: 16),
                      label: const Text("解绑"),
                      style: TextButton.styleFrom(
                        foregroundColor: Colors.redAccent,
                      ),
                    ),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// 配对码展示弹窗（含倒计时）。
class _PairingCodeDialog extends StatefulWidget {
  const _PairingCodeDialog({required this.code});

  final String code;

  @override
  State<_PairingCodeDialog> createState() => _PairingCodeDialogState();
}

class _PairingCodeDialogState extends State<_PairingCodeDialog> {
  static const int _totalSeconds = 600; // 10 分钟
  int _remaining = _totalSeconds;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) {
        t.cancel();
        return;
      }
      setState(() {
        _remaining--;
        if (_remaining <= 0) {
          t.cancel();
        }
      });
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  String get _mmss {
    final m = (_remaining ~/ 60).toString().padLeft(2, "0");
    final s = (_remaining % 60).toString().padLeft(2, "0");
    return "$m:$s";
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return AlertDialog(
      title: const Text("添加新设备"),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(
            "在新设备端输入以下配对码完成绑定",
            style: TextStyle(
              fontSize: 13,
              color: cs.onSurface.withValues(alpha: 0.7),
            ),
          ),
          const SizedBox(height: 20),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
            decoration: BoxDecoration(
              color: cs.primaryContainer.withValues(alpha: 0.4),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Text(
              widget.code,
              style: TextStyle(
                fontSize: 36,
                fontWeight: FontWeight.bold,
                letterSpacing: 6,
                color: cs.primary,
                fontFamily: "monospace",
              ),
            ),
          ),
          const SizedBox(height: 12),
          Text(
            _remaining > 0 ? "有效期剩余 $_mmss" : "配对码已过期",
            style: TextStyle(
              fontSize: 12,
              color: _remaining > 0 ? Colors.green : Colors.redAccent,
            ),
          ),
          const SizedBox(height: 16),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: cs.surfaceContainerHighest.withValues(alpha: 0.5),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  "配对步骤：",
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: cs.onSurface.withValues(alpha: 0.8),
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  "1. 在新设备端打开终端互连客户端\n"
                  "2. 选择「配对新设备」\n"
                  "3. 输入上方 6 位配对码\n"
                  "4. 等待设备上线",
                  style: TextStyle(
                    fontSize: 11,
                    height: 1.6,
                    color: cs.onSurface.withValues(alpha: 0.6),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
      actions: <Widget>[
        TextButton(
          onPressed: () => Navigator.of(context, rootNavigator: true).pop(),
          child: const Text("关闭"),
        ),
      ],
    );
  }
}
