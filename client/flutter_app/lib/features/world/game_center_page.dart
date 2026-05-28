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
            stops: <double>[0.8, 1.0],
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
                  fontSize: