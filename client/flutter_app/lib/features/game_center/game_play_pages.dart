import "dart:async";
import "dart:math";

import "package:flutter/material.dart";

import "../../core/services/world_api_client.dart";
import "../../core/utils/gomoku_player_session.dart";
import "../world/doudizhu_page.dart" show kDoudizhuCardLabel;

const Duration _dealDuration = Duration(milliseconds: 420);

// 预定义游戏卡片样式常量 - 避免每次 build 重新创建
class _GameCardStyles {
  _GameCardStyles._();
  
  // 牌背样式
  static final BoxDecoration cardBackDecoration = BoxDecoration(
    gradient: const LinearGradient(
      begin: Alignment.topLeft,
      end: Alignment.bottomRight,
      colors: [
        Color(0xFF1E40AF),
        Color(0xFF1E3A8A),
        Color(0xFF172554),
      ],
    ),
    borderRadius: BorderRadius.circular(8),
    border: Border.all(color: const Color(0xFF3B82F6).withValues(alpha: 0.4), width: 1.5),
    boxShadow: [
      BoxShadow(
        color: Colors.black.withValues(alpha: 0.25),
        blurRadius: 6,
        offset: const Offset(0, 3),
      ),
    ],
  );
  
  // 迷你牌正面样式（炸金花）
  static final BoxDecoration miniCardDecoration = BoxDecoration(
    gradient: const LinearGradient(
      begin: Alignment.topLeft,
      end: Alignment.bottomRight,
      colors: [Colors.white, Color(0xFFF3F4F6)],
    ),
    borderRadius: BorderRadius.circular(8),
    border: Border.all(color: const Color(0xFFFBBF24).withValues(alpha: 0.5), width: 1),
    boxShadow: [
      BoxShadow(
        color: Colors.black.withValues(alpha: 0.1),
        blurRadius: 4,
        offset: const Offset(0, 2),
      ),
    ],
  );
}

/// 游戏阶段枚举：统一管理所有游戏的生命周期
enum _GamePhase {
  /// 准备阶段：显示「开始」按钮，等待用户点击
  preparing,

  /// 发牌中：正在播放发牌动画
  dealing,

  /// 游戏进行中
  playing,

  /// 游戏已结束
  finished,
}

/// 单张扑克牌背面样式
Widget _buildCardBack({double width = 60, double height = 84, Color? accentColor}) {
  return Container(
    width: width,
    height: height,
    decoration: _GameCardStyles.cardBackDecoration,
    child: Center(
      child: Container(
        width: width * 0.7,
        height: height * 0.75,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(4),
          border: Border.all(
            color: Colors.white.withValues(alpha: 0.15),
            width: 1,
          ),
        ),
        child: Center(
          child: Icon(
            Icons.casino_outlined,
            size: min(width, height) * 0.32,
            color: Colors.white.withValues(alpha: 0.35),
          ),
        ),
      ),
    ),
  );
}

/// 真实发牌动画组件：从中央牌堆逐张飞入目标位置
class _RealisticDealAnimation extends StatefulWidget {
  const _RealisticDealAnimation({
    required this.totalCards,
    required this.cardBuildFn,
    this.dealIntervalMs = 180,
    this.onDealComplete,
    this.accentColor,
    this.title,
  });

  final int totalCards;
  final Widget Function(int index) cardBuildFn;
  final int dealIntervalMs;
  final VoidCallback? onDealComplete;
  final Color? accentColor;
  final String? title;

  @override
  State<_RealisticDealAnimation> createState() =>
      _RealisticDealAnimationState();
}

class _RealisticDealAnimationState extends State<_RealisticDealAnimation>
    with TickerProviderStateMixin {
  int _dealtCount = 0;
  late Timer _dealTimer;

  @override
  void initState() {
    super.initState();
    _startDealing();
  }

  void _startDealing() {
    if (widget.totalCards <= 0) {
      _finishDealing();
      return;
    }
    _dealTimer = Timer.periodic(
      Duration(milliseconds: widget.dealIntervalMs), (Timer timer) {
        if (!mounted) {
          timer.cancel();
          return;
        }
        if (_dealtCount < widget.totalCards) {
          setState(() => _dealtCount++);
        } else {
          timer.cancel();
          _finishDealing();
        }
      });
  }

  void _finishDealing() {
    Future<void>.delayed(const Duration(milliseconds: 400), () {
      if (!mounted) return;
      widget.onDealComplete?.call();
    });
  }

  @override
  void dispose() {
    _dealTimer.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final Size screenSize = MediaQuery.of(context).size;
    final Color accent = widget.accentColor ?? const Color(0xFFFBBF24);

    return Stack(
      children: [
        // 背景暗化层
        Positioned.fill(
          child: Container(
            color: Colors.black.withValues(alpha: 0.25),
          ),
        ),
        // 中央牌堆区域
        Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              // 牌堆（剩余未发的牌）
              AnimatedOpacity(
                opacity: _dealtCount >= widget.totalCards ? 0.0 : 1.0,
                duration: const Duration(milliseconds: 300),
                child: Column(
                  children: [
                    _buildCardBack(width: 70, height: 98, accentColor: accent),
                    const SizedBox(height: 12),
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 14, vertical: 6),
                      decoration: BoxDecoration(
                        color: Colors.black.withValues(alpha: 0.5),
                        borderRadius: BorderRadius.circular(20),
                      ),
                      child: Text(
                        widget.title ?? "正在发牌...",
                        style: TextStyle(
                          fontSize: 13,
                          color: accent,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 30),
              // 发牌进度
              if (_dealtCount < widget.totalCards)
                Text(
                  "$_dealtCount / ${widget.totalCards}",
                  style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.bold,
                    color: Colors.white.withValues(alpha: 0.8),
                  ),
                )
              else
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.check_circle, size: 18, color: accent),
                    const SizedBox(width: 6),
                    Text(
                      "发牌完成",
                      style: TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                        color: accent,
                      ),
                    ),
                  ],
                ),
              const SizedBox(height: 24),
              // 已发出的牌（逐张显示）
              SizedBox(
                width: screenSize.width * 0.8,
                height: 130,
                child: SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  physics: const BouncingScrollPhysics(),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      for (int i = 0; i < _dealtCount; i++)
                        Padding(
                          padding: const EdgeInsets.only(right: 8),
                          child: _FlyingCardIn(
                            index: i,
                            child: widget.cardBuildFn(i),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
        // 进度条
        Positioned(
          bottom: 40,
          left: 40,
          right: 40,
          child: ClipRRect(
            borderRadius: BorderRadius.circular(6),
            child: LinearProgressIndicator(
              value: widget.totalCards > 0
                  ? _dealtCount / widget.totalCards
                  : 1.0,
              minHeight: 6,
              backgroundColor: Colors.white.withValues(alpha: 0.15),
              valueColor: AlwaysStoppedAnimation<Color>(accent),
            ),
          ),
        ),
      ],
    );
  }
}

/// 飞入中的单张牌动画
class _FlyingCardIn extends StatefulWidget {
  const _FlyingCardIn({required this.index, required this.child});
  final int index;
  final Widget child;

  @override
  State<_FlyingCardIn> createState() => _FlyingCardInState();
}

class _FlyingCardInState extends State<_FlyingCardIn>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _flyAnim;
  late Animation<double> _scaleAnim;
  late Animation<double> _opacityAnim;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 450),
    );
    _flyAnim = Tween<double>(begin: -80.0, end: 0.0).animate(CurvedAnimation(
      parent: _controller,
      curve: Curves.easeOutCubic,
    ));
    _scaleAnim =
        Tween<double>(begin: 0.5, end: 1.0).animate(CurvedAnimation(
      parent: _controller,
      curve: Curves.easeOutBack,
    ));
    _opacityAnim =
        Tween<double>(begin: 0.0, end: 1.0).animate(CurvedAnimation(
      parent: _controller,
      curve: const Interval(0.0, 0.6, curve: Curves.easeOut),
    ));
    _controller.forward();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (BuildContext context, Widget? child) {
        return Transform.translate(
          offset: Offset(0, _flyAnim.value),
          child: Transform.scale(
            scale: _scaleAnim.value,
            child: Opacity(
              opacity: _opacityAnim.value,
              child: child,
            ),
          ),
        );
      },
      child: widget.child,
    );
  }
}

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
  _GamePhase _phase = _GamePhase.preparing;
  String get _humanId => GomokuPlayerSession.humanId(widget.agentId);

  @override
  void initState() {
    super.initState();
    _snap = widget.initialSnapshot;
    _poll = Timer.periodic(const Duration(seconds: 2), (_) => _refresh());
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
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(r["reason"]?.toString() ?? "操作失败")),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
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
      body: Container(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [
              const Color(0xFF1B5E20).withValues(alpha: 0.1),
              const Color(0xFF2E7D32).withValues(alpha: 0.05)
            ],
          ),
        ),
        child: _phase == _GamePhase.preparing
            ? _buildPreparationRoom(seats)
            : _phase == _GamePhase.dealing
                ? _buildZhajinhuaDealAnimation(myHand, seats)
                : playerCount > 0
                    ? _buildRoundTableLayout(
                        status, pot, seats, inHand, turnSeat, myHand, myTurn)
                    : _buildWaitingRoom(),
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
                  const Color(0xFFFBBF24).withValues(alpha: 0.3),
                  const Color(0xFFFBBF24).withValues(alpha: 0.1),
                  Colors.transparent,
                ]),
                border: Border.all(
                    color: const Color(0xFFFBBF24).withValues(alpha: 0.4), width: 2),
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
                color: Colors.white.withValues(alpha: 0.9),
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
                      color: const Color(0xFF34D399).withValues(alpha: 0.1),
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
        setState(() => _phase = _GamePhase.dealing);
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
            const Color(0xFFFBBF24).withValues(alpha: 0.3),
            const Color(0xFFFBBF24).withValues(alpha: 0.1),
            Colors.transparent,
          ],
        ),
        border: Border.all(
          color: const Color(0xFFFBBF24).withValues(alpha: 0.4),
          width: 2,
        ),
        boxShadow: [
          BoxShadow(
            color: const Color(0xFFFBBF24).withValues(alpha: 0.2),
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
                  ? const Color(0xFF34D399).withValues(alpha: 0.2)
                  : const Color(0xFF60A5FA).withValues(alpha: 0.2),
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
      child: RepaintBoundary(
        child: AnimatedContainer(
        duration: Duration(milliseconds: 300),
        transform: Matrix4.translationValues(0, isMyTurn ? -10 : 0, 0),
        child: _buildPlayerCard(
            seatIndex, isOccupied, stillIn, isMyTurn, isMe, sessionId),
        ),
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
                  const Color(0xFFFBBF24).withValues(alpha: 0.3),
                  const Color(0xFFFBBF24).withValues(alpha: 0.1)
                ]
              : isOccupied
                  ? [Colors.white.withValues(alpha: 0.95), Colors.grey.shade50]
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
                ? const Color(0xFFFBBF24).withValues(alpha: 0.4)
                : Colors.black.withValues(alpha: 0.1),
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
                          ? const Color(0xFF34D399).withValues(alpha: 0.2)
                          : const Color(0xFFEF4444).withValues(alpha: 0.2),
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
                      color: const Color(0xFFFBBF24).withValues(alpha: 0.6),
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
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Container(
        padding: EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        decoration: BoxDecoration(
          color: Colors.white.withValues(alpha: 0.9),
          borderRadius: BorderRadius.circular(20),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.15),
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
      decoration: _GameCardStyles.miniCardDecoration,
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
                  const Color(0xFFFBBF24).withValues(alpha: 0.3),
                  const Color(0xFFFBBF24).withValues(alpha: 0.1),
                  Colors.transparent,
                ],
              ),
              border: Border.all(
                color: const Color(0xFFFBBF24).withValues(alpha: 0.4),
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

  /// 构建炸金花发牌动画界面
  Widget _buildZhajinhuaDealAnimation(List<dynamic>? myHand, List<dynamic>? seats) {
    // 炸金花：3位玩家各3张，共9张牌
    final int totalCards = (myHand?.length ?? 0) * 3;
    return _RealisticDealAnimation(
      totalCards: totalCards,
      accentColor: const Color(0xFFFBBF24),
      title: "炸金花 · 发牌中...",
      dealIntervalMs: 180,
      cardBuildFn: (int index) => _buildMiniCard(
        myHand != null && index < myHand.length
            ? myHand[index]?.toString() ?? ""
            : "",
      ),
      onDealComplete: () {
        if (mounted) {
          final String status = _snap["status"]?.toString() ?? "";
          setState(() {
            _phase = (status == "finished")
                ? _GamePhase.finished
                : _GamePhase.playing;
          });
        }
      },
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
    final int r = int.tryParse(p.isNotEmpty ? p[0] : "") ?? 0;
    if (r >= 2 && r <= 10) return "$r";
    const Map<int, String> f = <int, String>{
      11: "J",
      12: "Q",
      13: "K",
      14: "A"
    };
    return f[r] ?? id;
  }

  Widget _buildActionButtons() {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          FilledButton(
            onPressed: _busy ? null : () => _act("stay"),
            style: FilledButton.styleFrom(
              padding: const EdgeInsets.symmetric(vertical: 16),
              backgroundColor: const Color(0xFF34D399),
            ),
            child: const Row(
              mainAxisSize: MainAxisSize.min,
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(Icons.casino),
                SizedBox(width: 8),
                Text("跟注 / 弃牌", style: TextStyle(fontSize: 16)),
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
              mainAxisSize: MainAxisSize.min,
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(Icons.close, color: Color(0xFFEF4444)),
                SizedBox(width: 8),
                Text("弃牌", style: TextStyle(fontSize: 16, color: Color(0xFFEF4444))),
              ],
            ),
          ),
        ],
      ),
    );
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
  _GamePhase _phase = _GamePhase.preparing;
  final Set<String> _selected = <String>{};
  String get _humanId => GomokuPlayerSession.humanId(widget.agentId);

  @override
  void initState() {
    super.initState();
    _snap = widget.initialSnapshot;
    _poll = Timer.periodic(const Duration(seconds: 2), (_) => _refresh());
    _scheduleDealIfNeeded();
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
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(r["reason"]?.toString() ?? "出牌失败")),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final List<dynamic>? myHand = _snap["myHand"] as List<dynamic>?;
    final String status = _snap["status"]?.toString() ?? "";
    final int? landlordSeat = (_snap["landlordSeat"] as num?)?.round();
    final int? mySeat = (_snap["mySeat"] as num?)?.round();
    final int? turnSeat = (_snap["turnSeat"] as num?)?.round();
    final List<dynamic>? handCounts = _snap["handCounts"] as List<dynamic>?;
    final dynamic lastPlay = _snap["lastNonPass"];
    final bool isLandlord = _snap["isLandlord"] == true;
    final List<dynamic>? seats = _snap["seats"] as List<dynamic>?;

    return Scaffold(
      appBar: AppBar(title: const Text("斗地主 · 游戏")),
      body: Container(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [
              const Color(0xFF7F1D1D).withValues(alpha: 0.08),
              const Color(0xFF991B1B).withValues(alpha: 0.03)
            ],
          ),
        ),
        child: _phase == _GamePhase.preparing
            ? _buildPreparationRoom(seats)
            : _phase == _GamePhase.dealing
                ? _buildDoudizhuDealAnimation(myHand, seats)
                : (status == "bidding")
                    ? _buildBiddingRoom()
                    : _buildTriangleTableLayout(status, landlordSeat, mySeat,
                        turnSeat, handCounts, lastPlay, myHand, isLandlord),
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
                  const Color(0xFFF87171).withValues(alpha: 0.3),
                  const Color(0xFFF87171).withValues(alpha: 0.1),
                  Colors.transparent,
                ]),
                border: Border.all(
                    color: const Color(0xFFF87171).withValues(alpha: 0.4), width: 2),
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
                color: Colors.white.withValues(alpha: 0.9),
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
                      color: const Color(0xFF34D399).withValues(alpha: 0.1),
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
        setState(() => _phase = _GamePhase.dealing);
        _scheduleDealIfNeeded();
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
        border: Border.all(color: const Color(0xFF34D399).withValues(alpha: 0.22)),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.2),
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
                border: Border.all(color: Colors.white.withValues(alpha: 0.05)),
              ),
            ),
          ),
          Column(
            children: [
              SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(
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
                    const SizedBox(width: 10),
                    _buildTurnChip(status, turnSeat, mySeat),
                  ],
                ),
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
        color: Colors.black.withValues(alpha: 0.2),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: color.withValues(alpha: 0.24)),
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
                      fontSize: 10, color: Colors.white.withValues(alpha: 0.62))),
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
        color: color.withValues(alpha: 0.16),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.32)),
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
        color: Colors.white.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: Colors.white.withValues(alpha: 0.1)),
      ),
      child: Text(
        status == "playing" ? "等待第一手出牌" : "牌桌准备中",
        style: TextStyle(
          fontSize: 14,
          fontWeight: FontWeight.w700,
          color: Colors.white.withValues(alpha: 0.82),
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
        color: Colors.white.withValues(alpha: isTurn ? 0.18 : 0.1),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: (isTurn ? const Color(0xFF34D399) : Colors.white)
              .withValues(alpha: 0.22),
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
            overflow: TextOverflow.ellipsis,
          ),
        ],
      ),
    );
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
                    const Color(0xFFF87171).withValues(alpha: 0.25),
                    const Color(0xFFF87171).withValues(alpha: 0.08)
                  ]
                : [Colors.white.withValues(alpha: 0.95), Colors.grey.shade50],
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
                  ? const Color(0xFFF87171).withValues(alpha: 0.35)
                  : Colors.black.withValues(alpha: 0.08),
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
                        color: const Color(0xFF7F1D1D).withValues(alpha: 0.1),
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
                          color: const Color(0xFFF87171).withValues(alpha: 0.5),
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
          color: Colors.white.withValues(alpha: 0.95),
          borderRadius: BorderRadius.circular(16),
          boxShadow: [
            BoxShadow(color: Colors.black.withValues(alpha: 0.1), blurRadius: 10)
          ],
          border: Border.all(color: const Color(0xFFF87171).withValues(alpha: 0.2)),
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
              SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Wrap(
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
                ),
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
          BoxShadow(color: Colors.black.withValues(alpha: 0.08), blurRadius: 3)
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
          color: Colors.white.withValues(alpha: 0.94),
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: const Color(0xFFF87171).withValues(alpha: 0.22)),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.12),
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
          color: Colors.white.withValues(alpha: 0.92),
          borderRadius: BorderRadius.circular(18),
          boxShadow: [
            BoxShadow(
                color: Colors.black.withValues(alpha: 0.12),
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
                        color: const Color(0xFF60A5FA).withValues(alpha: 0.15),
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
                const Color(0xFFFBBF24).withValues(alpha: 0.3),
                const Color(0xFFFBBF24).withValues(alpha: 0.1),
                Colors.transparent
              ]),
              border: Border.all(
                  color: const Color(0xFFFBBF24).withValues(alpha: 0.4), width: 2),
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
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
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


  Color _getCardColor(String cardId) {
    final String suit =
        cardId.split("-").length > 1 ? cardId.split("-")[1] : "";
    if (suit == "h" || suit == "d") {
      return const Color(0xFFF87171); // 红心/方块 - 红色
    }
    return const Color(0xFF1F2937); // 黑桃/梅花 - 黑色
  }

  /// 构建斗地主发牌动画界面
  Widget _buildDoudizhuDealAnimation(List<dynamic>? myHand, List<dynamic>? seats) {
    // 斗地主：3位玩家各17张 + 3张底牌 = 54张
    final int totalCards = (myHand?.length ?? 17) * 3 + 3;
    return _RealisticDealAnimation(
      totalCards: totalCards,
      accentColor: const Color(0xFFF87171),
      title: "斗地主 · 发牌中...",
      dealIntervalMs: 100,
      cardBuildFn: (int index) => _buildMiniDoudizhuCard(
        myHand != null && index < myHand.length
            ? myHand[index]?.toString() ?? ""
            : "",
      ),
      onDealComplete: () {
        if (mounted) {
          final String status = _snap["status"]?.toString() ?? "";
          setState(() {
            _phase = (status == "finished")
                ? _GamePhase.finished
                : _GamePhase.playing;
            _showHandCards = true;
          });
        }
      },
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
                    const Color(0xFF60A5FA).withValues(alpha: 0.2),
                    const Color(0xFF60A5FA).withValues(alpha: 0.1)
                  ]
                : [Colors.white, Colors.grey.shade100],
          ),
          borderRadius: BorderRadius.circular(8),
          boxShadow: [
            BoxShadow(
              color: isSelected
                  ? const Color(0xFF60A5FA).withValues(alpha: 0.4)
                  : Colors.black.withValues(alpha: 0.1),
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
  _GamePhase _phase = _GamePhase.preparing;
  String get _humanId => GomokuPlayerSession.humanId(widget.agentId);

  @override
  void initState() {
    super.initState();
    _snap = widget.initialSnapshot;
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
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
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

    return Scaffold(
      appBar: AppBar(title: const Text("21 点 · 游戏")),
      body: Container(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [
              const Color(0xFF065F46).withValues(alpha: 0.08),
              const Color(0xFF047857).withValues(alpha: 0.03)
            ],
          ),
        ),
        child: _phase == _GamePhase.preparing
            ? _buildPreparationRoom()
            : _phase == _GamePhase.dealing
                ? _buildDealingAnimation(dealerHand, playerHand)
                : _buildBlackjackTableLayout(phase, playing, dealerHand,
                    playerHand, dealerScore, playerScore),
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
                  const Color(0xFF34D399).withValues(alpha: 0.3),
                  const Color(0xFF34D399).withValues(alpha: 0.1),
                  Colors.transparent,
                ]),
                border: Border.all(
                    color: const Color(0xFF34D399).withValues(alpha: 0.4), width: 2),
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
                color: Colors.white.withValues(alpha: 0.9),
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
        setState(() => _phase = _GamePhase.dealing);
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
            const Color(0xFFF87171).withValues(alpha: 0.08),
            Colors.transparent
          ],
        ),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: const Color(0xFFF87171).withValues(alpha: 0.2)),
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
                  color: const Color(0xFFF87171).withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(
                      color: const Color(0xFFF87171).withValues(alpha: 0.3)),
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
              color: Colors.black.withValues(alpha: 0.1),
              blurRadius: 8,
              offset: Offset(0, 4))
        ],
        border: Border.all(
            color: const Color(0xFFF87171).withValues(alpha: 0.3), width: 2),
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
          const Color(0xFF34D399).withValues(alpha: 0.15),
          const Color(0xFF34D399).withValues(alpha: 0.05),
          Colors.transparent,
        ]),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: const Color(0xFF34D399).withValues(alpha: 0.25)),
      ),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
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
            color: color.withValues(alpha: 0.15),
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
              const Color(0xFF60A5FA).withValues(alpha: 0.08),
              Colors.transparent
            ]),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: const Color(0xFF60A5FA).withValues(alpha: 0.2)),
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
                  color: const Color(0xFF60A5FA).withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(
                      color: const Color(0xFF60A5FA).withValues(alpha: 0.3)),
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
              color: const Color(0xFF60A5FA).withValues(alpha: 0.15),
              blurRadius: 10,
              offset: Offset(0, -4))
        ],
        border: Border.all(
            color: const Color(0xFF60A5FA).withValues(alpha: 0.4), width: 2),
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

  /// 发牌动画完成后，根据游戏阶段决定下一步
  void _onDealComplete() {
    final String bjPhase = _snap["phase"]?.toString() ?? "";
    if (mounted) {
      setState(() {
        _phase = (bjPhase == "finished")
            ? _GamePhase.finished
            : _GamePhase.playing;
      });
    }
  }

  /// 构建发牌动画界面
  Widget _buildDealingAnimation(List<dynamic> dealerHand, List<dynamic> playerHand) {
    // 合并庄家和玩家手牌作为总牌数
    final List<dynamic> allCards = [...dealerHand, ...playerHand];
    return _RealisticDealAnimation(
      totalCards: allCards.length,
      accentColor: const Color(0xFF34D399),
      title: "21点 · 发牌中...",
      dealIntervalMs: 200,
      cardBuildFn: (int index) {
        if (index < dealerHand.length) {
          return _buildMiniBjCard(dealerHand[index]?.toString() ?? "");
        } else {
          final int pIndex = index - dealerHand.length;
          return _buildMiniBjCard(playerHand[pIndex]?.toString() ?? "");
        }
      },
      onDealComplete: _onDealComplete,
    );
  }

  /// 迷你扑克牌用于21点发牌动画
  Widget _buildMiniBjCard(String cardId) {
    final String suit = _bjSuit(cardId);
    final bool red = suit == "h" || suit == "d" || suit == "♥" || suit == "♦";
    final Color ink = red ? const Color(0xFFDC2626) : const Color(0xFF111827);
    return Container(
      width: 50,
      height: 70,
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [Colors.white, Colors.grey.shade100],
        ),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: const Color(0xFF34D399).withValues(alpha: 0.4), width: 1.5),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.15),
            blurRadius: 4,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      child: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(_bjLabel(cardId),
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: ink)),
            SizedBox(height: 2),
            Text(suit, style: TextStyle(fontSize: 13, color: ink)),
          ],
        ),
      ),
    );
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
            side: BorderSide(color: const Color(0xFFF87171)),
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
}
