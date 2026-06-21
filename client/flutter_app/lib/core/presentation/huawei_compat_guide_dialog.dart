import "package:flutter/material.dart";

import "../services/phone_bridge_service.dart";

/// 华为/荣耀/HarmonyOS 设备兼容性引导对话框。
///
/// 显示当前授权状态并提供一键跳转系统设置的能力。
Future<void> showHuaweiCompatGuideDialog({required BuildContext context}) async {
  return showDialog<void>(
    context: context,
    builder: (BuildContext ctx) => const _HuaweiCompatGuideDialog(),
  );
}

class _HuaweiCompatGuideDialog extends StatefulWidget {
  const _HuaweiCompatGuideDialog();

  @override
  State<_HuaweiCompatGuideDialog> createState() => _HuaweiCompatGuideDialogState();
}

class _HuaweiCompatGuideDialogState extends State<_HuaweiCompatGuideDialog> {
  bool _loading = true;
  bool _isHuaweiLike = false;
  Map<String, dynamic> _status = <String, dynamic>{};

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    Map<String, dynamic> status = <String, dynamic>{};
    try {
      status = await PhoneBridgeService.instance.getCompatStatus();
    } catch (_) {
      status = <String, dynamic>{"ok": false};
    }

    if (mounted) {
      setState(() {
        _isHuaweiLike = status["isHuaweiLike"] == true;
        _status = status;
        _loading = false;
      });
    }
  }

  Future<void> _open(String key) async {
    try {
      await PhoneBridgeService.instance.openSettingsByKey(key);
    } catch (_) {}
  }

  Future<void> _startService() async {
    try {
      await PhoneBridgeService.instance.startForegroundService();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text("前台保活服务已启动")),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("启动失败：$e")),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final TextTheme text = Theme.of(context).textTheme;

    return AlertDialog(
      title: const Text("手机桥接授权引导"),
      content: SizedBox(
        width: double.maxFinite,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      "为了让 Agent 在后台也能远程控制你的手机，需要授予以下权限。",
                      style: text.bodyMedium?.copyWith(color: cs.onSurfaceVariant),
                    ),
                    const SizedBox(height: 16),
                    _buildItem(
                      icon: Icons.battery_full,
                      title: "电池优化白名单",
                      subtitle: "防止系统休眠后断开 WebSocket",
                      status: _status["batteryOptimization"] as bool? ?? false,
                      onTap: () => _open("battery_optimization"),
                    ),
                    if (_isHuaweiLike) ...<Widget>[
                      _buildItem(
                        icon: Icons.power_settings_new,
                        title: "华为自启动管理",
                        subtitle: "允许应用自启动，被杀后可恢复",
                        status: _status["autostart"] as bool? ?? false,
                        onTap: () => _open("huawei_autostart"),
                      ),
                      _buildItem(
                        icon: Icons.app_blocking,
                        title: "华为后台运行管理",
                        subtitle: "允许应用后台运行",
                        status: _status["backgroundRunning"] as bool? ?? false,
                        onTap: () => _open("huawei_background"),
                      ),
                    ],
                    _buildItem(
                      icon: Icons.notifications,
                      title: "通知使用权",
                      subtitle: "同步通知内容到 Agent",
                      status: _status["notificationListener"] as bool? ?? false,
                      onTap: () => _open("notification_listener"),
                    ),
                    _buildItem(
                      icon: Icons.camera_alt,
                      title: "相机权限",
                      subtitle: "远程拍照、录屏",
                      status: _status["camera"] as bool? ?? false,
                      onTap: () => _open("camera"),
                    ),
                    _buildItem(
                      icon: Icons.location_on,
                      title: "定位权限",
                      subtitle: "手机丢失定位",
                      status: _status["location"] as bool? ?? false,
                      onTap: () => _open("location"),
                    ),
                    _buildItem(
                      icon: Icons.sms,
                      title: "短信读取",
                      subtitle: "同步最近短信",
                      status: _status["sms"] as bool? ?? false,
                      onTap: () => _open("sms"),
                    ),
                    _buildItem(
                      icon: Icons.call,
                      title: "通话记录读取",
                      subtitle: "同步最近通话",
                      status: _status["callLog"] as bool? ?? false,
                      onTap: () => _open("call_log"),
                    ),
                  ],
                ),
              ),
      ),
      actions: <Widget>[
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text("稍后再说"),
        ),
        FilledButton(
          onPressed: _startService,
          child: const Text("启动保活服务"),
        ),
      ],
    );
  }

  Widget _buildItem({
    required IconData icon,
    required String title,
    required String subtitle,
    required bool status,
    required VoidCallback onTap,
  }) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final TextTheme text = Theme.of(context).textTheme;
    return ListTile(
      leading: Icon(icon, color: status ? Colors.green : cs.primary),
      title: Text(title),
      subtitle: Text(subtitle, style: text.bodySmall?.copyWith(color: cs.onSurfaceVariant)),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(status ? Icons.check_circle : Icons.radio_button_unchecked,
              color: status ? Colors.green : cs.outline),
          const SizedBox(width: 8),
          TextButton(
            onPressed: onTap,
            child: const Text("去设置"),
          ),
        ],
      ),
    );
  }
}
