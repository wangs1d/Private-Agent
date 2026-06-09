import "dart:async";

import "package:flutter/material.dart";

import "../../core/services/world_api_client.dart";
import "../../core/services/ws_chat_service.dart";
import "../../core/utils/gomoku_player_session.dart";

const String _kWsGomokuSnapshot = "world.gomoku.snapshot";
const String _kWsGomokuBanter = "world.gomoku.banter";
const int _kBoardSize = 15;

/// 用户与 Agent 五子棋对战（内嵌，非 Agent World 观战页）。
class GomokuPage extends StatefulWidget {
  const GomokuPage({
    super.key,
    required this.agentActorId,
    required this.api,
    required this.ws,
    required this.tableId,
  });

  /// Agent / 聊天绑定的 actorId（执黑）；人类选手使用独立的 [playerSessionId]。
  final String agentActorId;
  final WorldApiClient api;
  final WsChatService ws;
  final String tableId;

  String get playerSessionId => GomokuPlayerSession.humanId(agentActorId);

  @override
  State<GomokuPage> createState() => _GomokuPageState();
}

class _GomokuPageState extends State<GomokuPage> {
  Map<String, dynamic>? _snap;
  String? _error;
  bool _loading = true;
  bool _gameStarted = false; // 是否已点击开始
  final List<Map<String, dynamic>> _banterLines = <Map<String, dynamic>>[];
  StreamSubscription<Map<String, dynamic>>? _tableSub;
  Timer? _pollTimer;

  String get _playerId => widget.playerSessionId;

  @override
  void initState() {
    super.initState();
    widget.ws.sendEvent("world.gomoku.subscribe", <String, dynamic>{"tableId": widget.tableId});
    _tableSub = widget.ws.events.listen(_onTableWs);
    unawaited(_bootstrap());
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    widget.ws.sendEvent("world.gomoku.unsubscribe", <String, dynamic>{"tableId": widget.tableId});
    _tableSub?.cancel();
    super.dispose();
  }

  void _applySnapshot(Map<String, dynamic> snap) {
    setState(() {
      _snap = snap;
      _error = null;
      _loading = false;
      _mergeBanterFromSnapshot(snap);
    });
    _syncPollTimer(snap);
  }

  void _mergeBanterFromSnapshot(Map<String, dynamic> snap) {
    final Object? raw = snap["banter"];
    if (raw is! List) return;
    final Set<String> seen = _banterLines
        .map((Map<String, dynamic> b) => b["id"]?.toString() ?? "")
        .where((String id) => id.isNotEmpty)
        .toSet();
    for (final Object? item in raw) {
      if (item is! Map) continue;
      final Map<String, dynamic> line = item.cast<String, dynamic>();
      final String id = line["id"]?.toString() ?? "";
      if (id.isEmpty || seen.contains(id)) continue;
      seen.add(id);
      _banterLines.add(line);
    }
  }

  void _appendBanterLine(Map<String, dynamic> line) {
    final String id = line["id"]?.toString() ?? "";
    if (id.isNotEmpty && _banterLines.any((Map<String, dynamic> b) => b["id"] == id)) {
      return;
    }
    setState(() => _banterLines.add(line));
  }

  void _syncPollTimer(Map<String, dynamic>? snap) {
    final String status = snap?["status"]?.toString() ?? "";
    if (status == "playing") {
      _pollTimer ??= Timer.periodic(const Duration(milliseconds: 800), (_) => unawaited(_refreshSnapshot()));
    } else {
      _pollTimer?.cancel();
      _pollTimer = null;
    }
  }

  void _onTableWs(Map<String, dynamic> event) {
    final String type = event["type"]?.toString() ?? "";
    if (type == "ws_connected") {
      widget.ws.sendEvent("world.gomoku.subscribe", <String, dynamic>{"tableId": widget.tableId});
      unawaited(_refreshSnapshot());
      return;
    }
    if (type == _kWsGomokuBanter) {
      final Object? payload = event["payload"];
      if (payload is! Map) return;
      final Map<String, dynamic> p = payload.cast<String, dynamic>();
      if (p["tableId"]?.toString() != widget.tableId) return;
      final Object? line = p["line"];
      if (line is Map && mounted) {
        _appendBanterLine(line.cast<String, dynamic>());
      }
      return;
    }
    
    if (type == "world.gomoku.chat.message") {
      final Object? payload = event["payload"];
      if (payload is! Map) return;
      final Map<String, dynamic> p = payload.cast<String, dynamic>();
      if (p["tableId"]?.toString() != widget.tableId) return;
      return;
    }
    
    if (type != _kWsGomokuSnapshot) return;
    final Object? payload = event["payload"];
    if (payload is! Map) return;
    final Map<String, dynamic> p = payload.cast<String, dynamic>();
    if (p["tableId"]?.toString() != widget.tableId) return;
    final Object? snap = p["snapshot"];
    if (snap is! Map) return;
    if (!mounted) return;
    // 同一 WS 绑定 Agent actor，推送多为黑棋视角；人类白棋以 HTTP 轮询为准，此处仅作补充。
    final Map<String, dynamic> parsed = snap.cast<String, dynamic>();
    if (parsed["role"]?.toString() == "white") {
      _applySnapshot(parsed);
    }
  }

  Future<void> _refreshSnapshot() async {
    try {
      final Map<String, dynamic> r =
          await widget.api.gomokuSnapshot(_playerId, widget.tableId);
      if (!mounted || r["ok"] != true) return;
      final Map<String, dynamic>? snap = (r["snapshot"] as Map?)?.cast<String, dynamic>();
      if (snap != null) _applySnapshot(snap);
    } catch (_) {}
  }

  Future<void> _bootstrap() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      Map<String, dynamic>? snap = await _fetchSnapshot();
      if (!mounted) return;
      if (snap == null) return;

      final String role = snap["role"]?.toString() ?? "guest";
      final String status = snap["status"]?.toString() ?? "";

      if (role == "guest" && status == "waiting") {
        final Map<String, dynamic> join =
            await widget.api.gomokuJoin(_playerId, widget.tableId, "player");
        if (join["ok"] != true) {
          setState(() {
            _loading = false;
            _error = join["reason"]?.toString() ?? "加入对局失败";
          });
          return;
        }
        snap = await _fetchSnapshot();
      }

      if (snap != null) {
        _applySnapshot(snap);
      } else {
        setState(() => _loading = false);
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = e.toString();
      });
    }
  }

  Future<Map<String, dynamic>?> _fetchSnapshot() async {
    final Map<String, dynamic> r =
        await widget.api.gomokuSnapshot(_playerId, widget.tableId);
    if (r["ok"] != true) {
      setState(() {
        _loading = false;
        _error = r["reason"]?.toString() ?? "加载失败";
      });
      return null;
    }
    return (r["snapshot"] as Map?)?.cast<String, dynamic>();
  }

  Future<void> _play(int row, int col) async {
    try {
      final Map<String, dynamic> r = await widget.api.gomokuPlay(
        _playerId,
        widget.tableId,
        row,
        col,
      );
      if (!mounted) return;
      if (r["ok"] == true) {
        final Map<String, dynamic>? snap = (r["snapshot"] as Map?)?.cast<String, dynamic>();
        if (snap != null) _applySnapshot(snap);
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("落子失败：${r["reason"] ?? "未知错误"}")),
        );
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("落子失败：$e")),
      );
    }
  }

  Future<void> _leave() async {
    try {
      await widget.api.gomokuLeave(_playerId, widget.tableId);
    } catch (_) {}
    if (mounted) Navigator.of(context).pop();
  }

  String _stoneLabel(String color) => color == "black" ? "黑 ●" : "白 ○";

  String _statusHint(String status, String role, String? current) {
    if (status == "waiting") {
      if (role == "black" || role == "white") return "已加入，等待开局…";
      return "等待加入对局…";
    }
    if (status == "playing" && (role == "black" || role == "white")) {
      if (role == current) return "轮到你啦，点击棋盘落子";
      return "Agent 落子中…";
    }
    return "";
  }

  String? _resultLine(String? winner, String role) {
    if (winner == null || winner.isEmpty) return null;
    if (role == winner) return "你赢了！";
    if (role == "black" || role == "white") return "Agent 获胜";
    return null;
  }

  List<List<int>> _boardMatrix(Map<String, dynamic>? snap) {
    final List<dynamic>? raw = snap?["board"] as List<dynamic>?;
    if (raw != null && raw.length == _kBoardSize) {
      return List<List<int>>.generate(_kBoardSize, (int r) {
        final Object? row = raw[r];
        if (row is! List) return List<int>.filled(_kBoardSize, 0);
        return List<int>.generate(_kBoardSize, (int c) {
          if (c >= row.length) return 0;
          return (row[c] as num?)?.round() ?? 0;
        });
      });
    }
    return List<List<int>>.generate(
      _kBoardSize,
      (_) => List<int>.filled(_kBoardSize, 0),
    );
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(
        title: const Text("五子棋"),
        actions: <Widget>[
          IconButton(
            tooltip: "刷新",
            onPressed: () => unawaited(_refreshSnapshot()),
            icon: const Icon(Icons.refresh),
          ),
          IconButton(
            tooltip: "离开",
            onPressed: _leave,
            icon: const Icon(Icons.close),
          ),
        ],
      ),
      body: _buildBody(cs),
    );
  }

  /// 五子棋准备界面：显示「开始对弈」按钮
  Widget _buildPreparationRoom(ColorScheme cs) {
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              width: 140,
              height: 140,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: RadialGradient(colors: [
                  const Color(0xFF60A5FA).withValues(alpha: 0.3),
                  const Color(0xFF60A5FA).withValues(alpha: 0.1),
                  Colors.transparent,
                ]),
                border: Border.all(
                    color: const Color(0xFF60A5FA).withValues(alpha: 0.4), width: 2),
              ),
              child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(Icons.grid_on, size: 40, color: const Color(0xFF60A5FA)),
                    SizedBox(height: 8),
                    Text("五子棋",
                        style: TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.bold,
                            color: Colors.grey.shade700)),
                  ]),
            ),
            SizedBox(height: 32),
            Text("五子连珠",
                style: Theme.of(context)
                    .textTheme
                    .headlineSmall
                    ?.copyWith(fontWeight: FontWeight.bold)),
            SizedBox(height: 12),
            Text("经典策略对弈 · 你 vs AI Agent",
                style: TextStyle(fontSize: 14, color: Colors.grey.shade600)),
            SizedBox(height: 24),
            Container(
              padding: EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: Colors.white.withValues(alpha: 0.9),
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: Colors.grey.shade200),
              ),
              child: Column(children: [
                Icon(Icons.info_outline,
                    size: 20, color: const Color(0xFF60A5FA)),
                SizedBox(height: 12),
                Text("游戏规则",
                    style:
                        TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                SizedBox(height: 8),
                Text("目标：五子连成一线即获胜",
                    style:
                        TextStyle(fontSize: 13, color: Colors.grey.shade600)),
                Text("你执黑先手，AI 执白后手",
                    style:
                        TextStyle(fontSize: 13, color: Colors.grey.shade600)),
                Text("点击格子落子，不可悔棋",
                    style:
                        TextStyle(fontSize: 13, color: Colors.grey.shade600)),
                SizedBox(height: 16),
                FilledButton.icon(
                  onPressed: () => setState(() => _gameStarted = true),
                  icon: Icon(Icons.play_arrow, size: 18),
                  label: Text("开始对弈", style: TextStyle(fontSize: 15)),
                  style: FilledButton.styleFrom(
                    padding: EdgeInsets.symmetric(horizontal: 36, vertical: 12),
                    backgroundColor: const Color(0xFF60A5FA),
                  ),
                ),
              ]),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildBody(ColorScheme cs) {
    if (_loading && _snap == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null && _snap == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Text(_error!, textAlign: TextAlign.center),
              const SizedBox(height: 16),
              FilledButton(onPressed: _bootstrap, child: const Text("重试")),
            ],
          ),
        ),
      );
    }

    // 未点击开始时显示准备界面
    if (!_gameStarted && _snap != null) {
      return _buildPreparationRoom(cs);
    }

    final Map<String, dynamic>? s = _snap;
    final String status = s?["status"]?.toString() ?? "—";
    final String role = s?["role"]?.toString() ?? "guest";
    final String? current = s?["currentPlayer"]?.toString();
    final String? winner = s?["winner"]?.toString();
    final String humanColor = s?["humanColor"]?.toString() ?? role;
    final List<List<int>> board = _boardMatrix(s);
    final bool canPlay =
        status == "playing" && role == current && (role == "black" || role == "white");
    final String hint = _statusHint(status, role, current);
    final String? resultLine = _resultLine(winner, role);
    final String boardCaption =
        "你执${_stoneLabel(humanColor)} · Agent 执${_stoneLabel(s?["agentColor"]?.toString() ?? (humanColor == "black" ? "white" : "black"))}";

    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final double maxW = constraints.maxWidth;
        final double cellSize = ((maxW - 56) / 14).clamp(24.0, 34.0);

        return ListView(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          children: <Widget>[
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text(_error!, style: TextStyle(color: cs.error)),
              ),
            if (hint.isNotEmpty || resultLine != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    if (hint.isNotEmpty)
                      Text(
                        hint,
                        style: Theme.of(context).textTheme.titleSmall?.copyWith(
                              color: cs.primary,
                              fontWeight: FontWeight.w600,
                            ),
                      ),
                    if (resultLine != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Text(
                          resultLine,
                          style: TextStyle(
                            color: resultLine.startsWith("你") ? cs.primary : cs.error,
                            fontWeight: FontWeight.bold,
                            fontSize: 16,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            if (_banterLines.isNotEmpty) ...<Widget>[
              _AgentBanterLine(lines: _banterLines),
              const SizedBox(height: 12),
            ],
            Center(
              child: _GomokuBoard(
                board: board,
                cellSize: cellSize,
                canPlay: canPlay,
                caption: boardCaption,
                onCellTap: _play,
              ),
            ),
            const SizedBox(height: 16),
          ],
        );
      },
    );
  }
}

/// 仅在有旁白内容时展示最新一句（无标题、无占位文案）。
class _AgentBanterLine extends StatelessWidget {
  const _AgentBanterLine({required this.lines});

  final List<Map<String, dynamic>> lines;

  @override
  Widget build(BuildContext context) {
    final String text = lines.last["text"]?.toString() ?? "";
    if (text.isEmpty) return const SizedBox.shrink();

    final ColorScheme cs = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: Theme.of(context).textTheme.bodyLarge?.copyWith(
              height: 1.4,
              color: cs.onSurface.withValues(alpha: 0.92),
            ),
      ),
    );
  }
}

class _GomokuBoard extends StatelessWidget {
  const _GomokuBoard({
    required this.board,
    required this.cellSize,
    required this.canPlay,
    required this.caption,
    required this.onCellTap,
  });

  final List<List<int>> board;
  final double cellSize;
  final bool canPlay;
  final String caption;
  final void Function(int row, int col) onCellTap;

  static const double _padding = 18;

  @override
  Widget build(BuildContext context) {
    const Color boardColor = Color(0xFFDEB887);
    const Color lineColor = Color(0xFF5C4033);
    final double inner = cellSize * (_kBoardSize - 1);
    final double total = inner + _padding * 2;

    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: boardColor,
        borderRadius: BorderRadius.circular(12),
        boxShadow: <BoxShadow>[
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.25),
            blurRadius: 8,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Column(
        children: <Widget>[
          SizedBox(
            width: total,
            height: total,
            child: Stack(
              clipBehavior: Clip.none,
              children: <Widget>[
                CustomPaint(
                  size: Size(total, total),
                  painter: _GomokuGridPainter(
                    cellSize: cellSize,
                    padding: _padding,
                    lineColor: lineColor,
                  ),
                ),
                for (int r = 0; r < _kBoardSize; r++)
                  for (int c = 0; c < _kBoardSize; c++)
                    Positioned(
                      left: _padding + c * cellSize - cellSize / 2,
                      top: _padding + r * cellSize - cellSize / 2,
                      width: cellSize,
                      height: cellSize,
                      child: _GomokuStone(
                        value: board[r][c],
                        enabled: canPlay && board[r][c] == 0,
                        onTap: () => onCellTap(r, c),
                      ),
                    ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          Text(caption, style: Theme.of(context).textTheme.labelMedium),
        ],
      ),
    );
  }
}

class _GomokuGridPainter extends CustomPainter {
  _GomokuGridPainter({
    required this.cellSize,
    required this.padding,
    required this.lineColor,
  });

  final double cellSize;
  final double padding;
  final Color lineColor;

  @override
  void paint(Canvas canvas, Size size) {
    final Paint paint = Paint()
      ..color = lineColor
      ..strokeWidth = 1.2
      ..style = PaintingStyle.stroke;

    for (int i = 0; i < _kBoardSize; i++) {
      final double x = padding + i * cellSize;
      final double y = padding + i * cellSize;
      canvas.drawLine(Offset(padding, y), Offset(padding + cellSize * (_kBoardSize - 1), y), paint);
      canvas.drawLine(Offset(x, padding), Offset(x, padding + cellSize * (_kBoardSize - 1)), paint);
    }

    // 星位
    const List<int> stars = <int>[3, 7, 11];
    final Paint star = Paint()..color = lineColor;
    for (final int r in stars) {
      for (final int c in stars) {
        canvas.drawCircle(
          Offset(padding + c * cellSize, padding + r * cellSize),
          3,
          star,
        );
      }
    }
  }

  @override
  bool shouldRepaint(covariant _GomokuGridPainter oldDelegate) => false;
}

class _GomokuStone extends StatelessWidget {
  const _GomokuStone({
    required this.value,
    required this.enabled,
    required this.onTap,
  });

  final int value;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    Widget? stone;
    if (value == 1) {
      stone = Container(
        decoration: const BoxDecoration(
          shape: BoxShape.circle,
          gradient: RadialGradient(
            colors: <Color>[Color(0xFF444444), Colors.black],
          ),
        ),
      );
    } else if (value == 2) {
      stone = Container(
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          gradient: const RadialGradient(
            colors: <Color>[Colors.white, Color(0xFFE0E0E0)],
          ),
          border: Border.all(color: Colors.black26),
        ),
      );
    }

    return Material(
      color: Colors.transparent,
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: enabled ? onTap : null,
        child: Padding(
          padding: const EdgeInsets.all(3),
          child: stone ?? (enabled ? Icon(Icons.add, size: 14, color: Colors.brown.shade300) : null),
        ),
      ),
    );
  }
}
