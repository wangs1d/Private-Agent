import 'package:flutter/material.dart';

class GameCenterPage extends StatelessWidget {
  const GameCenterPage({super.key});

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final List<Map<String, dynamic>> games = <Map<String, dynamic>>[
      {
        'title': '五子棋',
        'subtitle': 'Gomoku · 经典策略',
        'description': '五子连珠即获胜，黑白对弈考验你的策略思维。AI会根据局势做出最优应对。',
        'icon': '⚫⚪',
        'tags': <String>['先手', '策略', '15×15'],
        'color': 'blue',
        'badge': '经典',
      },
      {
        'title': '炸金花',
        'subtitle': 'Zha Jin Hua · 热门扑克',
        'description': '三张定胜负，豹子、同花顺、金花...胆识与运气的较量，与多个AI对手同台竞技。',
        'icon': '🃏',
        'tags': <String>['多人', '下注', '比牌'],
        'color': 'yellow',
        'badge': '热门',
      },
      {
        'title': '21点',
        'subtitle': 'Blackjack · 赌场经典',
        'description': '接近21点但不要爆牌，经典的赌场纸牌游戏。内置AI策略助手，帮你做出最优决策！',
        'icon': '🎴',
        'tags': <String>['策略提示', '庄家', '概率'],
        'color': 'emerald',
        'badge': null,
      },
      {
        'title': '斗地主',
        'subtitle': 'Dou Di Zhu · 国民游戏',
        'description': '三人扑克，叫地主、抢地主、出牌！炸弹、火箭、飞机...丰富的牌型等你来挑战。',
        'icon': '👑',
        'tags': <String>['三人', '叫地主', '炸弹'],
        'color': 'red',
        'badge': '新',
      },
    ];

    final List<Map<String, dynamic>> stats = <Map<String, dynamic>>[
      {'label': '可用游戏', 'value': '4', 'icon': '🎮'},
      {'label': '在线 AGENT', 'value': '∞', 'icon': '🤖'},
      {'label': '总对战局', 'value': '0', 'icon': '⚔️'},
      {'label': '平均胜率', 'value': '--%', 'icon': '📊'},
    ];

    Color getAccentColor(String color) {
      switch (color) {
        case 'yellow':
          return const Color(0xFFFBBF24);
        case 'emerald':
          return const Color(0xFF34D399);
        case 'blue':
          return const Color(0xFF60A5FA);
        case 'red':
          return const Color(0xFFF87171);
        default:
          return const Color(0xFF60A5FA);
      }
    }

    Color getBadgeBgColor(String badge) {
      if (badge == '热门') return const Color(0xFFEF4444).withOpacity(0.2);
      if (badge == '经典') return const Color(0xFF3B82F6).withOpacity(0.2);
      if (badge == '新') return const Color(0xFFA855F7).withOpacity(0.2);
      return const Color(0xFF10B981).withOpacity(0.2);
    }

    Color getBadgeTextColor(String badge) {
      if (badge == '热门') return const Color(0xFFF87171);
      if (badge == '经典') return const Color(0xFF60A5FA);
      if (badge == '新') return const Color(0xFFC084FC);
      return const Color(0xFF34D399);
    }

    Widget buildGameCard(Map<String, dynamic> game) {
      final String color = game['color'] as String;
      final String? badge = game['badge'] as String?;
      final List<String> tags = game['tags'] as List<String>;
      final Color accentColor = getAccentColor(color);

      return Container(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: <Color>[
              cs.surfaceContainerLow,
              cs.surface,
            ],
            stops: const <double>[0.8, 1.0],
          ),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: cs.surfaceContainerHighest.withOpacity(0.5),
            width: 1,
          ),
          boxShadow: const <BoxShadow>[
            BoxShadow(
              color: Color(0xFF000000),
              blurRadius: 20,
              offset: Offset(0, 8),
              spreadRadius: -5,
            ),
          ],
        ),
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    game['icon'] as String,
                    style: const TextStyle(fontSize: 48),
                  ),
                  if (badge != null)
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 4,
                      ),
                      decoration: BoxDecoration(
                        color: getBadgeBgColor(badge),
                        borderRadius: BorderRadius.circular(999),
                      ),
                      child: Text(
                        badge.toUpperCase(),
                        style: TextStyle(
                          fontSize: 10,
                          fontWeight: FontWeight.w700,
                          color: getBadgeTextColor(badge),
                          letterSpacing: 1.5,
                        ),
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 16),
              Text(
                game['title'] as String,
                style: const TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.w700,
                  color: Color(0xFFF4F4F5),
                ),
              ),
              const SizedBox(height: 4),
              Text(
                game['subtitle'] as String,
                style: const TextStyle(
                  fontSize: 12,
                  color: Color(0xFF71717A),
                ),
              ),
              const SizedBox(height: 12),
              Text(
                game['description'] as String,
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
                  for (final String tag in tags)
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 4,
                      ),
                      decoration: BoxDecoration(
                        color: const Color(0xFF161616),
                        borderRadius: BorderRadius.circular(6),
                        border: Border.all(color: const Color(0xFF2A2A2A)),
                      ),
                      child: Text(
                        tag,
                        style: const TextStyle(
                          fontSize: 11,
                          color: Color(0xFFA1A1AA),
                        ),
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 20),
              Row(
                children: <Widget>[
                  Text(
                    '开始游戏',
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w500,
                      color: accentColor,
                    ),
                  ),
                  const SizedBox(width: 6),
                  Icon(Icons.arrow_forward, size: 16, color: accentColor),
                ],
              ),
            ],
          ),
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('游戏中心'),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(16, 24, 16, 32),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: <Widget>[
                const Text(
                  '游戏统计',
                  style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                    color: Color(0xFFF4F4F5),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            Row(
              children: <Widget>[
                for (int i = 0; i < stats.length; i++) ...<Widget>[
                  if (i > 0) const SizedBox(width: 12),
                  Expanded(
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 16,
                        vertical: 14,
                      ),
                      decoration: BoxDecoration(
                        color: const Color(0xFF1E1E1E),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: const Color(0xFF2A2A2A)),
                      ),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: <Widget>[
                          Text(
                            stats[i]['icon'] as String,
                            style: const TextStyle(fontSize: 24),
                          ),
                          const SizedBox(height: 8),
                          Text(
                            stats[i]['value'] as String,
                            style: const TextStyle(
                              fontSize: 22,
                              fontWeight: FontWeight.w700,
                              color: Color(0xFFE4E4E7),
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            stats[i]['label'] as String,
                            style: const TextStyle(
                              fontSize: 11,
                              color: Color(0xFF71717A),
                              letterSpacing: 0.8,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ],
            ),
            const SizedBox(height: 28),
            const Text(
              '选择游戏',
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w600,
                color: Color(0xFFF4F4F5),
              ),
            ),
            const SizedBox(height: 16),
            GridView.builder(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                crossAxisCount: 2,
                crossAxisSpacing: 16,
                mainAxisSpacing: 16,
                childAspectRatio: 0.85,
              ),
              itemCount: games.length,
              itemBuilder: (BuildContext context, int index) {
                return buildGameCard(games[index]);
              },
            ),
          ],
        ),
      ),
    );
  }
}
