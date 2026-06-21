import "package:flutter/material.dart";
import "package:flutter/services.dart";
import "package:url_launcher/url_launcher.dart";

import "../../core/presentation/huawei_compat_guide_dialog.dart";
import "../../core/services/phone_bridge_service.dart";

/// 真实手机功能页：
/// 常用工具「手机」入口的落地页。对接的是**用户自己的手机**（拨号 / 短信 /
/// 通讯录 / 地图 / 浏览器 / 远程控制等），与 Agent 持有的"虚拟电话"分离。
class PhoneDevicesPage extends StatefulWidget {
  const PhoneDevicesPage({super.key});

  @override
  State<PhoneDevicesPage> createState() => _PhoneDevicesPageState();
}

class _PhoneDevicesPageState extends State<PhoneDevicesPage> {
  final TextEditingController _phoneController = TextEditingController();
  final TextEditingController _smsController = TextEditingController();
  final TextEditingController _urlController = TextEditingController(
    text: "https://",
  );

  @override
  void dispose() {
    _phoneController.dispose();
    _smsController.dispose();
    _urlController.dispose();
    super.dispose();
  }

  Future<void> _launch(Uri uri, {String fallback = "未安装可处理此链接的应用"}) async {
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    try {
      if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
        messenger.showSnackBar(SnackBar(content: Text(fallback)));
      }
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text("启动失败：$e")));
    }
  }

  Future<void> _dialPhone() async {
    final String raw = _phoneController.text.trim();
    if (raw.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("请输入要拨打的号码")),
      );
      return;
    }
    await _launch(Uri(scheme: "tel", path: raw));
  }

  Future<void> _sendSms() async {
    final String raw = _phoneController.text.trim();
    if (raw.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("请输入收件人号码")),
      );
      return;
    }
    final String body = _smsController.text.trim();
    final Uri uri = Uri(
      scheme: "sms",
      path: raw,
      queryParameters: <String, String>{
        if (body.isNotEmpty) "body": body,
      },
    );
    await _launch(uri, fallback: "当前设备不支持发送短信");
  }

  Future<void> _openBrowser() async {
    final String raw = _urlController.text.trim();
    final Uri? uri = Uri.tryParse(raw);
    if (uri == null || !uri.hasScheme || !(uri.isScheme("http") || uri.isScheme("https"))) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("请输入正确的 http(s) 链接")),
      );
      return;
    }
    await _launch(uri);
  }

  Future<void> _copyToClipboard(String value, String label) async {
    await Clipboard.setData(ClipboardData(text: value));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text("$label 已复制到剪贴板")),
    );
  }

  Future<void> _invoke(String action, Map<String, dynamic> params) async {
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    if (!PhoneBridgeService.instance.isActive) {
      messenger.showSnackBar(
        const SnackBar(content: Text("手机桥接未连接，请确认已在 Android 端登录并保持在线")),
      );
      return;
    }
    messenger.showSnackBar(
      SnackBar(content: Text("正在执行 $action...")),
    );
    try {
      final result = await PhoneBridgeService.instance.invokeLocal(action, params);
      final ok = result["ok"] == true;
      messenger.showSnackBar(
        SnackBar(
          content: Text(ok ? "$action 完成" : "$action 失败：${result["error"] ?? ""}"),
        ),
      );
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text("调用失败：$e")));
    }
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final TextTheme text = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(
        title: const Text("📱 我的手机"),
        actions: <Widget>[
          IconButton(
            tooltip: "复制当前号码",
            icon: const Icon(Icons.copy),
            onPressed: _phoneController.text.trim().isEmpty
                ? null
                : () => _copyToClipboard(
                      _phoneController.text.trim(),
                      "号码",
                    ),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: <Widget>[
          _buildBridgeCard(cs, text),
          const SizedBox(height: 16),
          _buildHint(cs, text),
          const SizedBox(height: 16),
          _buildDialCard(cs, text),
          const SizedBox(height: 16),
          _buildSmsCard(cs, text),
          const SizedBox(height: 16),
          _buildBrowserCard(cs, text),
          const SizedBox(height: 16),
          _buildQuickActions(cs, text),
        ],
      ),
    );
  }

  Widget _buildBridgeCard(ColorScheme cs, TextTheme text) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: _cardDecoration(cs),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _sectionTitle(cs, text, Icons.phonelink_ring, "Agent 远程桥接"),
          const SizedBox(height: 12),
          ValueListenableBuilder<bool>(
            valueListenable: PhoneBridgeService.instance.bridgeConnected,
            builder: (BuildContext context, bool online, Widget? child) {
              return Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                decoration: BoxDecoration(
                  color: online ? Colors.green.withValues(alpha: 0.1) : cs.errorContainer,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(
                    color: online ? Colors.green.withValues(alpha: 0.4) : cs.error,
                  ),
                ),
                child: Row(
                  children: <Widget>[
                    Icon(
                      online ? Icons.check_circle : Icons.warning_amber,
                      color: online ? Colors.green : cs.error,
                      size: 20,
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        online
                            ? "手机桥接在线：Agent 可远程控制本机"
                            : "手机桥接离线：Agent 无法远程控制本机",
                        style: text.bodyMedium?.copyWith(
                          color: online ? Colors.green.shade800 : cs.onErrorContainer,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                    ),
                  ],
                ),
              );
            },
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 10,
            runSpacing: 8,
            children: <Widget>[
              FilledButton.tonalIcon(
                onPressed: () => showHuaweiCompatGuideDialog(context: context),
                icon: const Icon(Icons.settings, size: 18),
                label: const Text("授权与保活设置"),
              ),
              OutlinedButton.icon(
                onPressed: () => PhoneBridgeService.instance.start(),
                icon: const Icon(Icons.play_arrow, size: 18),
                label: const Text("连接桥接"),
              ),
            ],
          ),
          const Divider(height: 24),
          Text("远程控制", style: text.titleSmall?.copyWith(fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          Wrap(
            spacing: 10,
            runSpacing: 8,
            children: <Widget>[
              _RemoteButton(
                icon: Icons.battery_full,
                label: "查电量",
                onPressed: () => _invoke("battery", <String, dynamic>{}),
              ),
              _RemoteButton(
                icon: Icons.notifications,
                label: "通知",
                onPressed: () => _invoke("notifications", <String, dynamic>{"limit": 10}),
              ),
              _RemoteButton(
                icon: Icons.camera_alt,
                label: "拍照",
                onPressed: () => _invoke("camera_capture", <String, dynamic>{}),
              ),
              _RemoteButton(
                icon: Icons.videocam,
                label: "录屏",
                onPressed: () => _invoke("screen_record", <String, dynamic>{"durationSec": 10}),
              ),
              _RemoteButton(
                icon: Icons.location_on,
                label: "定位",
                onPressed: () => _invoke("locate", <String, dynamic>{}),
              ),
              _RemoteButton(
                icon: Icons.ring_volume,
                label: "响铃",
                onPressed: () => _invoke("ring", <String, dynamic>{"durationSec": 10}),
              ),
              _RemoteButton(
                icon: Icons.sms,
                label: "短信",
                onPressed: () => _invoke("sms_list", <String, dynamic>{"limit": 10}),
              ),
              _RemoteButton(
                icon: Icons.call,
                label: "通话",
                onPressed: () => _invoke("call_log", <String, dynamic>{"limit": 10}),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildHint(ColorScheme cs, TextTheme text) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: cs.outline.withValues(alpha: 0.3)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Icon(Icons.info_outline, color: cs.primary, size: 20),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              "本页对接的是**你自己手机**的系统能力：拨号盘、短信、浏览器、地图等。"
              "「Agent 远程桥接」可在电脑端/服务端调用 phone.* 工具控制此手机。"
              "聊天页底部那个「📞」按钮才是联系 Agent 的虚拟电话。",
              style: text.bodyMedium?.copyWith(color: cs.onSurfaceVariant),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildDialCard(ColorScheme cs, TextTheme text) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: _cardDecoration(cs),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _sectionTitle(cs, text, Icons.phone_in_talk, "拨号"),
          const SizedBox(height: 12),
          TextField(
            controller: _phoneController,
            keyboardType: TextInputType.phone,
            decoration: const InputDecoration(
              labelText: "手机号 / 固定电话",
              hintText: "例如 13800138000",
              prefixIcon: Icon(Icons.phone_iphone),
              border: OutlineInputBorder(),
            ),
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 10,
            runSpacing: 8,
            children: <Widget>[
              FilledButton.icon(
                onPressed: _dialPhone,
                icon: const Icon(Icons.call, size: 18),
                label: const Text("拨打电话"),
              ),
              OutlinedButton.icon(
                onPressed: _phoneController.text.trim().isEmpty
                    ? null
                    : () => _copyToClipboard(
                          _phoneController.text.trim(),
                          "号码",
                        ),
                icon: const Icon(Icons.copy, size: 18),
                label: const Text("复制号码"),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildSmsCard(ColorScheme cs, TextTheme text) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: _cardDecoration(cs),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _sectionTitle(cs, text, Icons.sms_outlined, "短信"),
          const SizedBox(height: 12),
          TextField(
            controller: _smsController,
            maxLines: 4,
            minLines: 2,
            decoration: const InputDecoration(
              labelText: "短信内容（可选）",
              hintText: "想说的话…",
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 12),
          FilledButton.tonalIcon(
            onPressed: _sendSms,
            icon: const Icon(Icons.send, size: 18),
            label: const Text("打开短信 App 发送"),
          ),
        ],
      ),
    );
  }

  Widget _buildBrowserCard(ColorScheme cs, TextTheme text) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: _cardDecoration(cs),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _sectionTitle(cs, text, Icons.public, "浏览器 / 地图"),
          const SizedBox(height: 12),
          TextField(
            controller: _urlController,
            keyboardType: TextInputType.url,
            decoration: const InputDecoration(
              labelText: "网址（http/https）",
              hintText: "https://example.com",
              prefixIcon: Icon(Icons.link),
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 10,
            runSpacing: 8,
            children: <Widget>[
              FilledButton.icon(
                onPressed: _openBrowser,
                icon: const Icon(Icons.open_in_browser, size: 18),
                label: const Text("用系统浏览器打开"),
              ),
              OutlinedButton.icon(
                onPressed: () => _launch(
                  Uri.parse("geo:0,0?q=附近"),
                  fallback: "当前设备未安装地图 App",
                ),
                icon: const Icon(Icons.place, size: 18),
                label: const Text("打开地图搜索「附近」"),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildQuickActions(ColorScheme cs, TextTheme text) {
    final List<_Shortcut> shortcuts = <_Shortcut>[
      _Shortcut(
        icon: Icons.contacts,
        label: "通讯录",
        onTap: () => _launch(
          Uri.parse("content://com.android.contacts/contacts"),
          fallback: "当前设备未提供通讯录入口",
        ),
      ),
      _Shortcut(
        icon: Icons.email_outlined,
        label: "邮件",
        onTap: () => _launch(
          Uri(scheme: "mailto"),
          fallback: "未配置邮件客户端",
        ),
      ),
      _Shortcut(
        icon: Icons.alarm,
        label: "闹钟 / 计时器",
        onTap: () => _launch(
          Uri.parse("clock-alarm://"),
          fallback: "当前设备不支持系统闹钟跳转",
        ),
      ),
      _Shortcut(
        icon: Icons.camera_alt_outlined,
        label: "相机",
        onTap: () => _launch(
          Uri.parse("camera://"),
          fallback: "无法打开系统相机",
        ),
      ),
    ];
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: _cardDecoration(cs),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _sectionTitle(cs, text, Icons.apps, "系统快捷入口"),
          const SizedBox(height: 12),
          GridView.count(
            crossAxisCount: 4,
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            mainAxisSpacing: 8,
            crossAxisSpacing: 8,
            childAspectRatio: 0.95,
            children: shortcuts
                .map((s) => _ShortcutTile(spec: s))
                .toList(),
          ),
        ],
      ),
    );
  }

  BoxDecoration _cardDecoration(ColorScheme cs) {
    return BoxDecoration(
      color: cs.surfaceContainerHigh,
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: cs.outline.withValues(alpha: 0.3)),
    );
  }

  Widget _sectionTitle(
    ColorScheme cs,
    TextTheme text,
    IconData icon,
    String label,
  ) {
    return Row(
      children: <Widget>[
        Icon(icon, size: 18, color: cs.primary),
        const SizedBox(width: 8),
        Text(
          label,
          style: text.titleSmall?.copyWith(
            color: cs.onSurface,
            fontWeight: FontWeight.w600,
          ),
        ),
      ],
    );
  }
}

class _Shortcut {
  const _Shortcut({required this.icon, required this.label, required this.onTap});
  final IconData icon;
  final String label;
  final VoidCallback onTap;
}

class _ShortcutTile extends StatelessWidget {
  const _ShortcutTile({required this.spec});
  final _Shortcut spec;
  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: spec.onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 6),
          decoration: BoxDecoration(
            border: Border.all(color: cs.outline.withValues(alpha: 0.3)),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              Icon(spec.icon, color: cs.onSurfaceVariant, size: 22),
              const SizedBox(height: 6),
              Text(
                spec.label,
                style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant),
                textAlign: TextAlign.center,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _RemoteButton extends StatelessWidget {
  const _RemoteButton({required this.icon, required this.label, required this.onPressed});
  final IconData icon;
  final String label;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return OutlinedButton.icon(
      onPressed: onPressed,
      icon: Icon(icon, size: 18),
      label: Text(label),
      style: OutlinedButton.styleFrom(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        side: BorderSide(color: cs.outline.withValues(alpha: 0.4)),
      ),
    );
  }
}
