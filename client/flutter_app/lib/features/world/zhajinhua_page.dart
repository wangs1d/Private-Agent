import "dart:async";

import "package:flutter/material.dart";

import "../../core/services/world_api_client.dart";
import "../../core/services/ws_chat_service.dart";

const String _kWsZjhLobbySnapshot = "world.zhajinhua.lobby_snapshot";
const String _kWsZjhTableSnapshot = "world.zhajinhua.snapshot";
const int _kZjhSeats = 6;

String kZhajinhuaCardLabel(String id) {
  final List<String> parts = id.split("-");
  final int r = int.tryParse(parts.isNotEmpty ? parts[0] : "") ?? 0;
  if (r >= 2 && r <= 10) return "$r";
  const Map<int, String> face = <int, String>{11: "J", 12: "Q", 13: "K", 14: "A"};
  return face[r] ?? id;
}

/// 炸金花馆：大厅与单桌观战；列表与桌态以 WebSocket 为主，HTTP 用于兜底。
class ZhaJinHuaPage extends StatefulWidget {
  const ZhaJinHuaPage({
    super.key,
    required this.sessionId,
    required this.api,
    required this.ws,
  });

  final String sessionId;
  final WorldApiClient api;
  final WsChatService ws;

  @override
  State<ZhaJinHuaPage> createState() => _ZhaJinHuaPageState();
}

class _ZhaJinHuaPageState extends State<ZhaJinHuaPage> {
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _tables = <Map<String, dynamic>>[];
  StreamSubscription<Map<String, dynamic>>? _lobbySub;

  @override
  void initState() {
    super.initState();
    widget.ws.sendEvent("world.zhajinhua.subscribe_lobby", <String, dynamic>{});
    _lobbySub = widget.ws.events.listen(_onLobbyWs);
    unawaited(_refresh());
  }

  @override
  void dispose() {
    widget.ws.sendEvent("world.zhajinhua.unsubscribe_lobby", <String, dynamic>{});
    _lobbySub?.cancel();
    super.dispose();
  }

  void _onLobbyWs(Map<String, dynamic> event) {
    final String type = event["type"]?.toString() ?? "";
    if (type == "ws_connected") {
      widget.ws.sendEvent("world.zhajinhua.subscribe_lobby", <String, dynamic>{});
      unawaited(_refresh());
      return;
    }
    if (type != _kWsZjhLobbySnapshot) return;
    final Object? payload = event["payload"];
    if (payload is! Map) return;
    final Map<String, dynamic> p = payload.cast<String, dynamic>();
    final List<dynamic>? raw = p["tables"] as List<dynamic>?;
    final List<Map<String, dynamic>> list = <Map<String, dynamic>>[
      for (final Object? x in raw ?? <dynamic>[]) if (x is Map) x.cast<String, dynamic>(),
    ];
    if (!mounted) return;
    setState(() {
      _tables = list;
      _loading = false;
      _error = null;
    });
  }

  /// 不传 sessionId，避免观战拉列表时把用户会话标成炸金花场景。
  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final Map<String, dynamic> r = await widget.api.zhajinhuaListTables();
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
        for (final Object? x in raw ?? <dynamic>[]) if (x is Map) x.cast<String, dynamic>(),
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

  void _openWatch(String tableId) {
    Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (BuildContext c) => ZhaJinHuaTablePage(
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
        title: const Text("炸金花馆"),
        actions: <Widget>[IconButton(onPressed: _refresh, icon: const Icon(Icons.refresh))],
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
                "暂无牌桌。\n入座、开局与操作由 Agent 执行；本页观战。列表由 WebSocket 实时更新。",
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
              title: Text("底注 $stake · $status"),
              subtitle: Text("选手 $pc/6 · 观战 $sc\n$id"),
              isThreeLine: true,
              trailing: const Icon(Icons.visibility_outlined),
              onTap: () => _openWatch(id),
            ),
          );
        },
      ),
    );
  }
}

/// 单桌观战：`world.zhajinhua.snapshot`；首帧可 HTTP 拉取 `/world/zhajinhua/table/:id`。
class ZhaJinHuaTablePage extends StatefulWidget {
  const ZhaJinHuaTablePage({
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
  State<ZhaJinHuaTablePage> createState() => _ZhaJinHuaTablePageState();
}

class _ZhaJinHuaTablePageState extends State<ZhaJinHuaTablePage> {
  Map<String, dynamic>? _snap;
  String? _syncError;
  StreamSubscription<Map<String, dynamic>>? _tableSub;

  @override
  void initState() {
    super.initState();
    widget.ws.sendEvent("world.zhajinhua.subscribe", <String, dynamic>{"tableId": widget.tableId});
    _tableSub = widget.ws.events.listen(_onTableWs);
    unawaited(_loadSnapshotOnce());
  }

  @override
  void dispose() {
    widget.ws.sendEvent("world.zhajinhua.unsubscribe", <String, dynamic>{"tableId": widget.tableId});
    _tableSub?.cancel();
    super.dispose();
  }

  void _onTableWs(Map<String, dynamic> event) {
    final String type = event["type"]?.toString() ?? "";
    if (type == "ws_connected") {
      widget.ws.sendEvent("world.zhajinhua.subscribe", <String, dynamic>{"tableId": widget.tableId});
      unawaited(_loadSnapshotOnce());
      return;
    }
    if (type != _kWsZjhTableSnapshot) return;
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
      final Map<String, dynamic> r = await widget.api.zhajinhuaSnapshot(widget.sessionId, widget.tableId);
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

  String _shortSession(String? s) {
    if (s == null || s.isEmpty) return "—";
    if (s.length <= 8) return s;
    return "${s.substring(0, 6)}…";
  }

  @override
  Widget build(BuildContext context) {
    final Map<String, dynamic>? s = _snap;
    final String role = s?["role"]?.toString() ?? "guest";
    final String status = s?["status"]?.toString() ?? "—";
    final int pot = (s?["pot"] as num?)?.round() ?? 0;
    final int? turn = (s?["turnSeat"] as num?)?.round();
    final List<dynamic>? seats = s?["seats"] as List<dynamic>?;
    final List<dynamic>? inHand = s?["inHand"] as List<dynamic>?;
    final List<dynamic>? handCounts = s?["handCardCounts"] as List<dynamic>?;
    final List<dynamic>? hands = s?["hands"] as List<dynamic>?;
    final List<dynamic>? winnerSeats = s?["winnerSeats"] as List<dynamic>?;

    return Scaffold(
      appBar: AppBar(
        title: Text("炸金花 ${widget.tableId}"),
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
                      "观战：公共快照（$role）。开局与弃牌/跟注仅由 Agent 经工具执行。",
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                if (_syncError != null)
                  Text("HTTP 兜底：$_syncError", style: TextStyle(color: Theme.of(context).colorScheme.error)),
                Text("状态：$status · 底池：$pot"),
                Text("当前回合座位：${turn != null && turn >= 0 ? turn + 1 : "—"}（1–6）"),
                const SizedBox(height: 8),
                Text("座位", style: Theme.of(context).textTheme.titleSmall),
                const SizedBox(height: 4),
                for (int i = 0; i < _kZjhSeats; i++)
                  _buildSeatLine(
                    context,
                    i,
                    seatSession: (seats != null && i < seats.length) ? seats[i]?.toString() : null,
                    status: status,
                    inHand: inHand,
                    handCounts: handCounts,
                    turn: turn,
                  ),
                if (status == "finished" && hands != null) ...<Widget>[
                  const SizedBox(height: 12),
                  Text("终局手牌", style: Theme.of(context).textTheme.titleSmall),
                  for (int i = 0; i < hands.length; i++)
                    if (hands[i] is List && (hands[i] as List<dynamic>).isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Text("座位 ${i + 1}：${(hands[i] as List<dynamic>).map((c) => kZhajinhuaCardLabel(c.toString())).join(" ")}"),
                      ),
                ],
                if (status == "finished" && s["payouts"] is Map) ...<Widget>[
                  const SizedBox(height: 8),
                  Text("结算：${s["payouts"]}"),
                ],
                if (status == "finished" && winnerSeats != null && winnerSeats.isNotEmpty)
                  Text(
                    "胜方座位：${winnerSeats.map((e) => (e is num) ? e + 1 : e).join(", ")}",
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
              ],
            ),
    );
  }

  Widget _buildSeatLine(
    BuildContext context,
    int seatIndex,
    {required String? seatSession,
    required String status,
    required List<dynamic>? inHand,
    required List<dynamic>? handCounts,
    required int? turn,
  }) {
    final bool occ = seatSession != null && seatSession.isNotEmpty;
    final bool stillIn = occ && inHand != null && seatIndex < inHand.length && inHand[seatIndex] == true;
    final int? n = (handCounts != null && seatIndex < handCounts.length)
        ? (handCounts[seatIndex] as num?)?.round()
        : null;
    String detail = "";
    if (!occ) {
      detail = "空位";
    } else if (status == "playing") {
      detail = stillIn ? "手牌 ${n ?? 3} 张" : "已弃牌";
    } else if (status == "waiting") {
      detail = "待开局";
    } else {
      detail = "";
    }
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: <Widget>[
          SizedBox(
            width: 72,
            child: Text("座位 ${seatIndex + 1}", style: Theme.of(context).textTheme.bodySmall),
          ),
          Expanded(
            child: Text(occ ? _shortSession(seatSession) : "—", style: Theme.of(context).textTheme.bodyMedium),
          ),
          Text(detail, style: Theme.of(context).textTheme.bodySmall),
          if (turn == seatIndex) const Chip(label: Text("行动")),
        ],
      ),
    );
  }
}
