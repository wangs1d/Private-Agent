import "package:flutter/material.dart";

import "../../core/config/api_config.dart";
import "../../core/services/world_api_client.dart";
import "../../core/theme/app_theme.dart";
import "skills_library_tab.dart";

/// 主侧栏「技能商店」：上架目录（与 Agent World 观战目录同源）+「我的技能」启用管理。
class SkillStorePage extends StatefulWidget {
  const SkillStorePage({super.key, required this.api});

  final WorldApiClient api;

  @override
  State<SkillStorePage> createState() => _SkillStorePageState();
}

class _SkillStorePageState extends State<SkillStorePage> {
  static const int _tabBrowse = 0;
  static const int _tabMine = 1;

  int _subTab = _tabBrowse;
  final TextEditingController _searchController = TextEditingController();
  String _searchQuery = "";

  bool _browseLoading = true;
  String? _browseError;
  Map<String, dynamic>? _worldState;
  List<Map<String, dynamic>> _shopItems = <Map<String, dynamic>>[];

  String get _sessionId => ApiConfig.effectiveActorId;

  @override
  void initState() {
    super.initState();
    _searchController.addListener(() {
      final String q = _searchController.text.trim().toLowerCase();
      if (q != _searchQuery) {
        setState(() => _searchQuery = q);
      }
    });
    _loadBrowse();
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  Future<void> _loadBrowse() async {
    setState(() {
      _browseLoading = true;
      _browseError = null;
    });
    try {
      final Map<String, dynamic> st =
          await widget.api.getState(_sessionId);
      final Map<String, dynamic> sh =
          await widget.api.getShopCatalog(_sessionId);
      if (!mounted) return;
      if (st["ok"] != true) {
        setState(() {
          _browseLoading = false;
          _browseError = st.toString();
        });
        return;
      }
      final List<dynamic>? raw = sh["items"] as List<dynamic>?;
      setState(() {
        _worldState = st["state"] as Map<String, dynamic>?;
        _shopItems = raw == null
            ? <Map<String, dynamic>>[]
            : raw.map((e) => Map<String, dynamic>.from(e as Map)).toList();
        _browseLoading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _browseLoading = false;
        _browseError = e.toString();
      });
    }
  }

  List<Map<String, dynamic>> get _filteredShopItems {
    if (_searchQuery.isEmpty) return _shopItems;
    return _shopItems.where((Map<String, dynamic> item) {
      final String id = item["skillId"]?.toString() ?? "";
      final String name = item["displayName"]?.toString() ?? "";
      final String desc = item["description"]?.toString() ?? "";
      final String blob = "$id $name $desc".toLowerCase();
      return blob.contains(_searchQuery);
    }).toList();
  }

  void _snack(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final ColorScheme cs = theme.colorScheme;
    return MainPanel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
            child: LayoutBuilder(
              builder: (BuildContext context, BoxConstraints bc) {
                final bool narrow = bc.maxWidth < 720;
                final Widget tabs = Row(
                  children: <Widget>[
                    _SubNavChip(
                      label: "技能商店",
                      selected: _subTab == _tabBrowse,
                      onTap: () => setState(() => _subTab = _tabBrowse),
                    ),
                    const SizedBox(width: 8),
                    _SubNavChip(
                      label: "我的技能",
                      selected: _subTab == _tabMine,
                      onTap: () => setState(() => _subTab = _tabMine),
                    ),
                  ],
                );
                final Widget search = SizedBox(
                  width: narrow ? double.infinity : 220,
                  child: TextField(
                    controller: _searchController,
                    decoration: InputDecoration(
                      isDense: true,
                      hintText: _subTab == _tabBrowse
                          ? "搜索更多技能"
                          : "搜索我的技能",
                      prefixIcon: const Icon(Icons.search, size: 20),
                      border: const OutlineInputBorder(
                        borderRadius: BorderRadius.all(Radius.circular(24)),
                      ),
                      contentPadding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 10,
                      ),
                    ),
                    onSubmitted: (String value) {
                      // 按 Enter 键时执行搜索
                      // 搜索功能已通过监听器自动处理，这里可以添加额外的逻辑（如 analytics）
                    },
                  ),
                );
                final Widget actions = _subTab == _tabBrowse
                    ? Align(
                        alignment: Alignment.centerRight,
                        child: FilledButton(
                          style: FilledButton.styleFrom(
                            backgroundColor: cs.surfaceContainerLow,
                            foregroundColor: cs.onSurface,
                          ),
                          onPressed: () => _snack(
                            "创建与上架技能请在会话中由 Agent 通过世界工具完成。",
                          ),
                          child: const Text("+ 创建技能"),
                        ),
                      )
                    : Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        alignment: WrapAlignment.end,
                        children: <Widget>[
                          OutlinedButton(
                            style: OutlinedButton.styleFrom(
                              backgroundColor: cs.surfaceContainerLow,
                              foregroundColor: cs.onSurface,
                            ),
                            onPressed: () => _snack("商户功能尚未接入，敬请期待。"),
                            child: const Text("开通商户"),
                          ),
                          FilledButton(
                            style: FilledButton.styleFrom(
                              backgroundColor: cs.surfaceContainerLow,
                              foregroundColor: cs.onSurface,
                            ),
                            onPressed: () => _snack(
                              "创建与上架技能请在会话中由 Agent 通过世界工具完成。",
                            ),
                            child: const Text("+ 创建技能"),
                          ),
                        ],
                      );
                if (narrow) {
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      tabs,
                      const SizedBox(height: 10),
                      search,
                      const SizedBox(height: 10),
                      actions,
                    ],
                  );
                }
                return Row(
                  crossAxisAlignment: CrossAxisAlignment.center,
                  children: <Widget>[
                    tabs,
                    const SizedBox(width: 16),
                    Flexible(
                      child: search,
                    ),
                    const SizedBox(width: 16),
                    actions,
                  ],
                );
              },
            ),
          ),
          const Divider(height: 1),
          Expanded(
            child: _subTab == _tabBrowse
                ? _buildBrowse(context)
                : SkillsLibraryTab(
                    api: widget.api,
                    outerSearchQuery:
                        _subTab == _tabMine ? _searchQuery : "",
                  ),
          ),
        ],
      ),
    );
  }

  Widget _buildBrowse(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    if (_browseLoading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_browseError != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              Text("无法加载技能商店：$_browseError", textAlign: TextAlign.center),
              const SizedBox(height: 16),
              FilledButton(
                style: FilledButton.styleFrom(
                  backgroundColor: cs.surfaceContainerLow,
                  foregroundColor: cs.onSurface,
                ),
                onPressed: null, 
                child: const Text("重试"),
              ),
            ],
          ),
        ),
      );
    }

    final int coins = (_worldState?["agentWorldCredits"] as num?)?.round() ??
        (_worldState?["worldCoins"] as num?)?.round() ??
        0;
    final List<Map<String, dynamic>> items = _filteredShopItems;
    final Map<String, dynamic>? pick =
        _shopItems.isNotEmpty ? _shopItems.first : null;

    final String searchDisplay = _searchController.text.trim();

    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final double w = constraints.maxWidth;
        final int cols = w >= 900 ? 3 : 2;
        return RefreshIndicator(
          onRefresh: _loadBrowse,
          child: CustomScrollView(
            physics: const AlwaysScrollableScrollPhysics(),
            slivers: <Widget>[
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
                sliver: SliverToBoxAdapter(
                  child: Row(
                    children: <Widget>[
                      Text(
                        "世界点数 $coins",
                        style: Theme.of(context).textTheme.titleSmall,
                      ),
                      const SizedBox(width: 12),
                      Flexible(
                        child: Text(
                          "在会话中由 Agent 在世界获得技能后，会出现在「我的技能」中，你可自行选择是否启用。",
                          style: Theme.of(context).textTheme.bodySmall?.copyWith(
                                color: Theme.of(context)
                                    .colorScheme
                                    .onSurfaceVariant,
                              ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              SliverPadding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                sliver: SliverToBoxAdapter(
                  child: _FeaturedRow(editorPick: pick),
                ),
              ),
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(16, 20, 16, 8),
                sliver: SliverToBoxAdapter(
                  child: Row(
                    children: <Widget>[
                      Text(
                        "编辑精选",
                        style: Theme.of(context).textTheme.titleMedium?.copyWith(
                              fontWeight: FontWeight.w600,
                            ),
                      ),
                      const Spacer(),
                      TextButton(
                        onPressed: items.isEmpty
                            ? null
                            : () => _snack("已展示当前上架的全部技能。"),
                        child: const Text("查看更多 >"),
                      ),
                    ],
                  ),
                ),
              ),
              if (items.isEmpty)
                SliverFillRemaining(
                  hasScrollBody: false,
                  child: Padding(
                    padding: const EdgeInsets.all(32),
                    child: Center(
                      child: Text(
                        searchDisplay.isNotEmpty
                            ? "没有匹配「$searchDisplay」的技能"
                            : "暂无技能上架（服务端尚未注册 Skill 时列表为空）",
                        textAlign: TextAlign.center,
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                              color: Theme.of(context)
                                  .colorScheme
                                  .onSurfaceVariant,
                            ),
                      ),
                    ),
                  ),
                )
              else
                SliverPadding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
                  sliver: SliverGrid(
                    gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                      crossAxisCount: cols,
                      mainAxisSpacing: 12,
                      crossAxisSpacing: 12,
                      childAspectRatio: cols >= 3 ? 1.45 : 1.35,
                    ),
                    delegate: SliverChildBuilderDelegate(
                      (BuildContext context, int i) {
                        return _SkillMarketCard(item: items[i]);
                      },
                      childCount: items.length,
                    ),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }
}

class _SubNavChip extends StatelessWidget {
  const _SubNavChip({
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
    // 使用更深的灰色作为选中状态，避免紫色调
    final Color selectedBg = const Color(0xFF5A5A5A); // 深灰色背景
    final Color selectedBorder = const Color(0xFF7A7A7A); // 稍亮的边框
    final Color unselectedBorder = cs.outlineVariant.withOpacity(0.4);
    
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(20),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 180),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          decoration: BoxDecoration(
            color: selected ? selectedBg : null,
            borderRadius: BorderRadius.circular(20),
            border: Border.all(
              color: selected ? selectedBorder : unselectedBorder,
            ),
          ),
          child: Text(
            label,
            style: theme.textTheme.labelLarge?.copyWith(
              fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
              color: selected ? Colors.white : cs.onSurfaceVariant,
            ),
          ),
        ),
      ),
    );
  }
}

class _FeaturedRow extends StatelessWidget {
  const _FeaturedRow({this.editorPick});

  final Map<String, dynamic>? editorPick;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final ColorScheme cs = theme.colorScheme;
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints bc) {
        final bool stack = bc.maxWidth < 560;
        final Widget left = Container(
          constraints: BoxConstraints(
            minHeight: stack ? 100 : 160,
            maxHeight: stack ? double.infinity : 160,
          ),
          width: double.infinity,
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(14),
            gradient: LinearGradient(
              colors: <Color>[
                cs.surfaceContainerHighest,
                cs.surfaceContainerHigh,
              ],
            ),
            border: Border.all(color: cs.outlineVariant.withOpacity(0.35)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              Wrap(
                spacing: 6,
                runSpacing: 6,
                children: <Widget>[
                  _MiniPill(text: "电商专题", cs: cs),
                  _MiniPill(text: "首批上线", cs: cs),
                ],
              ),
              const SizedBox(height: 10),
              Text(
                "想用 AI 做电商？这里有你的「增长加速器」",
                style: theme.textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                "上架技能由服务端注册；获得后将出现在「我的技能」，由你决定是否启用。",
                style: theme.textTheme.bodySmall?.copyWith(
                  color: cs.onSurfaceVariant,
                ),
              ),
            ],
          ),
        );

        final String pickTitle = editorPick?["displayName"]?.toString() ??
            "小红书爆款 | 文案创作";
        final String pickDesc = editorPick?["description"]?.toString() ??
            "社区技能上架后将显示在此处；当前为示例文案。";
        final String author =
            editorPick?["author"]?.toString().trim().isNotEmpty == true
                ? "@${editorPick!["author"]}"
                : "@编辑推荐";

        final Widget right = Container(
          constraints: BoxConstraints(
            minHeight: stack ? 100 : 160,
            maxHeight: stack ? double.infinity : 160,
          ),
          width: double.infinity,
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(14),
            color: cs.surfaceContainerLow,
            border: Border.all(color: cs.outlineVariant.withOpacity(0.35)),
          ),
          child: stack
              ? Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text("编辑推荐", style: theme.textTheme.labelMedium),
                    const SizedBox(height: 8),
                    Text(
                      pickTitle,
                      style: theme.textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      pickDesc,
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: cs.onSurfaceVariant,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(author, style: theme.textTheme.labelSmall),
                  ],
                )
              : Row(
                  children: <Widget>[
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: <Widget>[
                          Text("编辑推荐", style: theme.textTheme.labelMedium),
                          const SizedBox(height: 6),
                          Text(
                            pickTitle,
                            style: theme.textTheme.titleSmall?.copyWith(
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          const SizedBox(height: 6),
                          Text(
                            pickDesc,
                            maxLines: 3,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: cs.onSurfaceVariant,
                            ),
                          ),
                          const SizedBox(height: 8),
                          Text(author, style: theme.textTheme.labelSmall),
                        ],
                      ),
                    ),
                    const SizedBox(width: 12),
                    Container(
                      width: 72,
                      height: 72,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: cs.primary.withOpacity(0.12),
                        border: Border.all(color: cs.primary.withOpacity(0.35)),
                      ),
                      child: Text(
                        "精选",
                        style: theme.textTheme.labelLarge?.copyWith(
                          color: cs.primary,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                    ),
                  ],
                ),
        );

        if (stack) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              left,
              const SizedBox(height: 12),
              right,
            ],
          );
        }
        return Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Expanded(child: left),
            const SizedBox(width: 12),
            Expanded(child: right),
          ],
        );
      },
    );
  }
}

class _MiniPill extends StatelessWidget {
  const _MiniPill({required this.text, required this.cs});

  final String text;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(999),
        color: cs.primary.withOpacity(0.12),
      ),
      child: Text(
        text,
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
              color: cs.primary,
              fontWeight: FontWeight.w600,
            ),
      ),
    );
  }
}

class _SkillMarketCard extends StatelessWidget {
  const _SkillMarketCard({required this.item});

  final Map<String, dynamic> item;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final ColorScheme cs = theme.colorScheme;
    final String skillId = item["skillId"]?.toString() ?? "";
    final String name = item["displayName"]?.toString() ?? skillId;
    final String desc = item["description"]?.toString() ?? "";
    final int price = (item["price"] as num?)?.round() ?? 0;
    final bool owned = item["owned"] == true;
    final String kind = item["kind"]?.toString() ?? "";
    final bool official = kind == "builtin";
    final String? icon = item["icon"]?.toString();
    final String authorRaw = item["author"]?.toString().trim() ?? "";
    final String author =
        authorRaw.isNotEmpty ? "@$authorRaw" : "@社区作者";

    final List<dynamic>? tagList = item["tags"] as List<dynamic>?;
    final String tagHint = tagList != null && tagList.isNotEmpty
        ? tagList.first.toString()
        : "";

    return Card(
      clipBehavior: Clip.antiAlias,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: cs.outlineVariant.withOpacity(0.45)),
      ),
      child: InkWell(
        onTap: () {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(owned ? "已拥有 $name" : "$name · ${price == 0 ? "免费" : "$price 点"}")),
          );
        },
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Container(
                width: 48,
                height: 48,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(10),
                  color: cs.surfaceContainerHighest,
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
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Expanded(
                          child: Text(
                            name,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.titleSmall?.copyWith(
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ),
                        if (official)
                          Padding(
                            padding: const EdgeInsets.only(left: 6),
                            child: Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 6,
                                vertical: 2,
                              ),
                              decoration: BoxDecoration(
                                borderRadius: BorderRadius.circular(4),
                                color: cs.secondaryContainer,
                              ),
                              child: Text(
                                "官方",
                                style: theme.textTheme.labelSmall?.copyWith(
                                  color: cs.onSecondaryContainer,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                          ),
                        if (!official && tagHint.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(left: 6),
                            child: Text(
                              tagHint,
                              style: theme.textTheme.labelSmall?.copyWith(
                                color: cs.tertiary,
                              ),
                            ),
                          ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      desc.isEmpty ? "—" : desc,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: cs.onSurfaceVariant,
                        height: 1.35,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Row(
                      children: <Widget>[
                        Text(
                          owned
                              ? "已拥有"
                              : (price == 0 ? "免费" : "$price 点"),
                          style: theme.textTheme.labelMedium?.copyWith(
                            fontWeight: FontWeight.w600,
                            color: owned ? cs.primary : null,
                          ),
                        ),
                        const Spacer(),
                        Text(
                          author,
                          style: theme.textTheme.labelSmall?.copyWith(
                            color: cs.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
