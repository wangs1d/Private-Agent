import "package:flutter/material.dart";

/// 每日心情打卡：5 档表情选择 + 可选备注，提交后通过 [onSubmit] 回调上抛。
class MoodCheckinWidget extends StatefulWidget {
  const MoodCheckinWidget({
    super.key,
    required this.onSubmit,
  });

  /// [moodLevel] 取值 1..5（对应 [moodEmojis] 的索引 + 1）；[note] 可为空。
  final void Function(int moodLevel, String? note) onSubmit;

  static const List<String> moodEmojis = <String>["😄", "😊", "😐", "😟", "😢"];
  static const List<String> moodLabels = <String>["很好", "不错", "一般", "低落", "糟糕"];

  @override
  State<MoodCheckinWidget> createState() => _MoodCheckinWidgetState();
}

class _MoodCheckinWidgetState extends State<MoodCheckinWidget> {
  int? _selected;
  final TextEditingController _noteCtrl = TextEditingController();
  bool _submitted = false;

  @override
  void dispose() {
    _noteCtrl.dispose();
    super.dispose();
  }

  void _submit() {
    if (_selected == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("请先选择一个心情")),
      );
      return;
    }
    final String note = _noteCtrl.text.trim();
    widget.onSubmit(_selected!, note.isEmpty ? null : note);
    setState(() => _submitted = true);
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final ColorScheme cs = theme.colorScheme;

    if (_submitted) {
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: <Widget>[
              Icon(Icons.check_circle, color: cs.primary),
              const SizedBox(width: 8),
              const Expanded(child: Text("已记录今天的心情，明天见 👋")),
            ],
          ),
        ),
      );
    }

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text("今天心情如何？", style: theme.textTheme.titleMedium),
            const SizedBox(height: 12),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceAround,
              children: List<Widget>.generate(MoodCheckinWidget.moodEmojis.length, (int i) {
                final bool on = _selected == i + 1;
                return InkWell(
                  borderRadius: BorderRadius.circular(12),
                  onTap: () => setState(() => _selected = i + 1),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
                    decoration: BoxDecoration(
                      color: on ? cs.primaryContainer.withValues(alpha: 0.6) : Colors.transparent,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(
                        color: on ? cs.primary : cs.outline.withValues(alpha: 0.3),
                        width: on ? 2 : 1,
                      ),
                    ),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        Text(
                          MoodCheckinWidget.moodEmojis[i],
                          style: const TextStyle(fontSize: 28),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          MoodCheckinWidget.moodLabels[i],
                          style: theme.textTheme.labelSmall?.copyWith(
                            color: on ? cs.primary : cs.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                  ),
                );
              }),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _noteCtrl,
              decoration: const InputDecoration(
                labelText: "想说点什么？（可选）",
                border: OutlineInputBorder(),
                isDense: true,
              ),
              maxLines: 3,
              maxLength: 500,
            ),
            const SizedBox(height: 12),
            Align(
              alignment: Alignment.centerRight,
              child: FilledButton.icon(
                onPressed: _submit,
                icon: const Icon(Icons.send, size: 18),
                label: const Text("提交"),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
