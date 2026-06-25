import "package:flutter/material.dart";

import "../../core/services/notes_api_client.dart";

/// 笔记详情页：显示正文 / 摘要 / 卡片 / 题目；支持生成摘要、抽问、安排复习。
class NoteDetailPage extends StatefulWidget {
  const NoteDetailPage({super.key, required this.noteId, this.api});

  final String noteId;
  final NotesApiClient? api;

  @override
  State<NoteDetailPage> createState() => _NoteDetailPageState();
}

class _NoteDetailPageState extends State<NoteDetailPage> {
  late final NotesApiClient _api = widget.api ?? NotesApiClient();
  Map<String, dynamic>? _note;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final NotesApiResult<Map<String, dynamic>> r = await _api.getNote(widget.noteId);
    if (!mounted) return;
    setState(() {
      if (r.ok) {
        _note = r.value;
        _error = null;
      } else {
        _error = r.error;
      }
    });
  }

  Future<void> _doSummarize() async {
    setState(() {
      _busy = true;
    });
    final NotesApiResult<String> r = await _api.summarize(widget.noteId);
    if (!mounted) return;
    setState(() {
      _busy = false;
    });
    if (r.ok) {
      await _load();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(r.value != null && r.value!.isNotEmpty ? "摘要已生成" : "摘要为空")),
      );
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("生成摘要失败：${r.error}")),
      );
    }
  }

  Future<void> _doQuiz() async {
    setState(() {
      _busy = true;
    });
    final NotesApiResult<List<Map<String, dynamic>>> r = await _api.quiz(widget.noteId);
    if (!mounted) return;
    setState(() {
      _busy = false;
    });
    if (!r.ok) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("生成题目失败：${r.error}")),
      );
      return;
    }
    final List<Map<String, dynamic>> items = r.value ?? <Map<String, dynamic>>[];
    if (items.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("暂未生成题目（可能 LLM 未配置）")),
      );
      return;
    }
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (BuildContext ctx) {
        return DraggableScrollableSheet(
          expand: false,
          initialChildSize: 0.6,
          minChildSize: 0.3,
          maxChildSize: 0.95,
          builder: (BuildContext c, ScrollController ctrl) {
            return ListView.separated(
              controller: ctrl,
              padding: const EdgeInsets.all(16),
              itemCount: items.length,
              separatorBuilder: (_, __) => const Divider(),
              itemBuilder: (BuildContext c, int i) {
                final Map<String, dynamic> q = items[i];
                return ExpansionTile(
                  title: Text("Q${i + 1}. ${q["question"] ?? ""}"),
                  children: <Widget>[
                    Padding(
                      padding: const EdgeInsets.all(12),
                      child: Text(q["answer"]?.toString() ?? ""),
                    ),
                  ],
                );
              },
            );
          },
        );
      },
    );
  }

  Future<void> _doSchedule() async {
    final DateTime now = DateTime.now();
    final DateTime tomorrow9 = DateTime(now.year, now.month, now.day + 1, 9, 0);
    final DateTime picked = await showDatePicker(
      context: context,
      initialDate: tomorrow9,
      firstDate: now,
      lastDate: now.add(const Duration(days: 365)),
    ) ?? tomorrow9;
    if (!mounted) return;
    final TimeOfDay t = await showTimePicker(
      context: context,
      initialTime: const TimeOfDay(hour: 9, minute: 0),
    ) ?? const TimeOfDay(hour: 9, minute: 0);
    final DateTime at = DateTime(picked.year, picked.month, picked.day, t.hour, t.minute);
    setState(() {
      _busy = true;
    });
    final NotesApiResult<Map<String, dynamic>> r = await _api.scheduleReview(
      widget.noteId,
      runAt: at,
    );
    if (!mounted) return;
    setState(() {
      _busy = false;
    });
    if (r.ok) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text("复习提醒已加入：${r.value?["nextRunAtLocal"] ?? r.value?["nextRunAt"] ?? ""}"),
        ),
      );
      await _load();
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("创建提醒失败：${r.error}")),
      );
    }
  }

  Future<void> _doDelete() async {
    final bool? ok = await showDialog<bool>(
      context: context,
      builder: (BuildContext c) => AlertDialog(
        title: const Text("删除笔记"),
        content: const Text("确认删除？此操作不可撤销。"),
        actions: <Widget>[
          TextButton(onPressed: () => Navigator.of(c).pop(false), child: const Text("取消")),
          FilledButton(
            onPressed: () => Navigator.of(c).pop(true),
            child: const Text("删除"),
          ),
        ],
      ),
    );
    if (ok != true) return;
    final NotesApiResult<bool> r = await _api.deleteNote(widget.noteId);
    if (!mounted) return;
    if (r.ok) {
      Navigator.of(context).pop(<String, dynamic>{"deleted": true});
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("删除失败：${r.error}")),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) {
      return Scaffold(
        appBar: AppBar(title: const Text("笔记详情")),
        body: Center(child: Text("加载失败：$_error")),
      );
    }
    if (_note == null) {
      return Scaffold(
        appBar: AppBar(title: const Text("笔记详情")),
        body: const Center(child: CircularProgressIndicator()),
      );
    }
    final Map<String, dynamic> n = _note!;
    final List<dynamic> flashcards = (n["flashcards"] is List) ? n["flashcards"] as List<dynamic> : <dynamic>[];
    final List<dynamic> quizList = (n["quiz"] is List) ? n["quiz"] as List<dynamic> : <dynamic>[];
    return Scaffold(
      appBar: AppBar(
        title: Text(n["title"]?.toString() ?? "笔记详情"),
        actions: <Widget>[
          IconButton(
            icon: const Icon(Icons.delete_outline),
            onPressed: _busy ? null : _doDelete,
          ),
        ],
      ),
      body: AbsorbPointer(
        absorbing: _busy,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: <Widget>[
            Wrap(
              spacing: 8,
              runSpacing: 4,
              children: <Widget>[
                Chip(label: Text("分类：${n["category"] ?? "-"}")),
                if (n["source"] != null) Chip(label: Text("来源：${n["source"]}")),
                if (n["reviewCount"] is int && (n["reviewCount"] as int) > 0)
                  Chip(label: Text("已复习 ${n["reviewCount"]} 次")),
                ...((n["tags"] as List<dynamic>?) ?? <dynamic>[])
                    .map((dynamic t) => Chip(label: Text("#$t"))),
              ],
            ),
            const SizedBox(height: 12),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Text(n["content"]?.toString() ?? ""),
              ),
            ),
            const SizedBox(height: 12),
            _sectionTitle("摘要", action: TextButton(
              onPressed: _busy ? null : _doSummarize,
              child: const Text("生成"),
            )),
            if (n["summary"] is String && (n["summary"] as String).isNotEmpty)
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Text(n["summary"] as String),
                ),
              )
            else
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 8),
                child: Text("尚未生成摘要", style: TextStyle(color: Colors.grey)),
              ),
            const SizedBox(height: 12),
            _sectionTitle("记忆卡片", count: flashcards.length),
            if (flashcards.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 8),
                child: Text("尚未生成卡片", style: TextStyle(color: Colors.grey)),
              )
            else
              ...flashcards.map((dynamic f) {
                final Map<String, dynamic> m = f is Map<String, dynamic> ? f : <String, dynamic>{};
                return Card(
                  child: ListTile(
                    title: Text("Q. ${m["q"] ?? ""}"),
                    subtitle: Text("A. ${m["a"] ?? ""}"),
                  ),
                );
              }),
            const SizedBox(height: 12),
            _sectionTitle("自测题", count: quizList.length, action: TextButton(
              onPressed: _busy ? null : _doQuiz,
              child: const Text("出题"),
            )),
            if (quizList.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 8),
                child: Text("尚未生成题目", style: TextStyle(color: Colors.grey)),
              )
            else
              ...quizList.map((dynamic q) {
                final Map<String, dynamic> m = q is Map<String, dynamic> ? q : <String, dynamic>{};
                return Card(
                  child: ExpansionTile(
                    title: Text(m["question"]?.toString() ?? ""),
                    children: <Widget>[
                      Padding(
                        padding: const EdgeInsets.all(12),
                        child: Text(m["answer"]?.toString() ?? ""),
                      ),
                    ],
                  ),
                );
              }),
            const SizedBox(height: 24),
            Row(
              children: <Widget>[
                Expanded(
                  child: FilledButton.icon(
                    onPressed: _busy ? null : _doSummarize,
                    icon: const Icon(Icons.summarize),
                    label: const Text("生成摘要"),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: FilledButton.icon(
                    onPressed: _busy ? null : _doQuiz,
                    icon: const Icon(Icons.quiz),
                    label: const Text("出题"),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: FilledButton.icon(
                    onPressed: _busy ? null : _doSchedule,
                    icon: const Icon(Icons.alarm_add),
                    label: const Text("安排复习"),
                  ),
                ),
              ],
            ),
            if (_busy)
              const Padding(
                padding: EdgeInsets.all(12),
                child: Center(child: CircularProgressIndicator()),
              ),
          ],
        ),
      ),
    );
  }

  Widget _sectionTitle(String text, {int count = 0, Widget? action}) {
    return Row(
      children: <Widget>[
        Text(text, style: Theme.of(context).textTheme.titleMedium),
        if (count > 0) ...<Widget>[
          const SizedBox(width: 6),
          Text("($count)", style: const TextStyle(color: Colors.grey)),
        ],
        const Spacer(),
        if (action != null) action,
      ],
    );
  }
}
