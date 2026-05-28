import "dart:async";

import "package:flutter/material.dart";

import "../../core/services/world_api_client.dart";
import "../../core/utils/gomoku_player_session.dart";
import "../chat/widgets/game_chat_widget.dart";
import "../world/doudizhu_page.dart" show kDoudizhuCardLabel;

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
      final Map<String, dynamic> r =
          await widget.api.gameCenterZhajinhuaSnapshot(widget.tableId, _humanId);
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
        setState(() => _snap = (r["snapshot"] as Map<String, dynamic>?) ?? _snap);
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

    return Scaffold(
      appBar: AppBar(title: const Text("炸金花 · 游戏中心")),
      body: Stack(
        children: [
          SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                _buildGameInfo(status, pot),
                const SizedBox(height: 24),
                if (myHand != null)
                  _buildCards(myHand),
                const SizedBox(height: 32),
                if (status == "playing" && myTurn)
                  _buildActionButtons()
                else if (status == "finished")
                  _buildGameOver(),
              ],
            ),
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

  Widget _buildGameInfo(String status, int pot) {
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [const Color(0xFFFBBF24).withOpacity(0.1), Colors.transparent],
        ),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFFBBF24).withOpacity(0.3)),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceAround,
        children: [
          _buildInfoItem("底池", "$pot", Icons.monetization_on, const Color(0xFFFBBF24)),
          _buildInfoItem("状态", status == "playing" ? "进行中" : status, 
                         status == "playing" ? Icons.play_circle : Icons.flag, 
                         status == "playing" ? const Color(0xFF34D399) : const Color(0xFF60A5FA)),
        ],
      ),
    );
  }

  Widget _buildInfoItem(String label, String value, IconData icon, Color color) {
    return Column(
      children: [
        Icon(icon, size: 28, color: color),
        const SizedBox(height: 8),
        Text(value, style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold, color: color)),
        const SizedBox(height: 4),
        Text(label, style: const TextStyle(fontSize: 12, color: Color(0xFF71717A))),
      ],
    );
  }

  Widget _buildCards(List<dynamic> hand) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text("你的手牌", style: Theme.of(context).textTheme.titleMedium?.copyWith(
              fontWeight: FontWeight.w600,
            )),
        const SizedBox(height: 12),
        Wrap(
          spacing: 12,
          runSpacing: 12,
          children: <Widget>[
            for (final Object? c in hand)
              _buildCard(c?.toString() ?? ""),
          ],
        ),
      ],
    );
  }

  Widget _buildCard(String cardId) {
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
            Text(_cardLabel(cardId), style: const TextStyle(fontSize: 28, fontWeight: FontWeight.bold)),
            const SizedBox(height: 4),
            Text(_getCardSuit(cardId), style: const TextStyle(fontSize: 16)),
          ],
        ),
      ),
    );
  }

  String _getCardSuit(String id) {
    final List<String> p = id.split("-");
    if (p.length < 2) return "";
    final String suit = p[1];
    switch (suit) {
      case "h": return "♥";
      case "d": return "♦";
      case "c": return "♣";
      case "s": return "♠";
      default: return suit;
    }
  }

  Widget _buildActionButtons() {
    return Column(
      children: [
        FilledButton(
          onPressed: _busy ? null : () => _act("stay"),
          style: FilledButton.styleFrom(
            padding: const EdgeInsets.symmetric(vertical: 16),
            backgroundColor: const Color(0xFF34D399),
          ),
          child: const Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.casino),
              SizedBox(width: 8),
              Text("跟注 / 比牌", style: TextStyle(fontSize: 16)),
            ],
          ),
        ),
        const SizedBox(height: 12),
        OutlinedButton(
          onPressed: _busy ? null : () => _act("fold"),
          style: OutlinedButton.styleFrom(
            padding: const EdgeInsets.symmetric(vertical: 16),
            side: const BorderSide(color: Color(0xFFEF4444)),
          ),
          child: const Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.close, color: Color(0xFFEF4444)),
              SizedBox(width: 8),
              Text("弃牌", style: TextStyle(fontSize: 16, color: Color(0xFFEF4444))),
            ],
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
          Text("本局结束", textAlign: TextAlign.center, 
               style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                     color: const Color(0xFFF4F4F5),
                   )),
          const SizedBox(height: 12),
          Text("感谢对局，期待下一把！",
               style: TextStyle(color: Colors.grey.shade400)),
        ],
      ),
    );
  }

  String _cardLabel(String id) {
    final List<String> p = id.split("-");
    final int r = int.tryParse(p.isNotEmpty ? p[0]! : "") ?? 0;
    if (r >= 2 && r <= 10) return "$r";
    const Map<int, String> f = <int, String>{11: "J", 12: "Q", 13: "K", 14: "A"};
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
  bool _busy = false;
  final Set<String> _selected = <String>{};
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
        text: "欢迎来到斗地主！祝你成为牌桌之王！👑",
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
        _selected.removeWhere((String c) => !((_snap["myHand"] as List<dynamic>?)?.contains(c) ?? false));
      });
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
        });
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

    return Scaffold(
      appBar: AppBar(title: const Text("斗地主 · 游戏中心")),
      body: Stack(
        children: [
          SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                _buildGameStatus(status),
                const SizedBox(height: 24),
                if (myHand != null)
                  _buildCards(myHand),
                const SizedBox(height: 32),
                if (_isMyTurn)
                  _buildActionButtons()
                else if (status == "finished")
                  _buildGameOver(),
              ],
            ),
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

  Widget _buildGameStatus(String status) {
    final bool isLandlord = _snap["isLandlord"] == true;
    final String roleText = status == "bidding" ? "叫地主中..." :
                           isLandlord ? "你是地主 👑" : "你是农民 🌾";
    final Color roleColor = isLandlord ? const Color(0xFFF87171) : const Color(0xFF34D399);

    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [const Color(0xFFF87171).withOpacity(0.1), Colors.transparent],
        ),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFF87171).withOpacity(0.3)),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceAround,
        children: [
          _buildInfoItem("状态", status == "playing" ? "进行中" : status, 
                         Icons.play_circle, 
                         status == "playing" ? const Color(0xFF34D399) : const Color(0xFF60A5FA)),
          _buildInfoItem("身份", roleText, 
                         isLandlord ? Icons.workspace_premium : Icons.agriculture, 
                         roleColor),
        ],
      ),
    );
  }

  Widget _buildInfoItem(String label, String value, IconData icon, Color color) {
    return Column(
      children: [
        Icon(icon, size: 28, color: color),
        const SizedBox(height: 8),
        Text(value, style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600, color: color)),
        const SizedBox(height: 4),
        Text(label, style: const TextStyle(fontSize: 12, color: Color(0xFF71717A))),
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
            Text("你的手牌 (${hand.length}张)", style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w600,
                )),
            const Spacer(),
            if (_selected.isNotEmpty)
              Text("已选 ${_selected.length} 张", style: TextStyle(color: const Color(0xFF60A5FA), fontSize: 14)),
          ],
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: <Widget>[
            for (final Object? c in hand)
              _buildCard(c?.toString() ?? ""),
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
                ? [const Color(0xFF60A5FA).withOpacity(0.2), const Color(0xFF60A5FA).withOpacity(0.1)]
                : [Colors.white, Colors.grey.shade100],
          ),
          borderRadius: BorderRadius.circular(8),
          boxShadow: [
            BoxShadow(
              color: isSelected ? const Color(0xFF60A5FA).withOpacity(0.4) : Colors.black.withOpacity(0.1),
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
          child: Text(label, style: TextStyle(
            fontSize: 18,
            fontWeight: FontWeight.bold,
            color: _getCardColor(cardId),
          )),
        ),
      ),
    );
  }

  Color _getCardColor(String cardId) {
    final String suit = cardId.split("-").length > 1 ? cardId.split("-")[1] : "";
    if (suit == "h" || suit == "d") return const Color(0xFFF87171); // 红心/方块 - 红色
    return const Color(0xFF1F2937); // 黑桃/梅花 - 黑色
  }

  Widget _buildActionButtons() {
    return Column(
      children: [
        FilledButton(
          onPressed: _busy || _selected.isEmpty
              ? null
              : () => _play(action: "play", cards: _selected.toList()),
          style: FilledButton.styleFrom(
            padding: const EdgeInsets.symmetric(vertical: 16),
            backgroundColor: const Color(0xFFF87171),
          ),
          child: const Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.send),
              SizedBox(width: 8),
              Text("出牌", style: TextStyle(fontSize: 16)),
            ],
          ),
        ),
        const SizedBox(height: 12),
        OutlinedButton(
          onPressed: _busy ? null : () => _play(action: "pass"),
          style: OutlinedButton.styleFrom(
            padding: const EdgeInsets.symmetric(vertical: 16),
            side: const BorderSide(color: Color(0xFF71717A)),
          ),
          child: const Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.block, color: Color(0xFF71717A)),
              SizedBox(width: 8),
              Text("不出 (Pass)", style: TextStyle(fontSize: 16, color: Color(0xFF71717A))),
            ],
          ),
        ),
        if (_selected.isNotEmpty) ...[
          const SizedBox(height: 8),
          Text("提示：点击卡牌可以取消选择",
               style: TextStyle(fontSize: 12, color: Colors.grey.shade500)),
        ],
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
          Text("本局结束", textAlign: TextAlign.center,
               style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                     color: const Color(0xFFF4F4F5),
                   )),
          const SizedBox(height: 12),
          Text("精彩的对局！再来一局？",
               style: TextStyle(color: Colors.grey.shade400)),
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
    final List<dynamic> playerHand = _snap["playerHand"] as List<dynamic>? ?? <dynamic>[];
    final List<dynamic> dealerHand = _snap["dealerHand"] as List<dynamic>? ?? <dynamic>[];
    final String? hint = _snap["strategyHint"]?.toString();

    return Scaffold(
      appBar: AppBar(title: const Text("21 点 · 游戏中心")),
      body: Stack(
        children: [
          SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                _buildScoreBoard(),
                const SizedBox(height: 32),
                _buildDealerSection(dealerHand),
                const SizedBox(height: 24),
                _buildPlayerSection(playerHand),
                if (hint != null && playing) ...[
                  const SizedBox(height: 20),
                  _buildStrategyHint(hint),
                ],
                const SizedBox(height: 32),
                if (playing)
                  _buildActionButtons()
                else
                  _buildOutcome(),
              ],
            ),
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

  Widget _buildScoreBoard() {
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [const Color(0xFF34D399).withOpacity(0.1), Colors.transparent],
        ),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFF34D399).withOpacity(0.3)),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceAround,
        children: [
          _buildInfoItem("庄家", "${_snap["dealerScore"]} 点", Icons.casino, const Color(0xFFF87171)),
          _buildInfoItem("你", "${_snap["playerScore"]} 点", Icons.person, const Color(0xFF60A5FA)),
        ],
      ),
    );
  }

  Widget _buildInfoItem(String label, String value, IconData icon, Color color) {
    return Column(
      children: [
        Icon(icon, size: 28, color: color),
        const SizedBox(height: 8),
        Text(value, style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold, color: color)),
        const SizedBox(height: 4),
        Text(label, style: const TextStyle(fontSize: 12, color: Color(0xFF71717A))),
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
            Text("庄家的牌", style: Theme.of(context).textTheme.titleMedium?.copyWith(
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
            Text("你的手牌", style: Theme.of(context).textTheme.titleMedium?.copyWith(
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
        child: Text(_bjLabel(cardId), style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold, color: Colors.black87)),
      ),
    );
  }

  Widget _buildStrategyHint(String hint) {
    final bool shouldHit = hint == "hit";
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [const Color(0xFF34D399).withOpacity(0.15), Colors.transparent],
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
                Text("AI 策略建议", style: TextStyle(fontWeight: FontWeight.w600, color: const Color(0xFF34D399))),
                const SizedBox(height: 4),
                Text(shouldHit ? "建议要牌 (Hit)" : "建议停牌 (Stand)",
                     style: const TextStyle(fontSize: 16, color: Color(0xFFA1A1AA))),
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
    return Column(
      children: [
        FilledButton(
          onPressed: _busy ? null : _hit,
          style: FilledButton.styleFrom(
            padding: const EdgeInsets.symmetric(vertical: 16),
            backgroundColor: const Color(0xFF60A5FA),
          ),
          child: const Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.add_circle),
              SizedBox(width: 8),
              Text("要牌 (Hit)", style: TextStyle(fontSize: 16)),
            ],
          ),
        ),
        const SizedBox(height: 12),
        OutlinedButton(
          onPressed: _busy ? null : _stand,
          style: OutlinedButton.styleFrom(
            padding: const EdgeInsets.symmetric(vertical: 16),
            side: const BorderSide(color: const Color(0xFFF87171)),
          ),
          child: const Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.stop_circle, color: Color(0xFFF87171)),
              SizedBox(width: 8),
              Text("停牌 (Stand)", style: TextStyle(fontSize: 16, color: Color(0xFFF87171))),
            ],
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
          Icon(_getOutcomeIcon(outcome), size: 64, color: _getOutcomeColor(outcome)),
          const SizedBox(height: 16),
          Text(_outcomeText(outcome), textAlign: TextAlign.center,
               style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                     color: _getOutcomeColor(outcome),
                   )),
          const SizedBox(height: 12),
          Text("本局结束，再来一局？",
               style: TextStyle(color: Colors.grey.shade400)),
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
