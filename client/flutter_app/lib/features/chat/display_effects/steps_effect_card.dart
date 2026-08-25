import "package:flutter/material.dart";

import "../../../core/utils/agent_result_parser.dart";
import "../content_summary_detail_formatter.dart";
import "effect_card_shell.dart";

/// 数字步骤卡（cardType = "steps"）。
///
/// 服务端路由条件（display-effect-router.ts 规则 2）：多数条目带
/// 「第X步 / Step N / 数字.」标记，或原文是顺序编号列表。
/// 前端渲染为带序号徽章的纵向步骤链：圆形数字徽章 + 连接竖线 + 正文，
/// 条目文本中的「第X步」「Step N」前缀会被剥掉（序号已由徽章表达）。
///
/// 支持二级子步骤：服务端按原文缩进透传 `depth`（1=子步骤），
/// 子步骤不占序号，缩进对齐父步骤正文，以「–」小标记呈现从属关系。
class StepsEffectCard extends StatelessWidget {
  const StepsEffectCard({super.key, required this.data, required this.cs});

  final AgentResultData data;
  final ColorScheme cs;

  /// 剥掉条目文本中的步骤前缀（徽章已显示序号，避免重复）。
  static final RegExp _stepPrefixRe = RegExp(
    r"^(?:第\s*[一二三四五六七八九十百\d]+\s*[步阶段部]\s*[:：.]?\s*|step\s*\d+\s*[.、)）:]?\s*)",
    caseSensitive: false,
  );

  String _stripStepPrefix(String raw) {
    return raw.trim().replaceFirst(_stepPrefixRe, "").trim();
  }

  /// 组装步骤行：顶层步骤按出现顺序编号（连接竖线到最后一个顶层步骤），
  /// 子步骤以 [._SubStepRow 缩进展示，不参与编号。
  List<Widget> _buildRows() {
    final List<AgentResultItem> items = data.items;
    final int topCount =
        items.where((AgentResultItem i) => i.depth == 0).length;
    final List<Widget> rows = <Widget>[];
    int topIndex = 0;
    for (final AgentResultItem item in items) {
      if (item.depth > 0) {
        rows.add(_SubStepRow(text: _stripStepPrefix(item.text), cs: cs));
      } else {
        topIndex++;
        rows.add(_StepRow(
          index: topIndex,
          text: _stripStepPrefix(item.text),
          isLast: topIndex >= topCount,
          cs: cs,
        ));
      }
    }
    return rows;
  }

  @override
  Widget build(BuildContext context) {
    return EffectCardShell(
      cs: cs,
      icon: Icons.format_list_numbered,
      title: data.title,
      footer: data.footer,
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: _buildRows(),
      ),
    );
  }
}

/// 子步骤行：与父步骤正文左缘对齐，用「–」小标记替代序号徽章，
/// 字号降一档、字色降一档，一眼区分从属层级。
class _SubStepRow extends StatelessWidget {
  const _SubStepRow({required this.text, required this.cs});

  final String text;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(left: 34, bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          SizedBox(
            width: 12,
            child: Text(
              "–",
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w700,
                color: cs.primary.withValues(alpha: 0.65),
                height: 1.35,
              ),
            ),
          ),
          const SizedBox(width: 6),
          Expanded(
            child: buildInlineMarkdownText(
              text,
              TextStyle(
                fontSize: 12.5,
                color: cs.onSurface.withValues(alpha: 0.65),
                height: 1.5,
              ),
              cs: cs,
            ),
          ),
        ],
      ),
    );
  }
}

class _StepRow extends StatelessWidget {
  const _StepRow({
    required this.index,
    required this.text,
    required this.isLast,
    required this.cs,
  });

  final int index;
  final String text;
  final bool isLast;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          // 徽章列：圆形序号 + 连接竖线
          SizedBox(
            width: 24,
            child: Column(
              children: <Widget>[
                Container(
                  width: 20,
                  height: 20,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: cs.primary.withValues(alpha: 0.12),
                    shape: BoxShape.circle,
                  ),
                  child: Text(
                    "$index",
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w700,
                      color: cs.primary,
                      height: 1.1,
                    ),
                  ),
                ),
                if (!isLast)
                  Expanded(
                    child: Container(
                      width: 1.5,
                      margin: const EdgeInsets.only(top: 2),
                      color: cs.outline.withValues(alpha: 0.3),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 10),
          // 正文列
          Expanded(
            child: Padding(
              padding: EdgeInsets.only(bottom: isLast ? 0 : 12, top: 1),
              child: buildInlineMarkdownText(
                text,
                TextStyle(
                  fontSize: 13,
                  color: cs.onSurface.withValues(alpha: 0.85),
                  height: 1.5,
                ),
                cs: cs,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
