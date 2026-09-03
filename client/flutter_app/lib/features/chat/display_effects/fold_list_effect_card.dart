import "package:flutter/material.dart";

import "../../../core/utils/agent_result_parser.dart";
import "effect_card_shell.dart";

/// 折叠列表卡（cardType = "fold_list"）。
///
/// 服务端路由条件（display-effect-router.ts 规则 7）：条目 ≥8 条的长清单。
/// 前端默认只展开前 5 条，其余收进「展开全部 N 条」；展开后可一键收起。
/// 避免长清单刷屏，同时保留完整内容的可达性。
class FoldListEffectCard extends StatefulWidget {
  const FoldListEffectCard({super.key, required this.data, required this.cs});

  final AgentResultData data;
  final ColorScheme cs;

  @override
  State<FoldListEffectCard> createState() => _FoldListEffectCardState();
}

class _FoldListEffectCardState extends State<FoldListEffectCard> {
  /// 折叠态下直接可见的条数。
  static const int _collapsedCount = 5;

  bool _expanded = false;

  void _toggle() {
    setState(() => _expanded = !_expanded);
  }

  @override
  Widget build(BuildContext context) {
    final List<AgentResultItem> items = widget.data.items;
    final bool needFold = items.length > _collapsedCount;
    final List<AgentResultItem> visible = _expanded || !needFold
        ? items
        : items.sublist(0, _collapsedCount);

    return EffectCardShell(
      cs: widget.cs,
      icon: Icons.format_list_bulleted,
      title: widget.data.title,
      footer: widget.data.footer,
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          for (final AgentResultItem it in visible)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Container(
                    margin: const EdgeInsets.only(top: 6.5),
                    width: 5,
                    height: 5,
                    decoration: BoxDecoration(
                      color: widget.cs.primary.withValues(alpha: 0.55),
                      shape: BoxShape.circle,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      it.text,
                      style: TextStyle(
                        fontSize: 13,
                        color: widget.cs.onSurface.withValues(alpha: 0.82),
                        height: 1.55,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          if (needFold) ...<Widget>[
            const SizedBox(height: 4),
            InkWell(
              onTap: _toggle,
              borderRadius: BorderRadius.circular(6),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 4),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Text(
                      _expanded ? "收起" : "展开全部 ${items.length} 条",
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                        color: widget.cs.primary,
                        height: 1.3,
                      ),
                    ),
                    const SizedBox(width: 2),
                    Icon(
                      _expanded
                          ? Icons.keyboard_arrow_up
                          : Icons.keyboard_arrow_down,
                      size: 16,
                      color: widget.cs.primary,
                    ),
                  ],
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
