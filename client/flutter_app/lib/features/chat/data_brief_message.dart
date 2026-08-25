import "dart:convert";

import "package:flutter/material.dart";

import "content_summary_detail_formatter.dart";

/// 数据快报（[RENDER_AS:data_brief] 的专属渲染）
///
/// 服务端对「数字密集」内容（行情 / 指标 / 统计总结 / 评测打分）注入
/// `[RENDER_AS:data_brief]` + `[DATA_BRIEF_START]{json}[DATA_BRIEF_END]`，
/// payload 结构见 [DataBriefPayload]：一句话结论 + KPI 数据点 + 详情正文。
///
/// 此组件把结构显式化为：
///   1. 头部徽标（📊 数据快报 · N 项指标）
///   2. 一句话结论（置顶强调条）
///   3. KPI 网格（2 列卡片：标签 + 数值 + 涨跌色变化）
///   4. 详情正文（默认折叠，「查看详情」展开；流式输出时自动展开）
///
/// 若 payload 缺失 / JSON 损坏，dispatch 层回退为结构化正文。
class DataBriefMessage extends StatefulWidget {
  const DataBriefMessage({
    super.key,
    required this.payload,
    required this.cs,
    required this.textTheme,
    this.showCursor = false,
  });

  final DataBriefPayload payload;
  final ColorScheme cs;
  final TextTheme textTheme;
  final bool showCursor;

  static final RegExp _blockRe = RegExp(
    r'\[DATA_BRIEF_START\]\s*(.*?)\s*\[DATA_BRIEF_END\]',
    dotAll: true,
  );

  /// 从正文解析 data_brief payload；标记缺失或 JSON 非法返回 null。
  static DataBriefPayload? tryParse(String text) {
    final RegExpMatch? m = _blockRe.firstMatch(text);
    if (m == null) return null;
    try {
      final Object? decoded = jsonDecode(m.group(1)!);
      if (decoded is! Map) return null;
      return DataBriefPayload.fromJson(decoded);
    } catch (_) {
      return null;
    }
  }

  @override
  State<DataBriefMessage> createState() => _DataBriefMessageState();
}

class _DataBriefMessageState extends State<DataBriefMessage> {
  late bool _detailsExpanded = widget.showCursor;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = widget.cs;
    final TextTheme textTheme = widget.textTheme;
    final DataBriefPayload p = widget.payload;
    final bool hasKpis = p.kpis.isNotEmpty;
    final bool hasDetails = p.restText.trim().isNotEmpty;

    if (!hasKpis && !hasDetails && p.conclusion.isEmpty) {
      return const SizedBox.shrink();
    }

    final TextStyle bodyStyle = textTheme.bodyMedium!.copyWith(
      color: cs.onSurface,
      height: 1.56,
    );

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHighest.withValues(alpha: 0.22),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: cs.outline.withValues(alpha: 0.12)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          // 头部徽标
          Row(
            children: <Widget>[
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: cs.primary.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(
                  "📊 数据快报${hasKpis ? " · ${p.kpis.length} 项指标" : ""}",
                  style: textTheme.labelSmall?.copyWith(
                        color: cs.primary,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 0.1,
                      ) ??
                      TextStyle(
                        fontSize: 11,
                        color: cs.primary,
                        fontWeight: FontWeight.w700,
                      ),
                ),
              ),
            ],
          ),
          // 一句话结论
          if (p.conclusion.isNotEmpty) ...<Widget>[
            const SizedBox(height: 10),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.fromLTRB(10, 7, 10, 7),
              decoration: BoxDecoration(
                color: cs.primaryContainer.withValues(alpha: 0.10),
                borderRadius: BorderRadius.circular(9),
                border: Border(
                  left: BorderSide(
                    color: cs.outline.withValues(alpha: 0.38),
                    width: 2.5,
                  ),
                ),
              ),
              child: buildInlineMarkdownText(
                p.conclusion,
                bodyStyle.copyWith(
                  fontWeight: FontWeight.w600,
                  color: cs.onSurfaceVariant,
                  height: 1.5,
                ),
                cs: cs,
              ),
            ),
          ],
          // KPI 网格（2 列瓦片）
          if (hasKpis) ...<Widget>[
            const SizedBox(height: 10),
            LayoutBuilder(
              builder: (BuildContext context, BoxConstraints constraints) {
                const double gap = 8;
                final double itemW = (constraints.maxWidth - gap) / 2;
                return Wrap(
                  spacing: gap,
                  runSpacing: gap,
                  children: <Widget>[
                    for (final DataBriefPoint point in p.kpis)
                      SizedBox(
                        width: itemW,
                        child: _KpiTile(
                          point: point,
                          cs: cs,
                          textTheme: textTheme,
                        ),
                      ),
                  ],
                );
              },
            ),
          ],
          // 详情（默认折叠）
          if (hasDetails) ...<Widget>[
            const SizedBox(height: 4),
            TextButton.icon(
              onPressed: () =>
                  setState(() => _detailsExpanded = !_detailsExpanded),
              style: TextButton.styleFrom(
                visualDensity: VisualDensity.compact,
                padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
                minimumSize: const Size(0, 28),
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
              icon: Icon(
                _detailsExpanded ? Icons.expand_less : Icons.expand_more,
                size: 16,
                color: cs.primary,
              ),
              label: Text(
                _detailsExpanded ? "收起详情" : "查看详情",
                style: textTheme.labelMedium?.copyWith(
                      color: cs.primary,
                      fontWeight: FontWeight.w600,
                    ) ??
                    TextStyle(
                      fontSize: 12,
                      color: cs.primary,
                      fontWeight: FontWeight.w600,
                    ),
              ),
            ),
            if (_detailsExpanded)
              ...formatContentSummaryDetailLines(p.restText, cs, textTheme),
          ],
          if (widget.showCursor)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                "▍",
                style: bodyStyle.copyWith(
                  color: cs.primary,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// KPI 指标瓦片：标签 + 数值 + 变化（带涨跌色）。
class _KpiTile extends StatelessWidget {
  const _KpiTile({
    required this.point,
    required this.cs,
    required this.textTheme,
  });

  final DataBriefPoint point;
  final ColorScheme cs;
  final TextTheme textTheme;

  static const Color _upColor = Color(0xFF43A047);
  static const Color _downColor = Color(0xFFE53935);

  @override
  Widget build(BuildContext context) {
    final Color? changeColor = _changeColor(point.change);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: cs.surface.withValues(alpha: 0.5),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: cs.outline.withValues(alpha: 0.10)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(
            point.label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: textTheme.labelSmall?.copyWith(
                  color: cs.onSurfaceVariant,
                  fontWeight: FontWeight.w500,
                ) ??
                const TextStyle(fontSize: 11, fontWeight: FontWeight.w500),
          ),
          const SizedBox(height: 4),
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: <Widget>[
              Flexible(
                child: Text(
                  point.value,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w800,
                        color: cs.onSurface,
                        letterSpacing: -0.2,
                      ) ??
                      const TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w800,
                      ),
                ),
              ),
              if (point.change != null && point.change!.isNotEmpty) ...<Widget>[
                const SizedBox(width: 6),
                Text(
                  point.change!,
                  style: textTheme.labelSmall?.copyWith(
                        color: changeColor,
                        fontWeight: FontWeight.w700,
                      ) ??
                      TextStyle(
                        fontSize: 11,
                        color: changeColor,
                        fontWeight: FontWeight.w700,
                      ),
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }

  /// 涨跌色：带 + 的为正（绿）、带 -/− 的为负（红）；无法识别返回 null（中性色）。
  static Color? _changeColor(String? change) {
    if (change == null || change.isEmpty) return null;
    final String c = change.trim();
    if (c.startsWith("+")) return _upColor;
    if (c.startsWith("-") || c.startsWith("−")) return _downColor;
    return null;
  }
}

/// data_brief payload 模型（与 render-hint-service 的 DataBriefPayload 对齐）。
class DataBriefPayload {
  const DataBriefPayload({
    required this.conclusion,
    required this.kpis,
    required this.restText,
  });

  /// 一句话结论（可为空）
  final String conclusion;

  /// KPI 数据点（≤8 个）
  final List<DataBriefPoint> kpis;

  /// 详情正文（不含结论），供「查看详情」展开
  final String restText;

  factory DataBriefPayload.fromJson(Map<dynamic, dynamic> json) =>
      DataBriefPayload(
        conclusion: (json['conclusion'] as String?) ?? "",
        kpis: ((json['kpis'] as List?) ?? const <dynamic>[])
            .whereType<Map<dynamic, dynamic>>()
            .map(DataBriefPoint.fromJson)
            .toList(growable: false),
        restText: (json['restText'] as String?) ?? "",
      );
}

/// 单个 KPI 数据点：标签 + 数值（含单位）+ 可选变化（±百分比）。
class DataBriefPoint {
  const DataBriefPoint({
    required this.label,
    required this.value,
    this.change,
  });

  final String label;
  final String value;
  final String? change;

  factory DataBriefPoint.fromJson(Map<dynamic, dynamic> json) =>
      DataBriefPoint(
        label: (json['label'] as String?) ?? "",
        value: (json['value'] as String?) ?? "",
        change: json['change'] as String?,
      );
}