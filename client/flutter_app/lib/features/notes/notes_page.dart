import "package:flutter/material.dart";

import "../../core/services/notes_api_client.dart";
import "note_detail_page.dart";

/// 学习/知识笔记列表页：
/// - 顶部分类 Tab（全部 / 学习 / 会议 / 视频 / 读书 / 灵感 / 待办 / 其它）
/// - 搜索框（命中后跳详情）
/// - 列表项点击进入详情；右下 FAB 新建
class NotesPage extends StatefulWidget {
  const NotesPage({super.key, this.api});

  final NotesApiClient? api;

  @override
  State<NotesPage> createState() => _NotesPageState();
}

class _NotesPageState extends State<NotesPage> {
  static const List<_CategoryOption> _categories = <_CategoryOption>[
    _CategoryOption(null, "全部"),
    _CategoryOption("study", "学习"),
    _CategoryOption("meeting", "会议"),
    _CategoryOption("video", "视频"),
    _CategoryOption("reading", "读书"),
    _CategoryOption("idea", "灵感"),
    _CategoryOption("todo", "待办"),
    _CategoryOption("other", "其它"),
  ];

  late final NotesApiClient _api = widget.api ?? NotesApiClient();
  String? _activeCategory;
  List<Map<String, dynamic>> _notes = <Map<String, dynamic>>[];
  bool _loading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final NotesApiResult<List<Map<String, dynamic>>> r =
        await _api.listNotes(category: _activeCategory, limit: 80);
    if (!mounted) return;
    setState(() {
      _loading = false;
      if (r.ok) {
        _notes = r.value ?? <Map<String, dynamic>>[];
      } else {
        _error = r.error;
        _notes = <Map<String, dynamic>>[];
      }
    });
  }

  Future<void> _openCreate() async {
    final Map<String, dynamic>? created = await Navigator.of(context).push<Map<String, dynamic>>(
      MaterialPageRoute<Map<String, dynamic>>(
        builder: (_) => const _NoteEditorPage(),
      ),
    );
    if (created != null) {
      _reload();
    }
  }

  Future<void> _openSearch() async {
    final TextEditingController ctrl = TextEditingController();
    final String? query = await showDialog<String>(
      context: context,
      builder: (BuildContext ctx) {
        return AlertDialog(
          title: const Text("搜索笔记"),
          content: TextField(
            controller: ctrl,
            autofocus: true,
            decoration: const InputDecoration(hintText: "关键词"),
          ),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(null),
              child: const Text("取消"),
            ),
            FilledButton(
              onPressed: () => Navigator.of(ctx).pop(ctrl.text.trim()),
              child: const Text("搜索"),
            ),
          ],
        );
      },
    );
    if (query == null || query.isEmpty) return;
    if (!mounted) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    final NotesApiResult<List<Map<String, dynamic>>> r = await _api.searchNotes(query);
    if (!mounted) return;
    setState(() {
      _loading = false;
      if (r.ok) {
        _notes = r.value ?? <Map<String, dynamic>>[];
      } else {
        _error = r.error;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text("学习笔记"),
        actions: <Widget>[
          IconButton(
            icon: const Icon(Icons.search),
            onPressed: _openSearch,
            tooltip: "搜索",
          ),
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _reload,
            tooltip: "刷新",
          ),
        ],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(48),
          child: SizedBox(
            height: 48,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 8),
              children: _categories
                  .map((_CategoryOption opt) => Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
                        child: ChoiceChip(
                          label: Text(opt.label),
                          selected: _activeCategory == opt.value,
                          onSelected: (_) {
                            setState(() {
                              _activeCategory = opt.value;
                            });
                            _reload();
                          },
                        ),
                      ))
                  .toList(),
            ),
          ),
        ),
      ),
      body: _buildBody(),
      floatingActionButton: FloatingActionButton(
        onPressed: _openCreate,
        tooltip: "新建笔记",
        child: const Icon(Icons.add),
      ),
    );
  }

  Widget _buildBody() {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text("加载失败：$_error"),
            const SizedBox(height: 12),
            FilledButton(onPressed: _reload, child: const Text("重试")),
          ],
        ),
      );
    }
    if (_notes.isEmpty) {
      return const Center(child: Text("还没有笔记，点右下角新建"));
    }
    return ListView.separated(
      itemCount: _notes.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (BuildContext ctx, int i) {
        final Map<String, dynamic> n = _notes[i];
        return ListTile(
          title: Text(n["title"]?.toString() ?? "(无标题)"),
          subtitle: Text(
            (n["contentPreview"] ?? "").toString(),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
          leading: _categoryIcon(n["category"]?.toString()),
          trailing: Text(_formatTime(n["updatedAt"]?.toString())),
          onTap: () async {
            final String? id = n["id"]?.toString();
            if (id == null) return;
            await Navigator.of(context).push<Map<String, dynamic>>(
              MaterialPageRoute<Map<String, dynamic>>(
                builder: (_) => NoteDetailPage(noteId: id, api: _api),
              ),
            );
            _reload();
          },
        );
      },
    );
  }
}

Widget _categoryIcon(String? cat) {
  switch (cat) {
    case "study":
      return const Icon(Icons.school, color: Colors.blue);
    case "meeting":
      return const Icon(Icons.groups, color: Colors.deepPurple);
    case "video":
      return const Icon(Icons.play_circle_outline, color: Colors.red);
    case "reading":
      return const Icon(Icons.menu_book, color: Colors.brown);
    case "idea":
      return const Icon(Icons.lightbulb, color: Colors.amber);
    case "todo":
      return const Icon(Icons.checklist, color: Colors.green);
    default:
      return const Icon(Icons.notes, color: Colors.grey);
  }
}

String _formatTime(String? iso) {
  if (iso == null || iso.isEmpty) return "";
  final DateTime? d = DateTime.tryParse(iso);
  if (d == null) return "";
  final DateTime local = d.toLocal();
  final String hh = local.hour.toString().padLeft(2, "0");
  final String mm = local.minute.toString().padLeft(2, "0");
  return "${local.month.toString().padLeft(2, "0")}-${local.day.toString().padLeft(2, "0")} $hh:$mm";
}

class _CategoryOption {
  const _CategoryOption(this.value, this.label);
  final String? value;
  final String label;
}

class _NoteEditorPage extends StatefulWidget {
  const _NoteEditorPage();

  @override
  State<_NoteEditorPage> createState() => _NoteEditorPageState();
}

class _NoteEditorPageState extends State<_NoteEditorPage> {
  final TextEditingController _titleCtrl = TextEditingController();
  final TextEditingController _contentCtrl = TextEditingController();
  final TextEditingController _tagsCtrl = TextEditingController();
  String _category = "other";
  bool _saving = false;

  Future<void> _save() async {
    final String title = _titleCtrl.text.trim();
    final String content = _contentCtrl.text.trim();
    if (title.isEmpty || content.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("标题与正文均必填")),
      );
      return;
    }
    setState(() {
      _saving = true;
    });
    final List<String> tags = _tagsCtrl.text
        .split(RegExp(r"[,\s]+"))
        .map((String t) => t.trim())
        .where((String t) => t.isNotEmpty)
        .toList();
    final NotesApiResult<Map<String, dynamic>> r = await NotesApiClient().createNote(
      title: title,
      content: content,
      category: _category,
      tags: tags,
      source: "flutter",
    );
    if (!mounted) return;
    setState(() {
      _saving = false;
    });
    if (r.ok) {
      Navigator.of(context).pop(r.value);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("保存失败：${r.error}")),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text("新建笔记"),
        actions: <Widget>[
          IconButton(
            icon: _saving
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.check),
            onPressed: _saving ? null : _save,
          ),
        ],
      ),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: ListView(
          children: <Widget>[
            TextField(
              controller: _titleCtrl,
              decoration: const InputDecoration(
                labelText: "标题",
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _contentCtrl,
              decoration: const InputDecoration(
                labelText: "正文（Markdown 友好）",
                border: OutlineInputBorder(),
                alignLabelWithHint: true,
              ),
              minLines: 6,
              maxLines: 16,
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              value: _category,
              decoration: const InputDecoration(
                labelText: "分类",
                border: OutlineInputBorder(),
              ),
              items: const <DropdownMenuItem<String>>[
                DropdownMenuItem<String>(value: "study", child: Text("学习")),
                DropdownMenuItem<String>(value: "meeting", child: Text("会议")),
                DropdownMenuItem<String>(value: "video", child: Text("视频")),
                DropdownMenuItem<String>(value: "reading", child: Text("读书")),
                DropdownMenuItem<String>(value: "idea", child: Text("灵感")),
                DropdownMenuItem<String>(value: "todo", child: Text("待办")),
                DropdownMenuItem<String>(value: "other", child: Text("其它")),
              ],
              onChanged: (String? v) {
                if (v == null) return;
                setState(() {
                  _category = v;
                });
              },
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _tagsCtrl,
              decoration: const InputDecoration(
                labelText: "标签（逗号或空格分隔）",
                border: OutlineInputBorder(),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
