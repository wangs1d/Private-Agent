import "dart:async";

import "package:file_picker/file_picker.dart";
import "package:flutter/foundation.dart";
import "package:flutter/material.dart";

import "../core/config/api_config.dart";
import "../core/presentation/user_avatar.dart";
import "../core/services/user_avatar_api.dart";
import "mobile_theme.dart";

/// 手机端「我的」页。
///
/// - 顶部账号卡片：头像（点击可设置，未设置时首字母）+ 当前账号 id + 服务器地址
/// - 设置：主题(亮 / 暗 / 跟随系统)、每日简报入口
/// - 账号：退出登录
class MobileProfilePage extends StatefulWidget {
  const MobileProfilePage({
    super.key,
    required this.themeMode,
    required this.onThemeModeChanged,
    required this.onLogout,
  });

  /// 当前主题模式(亮 / 暗 / 跟随系统)。
  final ThemeMode themeMode;

  /// 切换主题模式。
  final ValueChanged<ThemeMode> onThemeModeChanged;

  /// 退出登录。
  final VoidCallback onLogout;

  @override
  State<MobileProfilePage> createState() => _MobileProfilePageState();
}

class _MobileProfilePageState extends State<MobileProfilePage> {
  final UserAvatarApi _avatarApi = UserAvatarApi();

  /// 用户头像相对路径（服务端 /agent/avatars/...；null=未设置）。
  String? _userAvatarPath;

  @override
  void initState() {
    super.initState();
    unawaited(_loadAvatar());
  }

  /// 拉取当前账号头像（非关键链路：失败静默，账号卡回退首字母球）。
  Future<void> _loadAvatar() async {
    final String? path = await _avatarApi.fetchAvatarPath();
    if (!mounted || path == _userAvatarPath) return;
    setState(() => _userAvatarPath = path);
  }

  /// 点击账号卡头像：选图 → 上传 → 即时刷新。
  Future<void> _setAvatar() async {
    final FilePickerResult? picked = await FilePicker.platform.pickFiles(
      type: FileType.image,
      withData: true,
    );
    final PlatformFile? file = picked?.files.single;
    if (file == null) return;
    if (file.bytes == null || file.bytes!.isEmpty) {
      // 选图期间页面可能已被销毁（返回/退出登录），此时 context 不可用
      if (!mounted) return;
      _toast("读取图片失败，请换一张试试");
      return;
    }
    final String? path = await _avatarApi.uploadAvatar(file.bytes!, file.name);
    if (!mounted) return;
    if (path == null) {
      _toast("头像上传失败，请稍后再试");
      return;
    }
    setState(() => _userAvatarPath = path);
    _toast("头像已更新");
  }

  void _toast(String message) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Scaffold(
      backgroundColor: p.background,
      appBar: AppBar(
        title: const Text("我的"),
        automaticallyImplyLeading: false,
      ),
      body: ListView(
        padding: const EdgeInsets.symmetric(vertical: 8),
        children: [
          _AccountCard(
            actorId: ApiConfig.effectiveActorId,
            httpBase: ApiConfig.httpBase,
            avatarUrl: UserAvatarApi.resolveUrl(_userAvatarPath),
            onChangeAvatar: _setAvatar,
          ),
          const SizedBox(height: 16),
          _GroupLabel(label: "设置"),
          _SectionCard(
            children: [
              _ThemeModeRow(
                themeMode: widget.themeMode,
                onChanged: widget.onThemeModeChanged,
              ),
              _divider(context),
              _ListRow(
                leading: Icon(Icons.notifications_outlined, color: p.textSecondary, size: 22),
                title: "每日简报",
                trailing: Icon(Icons.chevron_right, color: p.textMuted, size: 20),
                onTap: () => _showBriefingInfo(context),
              ),
            ],
          ),
          const SizedBox(height: 16),
          _GroupLabel(label: "关于"),
          _SectionCard(
            children: [
              _ListRow(
                leading: Icon(Icons.info_outline, color: p.textSecondary, size: 22),
                title: "版本",
                trailing: Text(
                  "1.0.0",
                  style: TextStyle(color: p.textMuted, fontSize: 14),
                ),
                onTap: () {},
              ),
              _divider(context),
              _ListRow(
                leading: Icon(Icons.logout, color: Theme.of(context).colorScheme.error, size: 22),
                title: "退出登录",
                titleColor: Theme.of(context).colorScheme.error,
                onTap: () => _confirmLogout(context),
              ),
            ],
          ),
          const SizedBox(height: 24),
          Center(
            child: Text(
              "智能助手 · 手机端",
              style: TextStyle(color: p.textMuted, fontSize: 12),
            ),
          ),
        ],
      ),
    );
  }

  Widget _divider(BuildContext context) {
    return Divider(height: 1, indent: 52, color: MobileTheme.of(context).divider);
  }

  void _showBriefingInfo(BuildContext context) {
    showDialog<void>(
      context: context,
      builder: (BuildContext ctx) {
        return AlertDialog(
          title: const Text("每日简报"),
          content: const Text(
            "每日简报由服务端在早上定时推送，手机端收到后会弹出系统通知，点击通知即可查看。\n\n"
            "简报内容与推送时间可在桌面端「每日简报」设置页配置，或直接在对话中让助手调整。",
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text("知道了"),
            ),
          ],
        );
      },
    );
  }

  void _confirmLogout(BuildContext context) {
    showDialog<void>(
      context: context,
      builder: (BuildContext ctx) {
        return AlertDialog(
          title: const Text("退出登录"),
          content: const Text(
            "退出后会断开连接并清空当前会话。\n\n"
            "当前账号由构建参数 --dart-define=USER_ID 指定，如需切换账号请重新构建安装。",
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text("取消"),
            ),
            TextButton(
              onPressed: () {
                Navigator.of(ctx).pop();
                widget.onLogout();
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text("已退出登录,会话已清空")),
                );
              },
              child: const Text("退出"),
            ),
          ],
        );
      },
    );
  }
}

/// 顶部账号卡片。
class _AccountCard extends StatelessWidget {
  const _AccountCard({
    required this.actorId,
    required this.httpBase,
    this.avatarUrl,
    this.onChangeAvatar,
  });

  final String actorId;
  final String httpBase;

  /// 用户头像绝对 URL（null=未设置，渲染首字母球）。
  final String? avatarUrl;

  /// 点击头像更换头像（null 时不可点）。
  final VoidCallback? onChangeAvatar;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    final String initial =
        actorId.isEmpty ? "U" : actorId.characters.first.toUpperCase();
    final Widget avatarFallback = Container(
      width: 52,
      height: 52,
      decoration: BoxDecoration(
        color: p.accent,
        shape: BoxShape.circle,
      ),
      alignment: Alignment.center,
      child: Text(
        initial,
        style: TextStyle(
          color: p.onAccent,
          fontSize: 20,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
    final Widget avatar = onChangeAvatar == null
        ? UserAvatar(url: avatarUrl, size: 52, fallback: avatarFallback)
        : GestureDetector(
            onTap: onChangeAvatar,
            child: Tooltip(
              message: "点击设置头像",
              child: UserAvatar(url: avatarUrl, size: 52, fallback: avatarFallback),
            ),
          );
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16),
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(20),
      ),
      child: Row(
        children: [
          avatar,
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  actorId,
                  style: TextStyle(
                    color: p.textPrimary,
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 4),
                Text(
                  "服务器 · $httpBase",
                  style: TextStyle(color: p.textSecondary, fontSize: 12),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _GroupLabel extends StatelessWidget {
  const _GroupLabel({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 4, 20, 8),
      child: Text(
        label,
        style: TextStyle(
          color: p.textSecondary,
          fontSize: 13,
          fontWeight: FontWeight.w500,
        ),
      ),
    );
  }
}

class _SectionCard extends StatelessWidget {
  const _SectionCard({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(18),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        children: children,
      ),
    );
  }
}

class _ListRow extends StatelessWidget {
  const _ListRow({
    required this.leading,
    required this.title,
    this.trailing,
    this.titleColor,
    required this.onTap,
  });

  final Widget leading;
  final String title;
  final Widget? trailing;
  final Color? titleColor;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        child: Row(
          children: [
            SizedBox(width: 28, child: leading),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                title,
                style: TextStyle(
                  color: titleColor ?? p.textPrimary,
                  fontSize: 15,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ),
            if (trailing != null) trailing!,
          ],
        ),
      ),
    );
  }
}

/// 主题三选一行组。
class _ThemeModeRow extends StatelessWidget {
  const _ThemeModeRow({required this.themeMode, required this.onChanged});

  final ThemeMode themeMode;
  final ValueChanged<ThemeMode> onChanged;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    const List<(ThemeMode, IconData, String)> modes = [
      (ThemeMode.light, Icons.light_mode_outlined, "亮色"),
      (ThemeMode.dark, Icons.dark_mode_outlined, "暗色"),
      (ThemeMode.system, Icons.brightness_auto_outlined, "跟随系统"),
    ];
    return Column(
      children: [
        for (int i = 0; i < modes.length; i++) ...<Widget>[
          if (i > 0) Divider(height: 1, indent: 52, color: p.divider),
          _ThemeModeOption(
            icon: modes[i].$2,
            label: modes[i].$3,
            selected: themeMode == modes[i].$1,
            onTap: () => onChanged(modes[i].$1),
          ),
        ],
      ],
    );
  }
}

class _ThemeModeOption extends StatelessWidget {
  const _ThemeModeOption({
    required this.icon,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    final ColorScheme cs = Theme.of(context).colorScheme;
    final Color fg = selected ? cs.primary : p.textPrimary;
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        child: Row(
          children: [
            SizedBox(
              width: 28,
              child: Icon(icon, size: 22, color: p.textSecondary),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                label,
                style: TextStyle(
                  color: fg,
                  fontSize: 15,
                  fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
                ),
              ),
            ),
            if (selected)
              Icon(Icons.check, size: 20, color: cs.primary),
          ],
        ),
      ),
    );
  }
}
