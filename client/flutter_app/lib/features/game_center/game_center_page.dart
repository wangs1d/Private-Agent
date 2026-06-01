import "package:flutter/material.dart";

import "../../core/services/world_api_client.dart";
import "../../core/services/ws_chat_service.dart";
import "../../core/theme/app_theme.dart";
import "../../core/utils/play_url_utils.dart";
import "game_play_pages.dart";
import "../gomoku/gomoku_page.dart";

enum _GameIconType { gomoku, zhajinhua, blackjack, doudizhu }

class _GameIcon extends StatelessWidget {
  const _GameIcon({
    required this.type,
    required this.accent,
  });

  final _GameIconType type;
  final Color accent;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 88,
      height: 88,
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[
            accent.withValues(alpha: 0.25),
            accent.withValues(alpha: 0.08),
          ],
        ),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: accent.withValues(alpha: 0.2)),
      ),
      child: Center(
        child: _buildIconContent(),
      ),
    );
  }

  Widget _buildIconContent() {
    switch (type) {
      case _GameIconType.gomoku:
        return _GomokuIcon(accent: accent);
      case _GameIconType.zhajinhua:
        return _ZhajinhuaIcon(accent: accent);
      case _GameIconType.blackjack:
        return _BlackjackIcon(accent: accent);
      case _GameIconType.doudizhu:
        return _DoudizhuIcon(accent: accent);
    }
  }
}

class _GomokuIcon extends StatelessWidget {
  const _GomokuIcon({required this.accent});

  final Color accent;

  @override
  Widget build(BuildContext context) {
    return Stack(
      alignment: Alignment.center,
      children: <Widget>[
        Container(
          width: 60,
          height: 60,
          decoration: BoxDecoration(
            color: const Color(0xFF2A2A2A),
            borderRadius: BorderRadius.circular(8),
          ),
          child: CustomPaint(
            painter: _GomokuBoardPainter(),
          ),
        ),
        Positioned(
          top: 12,
          left: 12,
          child: Container(
            width: 12,
            height: 12,
            decoration: BoxDecoration(
              color: Colors.black,
              borderRadius: BorderRadius.circular(6),
              boxShadow: const <BoxShadow>[
                BoxShadow(color: Colors.black54, blurRadius: 2),
              ],
            ),
          ),
        ),
        Positioned(
          top: 12,
          left: 24,
          child: Container(
            width: 12,
            height: 12,
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(6),
              border: Border.all(color: const Color(0xFF3A3A3A)),
              boxShadow: const <BoxShadow>[
                BoxShadow(color: Colors.black26, blurRadius: 2),
              ],
            ),
          ),
        ),
        Positioned(
          top: 24,
          left: 12,
          child: Container(
            width: 12,
            height: 12,
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(6),
              border: Border.all(color: const Color(0xFF3A3A3A)),
              boxShadow: const <BoxShadow>[
                BoxShadow(color: Colors.black26, blurRadius: 2),
              ],
            ),
          ),
        ),
        Positioned(
          top: 24,
          left: 24,
          child: Container(
            width: 12,
            height: 12,
            decoration: BoxDecoration(
              color: Colors.black,
              borderRadius: BorderRadius.circular(6),
              boxShadow: const <BoxShadow>[
                BoxShadow(color: Colors.black54, blurRadius: 2),
              ],
            ),
          ),
        ),
        Positioned(
          top: 36,
          left: 36,
          child: Container(
            width: 12,
            height: 12,
            decoration: BoxDecoration(
              color: accent,
              borderRadius: BorderRadius.circular(6),
              boxShadow: <BoxShadow>[
                BoxShadow(color: accent.withValues(alpha: 0.5), blurRadius: 3),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _GomokuBoardPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final Paint paint = Paint()
      ..color = const Color(0xFF3A3A3A)
      ..strokeWidth = 1;

    for (int i = 0; i <= 3; i++) {
      final double y = 10 + i * 14;
      canvas.drawLine(Offset(10, y), Offset(size.width - 10, y), paint);
    }

    for (int i = 0; i <= 3; i++) {
      final double x = 10 + i * 14;
      canvas.drawLine(Offset(x, 10), Offset(x, size.height - 10), paint);
    }
  }

  @override
  bool shouldRepaint(_GomokuBoardPainter oldDelegate) => false;
}

class _ZhajinhuaIcon extends StatelessWidget {
  const _ZhajinhuaIcon({required this.accent});

  final Color accent;

  @override
  Widget build(BuildContext context) {
    return Stack(
      alignment: Alignment.center,
      children: <Widget>[
        Transform.translate(
          offset: const Offset(-12, 0),
          child: _PlayingCard(
            suit: "♥",
            rank: "A",
            color: const Color(0xFFEF4444),
          ),
        ),
        Transform.translate(
          offset: const Offset(-4, 0),
          child: _PlayingCard(
            suit: "♦",
            rank: "K",
            color: const Color(0xFFEF4444),
          ),
        ),
        _PlayingCard(
          suit: "♣",
          rank: "Q",
          color: const Color(0xFF374151),
          highlight: true,
          accent: accent,
        ),
      ],
    );
  }
}

class _PlayingCard extends StatelessWidget {
  const _PlayingCard({
    required this.suit,
    required this.rank,
    required this.color,
    this.highlight = false,
    this.accent,
  });

  final String suit;
  final String rank;
  final Color color;
  final bool highlight;
  final Color? accent;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 40,
      height: 56,
      decoration: BoxDecoration(
        color: highlight ? accent?.withValues(alpha: 0.15) ?? Colors.white : Colors.white,
        borderRadius: BorderRadius.circular(6),
        border: highlight
            ? Border.all(color: accent ?? Colors.grey, width: 2)
            : Border.all(color: const Color(0xFFE5E7EB)),
        boxShadow: highlight
            ? <BoxShadow>[
                BoxShadow(color: accent?.withValues(alpha: 0.3) ?? Colors.black12, blurRadius: 8),
              ]
            : const <BoxShadow>[
                BoxShadow(color: Colors.black12, blurRadius: 4),
              ],
      ),
      padding: const EdgeInsets.all(4),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.spaceEvenly,
        children: <Widget>[
          Text(
            rank,
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.bold,
              color: color,
            ),
          ),
          Text(
            suit,
            style: TextStyle(
              fontSize: 20,
              color: color,
            ),
          ),
        ],
      ),
    );
  }
}

class _BlackjackIcon extends StatelessWidget {
  const _BlackjackIcon({required this.accent});

  final Color accent;

  @override
  Widget build(BuildContext context) {
    return Stack(
      alignment: Alignment.center,
      children: <Widget>[
        Container(
          width: 56,
          height: 56,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: <Color>[
                accent.withValues(alpha: 0.3),
                accent.withValues(alpha: 0.05),
              ],
            ),
            border: Border.all(color: accent.withValues(alpha: 0.3)),
          ),
        ),
        Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            Text(
              "21",
              style: TextStyle(
                fontSize: 28,
                fontWeight: FontWeight.w800,
                color: accent,
                letterSpacing: -1,
              ),
            ),
            Container(
              width: 24,
              height: 3,
              decoration: BoxDecoration(
                color: accent,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ],
        ),
        Positioned(
          top: 4,
          right: 4,
          child: Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(
              color: accent,
              shape: BoxShape.circle,
            ),
          ),
        ),
        Positioned(
          bottom: 4,
          left: 4,
          child: Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(
              color: accent.withValues(alpha: 0.6),
              shape: BoxShape.circle,
            ),
          ),
        ),
      ],
    );
  }
}

class _DoudizhuIcon extends StatelessWidget {
  const _DoudizhuIcon({required this.accent});

  final Color accent;

  @override
  Widget build(BuildContext context) {
    return Stack(
      alignment: Alignment.center,
      children: <Widget>[
        Container(
          width: 52,
          height: 52,
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: <Color>[
                accent,
                accent.withValues(alpha: 0.6),
              ],
            ),
            borderRadius: BorderRadius.circular(26),
            boxShadow: <BoxShadow>[
              BoxShadow(color: accent.withValues(alpha: 0.4), blurRadius: 12),
            ],
          ),
          child: const Icon(
            Icons.whatshot,
            size: 28,
            color: Colors.white,
          ),
        ),
        Positioned(
          top: 2,
          left: 2,
          child: const Icon(
            Icons.star,
            size: 10,
            color: Colors.white,
          ),
        ),
        Positioned(
          top: 2,
          right: 2,
          child: const Icon(
            Icons.star,
            size: 10,
            color: Colors.white,
          ),
        ),
        Positioned(
          top: -4,
          child: Container(
            width: 3,
            height: 8,
            decoration: BoxDecoration(
              color: accent,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
        ),
      ],
    );
  }
}

/// 游戏：统计条 + 游戏卡片网格（与产品设计稿一致）。
class GameCenterPage extends StatefulWidget {
  const GameCenterPage({
    super.key,
    required this.actorId,
    required this.api,
    required this.ws,
  });

  final String actorId;
  final WorldApiClient api;
  final WsChatService ws;

  @override
  State<GameCenterPage> createState() => _GameCenterPageState();
}

class _GameCenterPageState extends State<GameCenterPage> {
  static const double _contentMaxWidth = 1152;

  _GameId? _launching;

  Future<void> _ensureWs() async {
    if (widget.ws.isConnected) return;
    widget.ws.retryConnect();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text("正在连接服务器，请稍后再试")),
    );
    throw StateError("ws disconnected");
  }

  Future<void> _startGame(_GameId id) async {
    if (_launching != null) return;
    setState(() => _launching = id);
    try {
      await _ensureWs();
      switch (id) {
        case _GameId.gomoku:
          await _startGomoku();
        case _GameId.zhajinhua:
          await _startZhajinhua();
        case _GameId.blackjack:
          await _startBlackjack();
        case _GameId.doudizhu:
          await _startDoudizhu();
      }
    } on StateError {
      // ws 提示已展示
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("无法开始游戏：$e")),
      );
    } finally {
      if (mounted) setState(() => _launching = null);
    }
  }

  Future<void> _startGomoku() async {
    final Map<String, dynamic> r = await widget.api.gameCenterStartGomoku(widget.actorId);
    if (!mounted) return;
    if (r["ok"] != true) {
      final String reason = r["reason"]?.toString() ?? r.toString();
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("创建对局失败：$reason")),
      );
      return;
    }
    String? tableId = r["tableId"]?.toString();
    tableId ??= PlayUrlUtils.parseTableId(r["playUrl"]?.toString() ?? "");
    if (tableId == null || tableId.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("服务端未返回有效棋局 ID")),
      );
      return;
    }
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (BuildContext context) => GomokuPage(
          agentActorId: widget.actorId,
          api: widget.api,
          ws: widget.ws,
          tableId: tableId!,
        ),
      ),
    );
  }

  Future<void> _startZhajinhua() async {
    final Map<String, dynamic> r = await widget.api.gameCenterStartZhajinhua(widget.actorId);
    if (!mounted) return;
    if (r["ok"] != true) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(r["reason"]?.toString() ?? "无法开始炸金花")),
      );
      return;
    }
    final String tableId = r["tableId"]?.toString() ?? "";
    final Map<String, dynamic>? snap = (r["snapshot"] as Map?)?.cast<String, dynamic>();
    if (tableId.isEmpty || snap == null) return;
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (BuildContext c) => ZhajinhuaPlayPage(
          api: widget.api,
          agentId: widget.actorId,
          tableId: tableId,
          initialSnapshot: snap,
        ),
      ),
    );
  }

  Future<void> _startDoudizhu() async {
    final Map<String, dynamic> r = await widget.api.gameCenterStartDoudizhu(widget.actorId);
    if (!mounted) return;
    if (r["ok"] != true) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(r["reason"]?.toString() ?? "无法开始斗地主")),
      );
      return;
    }
    final String tableId = r["tableId"]?.toString() ?? "";
    final Map<String, dynamic>? snap = (r["snapshot"] as Map?)?.cast<String, dynamic>();
    if (tableId.isEmpty || snap == null) return;
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (BuildContext c) => DoudizhuPlayPage(
          api: widget.api,
          agentId: widget.actorId,
          tableId: tableId,
          initialSnapshot: snap,
        ),
      ),
    );
  }

  Future<void> _startBlackjack() async {
    final Map<String, dynamic> r = await widget.api.gameCenterStartBlackjack(widget.actorId);
    if (!mounted) return;
    if (r["ok"] != true) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(r["reason"]?.toString() ?? "无法开始 21 点")),
      );
      return;
    }
    final String tableId = r["tableId"]?.toString() ?? "";
    final Map<String, dynamic>? snap = (r["snapshot"] as Map?)?.cast<String, dynamic>();
    if (tableId.isEmpty || snap == null) return;
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (BuildContext c) => BlackjackPlayPage(
          api: widget.api,
          agentId: widget.actorId,
          tableId: tableId,
          initialSnapshot: snap,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return MainPanel(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(32, 28, 32, 48),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: _contentMaxWidth),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                const _StatsBar(),
                const SizedBox(height: 28),
                _GameCardsSection(
                  launching: _launching,
                  onStart: _startGame,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

enum _GameId { gomoku, zhajinhua, blackjack, doudizhu }

class _StatsBar extends StatelessWidget {
  const _StatsBar();

  static const List<_StatSpec> _stats = <_StatSpec>[
    _StatSpec(
      label: "可用游戏",
      value: "4",
      icon: Icons.sports_esports_outlined,
      iconColor: Color(0xFFA78BFA),
      iconBg: Color(0xFF2D2640),
    ),
    _StatSpec(
      label: "在线 AGENT",
      value: "∞",
      icon: Icons.smart_toy_outlined,
      iconColor: Color(0xFF60A5FA),
      iconBg: Color(0xFF1E2A3D),
    ),
    _StatSpec(
      label: "总对战局",
      value: "0",
      icon: Icons.sports_martial_arts_outlined,
      iconColor: Color(0xFFF87171),
      iconBg: Color(0xFF3D2424),
    ),
    _StatSpec(
      label: "平均胜率",
      value: "--%",
      icon: Icons.bar_chart_rounded,
      iconColor: Color(0xFF34D399),
      iconBg: Color(0xFF1E3329),
    ),
  ];

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final bool narrow = constraints.maxWidth < 720;
        if (narrow) {
          return Column(
            children: <Widget>[
              for (int i = 0; i < _stats.length; i++) ...<Widget>[
                if (i > 0) const SizedBox(height: 12),
                _StatCard(spec: _stats[i]),
              ],
            ],
          );
        }
        return Row(
          children: <Widget>[
            for (int i = 0; i < _stats.length; i++) ...<Widget>[
              if (i > 0) const SizedBox(width: 16),
              Expanded(child: _StatCard(spec: _stats[i])),
            ],
          ],
        );
      },
    );
  }
}

class _StatSpec {
  const _StatSpec({
    required this.label,
    required this.value,
    required this.icon,
    required this.iconColor,
    required this.iconBg,
  });

  final String label;
  final String value;
  final IconData icon;
  final Color iconColor;
  final Color iconBg;
}

class _StatCard extends StatelessWidget {
  const _StatCard({required this.spec});

  final _StatSpec spec;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(
        color: const Color(0xFF1E1E1E),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0xFF2A2A2A)),
      ),
      child: Row(
        children: <Widget>[
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(
              color: spec.iconBg,
              borderRadius: BorderRadius.circular(10),
            ),
            alignment: Alignment.center,
            child: Icon(spec.icon, size: 22, color: spec.iconColor),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  spec.value,
                  style: const TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.w700,
                    color: Color(0xFFE4E4E7),
                    height: 1.1,
                    fontFeatures: <FontFeature>[FontFeature.tabularFigures()],
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  spec.label,
                  style: const TextStyle(
                    fontSize: 11,
                    color: Color(0xFF71717A),
                    letterSpacing: 0.8,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _GameCardsSection extends StatelessWidget {
  const _GameCardsSection({
    required this.launching,
    required this.onStart,
  });

  final _GameId? launching;
  final Future<void> Function(_GameId id) onStart;

  static const List<_GameSpec> _games = <_GameSpec>[
    _GameSpec(
      id: _GameId.gomoku,
      title: "五子棋",
      subtitle: "Gomoku · 经典策略",
      description: "五子连珠即获胜，黑白对弈考验你的策略思维。AI会根据局势做出最优应对。",
      iconType: _GameIconType.gomoku,
      tags: <String>["先手", "策略", "15×15"],
      accent: Color(0xFF60A5FA),
      badge: "经典",
      badgeBg: Color(0x333B82F6),
      badgeFg: Color(0xFF60A5FA),
    ),
    _GameSpec(
      id: _GameId.zhajinhua,
      title: "炸金花",
      subtitle: "Zha Jin Hua · 热门扑克",
      description: "三张定胜负，豹子、同花顺、金花...胆识与运气的较量，与多个AI对手同台竞技。",
      iconType: _GameIconType.zhajinhua,
      tags: <String>["多人", "下注", "比牌"],
      accent: Color(0xFFFACC15),
      badge: "热门",
      badgeBg: Color(0x33EF4444),
      badgeFg: Color(0xFFF87171),
    ),
    _GameSpec(
      id: _GameId.blackjack,
      title: "21点",
      subtitle: "Blackjack · 赌场经典",
      description: "接近21点但不要爆牌，经典的赌场纸牌游戏。内置AI策略助手，帮你做出最优决策！",
      iconType: _GameIconType.blackjack,
      tags: <String>["策略提示", "庄家", "概率"],
      accent: Color(0xFF34D399),
      badge: null,
      badgeBg: Color(0x00000000),
      badgeFg: Color(0xFF34D399),
    ),
    _GameSpec(
      id: _GameId.doudizhu,
      title: "斗地主",
      subtitle: "Dou Di Zhu · 国民游戏",
      description: "三人扑克，叫地主、抢地主、出牌！炸弹、火箭、飞机...丰富的牌型等你来挑战。",
      iconType: _GameIconType.doudizhu,
      tags: <String>["三人", "叫地主", "炸弹"],
      accent: Color(0xFFF87171),
      badge: "新",
      badgeBg: Color(0x33A855F7),
      badgeFg: Color(0xFFC084FC),
    ),
  ];

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final double w = constraints.maxWidth;
        final int columns = w >= 1024 ? 3 : (w >= 640 ? 2 : 1);
        const double gap = 24;
        final double cardWidth = columns == 1
            ? w
            : (w - gap * (columns - 1)) / columns;

        if (columns >= 3) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  for (int i = 0; i < 3; i++) ...<Widget>[
                    if (i > 0) const SizedBox(width: gap),
                    SizedBox(
                      width: cardWidth,
                      child: _InteractiveGameCard(
                        spec: _games[i],
                        loading: launching == _games[i].id,
                        onStart: () => onStart(_games[i].id),
                      ),
                    ),
                  ],
                ],
              ),
              const SizedBox(height: gap),
              SizedBox(
                width: cardWidth,
                child: _InteractiveGameCard(
                  spec: _games[3],
                  loading: launching == _games[3].id,
                  onStart: () => onStart(_games[3].id),
                ),
              ),
            ],
          );
        }

        return Wrap(
          spacing: gap,
          runSpacing: gap,
          children: <Widget>[
            for (final _GameSpec g in _games)
              SizedBox(
                width: cardWidth,
                child: _InteractiveGameCard(
                  spec: g,
                  loading: launching == g.id,
                  onStart: () => onStart(g.id),
                ),
              ),
          ],
        );
      },
    );
  }
}

class _GameSpec {
  const _GameSpec({
    required this.id,
    required this.title,
    required this.subtitle,
    required this.description,
    required this.iconType,
    required this.tags,
    required this.accent,
    required this.badge,
    required this.badgeBg,
    required this.badgeFg,
  });

  final _GameId id;
  final String title;
  final String subtitle;
  final String description;
  final _GameIconType iconType;
  final List<String> tags;
  final Color accent;
  final String? badge;
  final Color badgeBg;
  final Color badgeFg;
}

class _InteractiveGameCard extends StatefulWidget {
  const _InteractiveGameCard({
    required this.spec,
    required this.loading,
    required this.onStart,
  });

  final _GameSpec spec;
  final bool loading;
  final VoidCallback onStart;

  @override
  State<_InteractiveGameCard> createState() => _InteractiveGameCardState();
}

class _InteractiveGameCardState extends State<_InteractiveGameCard> {
  bool _hovered = false;
  bool _pressed = false;

  @override
  Widget build(BuildContext context) {
    final _GameSpec g = widget.spec;
    final bool elevated = _hovered || _pressed;
    final Color borderColor = elevated ? g.accent.withValues(alpha: 0.45) : const Color(0xFF2A2A2A);

    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        curve: Curves.easeOut,
        transform: Matrix4.translationValues(0, elevated ? -3 : 0, 0),
        decoration: BoxDecoration(
          color: const Color(0xFF1E1E1E),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: borderColor, width: 1),
          boxShadow: elevated
              ? <BoxShadow>[
                  BoxShadow(
                    color: g.accent.withValues(alpha: 0.12),
                    blurRadius: 24,
                    offset: const Offset(0, 8),
                  ),
                ]
              : null,
        ),
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            onTap: widget.loading ? null : widget.onStart,
            onHighlightChanged: (bool v) => setState(() => _pressed = v),
            borderRadius: BorderRadius.circular(16),
            splashColor: g.accent.withValues(alpha: 0.08),
            highlightColor: g.accent.withValues(alpha: 0.04),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      _GameIcon(type: g.iconType, accent: g.accent),
                      const Spacer(),
                      if (g.badge != null)
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                          decoration: BoxDecoration(
                            color: g.badgeBg,
                            borderRadius: BorderRadius.circular(999),
                            border: Border.all(color: g.badgeFg.withValues(alpha: 0.3)),
                          ),
                          child: Text(
                            g.badge!,
                            style: TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.w600,
                              color: g.badgeFg,
                            ),
                          ),
                        ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  Text(
                    g.title,
                    style: const TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.w700,
                      color: Color(0xFFF4F4F5),
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    g.subtitle,
                    style: const TextStyle(fontSize: 12, color: Color(0xFF71717A)),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    g.description,
                    style: const TextStyle(
                      fontSize: 14,
                      color: Color(0xFFA1A1AA),
                      height: 1.55,
                    ),
                  ),
                  const SizedBox(height: 16),
                  Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children: <Widget>[
                      for (final String tag in g.tags)
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                          decoration: BoxDecoration(
                            color: const Color(0xFF161616),
                            borderRadius: BorderRadius.circular(6),
                            border: Border.all(color: const Color(0xFF2A2A2A)),
                          ),
                          child: Text(
                            tag,
                            style: const TextStyle(fontSize: 11, color: Color(0xFFA1A1AA)),
                          ),
                        ),
                    ],
                  ),
                  const SizedBox(height: 20),
                  Row(
                    children: <Widget>[
                      if (widget.loading) ...<Widget>[
                        SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: g.accent,
                          ),
                        ),
                        const SizedBox(width: 10),
                        Text(
                          "正在进入…",
                          style: TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.w500,
                            color: g.accent,
                          ),
                        ),
                      ] else ...<Widget>[
                        Text(
                          "开始游戏",
                          style: TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.w500,
                            color: g.accent,
                          ),
                        ),
                        const SizedBox(width: 6),
                        Icon(Icons.arrow_forward, size: 16, color: g.accent),
                      ],
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
