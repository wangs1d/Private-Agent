import "package:flutter/material.dart";

import "../../core/services/user_preferences_api.dart";

class BriefingSettingsPage extends StatefulWidget {
  const BriefingSettingsPage({
    super.key,
    required this.api,
    required this.sessionId,
  });

  final UserPreferencesApi api;
  final String sessionId;

  @override
  State<BriefingSettingsPage> createState() => _BriefingSettingsPageState();
}

class _BriefingSettingsPageState extends State<BriefingSettingsPage> {
  bool _enabled = true;
  bool _showOnDesktopLaunch = true;
  TimeOfDay _time = const TimeOfDay(hour: 8, minute: 0);
  String _mode = UserPreferencesApi.modeWindow;
  late Map<String, bool> _sections;
  bool _loading = true;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _sections = Map<String, bool>.from(UserPreferencesApi.defaultBriefingSections);
    _load();
  }

  Future<void> _load() async {
    try {
      final Map<String, dynamic> prefs =
          await widget.api.getPreferences(widget.sessionId);
      final Object? rawMb = prefs["morningBriefing"];
      final Map<String, dynamic> mb =
          rawMb is Map ? rawMb.cast<String, dynamic>() : <String, dynamic>{};
      final Object? rawSections = mb["sections"];
      final Map<String, dynamic> sectionMap = rawSections is Map
          ? rawSections.cast<String, dynamic>()
          : <String, dynamic>{};
      if (!mounted) return;
      setState(() {
        _enabled = mb["enabled"] as bool? ?? true;
        _showOnDesktopLaunch = mb["showOnDesktopLaunch"] as bool? ?? true;
        final String timeStr = mb["time"]?.toString() ?? "08:00";
        final List<String> parts = timeStr.split(":");
        final int hour = parts.isNotEmpty ? int.tryParse(parts[0]) ?? 8 : 8;
        final int minute = parts.length > 1 ? int.tryParse(parts[1]) ?? 0 : 0;
        _time = TimeOfDay(hour: hour, minute: minute);
        final String? mode = mb["mode"]?.toString();
        if (mode != null && mode.isNotEmpty) {
          _mode = mode;
        }
        _sections = <String, bool>{
          for (final MapEntry<String, bool> entry
              in UserPreferencesApi.defaultBriefingSections.entries)
            entry.key: sectionMap[entry.key] as bool? ?? entry.value,
        };
        _loading = false;
      });
    } catch (_) {
      if (mounted) {
        setState(() => _loading = false);
      }
    }
  }

  Future<void> _pickTime() async {
    final TimeOfDay? picked = await showTimePicker(
      context: context,
      initialTime: _time,
    );
    if (picked != null && mounted) {
      setState(() => _time = picked);
    }
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    try {
      final String timeStr =
          "${_time.hour.toString().padLeft(2, "0")}:${_time.minute.toString().padLeft(2, "0")}";
      await widget.api.updatePreferences(
        widget.sessionId,
        enabled: _enabled,
        time: timeStr,
        mode: _mode,
        showOnDesktopLaunch: _showOnDesktopLaunch,
        sections: _sections,
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("每日简报设置已保存")),
      );
      Navigator.of(context).pop(true);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("保存失败：$e")),
      );
    } finally {
      if (mounted) {
        setState(() => _saving = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final TextTheme text = Theme.of(context).textTheme;

    return Scaffold(
      appBar: AppBar(
        title: const Text("每日简报设置"),
        actions: <Widget>[
          if (_loading)
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 16),
              child: Center(
                child: SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              ),
            )
          else
            TextButton(
              onPressed: _saving ? null : _save,
              child: _saving
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text("保存"),
            ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(16),
              children: <Widget>[
                _SectionTitle("启用方式", cs, text),
                Card(
                  child: Column(
                    children: <Widget>[
                      SwitchListTile(
                        title: Text("开启每日简报", style: text.titleSmall),
                        subtitle: Text(
                          "在设定时间自动推送今天的重要信息",
                          style: text.bodySmall?.copyWith(
                            color: cs.onSurfaceVariant,
                          ),
                        ),
                        value: _enabled,
                        onChanged: (bool value) {
                          setState(() => _enabled = value);
                        },
                      ),
                      Divider(height: 1, color: cs.outline.withValues(alpha: 0.3)),
                      SwitchListTile(
                        title: Text("电脑打开时自动显示", style: text.titleSmall),
                        subtitle: Text(
                          "桌面端重新进入可用状态后，自动弹出独立简报窗口",
                          style: text.bodySmall?.copyWith(
                            color: cs.onSurfaceVariant,
                          ),
                        ),
                        value: _showOnDesktopLaunch,
                        onChanged: _enabled
                            ? (bool value) {
                                setState(() => _showOnDesktopLaunch = value);
                              }
                            : null,
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 24),
                _SectionTitle("推送时间", cs, text),
                Card(
                  child: ListTile(
                    leading: const Icon(Icons.schedule_outlined),
                    title: Text("每日播报时间", style: text.titleSmall),
                    subtitle: Text(
                      _formatTimeOfDay(_time),
                      style: text.bodyMedium?.copyWith(color: cs.primary),
                    ),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: _enabled ? _pickTime : null,
                  ),
                ),
                const SizedBox(height: 24),
                _SectionTitle("展示形式", cs, text),
                Card(
                  child: Column(
                    children: <Widget>[
                      _buildModeTile(
                        value: UserPreferencesApi.modeWindow,
                        title: "独立窗口",
                        subtitle: "更适合电脑端，像简报卡片一样单独展示",
                      ),
                      Divider(height: 1, color: cs.outline.withValues(alpha: 0.3)),
                      _buildModeTile(
                        value: UserPreferencesApi.modeVoice,
                        title: "语音播报",
                        subtitle: "自动朗读今日简报内容",
                      ),
                      Divider(height: 1, color: cs.outline.withValues(alpha: 0.3)),
                      _buildModeTile(
                        value: UserPreferencesApi.modeCard,
                        title: "聊天卡片",
                        subtitle: "在应用内以卡片形式展示，不主动弹窗",
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 24),
                _SectionTitle("简报内容", cs, text),
                Card(
                  child: Column(
                    children: <Widget>[
                      _buildSectionSwitch("weather", "天气情况", "当天温度、天气概览"),
                      Divider(height: 1, color: cs.outline.withValues(alpha: 0.3)),
                      _buildSectionSwitch("outfit", "穿衣提醒", "根据天气给出简单穿搭建议"),
                      Divider(height: 1, color: cs.outline.withValues(alpha: 0.3)),
                      _buildSectionSwitch("schedule", "计划安排", "今天的重要日程和待处理事项"),
                      Divider(height: 1, color: cs.outline.withValues(alpha: 0.3)),
                      _buildSectionSwitch("notes", "待办笔记", "未复习或待处理的笔记提醒"),
                    ],
                  ),
                ),
                const SizedBox(height: 32),
                FilledButton.icon(
                  onPressed: _saving ? null : _save,
                  icon: _saving
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.check),
                  label: const Text("保存设置"),
                  style: FilledButton.styleFrom(
                    minimumSize: const Size.fromHeight(48),
                  ),
                ),
              ],
            ),
    );
  }

  Widget _buildModeTile({
    required String value,
    required String title,
    required String subtitle,
  }) {
    final TextTheme text = Theme.of(context).textTheme;
    final ColorScheme cs = Theme.of(context).colorScheme;
    return RadioListTile<String>(
      value: value,
      groupValue: _mode,
      onChanged: _enabled
          ? (String? next) {
              if (next != null) {
                setState(() => _mode = next);
              }
            }
          : null,
      title: Text(title, style: text.titleSmall),
      subtitle: Text(
        subtitle,
        style: text.bodySmall?.copyWith(color: cs.onSurfaceVariant),
      ),
    );
  }

  Widget _buildSectionSwitch(String key, String title, String subtitle) {
    final TextTheme text = Theme.of(context).textTheme;
    final ColorScheme cs = Theme.of(context).colorScheme;
    return SwitchListTile(
      value: _sections[key] ?? true,
      onChanged: _enabled
          ? (bool value) {
              setState(() => _sections[key] = value);
            }
          : null,
      title: Text(title, style: text.titleSmall),
      subtitle: Text(
        subtitle,
        style: text.bodySmall?.copyWith(color: cs.onSurfaceVariant),
      ),
    );
  }

  String _formatTimeOfDay(TimeOfDay t) {
    final String hour = t.hour.toString().padLeft(2, "0");
    final String minute = t.minute.toString().padLeft(2, "0");
    return "$hour:$minute";
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.title, this.cs, this.text);

  final String title;
  final ColorScheme cs;
  final TextTheme text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 0, 4, 8),
      child: Text(
        title,
        style: text.titleMedium?.copyWith(
          color: cs.onSurfaceVariant,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}
