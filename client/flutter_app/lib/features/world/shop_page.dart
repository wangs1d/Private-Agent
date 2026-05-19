import "package:flutter/material.dart";

import "../../core/services/world_api_client.dart";

/// 技能目录（观战）：仅展示上架与价格；购买由 Agent 通过工具完成。
class ShopPage extends StatefulWidget {
  const ShopPage({
    super.key,
    required this.sessionId,
    required this.api,
  });

  final String sessionId;
  final WorldApiClient api;

  @override
  State<ShopPage> createState() => _ShopPageState();
}

class _ShopPageState extends State<ShopPage> {
  bool _loading = true;
  String? _error;
  Map<String, dynamic>? _state;
  List<Map<String, dynamic>> _shopItems = <Map<String, dynamic>>[];

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
      final Map<String, dynamic> sh = await widget.api.getShopCatalog(widget.sessionId);
      if (!mounted) return;
      if (st["ok"] != true) {
        setState(() {
          _loading = false;
          _error = st.toString();
        });
        return;
      }
      final List<dynamic>? raw = sh["items"] as List<dynamic>?;
      setState(() {
        _state = st["state"] as Map<String, dynamic>?;
        _shopItems = raw == null
            ? <Map<String, dynamic>>[]
            : raw.map((e) => Map<String, dynamic>.from(e as Map)).toList();
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
    final int coins = (_state?["agentWorldCredits"] as num?)?.round() ??
        (_state?["worldCoins"] as num?)?.round() ??
        0;

    return Scaffold(
      appBar: AppBar(
        title: const Text("技能目录"),
        actions: <Widget>[
          Center(
            child: Padding(
              padding: const EdgeInsets.only(right: 16),
              child: Text("世界点数 $coins", style: Theme.of(context).textTheme.bodyMedium),
            ),
          ),
        ],
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
              Text("无法加载技能目录：$_error", textAlign: TextAlign.center),
              const SizedBox(height: 16),
              FilledButton(onPressed: null, child: const Text("重试")),
            ],
          ),
        ),
      );
    }

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
                "观战模式：解锁技能与扣点由 Agent 在对话中通过工具完成，此处仅同步展示目录与是否已拥有。",
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
          ),
          const SizedBox(height: 12),
          if (_shopItems.isEmpty)
            const Card(
              child: Padding(
                padding: EdgeInsets.all(16),
                child: Text("暂无技能上架（服务端尚未注册 Skill 时列表为空）"),
              ),
            )
          else
            ..._shopItems.map((Map<String, dynamic> item) {
              final String skillId = item["skillId"]?.toString() ?? "";
              final String name = item["displayName"]?.toString() ?? skillId;
              final String desc = item["description"]?.toString() ?? "";
              final int price = (item["price"] as num?)?.round() ?? 0;
              final bool owned = item["owned"] == true;
              return Card(
                key: ValueKey<String>(skillId),
                child: ListTile(
                  title: Text(name),
                  subtitle: Text(desc.isEmpty ? "—" : desc),
                  trailing: owned
                      ? const Chip(label: Text("已拥有"))
                      : Chip(
                          avatar: const Icon(Icons.visibility_outlined, size: 18),
                          label: Text("$price 点"),
                        ),
                ),
              );
            }),
        ],
      ),
    );
  }
}
