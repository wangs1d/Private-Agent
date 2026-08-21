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

  @override
  Widget build(BuildContext context) {
    final List<AgentResultItem> items = data.items;
    return EffectCardShell(
      cs: cs,
      icon: Icons.format_list_numbered,
      title: data.title,
      footer: data.footer,
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          for (int i = 0; i < items.length; i++) _StepRow(
            index: i + 1,
            text: _stripStepPrefix(items[i].text),
            isLast: i == items.length - 1,
            cs: cs,
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
                    border: Border.all(color: cs.primary.withValues(alpha: 0.5)),
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
