import "package:flutter/material.dart";

import "../../../core/utils/agent_result_parser.dart";
import "effect_card_shell.dart";

/// 标签/徽章行卡（cardType = "chips"）。
///
/// 服务端路由条件（display-effect-router.ts 规则 8）：≥4 条且全部是
/// ≤10 字的短标签（无句末标点、无数字、无时间前缀）。
/// 前端渲染为 Wrap 胶囊墙：圆角胶囊 + primary 浅底 + primary 文字，
/// 适合兴趣标签、关键词、类目聚合这类「一组词」的场景。
class ChipsEffectCard extends StatelessWidget {
  const ChipsEffectCard({super.key, required this.data, required this.cs});

  final AgentResultData data;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    final List<String> chips = data.items
        .map((AgentResultItem it) => it.text.trim())
        .where((String t) => t.isNotEmpty)
        .toList();
    return EffectCardShell(
      cs: cs,
      icon: Icons.sell_outlined,
      title: data.title,
      footer: data.footer,
      body: Wrap(
        spacing: 8,
        runSpacing: 8,
        children: <Widget>[
          for (final String chip in chips)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 5.5),
              decoration: BoxDecoration(
                color: cs.primary.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: cs.primary.withValues(alpha: 0.28)),
              ),
              child: Text(
                chip,
                style: TextStyle(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w600,
                  color: cs.primary,
                  height: 1.25,
                ),
              ),
            ),
        ],
      ),
    );
  }
}
