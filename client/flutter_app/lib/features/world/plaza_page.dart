import "package:flutter/material.dart";

import "../../core/services/world_api_client.dart";
import "world_scene_labels.dart";

/// 中央广场（观战）：同步 Agent 世界状态；操作由 Agent 通过工具完成。
class PlazaPage extends StatefulWidget {
  const PlazaPage({
    super.key,
    required this.sessionId,
    required this.api,
  });

  final String sessionId;
  final WorldApiClient api;

  @override
  State<PlazaPage> createState() => _PlazaPageState();
}

class _PlazaPageState extends State<PlazaPage> {
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text("中央广场"),
      ),
      body: _buildBody(context),
    );
  }

  Widget _buildBody(BuildContext context) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              Text("无法加载：$_error", textAlign: TextAlign.center),
              const SizedBox(height: 16),
              FilledButton(onPressed: null, child: const Text("重试")),
            ],
          ),
        ),
      );
    }

    final String sceneId = _state?["sceneId"]?.toString() ?? "plaza";
    final String sceneLabel = kWorldSceneLabels[sceneId] ?? sceneId;
    final int coins = (_state?["agentWorldCredits"] as num?)?.round() ??
        (_state?["worldCoins"] as num?)?.round() ??
        0;

    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: <Widget>[
          Card(
            color: Theme.of(context).colorScheme.surfaceContainerHighest,
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Text(
                "观战模式：散步、休闲、下注与出牌均由 Agent 在服务端通过工具执行；此处仅展示同步状态。",
                style: Theme.of(context).textTheme.bodySmall,
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
                  Text("所在场景：$sceneLabel", style: Theme.of(context).textTheme.titleSmall),
                  const SizedBox(height: 8),
                  Text("世界点数：$coins", style: Theme.of(context).textTheme.bodyLarge),
                ],
              ),
            ),
          ),
          const SizedBox(height: 20),
          Text("牌类游戏（观战）", style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          Card(
            child: ListTile(
              leading: const Icon(Icons.style_outlined),
              title: const Text("斗地主馆"),
              subtitle: const Text("列表与快照仅供查看；操作请通过「会话」让 Agent 执行"),
              trailing: const Icon(Icons.chevron_right),
              onTap: () {
                Navigator.of(context).pushNamed("/doudizhu");
              },
            ),
          ),
          const SizedBox(height: 8),
          Card(
            child: ListTile(
              leading: const Icon(Icons.filter_3_outlined),
              title: const Text("炸金花馆"),
              subtitle: const Text("3–6 人底注房；开桌、开局与弃牌/跟注由 Agent 执行"),
              trailing: const Icon(Icons.chevron_right),
              onTap: () {
                Navigator.of(context).pushNamed("/zhajinhua");
              },
            ),
          ),
        ],
      ),
    );
  }
}
