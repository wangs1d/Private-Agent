import "dart:async";
import "dart:math";

import "package:flutter/material.dart";

import "../../core/services/world_api_client.dart";
import "../../core/utils/gomoku_player_session.dart";
import "../chat/widgets/game_chat_widget.dart";
import "../world/doudizhu_page.dart" show kDoudizhuCardLabel;

const Duration _dealDuration = Duration(milliseconds: 420);

class _DealtCard extends StatelessWidget {
  const _DealtCard({
    required this.child,
    required this.index,
    this.stableKey,
    this.from = const Offset(0, -0.35),
    this.angle = 0,
    this.lift = 0,
  });

  final Widget child;
  final int index;
  final Object? stableKey;
  final Offset from;
  final double angle;
  final double lift;

  @override
  Widget build(BuildContext context) {
    final int durationMs =
        _dealDuration.inMilliseconds + (index.clamp(0, 10) * 32);
    return TweenAnimationBuilder<double>(
      key: ValueKey<Object>("deal-$index-${stableKey ?? child.hashCode}"),
      tween: Tween<double>(begin: 0, end: 1),
      duration: Duration(milliseconds: durationMs),
      curve: Curves.easeOutCubic,
      builder: (BuildContext context, double t, Widget? animatedChild) {
        final double dy = (1 - t) * from.dy * 180 - lift;
        final double dx = (1 - t) * from.dx * 180;
        return Opacity(
          opacity: t.clamp(0, 1),
          child: Transform.translate(
            offset: Offset(dx, dy),
            child: Transform.rotate(
              angle: angle * t,
              child: Transform.scale(
                scale: 0.82 + (0.18 * t),
                child: animatedChild,
              ),
            ),
          ),
        );
      },
      child: child,
    );
  }
}

/// 炸金花 — 用户 vs 主 Agent + 子 Agent 补位。
class ZhajinhuaPlayPage extends StatefulWidget {
  const ZhajinhuaPlayPage({
    super.key,
    required this.api,
    required this.agentId,
    required this.tableId,
    required this.initialSnapshot,
  });

  final WorldApiClient api;
  final String agentId;
  final String tableId;
  final Map<String, dynamic> initialSnapshot;

  @override
  State<ZhajinhuaPlayPage> createState() => _ZhajinhuaPlayPageState();
}

class _ZhajinhuaPlayPageState extends State<ZhajinhuaPlayPage> {
  late Map<String, dynamic> _snap;
  Timer? _poll;
  bool _busy = false;
  String get _humanId => GomokuPlayerSession.humanId(widget.agentId);
  final List<GameChatMessage> _chatMessages = <GameChatMessage>[];

  @override
  void initState() {
    super.initState();
    _snap = widget.initialSnapshot;
    _poll = Timer.periodic(const Duration(seconds: 2), (_) => _refresh());
    _addWelcomeMessage();
  }

  void _addWelcomeMessage() {
    setState(() {
      _chatMessages.add(GameChatMessage(
        id: DateTime.now().millisecondsSinceEpoch.toString(),
        text: "欢迎来到炸金花！祝你手气爆棚！🎴",
        isUser: false,
        timestamp: DateTime.now(),
      ));
    });
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _refresh() async {
    if (_busy) return;
    try {
      final Map<String, dynamic> r = await widget.api
          .gameCenterZhajinhuaSnapshot(widget.tableId, _humanId);
      if (!mounted || r["ok"] != true) return;
      setState(() => _snap = (r["snapshot"] as Map<String, dynamic>?) ?? _snap);
    } catch (_) {}
  }

  Future<void> _act(String action) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final Map<String, dynamic> r = await widget.api.gameCenterZhajinhuaAct(
        widget.tableId,
        _humanId,
        action,
      );
      if (!mounted) return;
      if (r["ok"] == true) {
        setState(
            () => _snap = (r["snapshot"] as Map<String, dynamic>?) ?? _snap);
        _addGameActionMessage(action);
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(r["reason"]?.toString() ?? "操作失败")),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _addGameActionMessage(String action) {
    String message = "";
    switch (action) {
      case "stay":
        message = "你选择了跟注/比牌！";
        break;
      case "fold":
        message = "你选择了弃牌。";
        break;
      default:
        return;
    }
    setState(() {
      _chatMessages.add(GameChatMessage(
        id: DateTime.now().millisecondsSinceEpoch.toString(),
        text: message,
        isUser: true,
        timestamp: DateTime.now(),
      ));
    });
  }

  void _sendMessage(String message) {
    if (message.trim().isEmpty) return;

    setState(() {
      _chatMessages.add(GameChatMessage(
        id: DateTime.now().millisecondsSinceEpoch.toString(),
        text: message,
        isUser: true,
        timestamp: DateTime.now(),
      ));
    });
  }

  @override
  Widget build(BuildContext context) {
    final String status = _snap["status"]?.toString() ?? "";
    final bool myTurn = _snap["pendingForMe"] == true;
    final List<dynamic>? myHand = _snap["myHand"] as List<dynamic>?;
    final int pot = (_snap["pot"] as num?)?.round() ?? 0;
    final List<dynamic>? seats = _snap["seats"] as List<dynamic>?;
    final List<dynamic>? inHand = _snap["inHand"] as List<dynamic>?;
    final int? turnSeat = (_snap["turnSeat"] as num?)?.round();
    final int playerCount = seats?.length ?? 0;

    return Scaffold(
      appBar: AppBar(title: const Text("炸金花 · 游戏")),
      body: Stack(
        children: [
          Container(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: [
                  const Color(0xFF1B5E20).withOpacity(0.1),
                  const Color(0xFF2E7D32).withOpacity(0.05)
                ],
              ),
            ),
            child: status == "waiting" || status == ""
                ? _buildPreparationRoom(seats)
                : playerCount > 0
                    ? _buildRoundTableLayout(
                        status, pot, seats, inHand, turnSeat, myHand, myTurn)
                    : _buildWaitingRoom(),
          ),
          GameChatWidget(
            messages: _chatMessages,
            onSendMessage: _sendMessage,
            placeholder: "聊聊这把牌...",
            title: "炸金花对局",
          ),
        ],
      ),
    );
  }

  Widget _buildPreparationRoom(List<dynamic>? seats) {
    final int readyCount =
        seats?.where((s) => s != null && s.toString().isNotEmpty).length ?? 0;
    final bool isReady = seats?.any((s) => s.toString() == _humanId) ?? false;

    return Center(
      child: SingleChildScrollView(
        padding: EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              width: 140,
              height: 140,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: RadialGradient(colors: [
                  const Color(0xFFFBBF24).withOpacity(0.3),
                  const Color(0xFFFBBF24).withOpacity(0.1),
                  Colors.transparent,
                ]),
                border: Border.all(
                    color: const Color(0xFFFBBF24).withOpacity(0.4), width: 2),
              ),
              child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(Icons.casino,
                        size: 40, color: const Color(0xFFFBBF24)),
                    SizedBox(height: 8),
                    Text("炸金花",
                        style: TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.bold,
                            color: Colors.grey.shade700)),
                  ]),
            ),
            SizedBox(height: 32),
            Text("🎴 游戏房间",
                style: Theme.of(context)
                    .textTheme
                    .headlineSmall
                    ?.copyWith(fontWeight: FontWeight.bold)),
            SizedBox(height: 12),
            Text("等待所有玩家准备后开始游戏",
                style: TextStyle(fontSize: 14, color: Colors.grey.shade600)),
            SizedBox(height: 24),
            Container(
              padding: EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: Colors.white.withOpacity(0.9),
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: Colors.grey.shade200),
              ),
              child: Column(children: [
                Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                  Icon(Icons.people, size: 18, color: const Color(0xFFFBBF24)),
                  SizedBox(width: 8),
                  Text("已准备：$readyCount / 3",
                      style:
                          TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                ]),
                SizedBox(height: 16),
                if (!isReady)
                  FilledButton.icon(
                    onPressed: _busy ? null : () => _startGame(),
                    icon: Icon(Icons.check_circle, size: 18),
                    label: Text("准备", style: TextStyle(fontSize: 15)),
                    style: FilledButton.styleFrom(
                      padding:
                          EdgeInsets.symmetric(horizontal: 32, vertical: 12),
                      backgroundColor: const Color(0xFFFBBF24),
                    ),
                  )
                else
                  Container(
                    padding: EdgeInsets.symmetric(horizontal: 24, vertical: 10),
                    decoration: BoxDecoration(
                      color: const Color(0xFF34D399).withOpacity(0.1),
                      borderRadius: BorderRadius.circular(20),
                      border: Border.all(color: const Color(0xFF34D399)),
                    ),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      Icon(Icons.check,
                          size: 16, color: const Color(0xFF34D399)),
                      SizedBox(width: 6),
                      Text("已准备 ✓",
                          style: TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.w600,
                              color: const Color(0xFF34D399))),
                    ]),
                  ),
              ]),
            ),
            SizedBox(height: 16),
            if (readyCount < 3)
              Text("还需 ${3 - readyCount} 位玩家准备...",
                  style: TextStyle(fontSize: 13, color: Colors.grey.shade500))
            else
              SizedBox(
                width: 28,
                height: 28,
                child: CircularProgressIndicator(
                    strokeWidth: 2.5, color: const Color(0xFFFBBF24)),
              ),
          ],
        ),
      ),
    );
  }

  Future<void> _startGame() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final Map<String, dynamic> r = await widget.api
          .gameCenterZhajinhuaAct(widget.tableId, _humanId, "ready");
      if (!mounted) return;
      if (r["ok"] == true) {
        setState(
            () => _snap = (r["snapshot"] as Map<String, dynamic>?) ?? _snap);
        _addGameActionMessage("ready");
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(r["reason"]?.toString() ?? "准备失败")));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _buildRoundTableLayout(
    String status,
    int pot,
    List<dynamic>? seats,
    List<dynamic>? inHand,
    int? turnSeat,
    List<dynamic>? myHand,
    bool myTurn,
  ) {
    return Center(
      child: SizedBox(
        width: double.infinity,
        height: double.infinity,
        child: Stack(
          alignment: Alignment.center,
          children: [
            _buildCenterPotArea(pot, status),
            if (seats != null)
              for (int i = 0; i < seats.length; i++)
                _buildPlayerPosition(i, seats, inHand, turnSeat),
            if (status == "playing" && myTurn)
              Positioned(
                bottom: 20,
                left: 0,
                right: 0,
                child: _buildActionButtons(),
              )
            else if (status == "finished")
              Positioned(
                bottom: 20,
                left: 0,
                right: 0,
                child: _buildGameOver(),
              ),
            if (myHand != null && status == "playing")
              Positioned(
                bottom: myTurn ? 120 : 20,
                left: 0,
                right: 0,
                child: _buildMyCardsArea(myHand),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildCenterPotArea(int pot, String status) {
    return Container(
      width: 160,
      height: 160,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: RadialGradient(
          colors: [
            const Color(0xFFFBBF24).withOpacity(0.3),
            const Color(0xFFFBBF24).withOpacity(0.1),
            Colors.transparent,
          ],
        ),
        border: Border.all(
          color: const Color(0xFFFBBF24).withOpacity(0.4),
          width: 2,
        ),
        boxShadow: [
          BoxShadow(
            color: const Color(0xFFFBBF24).withOpacity(0.2),
            blurRadius: 20,
            spreadRadius: 5,
          ),
        ],
      ),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.monetization_on, size: 36, color: const Color(0xFFFBBF24)),
          const SizedBox(height: 8),
          Text(
            "$pot",
            style: TextStyle(
              fontSize: 28,
              fontWeight: FontWeight.bold,
              color: const Color(0xFFFBBF24),
            ),
          ),
          Text(
            "底池",
            style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
          ),
          const SizedBox(height: 4),
          Container(
            padding: EdgeInsets.symmetric(horizontal: 8, vertical: 2),
            decoration: BoxDecoration(
              color: status == "playing"
                  ? const Color(0xFF34D399).withOpacity(0.2)
                  : const Color(0xFF60A5FA).withOpacity(0.2),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Text(
              status == "playing" ? "进行中" : status,
              style: TextStyle(
                fontSize: 11,
                color: status == "playing"
                    ? const Color(0xFF34D399)
                    : const Color(0xFF60A5FA),
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildPlayerPosition(
    int seatIndex,
    List<dynamic> seats,
    List<dynamic>? inHand,
    int? turnSeat,
  ) {
    final int totalPlayers = seats.length;
    final double angle = (2 * 3.141592653589793 * seatIndex) / totalPlayers -
        (3.141592653589793 / 2);
    final double radius = MediaQuery.of(context).size.shortestSide * 0.35;
    final double x = radius * cos(angle);
    final double y = radius * sin(angle);

    final String? sessionId = seats[seatIndex]?.toString();
    final bool isOccupied = sessionId != null && sessionId.isNotEmpty;
    final bool stillIn = isOccupied &&
        inHand != null &&
        seatIndex < inHand.length &&
        inHand[seatIndex] == true;
    final bool isMyTurn = turnSeat == seatIndex;
    final bool isMe = sessionId == _humanId;

    return Positioned(
      left: MediaQuery.of(context).size.width / 2 + x - 50,
      top: MediaQuery.of(context).size.height / 2 + y - 60,
      child: AnimatedContainer(
        duration: Duration(milliseconds: 300),
        transform: Matrix4.translationValues(0, isMyTurn ? -10 : 0, 0),
        child: _buildPlayerCard(
            seatIndex, isOccupied, stillIn, isMyTurn, isMe, sessionId),
      ),
    );
  }

  Widget _buildPlayerCard(
    int seatIndex,
    bool isOccupied,
    bool stillIn,
    bool isMyTurn,
    bool isMe,
    String? sessionId,
  ) {
    return Container(
      width: 100,
      height: 120,
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: isMyTurn
              ? [
                  const Color(0xFFFBBF24).withOpacity(0.3),
                  const Color(0xFFFBBF24).withOpacity(0.1)
                ]
              : isOccupied
                  ? [Colors.white.withOpacity(0.95), Colors.grey.shade50]
                  : [Colors.grey.shade200, Colors.grey.shade300],
        ),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: isMyTurn
              ? const Color(0xFFFBBF24)
              : isMe
                  ? const Color(0xFF60A5FA)
                  : Colors.grey.shade300,
          width: isMyTurn ? 3 : 2,
        ),
        boxShadow: [
          BoxShadow(
            color: isMyTurn
                ? const Color(0xFFFBBF24).withOpacity(0.4)
                : Colors.black.withOpacity(0.1),
            blurRadius: isMyTurn ? 12 : 6,
            offset: Offset(0, isMyTurn ? -4 : 2),
          ),
        ],
      ),
      child: Stack(
        alignment: Alignment.center,
        children: [
          if (!isOccupied)
            Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(Icons.person_add_outlined,
                    size: 32, color: Colors.grey.shade500),
                const SizedBox(height: 8),
                Text(
                  "座位 ${seatIndex + 1}",
                  style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                ),
              ],
            )
          else
            Padding(
              padding: const EdgeInsets.all(8),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  CircleAvatar(
                    radius: 24,
                    backgroundColor: isMe
                        ? const Color(0xFF60A5FA)
                        : const Color(0xFFF87171),
                    child: Text(
                      isMe ? "你" : "AI${seatIndex + 1}",
                      style: TextStyle(
                        color: Colors.white,
                        fontWeight: FontWeight.bold,
                        fontSize: 14,
                      ),
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    isMe ? "你" : "Agent ${seatIndex + 1}",
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                      color: Colors.grey.shade800,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 4),
                  Container(
                    padding: EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                    decoration: BoxDecoration(
                      color: stillIn
                          ? const Color(0xFF34D399).withOpacity(0.2)
                          : const Color(0xFFEF4444).withOpacity(0.2),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text(
                      stillIn ? "游戏中" : "已弃牌",
                      style: TextStyle(
                        fontSize: 9,
                        color: stillIn
                            ? const Color(0xFF34D399)
                            : const Color(0xFFEF4444),
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          if (isMyTurn)
            Positioned(
              top: -8,
              right: -8,
              child: Container(
                padding: EdgeInsets.all(4),
                decoration: BoxDecoration(
                  color: const Color(0xFFFBBF24),
                  shape: BoxShape.circle,
                  boxShadow: [
                    BoxShadow(
                      color: const Color(0xFFFBBF24).withOpacity(0.6),
                      blurRadius: 8,
                    ),
                  ],
                ),
                child: Icon(Icons.timer, size: 14, color: Colors.white),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildMyCardsArea(List<dynamic> hand) {
    return Center(
      child: Container(
        padding: EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        decoration: BoxDecoration(
          color: Colors.white.withOpacity(0.9),
          borderRadius: BorderRadius.circular(20),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withOpacity(0.15),
              blurRadius: 12,
              offset: Offset(0, -4),
            ),
          ],
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.handshake, size: 18, color: const Color(0xFFFBBF24)),
            SizedBox(width: 8),
            for (int i = 0; i < hand.length; i++)
              Padding(
                padding: EdgeInsets.symmetric(horizontal: 3),
                child: _DealtCard(
                  index: i,
                  stableKey: hand[i]?.toString() ?? i,
                  from: const Offset(0, 0.55),
                  angle: (i - (hand.length - 1) / 2) * 0.08,
                  child: _buildMiniCard(hand[i]?.toString() ?? ""),
                ),
              ),
            SizedBox(width: 8),
            Text(
              "你的手牌",
              style: TextStyle(fontSize: 12, color: Colors.grey.shade700),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildMiniCard(String cardId) {
    final String suit = _zjhSuit(cardId);
    final bool red = suit == "♥" || suit == "♦";
    final Color ink = red ? const Color(0xFFDC2626) : const Color(0xFF111827);
    return Container(
      width: 48,
      height: 68,
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [Colors.white, Colors.grey.shade100],
        ),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
            color: const Color(0xFFFBBF24).withOpacity(0.5), width: 1),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.1),
            blurRadius: 4,
            offset: Offset(0, 2),
          ),
        ],
      ),
      child: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(_cardLabel(cardId),
                style: TextStyle(
                    fontSize: 18, fontWeight: FontWeight.bold, color: ink)),
            SizedBox(height: 2),
            Text(suit, style: TextStyle(fontSize: 14, color: ink)),
          ],
        ),
      ),
    );
  }

  Widget _buildWaitingRoom() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Container(
            width: 120,
            height: 120,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: RadialGradient(
                colors: [
                  const Color(0xFFFBBF24).withOpacity(0.3),
                  const Color(0xFFFBBF24).withOpacity(0.1),
                  Colors.transparent,
                ],
              ),
              border: Border.all(
                color: const Color(0xFFFBBF24).withOpacity(0.4),
                width: 2,
              ),
            ),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(Icons.casino, size: 40, color: const Color(0xFFFBBF24)),
                const SizedBox(height: 8),
                Text("等待玩家",
                    style:
                        TextStyle(fontSize: 14, color: Colors.grey.shade600)),
              ],
            ),
          ),
          const SizedBox(height: 32),
          Text(
            "等待其他 Agent 加入游戏...",
            style: Theme.of(context)
                .textTheme
                .titleMedium
                ?.copyWith(color: Colors.grey.shade700),
          ),
          const SizedBox(height: 8),
          SizedBox(
            width: 40,
            height: 40,
            child: CircularProgressIndicator(
                strokeWidth: 3, color: const Color(0xFFFBBF24)),
          ),
        ],
      ),
    );
  }

  Widget _buildGameInfo(String status, int pot) {
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [
            const Color(0xFFFBBF24).withOpacity(0.1),
            Colors.transparent
          ],
        ),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFFBBF24).withOpacity(0.3)),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceAround,
        children: [
          _buildInfoItem(
              "底池", "$pot", Icons.monetization_on, const Color(0xFFFBBF24)),
          _buildInfoItem(
              "状态",
              status == "playing" ? "进行中" : status,
              status == "playing" ? Icons.play_circle : Icons.flag,
              status == "playing"
                  ? const Color(0xFF34D399)
                  : const Color(0xFF60A5FA)),
        ],
      ),
    );
  }

  Widget _buildInfoItem(
      String label, String value, IconData icon, Color color) {
    return Column(
      children: [
        Icon(icon, size: 28, color: color),
        const SizedBox(height: 8),
        Text(value,
            style: TextStyle(
                fontSize: 24, fontWeight: FontWeight.bold, color: color)),
        const SizedBox(height: 4),
        Text(label,
            style: const TextStyle(fontSize: 12, color: Color(0xFF71717A))),
      ],
    );
  }

  Widget _buildCards(List<dynamic> hand) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text("你的手牌",
            style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w600,
                )),
        const SizedBox(height: 12),
        Wrap(
          spacing: 12,
          runSpacing: 12,
          children: <Widget>[
            for (final Object? c in hand) _buildCard(c?.toString() ?? ""),
          ],
        ),
      ],
    );
  }

  Widget _buildCard(String cardId) {
    final String suit = _zjhSuit(cardId);
    final bool red = suit == "♥" || suit == "♦";
    final Color ink = red ? const Color(0xFFDC2626) : const Color(0xFF111827);
    return Container(
      width: 80,
      height: 112,
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [Colors.white, Colors.grey.shade100],
        ),
        borderRadius: BorderRadius.circular(12),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.1),
            blurRadius: 8,
            offset: const Offset(0, 4),
          ),
        ],
        border: Border.all(color: Colors.grey.shade300),
      ),
      child: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(_cardLabel(cardId),
                style: TextStyle(
                    fontSize: 28, fontWeight: FontWeight.bold, color: ink)),
            const SizedBox(height: 4),
            Text(suit, style: TextStyle(fontSize: 18, color: ink)),
          ],
        ),
      ),
    );
  }

  String _zjhSuit(String id) {
    final List<String> p = id.split("-");
    if (p.length < 2) return "";
    switch (p[1]) {
      case "h":
        return "♥";
      case "d":
        return "♦";
      case "c":
        return "♣";
      case "s":
        return "♠";
      default:
        return p[1];
    }
  }

  Widget _buildActionButtons() {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        SizedBox(
          width: 120,
          child: FilledButton(
            onPressed: _busy ? null : () => _act("stay"),
            style: FilledButton.styleFrom(
              padding: const EdgeInsets.symmetric(vertical: 10),
              backgroundColor: const Color(0xFF34D399),
            ),
            child: const Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(Icons.casino, size: 16),
                SizedBox(width: 6),
                Text("跟注", style: TextStyle(fontSize: 13)),
              ],
            ),
          ),
        ),
        const SizedBox(width: 12),
        SizedBox(
          width: 120,
          child: OutlinedButton(
            onPressed: _busy ? null : () => _act("fold"),
            style: OutlinedButton.styleFrom(
              padding: const EdgeInsets.symmetric(vertical: 10),
              side: const BorderSide(color: Color(0xFFEF4444)),
            ),
            child: const Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(Icons.close, size: 16, color: Color(0xFFEF4444)),
                SizedBox(width: 6),
                Text("弃牌",
                    style: TextStyle(fontSize: 13, color: Color(0xFFEF4444))),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildGameOver() {
    return Container(
      padding: const EdgeInsets.all(32),
      decoration: BoxDecoration(
        color: const Color(0xFF1E1E1E),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFF2A2A2A)),
      ),
      child: Column(
        children: [
          const Icon(Icons.emoji_events, size: 64, color: Color(0xFFFBBF24)),
          const SizedBox(height: 16),
          Text("本局结束",
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                    color: const Color(0xFFF4F4F5),
                  )),
          const SizedBox(height: 12),
          Text("感谢对局，期待下一把！", style: TextStyle(color: Colors.grey.shade400)),
        ],
      ),
    );
  }

  String _cardLabel(String id) {
    final List<String> p = id.split("-");
    final int r = int.tryParse(p.isNotEmpty ? p[0]! : "") ?? 0;
    if (r >= 2 && r <= 10) return "$r";
    const Map<int, String> f = <int, String>{
      11: "J",
      12: "Q",
      13: "K",
      14: "A"
    };
    return f[r] ?? id;
  }
}

/// 斗地主 — 用户 vs Agent + 子 Agent。
class DoudizhuPlayPage extends StatefulWidget {
  const DoudizhuPlayPage({
    super.key,
    required this.api,
    required this.agentId,
    required this.tableId,
    required this.initialSnapshot,
  });

  final WorldApiClient api;
  final String agentId;
  final String tableId;
  final Map<String, dynamic> initialSnapshot;

  @override
  State<DoudizhuPlayPage> createState() => _DoudizhuPlayPageState();
}

class _DoudizhuPlayPageState extends State<DoudizhuPlayPage> {
  late Map<String, dynamic> _snap;
  Timer? _poll;
  Timer? _dealTimer;
  bool _busy = false;
  bool _showHandCards = false;
  final Set<String> _selected = <String>{};
  String get _humanId => GomokuPlayerSession.humanId(widget.agentId);
  final List<GameChatMessage> _chatMessages = <GameChatMessage>[];

  @override
  void initState() {
    super.initState();
    _snap = widget.initialSnapshot;
    _poll = Timer.periodic(const Duration(seconds: 2), (_) => _refresh());
    _addWelcomeMessage();
    _scheduleDealIfNeeded();
  }

  void _addWelcomeMessage() {
    setState(() {
      _chatMessages.add(GameChatMessage(
        id: DateTime.now().millisecondsSinceEpoch.toString(),
        text: "欢迎来到斗地主！祝你成为牌桌之王！👑",
        isUser: false,
        timestamp: DateTime.now(),
      ));
    });
  }

  @override
  void dispose() {
    _poll?.cancel();
    _dealTimer?.cancel();
    super.dispose();
  }

  void _scheduleDealIfNeeded() {
    final String status = _snap["status"]?.toString() ?? "";
    final List<dynamic>? myHand = _snap["myHand"] as List<dynamic>?;
    if (status != "playing" ||
        myHand == null ||
        myHand.isEmpty ||
        _showHandCards) {
      return;
    }
    _dealTimer?.cancel();
    _dealTimer = Timer(const Duration(milliseconds: 520), () {
      if (!mounted) return;
      setState(() => _showHandCards = true);
    });
  }

  bool get _isMyTurn {
    final int? mySeat = (_snap["mySeat"] as num?)?.round();
    final int? turn = (_snap["turnSeat"] as num?)?.round();
    return _snap["status"] == "playing" && mySeat != null && mySeat == turn;
  }

  Future<void> _refresh() async {
    if (_busy) return;
    try {
      final Map<String, dynamic> r =
          await widget.api.gameCenterDoudizhuSnapshot(widget.tableId, _humanId);
      if (!mounted || r["ok"] != true) return;
      setState(() {
        _snap = (r["snapshot"] as Map<String, dynamic>?) ?? _snap;
        _selected.removeWhere((String c) =>
            !((_snap["myHand"] as List<dynamic>?)?.contains(c) ?? false));
        if (_snap["status"] != "playing") {
          _showHandCards = false;
        }
      });
      _scheduleDealIfNeeded();
    } catch (_) {}
  }

  Future<void> _play({required String action, List<String>? cards}) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final Map<String, dynamic> r = await widget.api.gameCenterDoudizhuPlay(
        widget.tableId,
        _humanId,
        action: action,
        cards: cards,
      );
      if (!mounted) return;
      if (r["ok"] == true) {
        setState(() {
          _snap = (r["snapshot"] as Map<String, dynamic>?) ?? _snap;
          _selected.clear();
          if (_snap["status"] != "playing") {
            _showHandCards = false;
          }
        });
        _scheduleDealIfNeeded();
        _addGameActionMessage(action, cards);
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(r["reason"]?.toString() ?? "出牌失败")),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _addGameActionMessage(String action, List<String>? cards) {
    String message = "";
    switch (action) {
      case "play":
        message = "你出了：${cards?.join(", ") ?? ""}";
        break;
      case "pass":
        message = "你选择不出。";
        break;
      default:
        return;
    }
    setState(() {
      _chatMessages.add(GameChatMessage(
        id: DateTime.now().millisecondsSinceEpoch.toString(),
        text: message,
        isUser: true,
        timestamp: DateTime.now(),
      ));
    });
  }

  void _sendMessage(String message) {
    if (message.trim().isEmpty) return;

    setState(() {
      _chatMessages.add(GameChatMessage(
        id: DateTime.now().millisecondsSinceEpoch.toString(),
        text: message,
        isUser: true,
        timestamp: DateTime.now(),
      ));
    });
  }

  @override
  Widget build(BuildContext context) {
    final List<dynamic>? myHand = _snap["myHand"] as List<dynamic>?;
    final String status = _snap["status"]?.toString() ?? "";
    final int? landlordSeat = (_snap["landlordSeat"] as num?)?.round();
    final int? mySeat = (_snap["mySeat"] as num?)?.round();
    final int? turnSeat = (_snap["turnSeat"] as num?)?.round();
    final List<dynamic>? handCounts = _snap["handCounts"] as List<dynamic>?;
    final List<dynamic>? lastPlay = _snap["lastNonPass"];
    final bool isLandlord = _snap["isLandlord"] == true;
    final List<dynamic>? seats = _snap["seats"] as List<dynamic>?;

    return Scaffold(
      appBar: AppBar(title: const Text("斗地主 · 游戏")),
      body: Stack(
        children: [
          Container(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: [
                  const Color(0xFF7F1D1D).withOpacity(0.08),
                  const Color(0xFF991B1B).withOpacity(0.03)
                ],
              ),
            ),
            child: (status == "waiting" || status == "")
                ? _buildPreparationRoom(seats)
                : (status == "bidding")
                    ? _buildBiddingRoom()
                    : _buildTriangleTableLayout(status, landlordSeat, mySeat,
                        turnSeat, handCounts, lastPlay, myHand, isLandlord),
          ),
          GameChatWidget(
            messages: _chatMessages,
            onSendMessage: _sendMessage,
            placeholder: "聊聊这把牌...",
            title: "斗地主对局",
          ),
        ],
      ),
    );
  }

  Widget _buildPreparationRoom(List<dynamic>? seats) {
    final int readyCount =
        seats?.where((s) => s != null && s.toString().isNotEmpty).length ?? 0;
    final bool isReady = seats?.any((s) => s.toString() == _humanId) ?? false;

    return Center(
      child: SingleChildScrollView(
        padding: EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              width: 140,
              height: 140,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: RadialGradient(colors: [
                  const Color(0xFFF87171).withOpacity(0.3),
                  const Color(0xFFF87171).withOpacity(0.1),
                  Colors.transparent,
                ]),
                border: Border.all(
                    color: const Color(0xFFF87171).withOpacity(0.4), width: 2),
              ),
              child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(Icons.whatshot,
                        size: 40, color: const Color(0xFFF87171)),
                    SizedBox(height: 8),
                    Text("斗地主",
                        style: TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.bold,
                            color: Colors.grey.shade700)),
                  ]),
            ),
            SizedBox(height: 32),
            Text("👑 斗地主",
                style: Theme.of(context)
                    .textTheme
                    .headlineSmall
                    ?.copyWith(fontWeight: FontWeight.bold)),
            SizedBox(height: 12),
            Text("三人游戏 · 一人对二人",
                style: TextStyle(fontSize: 14, color: Colors.grey.shade600)),
            SizedBox(height: 24),
            Container(
              padding: EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: Colors.white.withOpacity(0.9),
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: Colors.grey.shade200),
              ),
              child: Column(children: [
                Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                  Icon(Icons.people, size: 18, color: const Color(0xFFF87171)),
                  SizedBox(width: 8),
                  Text("已准备：$readyCount / 3",
                      style:
                          TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                ]),
                SizedBox(height: 16),
                if (!isReady)
                  FilledButton.icon(
                    onPressed: _busy ? null : () => _startGame(),
                    icon: Icon(Icons.check_circle, size: 18),
                    label: Text("准备", style: TextStyle(fontSize: 15)),
                    style: FilledButton.styleFrom(
                      padding:
                          EdgeInsets.symmetric(horizontal: 32, vertical: 12),
                      backgroundColor: const Color(0xFFF87171),
                    ),
                  )
                else
                  Container(
                    padding: EdgeInsets.symmetric(horizontal: 24, vertical: 10),
                    decoration: BoxDecoration(
                      color: const Color(0xFF34D399).withOpacity(0.1),
                      borderRadius: BorderRadius.circular(20),
                      border: Border.all(color: const Color(0xFF34D399)),
                    ),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      Icon(Icons.check,
                          size: 16, color: const Color(0xFF34D399)),
                      SizedBox(width: 6),
                      Text("已准备 ✓",
                          style: TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.w600,
                              color: const Color(0xFF34D399))),
                    ]),
                  ),
              ]),
            ),
            SizedBox(height: 16),
            if (readyCount < 3)
              Text("还需 ${3 - readyCount} 位玩家准备...",
                  style: TextStyle(fontSize: 13, color: Colors.grey.shade500))
            else
              SizedBox(
                width: 28,
                height: 28,
                child: CircularProgressIndicator(
                    strokeWidth: 2.5, color: const Color(0xFFF87171)),
              ),
          ],
        ),
      ),
    );
  }

  Future<void> _startGame() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final Map<String, dynamic> r = await widget.api
          .gameCenterDoudizhuPlay(widget.tableId, _humanId, action: "ready");
      if (!mounted) return;
      if (r["ok"] == true) {
        setState(
            () => _snap = (r["snapshot"] as Map<String, dynamic>?) ?? _snap);
        _scheduleDealIfNeeded();
        _addGameActionMessage("ready", null);
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(r["reason"]?.toString() ?? "准备失败")));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _buildTriangleTableLayout(
    String status,
    int? landlordSeat,
    int? mySeat,
    int? turnSeat,
    List<dynamic>? handCounts,
    dynamic lastPlay,
    List<dynamic>? myHand,
    bool isLandlord,
  ) {
    final Map<String, dynamic>? play =
        lastPlay is Map ? Map<String, dynamic>.from(lastPlay) : null;

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 12, 12, 10),
        child: Column(
          children: [
            _buildOpponentStrip(landlordSeat, mySeat, turnSeat, handCounts),
            const SizedBox(height: 10),
            Expanded(
              child: _buildTableSurface(
                status: status,
                landlordSeat: landlordSeat,
                mySeat: mySeat,
                turnSeat: turnSeat,
                lastPlay: play,
                isLandlord: isLandlord,
              ),
            ),
            const SizedBox(height: 10),
            if (status == "bidding")
              _buildBiddingButtons()
            else if (status == "finished")
              _buildGameOver()
            else if (myHand != null && status == "playing" && _showHandCards)
              _buildMyHandCards(myHand)
            else if (myHand != null && status == "playing")
              _buildDealingHint(myHand.length),
          ],
        ),
      ),
    );
  }

  Widget _buildOpponentStrip(
    int? landlordSeat,
    int? mySeat,
    int? turnSeat,
    List<dynamic>? handCounts,
  ) {
    final List<int> opponents =
        <int>[0, 1, 2].where((int seat) => seat != mySeat).toList();
    return Row(
      children: [
        for (int i = 0; i < opponents.length; i++) ...[
          Expanded(
            child: _buildPlayerSeat(
              opponents[i],
              landlordSeat,
              mySeat,
              turnSeat,
              handCounts,
              compact: true,
            ),
          ),
          if (i != opponents.length - 1) const SizedBox(width: 10),
        ],
      ],
    );
  }

  Widget _buildTableSurface({
    required String status,
    required int? landlordSeat,
    required int? mySeat,
    required int? turnSeat,
    required Map<String, dynamic>? lastPlay,
    required bool isLandlord,
  }) {
    final int pot = (_snap["pot"] as num?)?.round() ?? 0;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(26),
        gradient: const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            Color(0xFF1F473B),
            Color(0xFF15352E),
            Color(0xFF0E211D),
          ],
        ),
        border: Border.all(color: const Color(0xFF34D399).withOpacity(0.22)),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.2),
            blurRadius: 24,
            offset: const Offset(0, 12),
          ),
        ],
      ),
      child: Stack(
        children: [
          Positioned.fill(
            child: DecoratedBox(
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(22),
                border: Border.all(color: Colors.white.withOpacity(0.05)),
              ),
            ),
          ),
          Column(
            children: [
              Row(
                children: [
                  _buildTableMetric(
                      "底池", "$pot", Icons.savings, const Color(0xFFFBBF24)),
                  const SizedBox(width: 10),
                  _buildTableMetric(
                    "你的身份",
                    isLandlord ? "地主" : "农民",
                    isLandlord
                        ? Icons.workspace_premium
                        : Icons.shield_outlined,
                    isLandlord
                        ? const Color(0xFFFBBF24)
                        : const Color(0xFF60A5FA),
                  ),
                  const Spacer(),
                  _buildTurnChip(status, turnSeat, mySeat),
                ],
              ),
              const Spacer(),
              if (lastPlay != null)
                _buildLastPlayArea(lastPlay)
              else
                _buildEmptyTableMessage(status),
              const Spacer(),
              _buildHumanSeatSummary(landlordSeat, mySeat, turnSeat),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildTableMetric(
      String label, String value, IconData icon, Color color) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: Colors.black.withOpacity(0.2),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: color.withOpacity(0.24)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 16, color: color),
          const SizedBox(width: 6),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label,
                  style: TextStyle(
                      fontSize: 10, color: Colors.white.withOpacity(0.62))),
              Text(value,
                  style: TextStyle(
                      fontSize: 14, fontWeight: FontWeight.w800, color: color)),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildTurnChip(String status, int? turnSeat, int? mySeat) {
    final bool mine =
        status == "playing" && turnSeat != null && turnSeat == mySeat;
    final String text =
        status == "playing" ? (mine ? "轮到你" : "Agent 思考中") : status;
    final Color color =
        mine ? const Color(0xFF34D399) : const Color(0xFFFBBF24);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: color.withOpacity(0.16),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withOpacity(0.32)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(mine ? Icons.touch_app : Icons.psychology_alt,
              size: 15, color: color),
          const SizedBox(width: 6),
          Text(text,
              style: TextStyle(
                  fontSize: 12, fontWeight: FontWeight.w800, color: color)),
        ],
      ),
    );
  }

  Widget _buildEmptyTableMessage(String status) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
      decoration: BoxDecoration(
        color: Colors.white.withOpacity(0.08),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: Colors.white.withOpacity(0.1)),
      ),
      child: Text(
        status == "playing" ? "等待第一手出牌" : "牌桌准备中",
        style: TextStyle(
          fontSize: 14,
          fontWeight: FontWeight.w700,
          color: Colors.white.withOpacity(0.82),
        ),
      ),
    );
  }

  Widget _buildHumanSeatSummary(int? landlordSeat, int? mySeat, int? turnSeat) {
    final bool isLandlord =
        landlordSeat != null && mySeat != null && landlordSeat == mySeat;
    final bool isTurn = turnSeat != null && mySeat != null && turnSeat == mySeat;
    return AnimatedContainer(
      duration: const Duration(milliseconds: 220),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: Colors.white.withOpacity(isTurn ? 0.18 : 0.1),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: (isTurn ? const Color(0xFF34D399) : Colors.white)
              .withOpacity(0.22),
        ),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          CircleAvatar(
            radius: 16,
            backgroundColor:
                isLandlord ? const Color(0xFFFBBF24) : const Color(0xFF60A5FA),
            child: Icon(isLandlord ? Icons.workspace_premium : Icons.person,
                size: 17, color: Colors.white),
          ),
          const SizedBox(width: 9),
          Text(
            isLandlord ? "你是地主" : "你是农民",
            style: const TextStyle(
                fontSize: 13, fontWeight: FontWeight.w800, color: Colors.white),
          ),
        ],
      ),
    );
  }

  Widget _buildCenterGameInfo(String status) {
    final int pot = (_snap["pot"] as num?)?.round() ?? 0;
    return Container(
      width: 140,
      height: 140,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: RadialGradient(
          colors: [
            const Color(0xFFF87171).withOpacity(0.25),
            const Color(0xFFF87171).withOpacity(0.08),
            Colors.transparent,
          ],
        ),
        border: Border.all(
          color: const Color(0xFFF87171).withOpacity(0.3),
          width: 2,
        ),
        boxShadow: [
          BoxShadow(
            color: const Color(0xFFF87171).withOpacity(0.15),
            blurRadius: 16,
            spreadRadius: 4,
          ),
        ],
      ),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.casino, size: 32, color: const Color(0xFFF87171)),
          const SizedBox(height: 6),
          Text(
            "$pot",
            style: TextStyle(
                fontSize: 24,
                fontWeight: FontWeight.bold,
                color: const Color(0xFFF87171)),
          ),
          Text("底池",
              style: TextStyle(fontSize: 11, color: Colors.grey.shade600)),
          SizedBox(height: 4),
          Container(
            padding: EdgeInsets.symmetric(horizontal: 8, vertical: 2),
            decoration: BoxDecoration(
              color: status == "playing"
                  ? const Color(0xFF34D399).withOpacity(0.2)
                  : Colors.grey.withOpacity(0.15),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Text(
              status == "playing" ? "进行中" : status,
              style: TextStyle(
                  fontSize: 10,
                  color: status == "playing"
                      ? const Color(0xFF34D399)
                      : Colors.grey.shade600),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildTopPlayer(int seatIndex, int? landlordSeat, int? mySeat,
      int? turnSeat, List<dynamic>? handCounts) {
    return Center(
        child: _buildPlayerSeat(
            seatIndex, landlordSeat, mySeat, turnSeat, handCounts));
  }

  Widget _buildLeftBottomPlayer(int seatIndex, int? landlordSeat, int? mySeat,
      int? turnSeat, List<dynamic>? handCounts) {
    return Align(
        alignment: Alignment.bottomLeft,
        child: _buildPlayerSeat(
            seatIndex, landlordSeat, mySeat, turnSeat, handCounts));
  }

  Widget _buildRightBottomPlayer(int seatIndex, int? landlordSeat, int? mySeat,
      int? turnSeat, List<dynamic>? handCounts) {
    return Align(
        alignment: Alignment.bottomRight,
        child: _buildPlayerSeat(
            seatIndex, landlordSeat, mySeat, turnSeat, handCounts));
  }

  Widget _buildPlayerSeat(
    int seatIndex,
    int? landlordSeat,
    int? mySeat,
    int? turnSeat,
    List<dynamic>? handCounts, {
    bool compact = false,
  }) {
    final bool isLandlord = landlordSeat == seatIndex;
    final bool isMe = mySeat == seatIndex;
    final bool isCurrentTurn = turnSeat == seatIndex;
    final int? cardCount = (handCounts != null && seatIndex < handCounts.length)
        ? (handCounts[seatIndex] as num?)?.round()
        : null;

    return AnimatedContainer(
      duration: Duration(milliseconds: 300),
      transform: Matrix4.translationValues(0, isCurrentTurn ? -8 : 0, 0),
      child: Container(
        width: double.infinity,
        height: compact ? 92 : 130,
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: isCurrentTurn
                ? [
                    const Color(0xFFF87171).withOpacity(0.25),
                    const Color(0xFFF87171).withOpacity(0.08)
                  ]
                : [Colors.white.withOpacity(0.95), Colors.grey.shade50],
          ),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: isCurrentTurn
                ? const Color(0xFFF87171)
                : isMe
                    ? const Color(0xFF60A5FA)
                    : Colors.grey.shade300,
            width: isCurrentTurn ? 3 : 2,
          ),
          boxShadow: [
            BoxShadow(
              color: isCurrentTurn
                  ? const Color(0xFFF87171).withOpacity(0.35)
                  : Colors.black.withOpacity(0.08),
              blurRadius: isCurrentTurn ? 14 : 6,
              offset: Offset(0, isCurrentTurn ? -4 : 2),
            ),
          ],
        ),
        child: Stack(
          alignment: Alignment.center,
          children: [
            Padding(
              padding: EdgeInsets.all(compact ? 8 : 10),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  CircleAvatar(
                    radius: compact ? 20 : 26,
                    backgroundColor: isLandlord
                        ? const Color(0xFFFBBF24)
                        : isMe
                            ? const Color(0xFF60A5FA)
                            : const Color(0xFF34D399),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(
                          isLandlord ? Icons.workspace_premium : Icons.person,
                          size: compact ? 15 : 18,
                          color: Colors.white,
                        ),
                        if (isLandlord)
                          Text("王",
                              style: TextStyle(
                                  fontSize: 9,
                                  color: Colors.white,
                                  fontWeight: FontWeight.bold)),
                      ],
                    ),
                  ),
                  SizedBox(height: compact ? 4 : 6),
                  Text(
                    isMe
                        ? "你"
                        : (isLandlord
                            ? "Agent ${seatIndex + 1} · 地主"
                            : "Agent ${seatIndex + 1} · 农民"),
                    style: TextStyle(
                        fontSize: compact ? 11 : 12,
                        fontWeight: FontWeight.w600,
                        color: Colors.grey.shade800),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  SizedBox(height: compact ? 3 : 4),
                  if (cardCount != null)
                    Container(
                      padding: EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: const Color(0xFF7F1D1D).withOpacity(0.1),
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(Icons.style,
                              size: 12, color: const Color(0xFF7F1D1D)),
                          SizedBox(width: 3),
                          Text("$cardCount 张",
                              style: TextStyle(
                                  fontSize: 10,
                                  color: const Color(0xFF7F1D1D),
                                  fontWeight: FontWeight.w500)),
                        ],
                      ),
                    ),
                ],
              ),
            ),
            if (isCurrentTurn)
              Positioned(
                top: -8,
                right: -8,
                child: Container(
                  padding: EdgeInsets.all(4),
                  decoration: BoxDecoration(
                    color: const Color(0xFFF87171),
                    shape: BoxShape.circle,
                    boxShadow: [
                      BoxShadow(
                          color: const Color(0xFFF87171).withOpacity(0.5),
                          blurRadius: 8)
                    ],
                  ),
                  child: Icon(Icons.timer, size: 14, color: Colors.white),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildLastPlayArea(Map<String, dynamic> play) {
    final String kind = play["kind"]?.toString() ?? "";
    final List<dynamic> cards = play["cards"] as List<dynamic>? ?? [];

    return Center(
      child: Container(
        padding: EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        decoration: BoxDecoration(
          color: Colors.white.withOpacity(0.95),
          borderRadius: BorderRadius.circular(16),
          boxShadow: [
            BoxShadow(color: Colors.black.withOpacity(0.1), blurRadius: 10)
          ],
          border: Border.all(color: const Color(0xFFF87171).withOpacity(0.2)),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(kind,
                style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    color: const Color(0xFFF87171))),
            SizedBox(height: 8),
            if (cards.isNotEmpty)
              Wrap(
                spacing: 4,
                runSpacing: 4,
                children: <Widget>[
                  for (int i = 0; i < cards.length; i++)
                    _DealtCard(
                      index: i,
                      stableKey: cards[i]?.toString() ?? i,
                      from: const Offset(0, -0.35),
                      angle: (i - (cards.length - 1) / 2) * 0.02,
                      child: _buildMiniDoudizhuCard(cards[i]?.toString() ?? ""),
                    ),
                ],
              )
            else
              Text("不出",
                  style: TextStyle(fontSize: 13, color: Colors.grey.shade600)),
          ],
        ),
      ),
    );
  }

  Widget _buildMiniDoudizhuCard(String cardId) {
    return Container(
      width: 36,
      height: 50,
      decoration: BoxDecoration(
        gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [Colors.white, Colors.grey.shade100]),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: Colors.grey.shade300),
        boxShadow: [
          BoxShadow(color: Colors.black.withOpacity(0.08), blurRadius: 3)
        ],
      ),
      child: Center(
        child: Text(kDoudizhuCardLabel(cardId),
            style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.bold,
                color: _getCardColor(cardId))),
      ),
    );
  }

  Widget _buildDealingHint(int count) {
    return Center(
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
        decoration: BoxDecoration(
          color: Colors.white.withOpacity(0.94),
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: const Color(0xFFF87171).withOpacity(0.22)),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withOpacity(0.12),
              blurRadius: 12,
              offset: const Offset(0, -4),
            ),
          ],
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox(
              width: 22,
              height: 22,
              child: CircularProgressIndicator(
                strokeWidth: 2.4,
                color: const Color(0xFFF87171),
              ),
            ),
            const SizedBox(width: 10),
            Text(
              "正在发牌 · $count 张",
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w700,
                color: Colors.grey.shade800,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildMyHandCards(List<dynamic> hand) {
    final double maxPanelWidth =
        (MediaQuery.of(context).size.width - 24).clamp(280.0, 720.0);
    final double gap = hand.length <= 1
        ? 0
        : ((maxPanelWidth - 40 - 64) / (hand.length - 1)).clamp(20.0, 38.0);
    final double cardsWidth =
        hand.length <= 1 ? 64 : 64 + gap * (hand.length - 1);
    return Center(
      child: Container(
        width: maxPanelWidth,
        padding: EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: Colors.white.withOpacity(0.92),
          borderRadius: BorderRadius.circular(18),
          boxShadow: [
            BoxShadow(
                color: Colors.black.withOpacity(0.12),
                blurRadius: 12,
                offset: Offset(0, -4))
          ],
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.handshake, size: 16, color: const Color(0xFFF87171)),
                SizedBox(width: 6),
                Text("你的手牌 (${hand.length}张)",
                    style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: Colors.grey.shade700)),
                if (_selected.isNotEmpty) ...[
                  SizedBox(width: 8),
                  Container(
                    padding: EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                    decoration: BoxDecoration(
                        color: const Color(0xFF60A5FA).withOpacity(0.15),
                        borderRadius: BorderRadius.circular(8)),
                    child: Text("已选 ${_selected.length}",
                        style: TextStyle(
                            fontSize: 10,
                            color: const Color(0xFF60A5FA),
                            fontWeight: FontWeight.w500)),
                  ),
                ],
              ],
            ),
            SizedBox(height: 8),
            SizedBox(
              width: maxPanelWidth - 24,
              height: 112,
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                physics: const BouncingScrollPhysics(),
                child: SizedBox(
                  width: cardsWidth,
                  height: 112,
                  child: Stack(
                    clipBehavior: Clip.none,
                    children: <Widget>[
                      for (int i = 0; i < hand.length; i++)
                        Positioned(
                          left: i * gap,
                          top: 10,
                          child: _DealtCard(
                            index: i,
                            stableKey: hand[i]?.toString() ?? i,
                            from: const Offset(0, 0.55),
                            lift: _selected.contains(hand[i]?.toString() ?? "")
                                ? 10
                                : 0,
                            angle: (i - (hand.length - 1) / 2) * 0.01,
                            child: _buildCard(hand[i]?.toString() ?? ""),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildBiddingRoom() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Container(
            width: 120,
            height: 120,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: RadialGradient(colors: [
                const Color(0xFFFBBF24).withOpacity(0.3),
                const Color(0xFFFBBF24).withOpacity(0.1),
                Colors.transparent
              ]),
              border: Border.all(
                  color: const Color(0xFFFBBF24).withOpacity(0.4), width: 2),
            ),
            child:
                Column(mainAxisAlignment: MainAxisAlignment.center, children: [
              Icon(Icons.workspace_premium,
                  size: 36, color: const Color(0xFFFBBF24)),
              SizedBox(height: 6),
              Text("叫地主",
                  style: TextStyle(fontSize: 13, color: Colors.grey.shade700)),
            ]),
          ),
          SizedBox(height: 32),
          Text("等待叫地主...",
              style: Theme.of(context)
                  .textTheme
                  .titleMedium
                  ?.copyWith(color: Colors.grey.shade700)),
          SizedBox(height: 12),
          SizedBox(
              width: 32,
              height: 32,
              child: CircularProgressIndicator(
                  strokeWidth: 2.5, color: const Color(0xFFFBBF24))),
        ],
      ),
    );
  }

  Widget _buildBiddingButtons() {
    return Center(
      child: Container(
        padding: EdgeInsets.symmetric(horizontal: 20, vertical: 12),
        decoration: BoxDecoration(
            color: Colors.white.withOpacity(0.93),
            borderRadius: BorderRadius.circular(18),
            boxShadow: [
              BoxShadow(color: Colors.black.withOpacity(0.1), blurRadius: 10)
            ]),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            FilledButton.icon(
              onPressed: _busy ? null : () => _play(action: "bid"),
              icon: Icon(Icons.workspace_premium, size: 18),
              label: Text("叫地主", style: TextStyle(fontSize: 14)),
              style: FilledButton.styleFrom(
                  padding: EdgeInsets.symmetric(horizontal: 20, vertical: 12),
                  backgroundColor: const Color(0xFFFBBF24)),
            ),
            SizedBox(width: 12),
            OutlinedButton.icon(
              onPressed: _busy ? null : () => _play(action: "pass"),
              icon: Icon(Icons.block, size: 18, color: Colors.grey.shade600),
              label: Text("不叫",
                  style: TextStyle(fontSize: 14, color: Colors.grey.shade600)),
              style: OutlinedButton.styleFrom(
                  side: BorderSide(color: Colors.grey.shade400),
                  padding: EdgeInsets.symmetric(horizontal: 20, vertical: 12)),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildGameStatus(String status) {
    final bool isLandlord = _snap["isLandlord"] == true;
    final String roleText = status == "bidding"
        ? "叫地主中..."
        : isLandlord
            ? "你是地主 👑"
            : "你是农民 🌾";
    final Color roleColor =
        isLandlord ? const Color(0xFFF87171) : const Color(0xFF34D399);

    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [
            const Color(0xFFF87171).withOpacity(0.1),
            Colors.transparent
          ],
        ),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFF87171).withOpacity(0.3)),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceAround,
        children: [
          _buildInfoItem(
              "状态",
              status == "playing" ? "进行中" : status,
              Icons.play_circle,
              status == "playing"
                  ? const Color(0xFF34D399)
                  : const Color(0xFF60A5FA)),
          _buildInfoItem(
              "身份",
              roleText,
              isLandlord ? Icons.workspace_premium : Icons.agriculture,
              roleColor),
        ],
      ),
    );
  }

  Widget _buildInfoItem(
      String label, String value, IconData icon, Color color) {
    return Column(
      children: [
        Icon(icon, size: 28, color: color),
        const SizedBox(height: 8),
        Text(value,
            style: TextStyle(
                fontSize: 18, fontWeight: FontWeight.w600, color: color)),
        const SizedBox(height: 4),
        Text(label,
            style: const TextStyle(fontSize: 12, color: Color(0xFF71717A))),
      ],
    );
  }

  Widget _buildCards(List<dynamic> hand) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Icon(Icons.style, size: 20, color: Color(0xFFF87171)),
            const SizedBox(width: 8),
            Text("你的手牌 (${hand.length}张)",
                style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    )),
            const Spacer(),
            if (_selected.isNotEmpty)
              Text("已选 ${_selected.length} 张",
                  style:
                      TextStyle(color: const Color(0xFF60A5FA), fontSize: 14)),
          ],
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: <Widget>[
            for (final Object? c in hand) _buildCard(c?.toString() ?? ""),
          ],
        ),
      ],
    );
  }

  Widget _buildCard(String cardId) {
    final bool isSelected = _selected.contains(cardId);
    final String label = kDoudizhuCardLabel(cardId);

    return GestureDetector(
      onTap: _isMyTurn && !_busy
          ? () {
              setState(() {
                if (isSelected) {
                  _selected.remove(cardId);
                } else {
                  _selected.add(cardId);
                }
              });
            }
          : null,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        width: 60,
        height: 84,
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: isSelected
                ? [
                    const Color(0xFF60A5FA).withOpacity(0.2),
                    const Color(0xFF60A5FA).withOpacity(0.1)
                  ]
                : [Colors.white, Colors.grey.shade100],
          ),
          borderRadius: BorderRadius.circular(8),
          boxShadow: [
            BoxShadow(
              color: isSelected
                  ? const Color(0xFF60A5FA).withOpacity(0.4)
                  : Colors.black.withOpacity(0.1),
              blurRadius: isSelected ? 8 : 4,
              offset: Offset(0, isSelected ? -4 : 2),
            ),
          ],
          border: Border.all(
            color: isSelected ? const Color(0xFF60A5FA) : Colors.grey.shade300,
            width: isSelected ? 2 : 1,
          ),
        ),
        transform: Matrix4.translationValues(0, isSelected ? -8 : 0, 0),
        child: Center(
          child: Text(label,
              style: TextStyle(
                fontSize: 18,
                fontWeight: FontWeight.bold,
                color: _getCardColor(cardId),
              )),
        ),
      ),
    );
  }

  Color _getCardColor(String cardId) {
    final String suit =
        cardId.split("-").length > 1 ? cardId.split("-")[1] : "";
    if (suit == "h" || suit == "d")
      return const Color(0xFFF87171); // 红心/方块 - 红色
    return const Color(0xFF1F2937); // 黑桃/梅花 - 黑色
  }

  Widget _buildActionButtons() {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        SizedBox(
          width: 110,
          child: FilledButton(
            onPressed: _busy || _selected.isEmpty
                ? null
                : () => _play(action: "play", cards: _selected.toList()),
            style: FilledButton.styleFrom(
              padding: const EdgeInsets.symmetric(vertical: 10),
              backgroundColor: const Color(0xFFF87171),
            ),
            child: const Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(Icons.send, size: 16),
                SizedBox(width: 6),
                Text("出牌", style: TextStyle(fontSize: 13)),
              ],
            ),
          ),
        ),
        const SizedBox(width: 12),
        SizedBox(
          width: 110,
          child: OutlinedButton(
            onPressed: _busy ? null : () => _play(action: "pass"),
            style: OutlinedButton.styleFrom(
              padding: const EdgeInsets.symmetric(vertical: 10),
              side: const BorderSide(color: Color(0xFF71717A)),
            ),
            child: const Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(Icons.block, size: 16, color: Color(0xFF71717A)),
                SizedBox(width: 6),
                Text("不出",
                    style: TextStyle(fontSize: 13, color: Color(0xFF71717A))),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildGameOver() {
    return Container(
      padding: const EdgeInsets.all(32),
      decoration: BoxDecoration(
        color: const Color(0xFF1E1E1E),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFF2A2A2A)),
      ),
      child: Column(
        children: [
          Icon(Icons.emoji_events, size: 64, color: const Color(0xFFFBBF24)),
          const SizedBox(height: 16),
          Text("本局结束",
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                    color: const Color(0xFFF4F4F5),
                  )),
          const SizedBox(height: 12),
          Text("精彩的对局！再来一局？", style: TextStyle(color: Colors.grey.shade400)),
        ],
      ),
    );
  }
}

/// 21 点 — 用户 vs 庄家 Agent。
class BlackjackPlayPage extends StatefulWidget {
  const BlackjackPlayPage({
    super.key,
    required this.api,
    required this.agentId,
    required this.tableId,
    required this.initialSnapshot,
  });

  final WorldApiClient api;
  final String agentId;
  final String tableId;
  final Map<String, dynamic> initialSnapshot;

  @override
  State<BlackjackPlayPage> createState() => _BlackjackPlayPageState();
}

class _BlackjackPlayPageState extends State<BlackjackPlayPage> {
  late Map<String, dynamic> _snap;
  bool _busy = false;
  String get _humanId => GomokuPlayerSession.humanId(widget.agentId);
  final List<GameChatMessage> _chatMessages = <GameChatMessage>[];

  @override
  void initState() {
    super.initState();
    _snap = widget.initialSnapshot;
    _addWelcomeMessage();
  }

  void _addWelcomeMessage() {
    setState(() {
      _chatMessages.add(GameChatMessage(
        id: DateTime.now().millisecondsSinceEpoch.toString(),
        text: "欢迎来到21点！我会给你最优策略建议。🃏",
        isUser: false,
        timestamp: DateTime.now(),
      ));
    });
  }

  Future<void> _hit() async {
    setState(() => _busy = true);
    try {
      final Map<String, dynamic> r =
          await widget.api.gameCenterBlackjackHit(widget.tableId, _humanId);
      if (mounted && r["ok"] == true) {
        setState(() {
          _snap = (r["snapshot"] as Map<String, dynamic>?) ?? _snap;
        });
        _addGameActionMessage("hit");
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _stand() async {
    setState(() => _busy = true);
    try {
      final Map<String, dynamic> r =
          await widget.api.gameCenterBlackjackStand(widget.tableId, _humanId);
      if (mounted && r["ok"] == true) {
        setState(() {
          _snap = (r["snapshot"] as Map<String, dynamic>?) ?? _snap;
        });
        _addGameActionMessage("stand");
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _addGameActionMessage(String action) {
    String message = "";
    switch (action) {
      case "hit":
        message = "你要了一张牌！";
        break;
      case "stand":
        message = "你选择停牌。";
        break;
      default:
        return;
    }
    setState(() {
      _chatMessages.add(GameChatMessage(
        id: DateTime.now().millisecondsSinceEpoch.toString(),
        text: message,
        isUser: true,
        timestamp: DateTime.now(),
      ));
    });
  }

  void _sendMessage(String message) {
    if (message.trim().isEmpty) return;

    setState(() {
      _chatMessages.add(GameChatMessage(
        id: DateTime.now().millisecondsSinceEpoch.toString(),
        text: message,
        isUser: true,
        timestamp: DateTime.now(),
      ));
    });
  }

  @override
  Widget build(BuildContext context) {
    final String phase = _snap["phase"]?.toString() ?? "";
    final bool playing = phase == "player_turn";
    final List<dynamic> playerHand =
        _snap["playerHand"] as List<dynamic>? ?? <dynamic>[];
    final List<dynamic> dealerHand =
        _snap["dealerHand"] as List<dynamic>? ?? <dynamic>[];
    final int dealerScore = (_snap["dealerScore"] as num?)?.round() ?? 0;
    final int playerScore = (_snap["playerScore"] as num?)?.round() ?? 0;
    final bool hasStarted = playerHand.isNotEmpty || dealerHand.isNotEmpty;

    return Scaffold(
      appBar: AppBar(title: const Text("21 点 · 游戏")),
      body: Stack(
        children: [
          Container(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: [
                  const Color(0xFF065F46).withOpacity(0.08),
                  const Color(0xFF047857).withOpacity(0.03)
                ],
              ),
            ),
            child: !hasStarted
                ? _buildPreparationRoom()
                : _buildBlackjackTableLayout(phase, playing, dealerHand,
                    playerHand, dealerScore, playerScore),
          ),
          GameChatWidget(
            messages: _chatMessages,
            onSendMessage: _sendMessage,
            placeholder: "聊聊这把牌...",
            title: "21点对局",
          ),
        ],
      ),
    );
  }

  Widget _buildPreparationRoom() {
    return Center(
      child: SingleChildScrollView(
        padding: EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              width: 140,
              height: 140,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: RadialGradient(colors: [
                  const Color(0xFF34D399).withOpacity(0.3),
                  const Color(0xFF34D399).withOpacity(0.1),
                  Colors.transparent,
                ]),
                border: Border.all(
                    color: const Color(0xFF34D399).withOpacity(0.4), width: 2),
              ),
              child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(Icons.casino,
                        size: 40, color: const Color(0xFF34D399)),
                    SizedBox(height: 8),
                    Text("21",
                        style: TextStyle(
                            fontSize: 28,
                            fontWeight: FontWeight.w800,
                            color: const Color(0xFF34D399))),
                  ]),
            ),
            SizedBox(height: 32),
            Text("🃏 21点",
                style: Theme.of(context)
                    .textTheme
                    .headlineSmall
                    ?.copyWith(fontWeight: FontWeight.bold)),
            SizedBox(height: 12),
            Text("经典赌场游戏 · 你 vs 庄家",
                style: TextStyle(fontSize: 14, color: Colors.grey.shade600)),
            SizedBox(height: 24),
            Container(
              padding: EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: Colors.white.withOpacity(0.9),
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: Colors.grey.shade200),
              ),
              child: Column(children: [
                Icon(Icons.info_outline,
                    size: 20, color: const Color(0xFF34D399)),
                SizedBox(height: 12),
                Text("游戏规则",
                    style:
                        TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                SizedBox(height: 8),
                Text("• 目标：手牌点数尽量接近21点但不超过",
                    style:
                        TextStyle(fontSize: 13, color: Colors.grey.shade600)),
                Text("• A可算1点或11点，J/Q/K算10点",
                    style:
                        TextStyle(fontSize: 13, color: Colors.grey.shade600)),
                Text("• 超过21点即爆牌（Bust）",
                    style:
                        TextStyle(fontSize: 13, color: Colors.grey.shade600)),
                SizedBox(height: 16),
                FilledButton.icon(
                  onPressed: _busy ? null : () => _startGame(),
                  icon: Icon(Icons.play_arrow, size: 18),
                  label: Text("开始游戏", style: TextStyle(fontSize: 15)),
                  style: FilledButton.styleFrom(
                    padding: EdgeInsets.symmetric(horizontal: 36, vertical: 12),
                    backgroundColor: const Color(0xFF34D399),
                  ),
                ),
              ]),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _startGame() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final Map<String, dynamic> r =
          await widget.api.gameCenterStartBlackjack(widget.agentId);
      if (!mounted) return;
      if (r["ok"] == true) {
        setState(
            () => _snap = (r["snapshot"] as Map<String, dynamic>?) ?? _snap);
        _addGameActionMessage("start");
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(r["reason"]?.toString() ?? "开始失败")));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _buildBlackjackTableLayout(
    String phase,
    bool playing,
    List<dynamic> dealerHand,
    List<dynamic> playerHand,
    int dealerScore,
    int playerScore,
  ) {
    return Center(
      child: SingleChildScrollView(
        padding: EdgeInsets.symmetric(horizontal: 16, vertical: 20),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            SizedBox(height: 20),
            _buildDealerArea(dealerHand, dealerScore),
            SizedBox(height: 32),
            _buildGameStatusArea(dealerScore, playerScore, phase),
            SizedBox(height: 32),
            _buildPlayerArea(playerHand, playerScore),
            SizedBox(height: 24),
            if (playing) _buildActionButtons() else _buildOutcome(),
          ],
        ),
      ),
    );
  }

  Widget _buildDealerArea(List<dynamic> hand, int score) {
    return Container(
      width: double.infinity,
      padding: EdgeInsets.all(20),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            const Color(0xFFF87171).withOpacity(0.08),
            Colors.transparent
          ],
        ),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: const Color(0xFFF87171).withOpacity(0.2)),
      ),
      child: Column(
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.casino, size: 24, color: const Color(0xFFF87171)),
              SizedBox(width: 8),
              Text("庄 家",
                  style: TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                      color: const Color(0xFFF87171))),
              Spacer(),
              Container(
                padding: EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                decoration: BoxDecoration(
                  color: const Color(0xFFF87171).withOpacity(0.15),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(
                      color: const Color(0xFFF87171).withOpacity(0.3)),
                ),
                child: Text("$score 点",
                    style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.bold,
                        color: const Color(0xFFF87171))),
              ),
            ],
          ),
          SizedBox(height: 16),
          Wrap(
            alignment: WrapAlignment.center,
            spacing: 10,
            runSpacing: 10,
            children: <Widget>[
              for (int i = 0; i < hand.length; i++)
                _DealtCard(
                  index: i,
                  stableKey: hand[i]?.toString() ?? i,
                  from: const Offset(-0.25, -0.65),
                  angle: (i - (hand.length - 1) / 2) * 0.035,
                  child: _buildDealerCard(hand[i]?.toString() ?? ""),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildDealerCard(String cardId) {
    final String suit = _bjSuit(cardId);
    final bool red = suit == "h" || suit == "d" || suit == "♥" || suit == "♦";
    final Color ink = red ? const Color(0xFFDC2626) : const Color(0xFF111827);
    return Container(
      width: 72,
      height: 100,
      decoration: BoxDecoration(
        gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [Colors.white, Colors.grey.shade100]),
        borderRadius: BorderRadius.circular(12),
        boxShadow: [
          BoxShadow(
              color: Colors.black.withOpacity(0.1),
              blurRadius: 8,
              offset: Offset(0, 4))
        ],
        border: Border.all(
            color: const Color(0xFFF87171).withOpacity(0.3), width: 2),
      ),
      child: Stack(
        children: <Widget>[
          Positioned(
              top: 8,
              left: 8,
              child: Text(_bjLabel(cardId),
                  style: TextStyle(
                      fontSize: 18, fontWeight: FontWeight.w800, color: ink))),
          Positioned(
              bottom: 7,
              right: 8,
              child: Text(suit, style: TextStyle(fontSize: 18, color: ink))),
          Center(child: Text(suit, style: TextStyle(fontSize: 28, color: ink))),
        ],
      ),
    );
  }

  String _bjSuit(String id) {
    final String suit = id.split("-").length > 1 ? id.split("-")[1] : "";
    switch (suit) {
      case "h":
        return "♥";
      case "d":
        return "♦";
      case "c":
        return "♣";
      case "s":
        return "♠";
      default:
        return suit;
    }
  }

  Widget _buildGameStatusArea(int dealerScore, int playerScore, String phase) {
    return Container(
      width: double.infinity,
      padding: EdgeInsets.symmetric(vertical: 16, horizontal: 24),
      decoration: BoxDecoration(
        gradient: RadialGradient(colors: [
          const Color(0xFF34D399).withOpacity(0.15),
          const Color(0xFF34D399).withOpacity(0.05),
          Colors.transparent,
        ]),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: const Color(0xFF34D399).withOpacity(0.25)),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceEvenly,
        children: [
          _buildScoreItem(
              "庄家", "$dealerScore", Icons.casino, const Color(0xFFF87171)),
          Container(width: 1, height: 40, color: Colors.grey.shade300),
          _buildScoreItem(
              "你", "$playerScore", Icons.person, const Color(0xFF60A5FA)),
          Container(width: 1, height: 40, color: Colors.grey.shade300),
          _buildPhaseIndicator(phase),
        ],
      ),
    );
  }

  Widget _buildScoreItem(
      String label, String value, IconData icon, Color color) {
    return Column(children: [
      Icon(icon, size: 28, color: color),
      SizedBox(height: 6),
      Text(value,
          style: TextStyle(
              fontSize: 28, fontWeight: FontWeight.bold, color: color)),
      SizedBox(height: 4),
      Text(label, style: TextStyle(fontSize: 13, color: Colors.grey.shade600)),
    ]);
  }

  Widget _buildPhaseIndicator(String phase) {
    IconData icon;
    Color color;
    String text;

    switch (phase) {
      case "player_turn":
        icon = Icons.play_circle;
        color = const Color(0xFF34D399);
        text = "你的回合";
        break;
      case "dealer_turn":
        icon = Icons.casino;
        color = const Color(0xFFF87171);
        text = "庄家回合";
        break;
      default:
        icon = Icons.flag;
        color = const Color(0xFF60A5FA);
        text = phase;
        break;
    }

    return Column(children: [
      Icon(icon, size: 28, color: color),
      SizedBox(height: 6),
      Container(
        padding: EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: BoxDecoration(
            color: color.withOpacity(0.15),
            borderRadius: BorderRadius.circular(10)),
        child: Text(text,
            style: TextStyle(
                fontSize: 11, fontWeight: FontWeight.w600, color: color)),
      ),
      SizedBox(height: 4),
      Text("阶段", style: TextStyle(fontSize: 13, color: Colors.grey.shade600)),
    ]);
  }

  Widget _buildPlayerArea(List<dynamic> hand, int score) {
    return Container(
      width: double.infinity,
      padding: EdgeInsets.all(20),
      decoration: BoxDecoration(
        gradient: LinearGradient(
            begin: Alignment.bottomLeft,
            end: Alignment.topRight,
            colors: [
              const Color(0xFF60A5FA).withOpacity(0.08),
              Colors.transparent
            ]),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: const Color(0xFF60A5FA).withOpacity(0.2)),
      ),
      child: Column(
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.person, size: 24, color: const Color(0xFF60A5FA)),
              SizedBox(width: 8),
              Text("你",
                  style: TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                      color: const Color(0xFF60A5FA))),
              Spacer(),
              Container(
                padding: EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                decoration: BoxDecoration(
                  color: const Color(0xFF60A5FA).withOpacity(0.15),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(
                      color: const Color(0xFF60A5FA).withOpacity(0.3)),
                ),
                child: Text("$score 点",
                    style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.bold,
                        color: const Color(0xFF60A5FA))),
              ),
            ],
          ),
          SizedBox(height: 16),
          Wrap(
            alignment: WrapAlignment.center,
            spacing: 10,
            runSpacing: 10,
            children: <Widget>[
              for (int i = 0; i < hand.length; i++)
                _DealtCard(
                  index: i,
                  stableKey: hand[i]?.toString() ?? i,
                  from: const Offset(0.25, 0.65),
                  angle: (i - (hand.length - 1) / 2) * -0.035,
                  child: _buildPlayerCard(hand[i]?.toString() ?? ""),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildPlayerCard(String cardId) {
    final String suit = _bjSuit(cardId);
    final bool red = suit == "h" || suit == "d" || suit == "♥" || suit == "♦";
    final Color ink = red ? const Color(0xFFDC2626) : const Color(0xFF111827);
    return Container(
      width: 76,
      height: 106,
      decoration: BoxDecoration(
        gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [Colors.white, Colors.grey.shade100]),
        borderRadius: BorderRadius.circular(12),
        boxShadow: [
          BoxShadow(
              color: const Color(0xFF60A5FA).withOpacity(0.15),
              blurRadius: 10,
              offset: Offset(0, -4))
        ],
        border: Border.all(
            color: const Color(0xFF60A5FA).withOpacity(0.4), width: 2),
      ),
      child: Stack(
        children: <Widget>[
          Positioned(
              top: 8,
              left: 8,
              child: Text(_bjLabel(cardId),
                  style: TextStyle(
                      fontSize: 19, fontWeight: FontWeight.w800, color: ink))),
          Positioned(
              bottom: 7,
              right: 8,
              child: Text(suit, style: TextStyle(fontSize: 19, color: ink))),
          Center(child: Text(suit, style: TextStyle(fontSize: 30, color: ink))),
        ],
      ),
    );
  }

  Widget _buildScoreBoard() {
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [
            const Color(0xFF34D399).withOpacity(0.1),
            Colors.transparent
          ],
        ),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFF34D399).withOpacity(0.3)),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceAround,
        children: [
          _buildInfoItem("庄家", "${_snap["dealerScore"]} 点", Icons.casino,
              const Color(0xFFF87171)),
          _buildInfoItem("你", "${_snap["playerScore"]} 点", Icons.person,
              const Color(0xFF60A5FA)),
        ],
      ),
    );
  }

  Widget _buildInfoItem(
      String label, String value, IconData icon, Color color) {
    return Column(
      children: [
        Icon(icon, size: 28, color: color),
        const SizedBox(height: 8),
        Text(value,
            style: TextStyle(
                fontSize: 24, fontWeight: FontWeight.bold, color: color)),
        const SizedBox(height: 4),
        Text(label,
            style: const TextStyle(fontSize: 12, color: Color(0xFF71717A))),
      ],
    );
  }

  Widget _buildDealerSection(List<dynamic> hand) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Icon(Icons.casino, size: 20, color: Color(0xFFF87171)),
            const SizedBox(width: 8),
            Text("庄家的牌",
                style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    )),
          ],
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 10,
          runSpacing: 10,
          children: <Widget>[
            for (final Object? c in hand)
              _buildCard(c?.toString() ?? "", const Color(0xFFF87171)),
          ],
        ),
      ],
    );
  }

  Widget _buildPlayerSection(List<dynamic> hand) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Icon(Icons.person, size: 20, color: const Color(0xFF60A5FA)),
            const SizedBox(width: 8),
            Text("你的手牌",
                style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    )),
          ],
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 10,
          runSpacing: 10,
          children: <Widget>[
            for (final Object? c in hand)
              _buildCard(c?.toString() ?? "", const Color(0xFF60A5FA)),
          ],
        ),
      ],
    );
  }

  Widget _buildCard(String cardId, Color accentColor) {
    return Container(
      width: 70,
      height: 100,
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [Colors.white, Colors.grey.shade100],
        ),
        borderRadius: BorderRadius.circular(10),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.1),
            blurRadius: 6,
            offset: const Offset(0, 3),
          ),
        ],
        border: Border.all(color: accentColor.withOpacity(0.3), width: 2),
      ),
      child: Center(
        child: Text(_bjLabel(cardId),
            style: TextStyle(
                fontSize: 24,
                fontWeight: FontWeight.bold,
                color: Colors.black87)),
      ),
    );
  }

  Widget _buildStrategyHint(String hint) {
    final bool shouldHit = hint == "hit";
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [
            const Color(0xFF34D399).withOpacity(0.15),
            Colors.transparent
          ],
        ),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0xFF34D399).withOpacity(0.4)),
      ),
      child: Row(
        children: [
          Icon(Icons.lightbulb, color: const Color(0xFF34D399), size: 24),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text("AI 策略建议",
                    style: TextStyle(
                        fontWeight: FontWeight.w600,
                        color: const Color(0xFF34D399))),
                const SizedBox(height: 4),
                Text(shouldHit ? "建议要牌 (Hit)" : "建议停牌 (Stand)",
                    style: const TextStyle(
                        fontSize: 16, color: Color(0xFFA1A1AA))),
              ],
            ),
          ),
          Icon(shouldHit ? Icons.add_circle : Icons.stop_circle,
              size: 32, color: const Color(0xFF34D399)),
        ],
      ),
    );
  }

  Widget _buildActionButtons() {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        SizedBox(
          width: 120,
          child: FilledButton(
            onPressed: _busy ? null : _hit,
            style: FilledButton.styleFrom(
              padding: const EdgeInsets.symmetric(vertical: 10),
              backgroundColor: const Color(0xFF60A5FA),
            ),
            child: const Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(Icons.add_circle, size: 16),
                SizedBox(width: 6),
                Text("要牌", style: TextStyle(fontSize: 13)),
              ],
            ),
          ),
        ),
        const SizedBox(width: 12),
        SizedBox(
          width: 120,
          child: OutlinedButton(
            onPressed: _busy ? null : _stand,
            style: OutlinedButton.styleFrom(
              padding: const EdgeInsets.symmetric(vertical: 10),
              side: const BorderSide(color: const Color(0xFFF87171)),
            ),
            child: const Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(Icons.stop_circle, size: 16, color: Color(0xFFF87171)),
                SizedBox(width: 6),
                Text("停牌",
                    style: TextStyle(fontSize: 13, color: Color(0xFFF87171))),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildOutcome() {
    final String? outcome = _snap["outcome"]?.toString();
    return Container(
      padding: const EdgeInsets.all(32),
      decoration: BoxDecoration(
        color: const Color(0xFF1E1E1E),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFF2A2A2A)),
      ),
      child: Column(
        children: [
          Icon(_getOutcomeIcon(outcome),
              size: 64, color: _getOutcomeColor(outcome)),
          const SizedBox(height: 16),
          Text(_outcomeText(outcome),
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                    color: _getOutcomeColor(outcome),
                  )),
          const SizedBox(height: 12),
          Text("本局结束，再来一局？", style: TextStyle(color: Colors.grey.shade400)),
        ],
      ),
    );
  }

  IconData _getOutcomeIcon(String? outcome) {
    switch (outcome) {
      case "player_win":
      case "player_blackjack":
        return Icons.emoji_events;
      case "dealer_win":
      case "player_bust":
        return Icons.sentiment_dissatisfied;
      case "push":
        return Icons.handshake;
      default:
        return Icons.flag;
    }
  }

  Color _getOutcomeColor(String? outcome) {
    switch (outcome) {
      case "player_win":
      case "player_blackjack":
        return const Color(0xFF34D399);
      case "dealer_win":
      case "player_bust":
        return const Color(0xFFF87171);
      case "push":
        return const Color(0xFFFBBF24);
      default:
        return const Color(0xFF60A5FA);
    }
  }

  String _bjLabel(String id) {
    final int r = int.tryParse(id.split("-").first) ?? 0;
    if (r >= 2 && r <= 10) return "$r";
    if (r >= 11 && r <= 13) return <int, String>{11: "J", 12: "Q", 13: "K"}[r]!;
    if (r == 14) return "A";
    return id;
  }

  String _outcomeText(String? o) {
    switch (o) {
      case "player_win":
        return "🎉 你赢了！";
      case "player_blackjack":
        return "✨ Blackjack！你赢了！";
      case "dealer_win":
        return "😔 庄家获胜";
      case "player_bust":
        return "💥 爆牌了";
      case "push":
        return "🤝 平局";
      default:
        return "对局结束";
    }
  }
}
