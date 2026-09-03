import "package:flutter/material.dart";

import "../../../core/utils/agent_result_parser.dart";
import "effect_card_shell.dart";

/// 文本 A/B 对比双栏卡（cardType = "comparison_table"）。
///
/// 服务端路由条件（display-effect-router.ts 的 scoreComparisonTable）：
/// 条目呈 A/B 标签成对出现——裸 A/B 开头（「A便宜些」），或带前缀冒号
/// 形态（「方案A：续航好」），两侧各 ≥1 条。
///
/// 前端渲染：左右双栏 + 逐行对齐；A 侧条目按序排左列、B 侧排右列，
/// 行数不齐时缺位补「—」。不参与对比的剩余条目整行附在表格下方。
/// 纯文本对比场景（方案对比/产品对比/优缺点对照）专用；
/// 图片对比走 compare 双图滑杆，不在此卡。
class ComparisonTableEffectCard extends StatelessWidget {
  const ComparisonTableEffectCard({super.key, required this.data, required this.cs});

  final AgentResultData data;
  final ColorScheme cs;

  /// 条目侧归属：返回 "A"/"B"，null = 不参与对比。
  /// 与服务端 AB_LABEL_RE / AB_COLUMN_RE 的判定保持一致：
  /// 裸 A/B 开头（后面不是 ASCII 字母数字），或「方案A/产品B」带前缀词形态。
  static String? _sideOf(String raw) {
    final String t = raw.trim();
    final RegExp bare = RegExp(r"^([ABab])(?![A-Za-z0-9])");
    final RegExp prefixed = RegExp(r"^(?:方案|产品|选项|品牌|款)\s*([ABab])(?![A-Za-z0-9])");
    final RegExpMatch? m = bare.firstMatch(t) ?? prefixed.firstMatch(t);
    return m?.group(1)?.toUpperCase();
  }

  /// 剥掉行首的 A/B 标签（含可选前缀词与冒号），只留正文。
  static String _stripLabel(String raw) {
    final String t = raw.trim();
    final RegExpMatch? m =
        RegExp(r"^(?:方案|产品|选项|品牌|款)?\s*[ABab](?![A-Za-z0-9])[：:、]?\s*").firstMatch(t);
    if (m == null) return t;
    final String rest = t.substring(m.end).trim();
    return rest.isEmpty ? t : rest;
  }

  @override
  Widget build(BuildContext context) {
    final List<String> colA = <String>[];
    final List<String> colB = <String>[];
    final List<String> extra = <String>[];
    for (final AgentResultItem it in data.items) {
      final String? side = (it.side ?? _sideOf(it.text));
      if (side == "A") {
        colA.add(_stripLabel(it.text));
      } else if (side == "B") {
        colB.add(_stripLabel(it.text));
      } else {
        extra.add(it.text.trim());
      }
    }
    if (colA.isEmpty && colB.isEmpty) return const SizedBox.shrink();

    final String labelA = (data.sideA ?? "").trim().isNotEmpty ? data.sideA!.trim() : "A";
    final String labelB = (data.sideB ?? "").trim().isNotEmpty ? data.sideB!.trim() : "B";
    final int rowCount = colA.length > colB.length ? colA.length : colB.length;

    return EffectCardShell(
      cs: cs,
      icon: Icons.table_chart_outlined,
      title: data.title,
      footer: data.footer,
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          // 侧标签表头
          Row(
            children: <Widget>[
              Expanded(child: _SideHeader(label: labelA, cs: cs)),
              const SizedBox(width: 10),
              Expanded(child: _SideHeader(label: labelB, cs: cs)),
            ],
          ),
          const SizedBox(height: 6),
          // 逐行对齐的双栏正文
          for (int i = 0; i < rowCount; i++) ...<Widget>[
            if (i > 0)
              Divider(height: 1, thickness: 0.6, color: cs.outline.withValues(alpha: 0.18)),
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Expanded(
                    child: _CellText(text: i < colA.length ? colA[i] : "—", cs: cs),
                  ),
                  Container(
                    width: 1,
                    margin: const EdgeInsets.symmetric(horizontal: 4),
                    color: cs.outline.withValues(alpha: 0.18),
                  ),
                  Expanded(
                    child: _CellText(text: i < colB.length ? colB[i] : "—", cs: cs),
                  ),
                ],
              ),
            ),
          ],
          // 不参与对比的剩余条目
          if (extra.isNotEmpty) ...<Widget>[
            const SizedBox(height: 4),
            for (final String line in extra)
              Padding(
                padding: const EdgeInsets.only(top: 3),
                child: Text(
                  line,
                  style: TextStyle(
                    fontSize: 13,
                    color: cs.onSurfaceVariant,
                    height: 1.45,
                  ),
                ),
              ),
          ],
        ],
      ),
    );
  }
}

/// 侧标签表头胶囊。
class _SideHeader extends StatelessWidget {
  const _SideHeader({required this.label, required this.cs});

  final String label;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: cs.primary.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: cs.primary.withValues(alpha: 0.24)),
      ),
      child: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          fontSize: 12.5,
          fontWeight: FontWeight.w700,
          color: cs.primary,
          height: 1.3,
        ),
      ),
    );
  }
}

/// 单元格正文：可长按复制；缺位显示「—」弱化色。
class _CellText extends StatelessWidget {
  const _CellText({required this.text, required this.cs});

  final String text;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    final bool placeholder = text == "—";
    return SelectableText(
      text,
      style: TextStyle(
        fontSize: 13,
        color: placeholder ? cs.onSurfaceVariant.withValues(alpha: 0.5) : cs.onSurface,
        height: 1.45,
      ),
    );
  }
}
