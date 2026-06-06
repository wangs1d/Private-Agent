import "dart:async";

import "package:flutter/foundation.dart";
import "package:flutter/material.dart";
import "package:flutter/services.dart";

import "../../core/services/world_api_client.dart";
import "../../core/theme/app_theme.dart";

/// 当前登录主体可用的 Skill（内置 + 世界中获得的社区技能），卡片式管理启用状态。
///
/// [outerSearch] 由父级搜索框传入（非空时按名称与描述过滤）；
/// 传 `null` 表示父级未启用搜索（如在「技能商店」子页时）。
class SkillsLibraryTab extends StatefulWidget {
  const SkillsLibraryTab({
    super.key,
    required this.api,
    this.outerSearch,
  });

  final WorldApiClient api;

  /// 父组件「搜索我的技能」当前关键字监听器，传 `null` 则忽略。
  final ValueListenable<String>? outerSearch;

  @override
  State<SkillsLibraryTab> createState() => _SkillsLibraryTabState();
}

class _SkillsLibraryTabState extends State<SkillsLibraryTab> {
  static const int _segAdded = 0;
  static const int _segCreated = 1;

  int _segment = _segAdded;
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _items = <Map<String, dynamic>>[];
  final Set<String> _toggling = <String>{};

  /// 缓存分段结果，仅在 [setState] 改 segment 或 [items] 变化时失效。
  List<Map<String, dynamic>>? _cachedBase;
  int _cachedBaseSegment = -1;
  int _cachedBaseLength = -1;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final Map<String, dynamic> j = await widget.api.getChatSkillsLibrary();
      if (!mounted) return;
      if (j["ok"] != true) {
        setState(() {
          _loading = false;
          _error = j["message"]?.toString() ?? "加载失败";
        });
        return;
      }
      final List<dynamic>? raw = j["items"] as List<dynamic>?;
      setState(() {
        _loading = false;
        _items = raw
                ?.map((dynamic e) => (e as Map).cast<String, dynamic>())
                .toList() ??
            <Map<String, dynamic>>[];
        _invalidateBaseCache();
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = e.toString();
      });
    }
  }

  void _invalidateBaseCache() {
    _cachedBase = null;
    _cachedBaseSegment = -1;
    _cachedBaseLength = -1;
  }

  Future<void> _setEnabled(String skillName, bool enabled) async {
    if (_toggling.contains(skillName)) return;
    setState(() => _toggling.add(skillName));
    try {
      final Map<String, dynamic> res =
          await widget.api.patchChatSkillEnabled(skillName, enabled);
      if (!mounted) return;
      if (res["ok"] == true) {
        setState(() {
          final int i = _items.indexWhere(
            (Map<String, dynamic> x) => x["name"]?.toString() == skillName,
          );
          if (i >= 0) {
            _items[i] = <String, dynamic>{..._items[i], "enabled": enabled};
          }
        });
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(res["message"]?.toString() ?? "更新失败"),
          ),
        );
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("请求失败: $e")),
      );
    } finally {
      if (mounted) {
        setState(() => _toggling.remove(skillName));
      }
    }
  }

  List<Map<String, dynamic>> _segmentBase() {
    if (_cachedBase != null &&
        _cachedBaseSegment == _segment &&
        _cachedBaseLength == _items.length) {
      return _cachedBase!;
    }
    final List<Map<String, dynamic>> base = _items.where((Map<String, dynamic> e) {
      final String src = e["source"]?.toString() ?? "";
      final String kind = e["kind"]?.toString() ?? "";
      if (_segment == _segAdded) {
        return src == "community";
      }
      // "我创建的" 标签页：排除系统内置技能 (builtin)，只显示用户创建的技能
      return src != "community" && kind != "builtin";
    }).toList(growable: false);
    _cachedBase = base;
    _cachedBaseSegment = _segment;
    _cachedBaseLength = _items.length;
    return base;
  }

  List<Map<String, dynamic>> _visibleItems(String query) {
    final List<Map<String, dynamic>> base = _segmentBase();
    if (query.isEmpty) return base;
    return base.where((Map<String, dynamic> item) {
      final String name = item["name"]?.toString() ?? "";
      final String disp = item["displayName"]?.toString() ?? "";
      final String desc = item["description"]?.toString() ?? "";
      final String blob = "$name $disp $desc".toLowerCase();
      return blob.contains(query);
    }).toList(growable: false);
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Center(
        child: CircularProgressIndicator(),
      );
    }
    if (_error != null) {
      final ColorScheme cs = Theme.of(context).colorScheme;
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              Text(_error!, textAlign: TextAlign.center),
              const SizedBox(height: 16),
              _GhostButton(
                label: "重试",
                onTap: () => unawaited(_load()),
                cs: cs,
              ),
            ],
          ),
        ),
      );
    }

    final ValueListenable<String>? search = widget.outerSearch;

    if (search == null) {
      return const _LibraryBody(
        segment: _segAdded,
        visibleItems: <Map<String, dynamic>>[],
        toggling: <String>{},
        onSelectSegment: null,
        onUse: null,
        onDisable: null,
        onCopyId: null,
        onRefresh: null,
        description: "",
        emptyHint: "",
      );
    }

    return ValueListenableBuilder<String>(
      valueListenable: search,
      builder: (BuildContext context, String q, _) {
        final List<Map<String, dynamic>> visible = _visibleItems(q);
        return _LibraryBody(
          segment: _segment,
          visibleItems: visible,
          toggling: _toggling,
          onRefresh: _load,
          onSelectSegment: (int next) {
            if (next == _segment) return;
            setState(() => _segment = next);
          },
          onUse: (String name) {
            if (name.isEmpty) return;
            unawaited(_setEnabled(name, true));
          },
          onDisable: (String name) {
            if (name.isEmpty) return;
            unawaited(_setEnabled(name, false));
          },
          onCopyId: (String name) {
            if (name.isEmpty) return;
            Clipboard.setData(ClipboardData(text: name));
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(content: Text("已复制技能 ID")),
            );
          },
          description: _segment == _segAdded
              ? "从技能商店或世界中获得的技能；点「立即使用」即可在对话中启用。"
              : "你通过 Agent 自行创建并上架的技能；系统内置技能不在此展示。",
          emptyHint: _emptyHint(),
        );
      },
    );
  }

  String _emptyHint() {
    if (_segment == _segAdded) {
      return "暂无从商店获得的技能。\n可在「技能商店」浏览，并由 Agent 在世界中获取。";
    }
    assert(_segment == _segCreated, "未识别的 segment=$_segment");
    return "暂无你创建的技能；可通过 Agent 在世界中创建并上架新技能。";
  }
}

class _LibraryBody extends StatelessWidget {
  const _LibraryBody({
    required this.segment,
    required this.visibleItems,
    required this.toggling,
    required this.onSelectSegment,
    required this.onUse,
    required this.onDisable,
    required this.onCopyId,
    required this.onRefresh,
    required this.description,
    required this.emptyHint,
  });

  final int segment;
  final List<Map<String, dynamic>> visibleItems;
  final Set<String> toggling;
  final ValueChanged<int>? onSelectSegment;
  final ValueChanged<String>? onUse;
  final ValueChanged<String>? onDisable;
  final ValueChanged<String>? onCopyId;
  final Future<void> Function()? onRefresh;
  final String description;
  final String emptyHint;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return RepaintBoundary(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
            child: Row(
              children: <Widget>[
                _SegmentChip(
                  label: "我添加的",
                  selected: segment == 0,
                  onTap: () => onSelectSegment?.call(0),
                ),
                const SizedBox(width: 8),
                _SegmentChip(
                  label: "我创建的",
                  selected: segment == 1,
                  onTap: () => onSelectSegment?.call(1),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: Text(
              description,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
          Expanded(
            child: LayoutBuilder(
              builder: (BuildContext context, BoxConstraints c) {
                final int cols = c.maxWidth >= 720 ? 2 : 1;
                final int itemCount = visibleItems.length;
                return RefreshIndicator(
                  onRefresh: onRefresh ?? () async {},
                  child: itemCount == 0
                      ? ListView(
                          physics: const AlwaysScrollableScrollPhysics(),
                          padding: const EdgeInsets.all(32),
                          children: <Widget>[
                            SizedBox(height: c.maxHeight * 0.12),
                            Center(
                              child: Text(
                                emptyHint,
                                textAlign: TextAlign.center,
                                style: theme.textTheme.bodyMedium?.copyWith(
                                  color: theme.colorScheme.onSurfaceVariant,
                                ),
                              ),
                            ),
                          ],
                        )
                      : GridView.builder(
                          physics: const AlwaysScrollableScrollPhysics(),
                          padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
                          gridDelegate:
                              SliverGridDelegateWithFixedCrossAxisCount(
                            crossAxisCount: cols,
                            mainAxisSpacing: 12,
                            crossAxisSpacing: 12,
                            childAspectRatio: cols >= 2 ? 1.75 : 1.55,
                          ),
                          itemCount: itemCount,
                          itemBuilder: (BuildContext context, int i) {
                            final Map<String, dynamic> item = visibleItems[i];
                            return _MySkillCard(
                              item: item,
                              busy: toggling.contains(
                                item["name"]?.toString() ?? "",
                              ),
                              onUse: () => onUse?.call(
                                item["name"]?.toString() ?? "",
                              ),
                              onDisable: () => onDisable?.call(
                                item["name"]?.toString() ?? "",
                              ),
                              onCopyId: () => onCopyId?.call(
                                item["name"]?.toString() ?? "",
                              ),
                            );
                          },
                        ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _SegmentChip extends StatelessWidget {
  const _SegmentChip({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final ColorScheme cs = theme.colorScheme;

    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(20),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 180),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          decoration: AppTheme.subNavChip(cs, selected: selected),
          child: Text(
            label,
            style: theme.textTheme.labelLarge?.copyWith(
              fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
              color: selected ? cs.onSurface : cs.onSurfaceVariant,
            ),
          ),
        ),
      ),
    );
  }
}

class _GhostButton extends StatelessWidget {
  const _GhostButton({
    required this.label,
    required this.onTap,
    required this.cs,
  });

  final String label;
  final VoidCallback onTap;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    return FilledButton(
      style: FilledButton.styleFrom(
        backgroundColor: Colors.transparent,
        foregroundColor: cs.onSurface,
        side: BorderSide(
          color: cs.outline.withValues(alpha: 0.35),
        ),
      ),
      onPressed: onTap,
      child: Text(label),
    );
  }
}

class _MySkillCard extends StatelessWidget {
  const _MySkillCard({
    required this.item,
    required this.busy,
    required this.onUse,
    required this.onDisable,
    required this.onCopyId,
  });

  final Map<String, dynamic> item;
  final bool busy;
  final VoidCallback onUse;
  final VoidCallback onDisable;
  final VoidCallback onCopyId;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final ColorScheme cs = theme.colorScheme;
    final String name = item["name"]?.toString() ?? "";
    final String disp = item["displayName"]?.toString() ?? "";
    final String title = disp.isNotEmpty ? disp : name;
    final String desc = item["description"]?.toString() ?? "";
    final bool enabled = item["enabled"] == true;
    final String? icon = item["icon"]?.toString();

    return Card(
      clipBehavior: Clip.antiAlias,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: cs.outlineVariant.withValues(alpha: 0.55)),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Container(
                  width: 48,
                  height: 48,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: cs.outline.withValues(alpha: 0.35)),
                  ),
                  child: Text(
                    (icon != null && icon.isNotEmpty) ? icon : "◇",
                    style: const TextStyle(fontSize: 22),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      Row(
                        children: <Widget>[
                          Expanded(
                            child: Text(
                              title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: theme.textTheme.titleSmall?.copyWith(
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ),
                          if (!enabled)
                            Icon(
                              Icons.lock_outline,
                              size: 18,
                              color: cs.onSurfaceVariant,
                            ),
                        ],
                      ),
                      if (desc.isNotEmpty) ...<Widget>[
                        const SizedBox(height: 4),
                        Text(
                          desc,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: cs.onSurfaceVariant,
                            height: 1.35,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ),
            const Expanded(child: SizedBox.shrink()),
            Row(
              children: <Widget>[
                Expanded(
                  child: OutlinedButton(
                    onPressed: busy
                        ? null
                        : () {
                            if (enabled) {
                              onDisable();
                            } else {
                              onUse();
                            }
                          },
                    style: OutlinedButton.styleFrom(
                      padding: const EdgeInsets.symmetric(vertical: 12),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(10),
                      ),
                    ),
                    child: busy
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : Text(enabled ? "停用" : "立即使用"),
                  ),
                ),
                const SizedBox(width: 8),
                SizedBox(
                  width: 44,
                  height: 44,
                  child: Material(
                    color: Colors.transparent,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10),
                      side: BorderSide(color: cs.outlineVariant),
                    ),
                    child: PopupMenuButton<String>(
                      padding: EdgeInsets.zero,
                      enabled: !busy,
                      icon: const Icon(Icons.more_vert, size: 20),
                      tooltip: "更多",
                      onSelected: (String v) {
                        if (v == "disable") {
                          onDisable();
                        } else if (v == "enable") {
                          onUse();
                        } else if (v == "copy") {
                          onCopyId();
                        }
                      },
                      itemBuilder: (BuildContext ctx) {
                        return <PopupMenuEntry<String>>[
                          if (enabled)
                            const PopupMenuItem<String>(
                              value: "disable",
                              child: Text("停用"),
                            )
                          else
                            const PopupMenuItem<String>(
                              value: "enable",
                              child: Text("启用"),
                            ),
                          const PopupMenuItem<String>(
                            value: "copy",
                            child: Text("复制技能 ID"),
                          ),
                        ];
                      },
                    ),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
