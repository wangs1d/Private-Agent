import "dart:async";

import "package:flutter/material.dart";

import "../../core/services/world_api_client.dart";
import "../../core/services/ws_chat_service.dart";

const String _kWsDoudizhuLobbySnapshot = "world.doudizhu.lobby_snapshot";
const String _kWsDoudizhuTableSnapshot = "world.doudizhu.snapshot";

String kDoudizhuCardLabel(String id) {
  final List<String> parts = id.split("-");
  final int r = int.tryParse(parts.isNotEmpty ? parts[0] : "") ?? 0;
  if (r == 16) return "小王";
  if (r == 17) return "大王";
  if (r >= 3 && r <= 10) return "$r";
  const Map<int, String> face = <int, String>{11: "J", 12: "Q", 13: "K", 14: "A", 15: "2"};
  return face[r] ?? id;
}

String _describeLastPlay(Object? raw) {
  if (raw == null) return "—（新一轮由地主先出）";
  if (raw is! Map) return raw.toString();
  final Map<String, dynamic> m = raw.cast<String, dynamic>();
  final String kind = m["kind"]?.toString() ?? "";
  final Object? cards = m["cards"];
  if (cards is! List) return kind;
  final List<String> labels = <String>[
    for (final Object? c in cards) kDoudizhuCardLabel(c?.toString() ?? ""),
  ];
  return "$kind：${labels.join(" ")}";
}

/// 斗地主馆：大厅与牌桌以 WebSocket 推送为主；下拉仍可用 HTTP 刷新列表（不传 sessionId 时不改场景）。
class DoudizhuPage extends StatefulWidget {
  const DoudizhuPage({
    super.key,
    required this.sessionId,
    required this.api,
    required this.ws,
  });

  final String sessionId;
  final WorldApiClient api;
  final WsChatService ws;

  @override
  State<DoudizhuPage> createState() => _DoudizhuPageState();
}

class _DoudizhuPageState extends State<DoudizhuPage> {
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _tables = <Map<String, dynamic>>[];
  StreamSubscription<Map<String, dynamic>>? _lobbySub;

  @override
  void initState() {
    super.initState();
    widget.ws.sendEvent("world.doudizhu.subscribe_lobby", <String, dynamic>{});
    _lobbySub = widget.ws.events.listen(_onLobbyWs);
    _refresh();
  }

  @override
  void dispose() {
    widget.ws.sendEvent("world.doudizhu.unsubscribe_lobby", <String, dynamic>{});
    _lobbySub?.cancel();
    super.dispose();
  }

  void _onLobbyWs(Map<String, dynamic> event) {
    final String type = event["type"]?.toString() ?? "";
    if (type == "ws_connected") {
      widget.ws.sendEvent("world.doudizhu.subscribe_lobby", <String, dynamic>{});
      unawaited(_refresh());
      return;
    }
    if (type != _kWsDoudizhuLobbySnapshot) return;
    final Object? payload = event["payload"];
    if (payload is! Map) return;
    final Map<String, dynamic> p = payload.cast<String, dynamic>();
    final List<dynamic>? raw = p["tables"] as List<dynamic>?;
    final List<Map<String, dynamic>> list = <Map<String, dynamic>>[
      for (final Object? x in raw ?? <dynamic>[])
        if (x is Map) x.cast<String, dynamic>(),
    ];
    if (!mounted) return;
    setState(() {
      _tables = list;
      _loading = false;
      _error = null;
    });
  }

  /// 不传 sessionId，避免 HTTP 将用户会话标记为进入斗地主场景（观战与 Agent 场景分离）。
  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final Map<String, dynamic> r = await widget.api.doudizhuListTables();
      if (!mounted) return;
      if (r["ok"] != true) {
        setState(() {
          _loading = false;
          _error = r.toString();
        });
        return;
      }
      final List<dynamic>? raw = r["tables"] as List<dynamic>?;
      final List<Map<String, dynamic>> list = <Map<String, dynamic>>[
        for (final Object? x in raw ?? <dynamic>[])
          if (x is Map) x.cast<String, dynamic>(),
      ];
      setState(() {
        _tables = list;
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

  void _openWatchOnly(String tableId) {
    Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (BuildContext c) => DoudizhuTablePage(
          sessionId: widget.sessionId,
          api: widget.api,
          ws: widget.ws,
          tableId: tableId,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text("斗地主馆"),
        actions: <Widget>[
          IconButton(onPressed: _refresh, icon: const Icon(Icons.refresh)),
        ],
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
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
              Text("加载失败：$_error", textAlign: TextAlign.center),
              const SizedBox(height: 16),
              FilledButton(onPressed: null, child: const Text("重试")),
            ],
          ),
        ),
      );
    }
    if (_tables.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              Text(
                "暂无牌桌。\n出牌与桌内操作均由 Agent 执行；你可在「会话」里向 Agent 提建议。本页仅观战（列表 WebSocket 实时更新）。",
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyMedium,
              ),
              const SizedBox(height: 16),
              OutlinedButton(onPressed: _refresh, child: const Text("刷新")),
            ],
          ),
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: _tables.length,
        itemBuilder: (BuildContext c, int i) {
          final Map<String, dynamic> t = _tables[i];
          final String id = t["tableId"]?.toString() ?? "";
          final int stake = (t["stake"] as num?)?.round() ?? 0;
          final String status = t["status"]?.toString() ?? "";
          final int pc = (t["playerCount"] as num?)?.round() ?? 0;
          final int sc = (t["spectatorCount"] as num?)?.round() ?? 0;
          return Card(
            child: ListTile(
              title: Text("赌注 $stake · $status"),
              subtitle: Text("选手 $pc/3 · 观战 $sc\n$id"),
              isThreeLine: true,
              trailing: const Icon(Icons.visibility_outlined),
              onTap: () => _openWatchOnly(id),
            ),
          );
        },
      ),
    );
  }
}

/// 牌桌观战：WebSocket `world.doudizhu.snapshot` 推送；首帧可 HTTP 拉一次快照兜底。
class DoudizhuTablePage extends StatefulWidget {
  const DoudizhuTablePage({
    super.key,
    required this.sessionId,
    required this.api,
    required this.ws,
    required this.tableId,
  });

  final String sessionId;
  final WorldApiClient api;
  final WsChatService ws;
  final String tableId;

  @override
  State<DoudizhuTablePage> createState() => _DoudizhuTablePageState();
}

class _DoudizhuTablePageState extends State<DoudizhuTablePage> {
  Map<String, dynamic>? _snap;
  String? _syncError;
  StreamSubscription<Map<String, dynamic>>? _tableSub;

  @override
  void initState() {
    super.initState();
    widget.ws.sendEvent("world.doudizhu.subscribe", <String, dynamic>{"tableId": widget.tableId});
    _tableSub = widget.ws.events.listen(_onTableWs);
    unawaited(_loadSnapshotOnce());
  }

  @override
  void dispose() {
    widget.ws.sendEvent("world.doudizhu.unsubscribe", <String, dynamic>{"tableId": widget.tableId});
    _tableSub?.cancel();
    super.dispose();
  }

  void _onTableWs(Map<String, dynamic> event) {
    final String type = event["type"]?.toString() ?? "";
    if (type == "ws_connected") {
      widget.ws.sendEvent("world.doudizhu.subscribe", <String, dynamic>{"tableId": widget.tableId});
      unawaited(_loadSnapshotOnce());
      return;
    }
    if (type != _kWsDoudizhuTableSnapshot) return;
    final Object? payload = event["payload"];
    if (payload is! Map) return;
    final Map<String, dynamic> p = payload.cast<String, dynamic>();
    if (p["tableId"]?.toString() != widget.tableId) return;
    final Object? snap = p["snapshot"];
    if (snap is! Map) return;
    if (!mounted) return;
    setState(() {
      _snap = snap.cast<String, dynamic>();
      _syncError = null;
    });
  }

  Future<void> _loadSnapshotOnce() async {
    try {
      final Map<String, dynamic> r = await widget.api.doudizhuSnapshot(widget.sessionId, widget.tableId);
      if (!mounted) return;
      if (r["ok"] == true && _snap == null) {
        setState(() {
          _snap = r["snapshot"] as Map<String, dynamic>?;
          _syncError = null;
        });
      }
    } catch (e) {
      if (!mounted) return;
      if (_snap == null) setState(() => _syncError = e.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    final Map<String, dynamic>? s = _snap;
    final String role = s?["role"]?.toString() ?? "guest";
    final String status = s?["status"]?.toString() ?? "—";
    final int pot = (s?["pot"] as num?)?.round() ?? 0;
    final int? turn = (s?["turnSeat"] as num?)?.round();
    final int? landlord = (s?["landlordSeat"] as num?)?.round();
    final List<dynamic>? counts = s?["handCounts"] as List<dynamic>?;
    final bool finished = s?["finished"] == true;
    final int? winnerSeat = (s?["winnerSeat"] as num?)?.round();

    return Scaffold(
      appBar: AppBar(
        title: Text("牌桌 ${widget.tableId}"),
        actions: <Widget>[
          IconButton(
            onPressed: () {
              Navigator.of(context).pop();
            },
            icon: const Icon(Icons.close),
          ),
        ],
      ),
      body: s == null
          ? Center(child: Text(_syncError ?? "加载中…（WebSocket 快照）"))
          : ListView(
              padding: const EdgeInsets.all(16),
              children: <Widget>[
                Card(
                  color: Theme.of(context).colorScheme.surfaceContainerHighest,
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Text(
                      "观战模式：公共快照（身份：$role）。出牌等操作仅由 Agent 通过工具执行；请到「会话」向 Agent 提建议。",
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                if (_syncError != null)
                  Text("HTTP 兜底：$_syncError", style: TextStyle(color: Theme.of(context).colorScheme.error)),
                Text("状态：$status · 底池：$pot"),
                Text("地主座位：${landlord != null ? "${landlord + 1}" : "—"} · 当前回合：${turn != null ? "${turn + 1}" : "—"}"),
                if (counts != null && counts.length == 3)
                  Text(
                    "手牌张数：${counts[0]} / ${counts[1]} / ${counts[2]}（座位 1–3）",
                  ),
                const SizedBox(height: 8),
                Text("上一手：${_describeLastPlay(s["lastNonPass"])}"),
                if (finished) ...<Widget>[
                  const SizedBox(height: 12),
                  Text(
                    "本局结束：${s["winnerSide"] ?? "—"} 胜 · 赢家座位：${winnerSeat != null ? winnerSeat + 1 : "—"}",
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  if (s["payouts"] is Map) Text("结算：${s["payouts"]}"),
                ],
              ],
            ),
    );
  }
}
