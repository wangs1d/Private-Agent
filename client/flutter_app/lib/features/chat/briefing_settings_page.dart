import "package:flutter/material.dart";

import "../../core/services/user_preferences_api.dart";

/// 早安简报设置页。
///
/// 用户可以在此：
///   1. 开关早安简报；
///   2. 选择每日播报时间；
///   3. 选择播报方式（语音 / 弹窗 / 卡片）。
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
  TimeOfDay _time = const TimeOfDay(hour: 8, minute: 0);
  String _mode = UserPreferencesApi.modeVoice;
  bool _loading = true;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final Map<String, dynamic> prefs =
          await widget.api.getPreferences(widget.sessionId);
      final Object? rawMb = prefs["morningBriefing"];
      final Map<String, dynamic> mb =
          rawMb is Map ? rawMb.cast<String, dynamic>() : <String, dynamic>{};
      if (!mounted) return;
      setState(() {
        _enabled = mb["enabled"] as bool? ?? true;
        final String timeStr = mb["time"]?.toString() ?? "08:00";
        final List<String> parts = timeStr.split(":");
        final int hour = parts.isNotEmpty ? int.tryParse(parts[0]) ?? 8 : 8;
        final int minute = parts.length > 1
            ? int.tryParse(parts[1]) ?? 0
            : 0;
        _time = TimeOfDay(hour: hour, minute: minute);
        final String? m = mb["mode"]?.toString();
        if (m != null && m.isNotEmpty) {
          _mode = m;
        }
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
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("已保存")),
      );
      Navigator.of(context).pop();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("保存失败: $e")),
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
        title: const Text("早安简报设置"),
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
                _SectionTitle("开关", cs, text),
                Card(
                  child: SwitchListTile(
                    title: Text("启用早安简报", style: text.titleSmall),
                    subtitle: Text(
                      "开启后，Agent 将在设定时间推送每日简报",
                      style: text.bodySmall?.copyWith(
                        color: cs.onSurfaceVariant,
                      ),
                    ),
                    value: _enabled,
                    onChanged: (bool value) {
                      setState(() => _enabled = value);
                    },
                  ),
                ),
                const SizedBox(height: 24),
                _SectionTitle("播报时间", cs, text),
                Card(
                  child: ListTile(
                    leading: const Icon(Icons.access_time_outlined),
                    title: Text("每日提醒时间", style: text.titleSmall),
                    subtitle: Text(
                      _formatTimeOfDay(_time),
                      style: text.bodyMedium?.copyWith(
                        color: cs.primary,
                      ),
                    ),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: _enabled ? _pickTime : null,
                  ),
                ),
                const SizedBox(height: 24),
                _SectionTitle("播报方式", cs, text),
                Card(
                  child: Column(
                    children: <Widget>[
                      RadioListTile<String>(
                        title: Text(
                          "语音播报",
                          style: text.titleSmall,
                        ),
                        subtitle: Text(
                          "通过 TTS 朗读简报内容",
                          style: text.bodySmall?.copyWith(
                            color: cs.onSurfaceVariant,
                          ),
                        ),
                        value: UserPreferencesApi.modeVoice,
                        groupValue: _mode,
                        onChanged: _enabled
                            ? (String? value) {
                                if (value != null) {
                                  setState(() => _mode = value);
                                }
                              }
                            : null,
                      ),
                      Divider(
                        height: 1,
                        color: cs.outline.withValues(alpha: 0.35),
                      ),
                      RadioListTile<String>(
                        title: Text(
                          "桌面弹窗",
                          style: text.titleSmall,
                        ),
                        subtitle: Text(
                          "在桌面上弹出简报窗口",
                          style: text.bodySmall?.copyWith(
                            color: cs.onSurfaceVariant,
                          ),
                        ),
                        value: UserPreferencesApi.modeWindow,
                        groupValue: _mode,
                        onChanged: _enabled
                            ? (String? value) {
                                if (value != null) {
                                  setState(() => _mode = value);
                                }
                              }
                            : null,
                      ),
                      Divider(
                        height: 1,
                        color: cs.outline.withValues(alpha: 0.35),
                      ),
                      RadioListTile<String>(
                        title: Text(
                          "聊天卡片",
                          style: text.titleSmall,
                        ),
                        subtitle: Text(
                          "仅在聊天窗口内显示文字简报",
                          style: text.bodySmall?.copyWith(
                            color: cs.onSurfaceVariant,
                          ),
                        ),
                        value: UserPreferencesApi.modeCard,
                        groupValue: _mode,
                        onChanged: _enabled
                            ? (String? value) {
                                if (value != null) {
                                  setState(() => _mode = value);
                                }
                              }
                            : null,
                      ),
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
