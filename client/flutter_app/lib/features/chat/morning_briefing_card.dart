import "package:flutter/material.dart";

/// 早安简报卡片：聚合天气、今日日程、待办笔记与 Agent 问候语。
///
/// 数据格式（[briefing]）兼容以下两种字段命名：
/// ```
/// {
///   "greeting": "...",  // 或 "agentGreeting"
///   "weather": { "temperature": 22, "condition": "晴" },
///   "schedule": [ { "title": "晨会", "time": "09:30" } ],  // 或 "todaySchedule"
///   "notes": [ "回复张工的消息" ]                            // 或 "pendingNotes"
/// }
/// ```
///
/// 可选字段：
///   - [narrationText]：语音播报文本
///   - [modeLabel]：播报来源（"语音" / "弹窗" / "卡片"），用于显示角标
///   - [onSpeak]：点击扬声器按钮时的回调
class MorningBriefingCard extends StatelessWidget {
  const MorningBriefingCard({
    super.key,
    required this.briefing,
    this.narrationText,
    this.modeLabel,
    this.onSpeak,
  });

  final Map<String, dynamic> briefing;
  final String? narrationText;
  final String? modeLabel;
  final void Function(String text)? onSpeak;

  String? _readString(String key1, String key2) {
    final Object? a = briefing[key1];
    if (a is String && a.isNotEmpty) return a;
    final Object? b = briefing[key2];
    if (b is String && b.isNotEmpty) return b;
    return null;
  }

  List<dynamic>? _readList(String key1, String key2) {
    final Object? a = briefing[key1];
    if (a is List) return a;
    final Object? b = briefing[key2];
    if (b is List) return b;
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final ColorScheme cs = theme.colorScheme;

    final Object? weather = briefing["weather"];
    final num? temp = weather is Map ? (weather["temperature"] as num?) : null;
    final String condition =
        weather is Map ? (weather["condition"]?.toString() ?? "") : "";

    final String greeting = _readString("greeting", "agentGreeting") ?? "";
    final List<Map<String, dynamic>> schedule = <Map<String, dynamic>>[
      for (final Object? x in _readList("schedule", "todaySchedule") ??
          <dynamic>[])
        if (x is Map) x.cast<String, dynamic>(),
    ];
    final List<String> notes = <String>[
      for (final Object? x
          in _readList("notes", "pendingNotes") ?? <dynamic>[])
        if (x != null) x.toString(),
    ];

    final bool canSpeak = onSpeak != null &&
        narrationText != null &&
        narrationText!.isNotEmpty;

    return Card(
      clipBehavior: Clip.antiAlias,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                if (greeting.isNotEmpty) ...<Widget>[
                  Icon(Icons.wb_sunny_outlined, color: cs.primary, size: 20),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      greeting,
                      style: theme.textTheme.titleMedium,
                    ),
                  ),
                ] else
                  Expanded(
                    child: Text(
                      "早安简报",
                      style: theme.textTheme.titleMedium,
                    ),
                  ),
                if (modeLabel != null && modeLabel!.isNotEmpty) ...<Widget>[
                  const SizedBox(width: 8),
                  _ModeChip(label: modeLabel!),
                ],
                if (canSpeak) ...<Widget>[
                  const SizedBox(width: 4),
                  IconButton(
                    icon: const Icon(Icons.volume_up_outlined),
                    onPressed: () => onSpeak!(narrationText!),
                    tooltip: "语音播报",
                    visualDensity: VisualDensity.compact,
                    padding: EdgeInsets.zero,
                    constraints: const BoxConstraints(
                      minWidth: 32,
                      minHeight: 32,
                    ),
                  ),
                ],
              ],
            ),
            if (greeting.isNotEmpty) const SizedBox(height: 12),
            if (temp != null || condition.isNotEmpty) ...<Widget>[
              _SectionHeader(
                icon: Icons.cloud_outlined,
                text: "天气",
                theme: theme,
              ),
              const SizedBox(height: 4),
              Text(
                temp != null
                    ? "${condition.isEmpty ? "" : "$condition · "}${temp.round()}°C"
                    : (condition.isEmpty ? "暂无天气信息" : condition),
                style: theme.textTheme.bodyLarge,
              ),
              const SizedBox(height: 12),
            ],
            _SectionHeader(
              icon: Icons.event_note_outlined,
              text: "今日日程",
              theme: theme,
            ),
            const SizedBox(height: 4),
            if (schedule.isEmpty)
              Text(
                "今天暂无日程",
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: cs.onSurfaceVariant,
                ),
              )
            else
              for (final Map<String, dynamic> s in schedule)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Row(
                    children: <Widget>[
                      SizedBox(
                        width: 56,
                        child: Text(
                          s["time"]?.toString() ?? "",
                          style: theme.textTheme.labelMedium?.copyWith(
                            color: cs.primary,
                          ),
                        ),
                      ),
                      Expanded(child: Text(s["title"]?.toString() ?? "")),
                    ],
                  ),
                ),
            const SizedBox(height: 12),
            _SectionHeader(
              icon: Icons.checklist_outlined,
              text: "待办笔记",
              theme: theme,
            ),
            const SizedBox(height: 4),
            if (notes.isEmpty)
              Text(
                "暂无待办",
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: cs.onSurfaceVariant,
                ),
              )
            else
              for (final String n in notes)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Padding(
                        padding: const EdgeInsets.only(top: 6, right: 8),
                        child: Icon(Icons.circle, size: 6, color: cs.outline),
                      ),
                      Expanded(child: Text(n)),
                    ],
                  ),
                ),
          ],
        ),
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({
    required this.icon,
    required this.text,
    required this.theme,
  });

  final IconData icon;
  final String text;
  final ThemeData theme;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        Icon(icon, size: 16, color: theme.colorScheme.onSurfaceVariant),
        const SizedBox(width: 6),
        Text(text, style: theme.textTheme.titleSmall),
      ],
    );
  }
}

class _ModeChip extends StatelessWidget {
  const _ModeChip({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: cs.secondaryContainer,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 11,
          color: cs.onSecondaryContainer,
        ),
      ),
    );
  }
}
