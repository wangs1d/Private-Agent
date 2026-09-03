import "package:flutter/material.dart";

import "../../../core/utils/agent_result_parser.dart";
import "effect_card_shell.dart";

/// 数据面板卡（cardType = "metric"）。
///
/// 服务端路由条件（display-effect-router.ts 规则 6）：2-6 条全部为
/// 「短标签：数值(+单位)」。前端渲染为 2 列指标网格：
///   - 标签小字（onSurfaceVariant）+ 数值大字（primary 加粗）；
///   - 解析不出「标签：数值」结构的条目退化为跨两列的整行文本；
///   - 奇数条时最后一格跨满两列，避免半行空洞。
class MetricEffectCard extends StatelessWidget {
  const MetricEffectCard({super.key, required this.data, required this.cs});

  final AgentResultData data;
  final ColorScheme cs;

  /// 按第一个全/半角冒号拆「标签：数值」。
  (String, String) _splitMetric(String raw) {
    final String t = raw.trim();
    final int idx = t.indexOf(RegExp(r"[：:]"));
    if (idx <= 0 || idx == t.length - 1) return ("", t);
    return (t.substring(0, idx).trim(), t.substring(idx + 1).trim());
  }

  @override
  Widget build(BuildContext context) {
    final List<AgentResultItem> items = data.items;
    return EffectCardShell(
      cs: cs,
      icon: Icons.insights_outlined,
      title: data.title,
      footer: data.footer,
      body: LayoutBuilder(
        builder: (BuildContext context, BoxConstraints constraints) {
          const double gap = 6;
          final double half = (constraints.maxWidth - gap) / 2;
          final List<Widget> tiles = <Widget>[];
          for (int i = 0; i < items.length; i++) {
            final (String label, String value) = _splitMetric(items[i].text);
            final bool full = label.isEmpty ||
                (i == items.length - 1 && i.isEven);
            tiles.add(
              SizedBox(
                width: full ? constraints.maxWidth : half,
                child: _MetricTile(label: label, value: value, cs: cs),
              ),
            );
          }
          return Wrap(
            spacing: gap,
            runSpacing: gap,
            children: tiles,
          );
        },
      ),
    );
  }
}

class _MetricTile extends StatelessWidget {
  const _MetricTile({
    required this.label,
    required this.value,
    required this.cs,
  });

  final String label;
  final String value;
  final ColorScheme cs;

  /// 仅对「纯百分比 / 分数」值生成 0-1 进度比例，用于数值下方的微型语义条，
  /// 一眼看出「60% 是什么水平」；要求 cur ≤ max（如 120/80 血压类比值
  /// 不是进度，返回 null 不显示条，避免误导）。
  static double? _semanticRatio(String value) {
    final String v = value.trim();
    final RegExpMatch? pct = RegExp(r"^(\d+(?:\.\d+)?)\s*%$").firstMatch(v);
    if (pct != null) {
      final double? n = double.tryParse(pct.group(1)!);
      if (n != null) return n.clamp(0.0, 1.0).toDouble();
      return null;
    }
    final RegExpMatch? frac =
        RegExp(r"^(\d+(?:\.\d+)?)\s*/\s*(\d+(?:\.\d+)?)$").firstMatch(v);
    if (frac != null) {
      final double? cur = double.tryParse(frac.group(1)!);
      final double? max = double.tryParse(frac.group(2)!);
      if (cur != null && max != null && max > 0 && cur <= max) {
        return (cur / max).clamp(0.0, 1.0).toDouble();
      }
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final double? ratio = label.isNotEmpty ? _semanticRatio(value) : null;
    return Container(
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHighest.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (label.isNotEmpty)
            Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 12,
                color: cs.onSurfaceVariant,
                height: 1.3,
              ),
            ),
          const SizedBox(height: 2),
          // 数值可长按复制；FittedBox 缩放代替截断——「3.2万亿元」这类长值
          // 不再被 ellipsis 吃掉
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: SelectableText(
              value,
              style: TextStyle(
                fontSize: 15,
                fontWeight: FontWeight.w700,
                color: label.isEmpty
                    ? cs.onSurface.withValues(alpha: 0.85)
                    : cs.primary,
                height: 1.35,
              ),
            ),
          ),
          if (ratio != null) ...<Widget>[
            const SizedBox(height: 4),
            ClipRRect(
              borderRadius: BorderRadius.circular(3),
              child: LinearProgressIndicator(
                value: ratio,
                minHeight: 5,
                backgroundColor: cs.surfaceContainerHighest,
                valueColor: AlwaysStoppedAnimation<Color>(
                  cs.primary.withValues(alpha: 0.85),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
