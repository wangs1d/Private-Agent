import "package:flutter/material.dart";

import "../../core/services/world_api_client.dart";
import "world_scene_labels.dart";

/// 世界入口：仅展示概览与进入各场景的入口。
class WorldHubPage extends StatefulWidget {
  const WorldHubPage({
    super.key,
    required this.sessionId,
    required this.api,
  });

  final String sessionId;
  final WorldApiClient api;

  @override
  State<WorldHubPage> createState() => _WorldHubPageState();
}

class _WorldHubPageState extends State<WorldHubPage> {
  bool _loading = true;
  String? _error;
  Map<String, dynamic>? _state;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final Map<String, dynamic> st = await widget.api.getState(widget.sessionId);
      if (!mounted) return;
      if (st["ok"] != true) {
        setState(() {
          _loading = false;
          _error = st.toString();
        });
        return;
      }
      setState(() {
        _state = st["state"] as Map<String, dynamic>?;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = e.toString();
      });
    }
  }

  Future<void> _openShop() async {
    await Navigator.of(context).pushNamed("/shop");
    if (mounted) _refresh();
  }

  Future<void> _openSocial() async {
    await Navigator.of(context).pushNamed("/social");
    if (mounted) _refresh();
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(
        body: Center(child: CircularProgressIndicator()),
      );
    }
    if (_error != null) {
      return Scaffold(
        appBar: AppBar(title: const Text("")),
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                Text("无法加载世界：$_error", textAlign: TextAlign.center),
                const SizedBox(height: 16),
                FilledButton(onPressed: null, child: const Text("重试")),
              ],
            ),
          ),
        ),
      );
    }

    final String sceneId = _state?["sceneId"]?.toString() ?? "social";
    final String sceneLabel = kWorldSceneLabels[sceneId] ?? sceneId;
    final int coins = (_state?["agentWorldCredits"] as num?)?.round() ??
        (_state?["worldCoins"] as num?)?.round() ??
        0;
    final int leisure = (_state?["leisureCount"] as num?)?.round() ?? 0;
    final bool atShop = sceneId == "shop" || sceneId == "free_market";
    final bool atSocial = sceneId == "social";

    return Scaffold(
      appBar: AppBar(title: const Text("")),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: <Widget>[
            Card(
              color: Theme.of(context).colorScheme.secondaryContainer.withOpacity(0.35),
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Icon(Icons.visibility_outlined, color: Theme.of(context).colorScheme.primary),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        "",
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 12),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text("当前场景：$sceneLabel", style: Theme.of(context).textTheme.titleMedium),
                    const SizedBox(height: 8),
                    Text("世界点数：$coins", style: Theme.of(context).textTheme.bodyLarge),
                    const SizedBox(height: 4),
                    Text("休闲次数：$leisure", style: Theme.of(context).textTheme.bodySmall),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),
            Text("查看场景", style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            _SceneEntryCard(
              isCurrent: atSocial,
              icon: Icons.dynamic_feed_outlined,
              title: "Agent 动态",
              subtitle: "多 Agent 类推文、评论与点赞；自家 Agent 内容优先展示",
              onTap: _openSocial,
            ),
          ],
        ),
      ),
    );
  }
}

class _SceneEntryCard extends StatelessWidget {
  const _SceneEntryCard({
    required this.isCurrent,
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });

  final bool isCurrent;
  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final ColorScheme cs = theme.colorScheme;

    return Card(
      clipBehavior: Clip.antiAlias,
      elevation: isCurrent ? 1 : 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(
          color: isCurrent ? cs.primary : cs.outlineVariant.withOpacity(0.5),
          width: isCurrent ? 2 : 1,
        ),
      ),
      color: isCurrent ? cs.primaryContainer.withOpacity(0.55) : null,
      child: ListTile(
        selected: isCurrent,
        selectedColor: cs.onPrimaryContainer,
        selectedTileColor: Colors.transparent,
        leading: Icon(
          icon,
          color: isCurrent ? cs.primary : cs.onSurfaceVariant,
        ),
        title: Text(title),
        subtitle: Text(subtitle),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            if (isCurrent)
              Padding(
                padding: const EdgeInsets.only(right: 4),
                child: Chip(
                  visualDensity: VisualDensity.compact,
                  padding: EdgeInsets.zero,
                  labelPadding: const EdgeInsets.symmetric(horizontal: 8),
                  label: const Text("当前"),
                  side: BorderSide(color: cs.primary),
                  backgroundColor: cs.primary.withOpacity(0.12),
                ),
              ),
            Icon(Icons.chevron_right, color: cs.onSurfaceVariant),
          ],
        ),
        onTap: onTap,
      ),
    );
  }
}
