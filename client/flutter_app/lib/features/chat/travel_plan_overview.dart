import "package:flutter/material.dart";

import "../../core/utils/agent_result_parser.dart";
import "travel_design_theme.dart";
import "travel_plan_models.dart";
import "travel_plan_panel.dart" show TravelPlanFullscreenPage;

/// 行程概览页 —— 一比一还原 3D-Travel design-reference/overview.html。
///
/// 结构：顶栏(返回 + 规划完成) → Hero 简报 → KPI 四宫格 → 预算构成 →
/// 每日路线(可折叠 Day 卡片) → 底部行动区(重新生成 + 开始浏览行程)。
/// 宽度不足 560 时按设计稿 @media 规则降为两列 / 纵向堆叠。
class TravelPlanOverview extends StatefulWidget {
  const TravelPlanOverview({
    super.key,
    required this.data,
    this.onBack,
    this.onRegenerate,
  });

  final AgentResultData data;

  /// 返回回调（右侧面板模式传 _closeRightPanel；全屏时为空则自动 pop）。
  final VoidCallback? onBack;

  /// 「重新生成」回调（缺省提示）。
  final VoidCallback? onRegenerate;

  @override
  State<TravelPlanOverview> createState() => _TravelPlanOverviewState();
}

class _TravelPlanOverviewState extends State<TravelPlanOverview> {
  late final TravelPlanData _plan = TravelPlanData.from(widget.data);

  /// 各 Day 是否展开（Day 1 默认展开，其余折叠）。
  late final Set<int> _expanded = <int>{0};

  @override
  Widget build(BuildContext context) {
    return TravelDesign.scope(
      child: LayoutBuilder(
        builder: (BuildContext context, BoxConstraints constraints) {
          final bool narrow = constraints.maxWidth < 560;
          return ColoredBox(
            color: TravelDesign.background,
            child: Column(
              children: <Widget>[
                _buildTopbar(context),
                Expanded(
                  child: SingleChildScrollView(
                    child: Center(
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 720),
                        child: Padding(
                          padding: const EdgeInsets.fromLTRB(20, 32, 20, 40),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: <Widget>[
                              _buildHero(narrow),
                              const SizedBox(height: 32),
                              _buildKpiGrid(narrow),
                              const SizedBox(height: 32),
                              _buildBudget(narrow),
                              const SizedBox(height: 32),
                              _buildDaily(),
                              const SizedBox(height: 24),
                              _buildActions(context),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  // ── 顶栏：返回 + 规划完成 ────────────────────────────────────────
  Widget _buildTopbar(BuildContext context) {
    return Container(
      height: 56,
      padding: const EdgeInsets.symmetric(horizontal: 20),
      decoration: BoxDecoration(
        color: TravelDesign.background,
        border: Border(bottom: BorderSide(color: TravelDesign.border)),
      ),
      child: Row(
        children: <Widget>[
          _backButton(context),
          const Spacer(),
          Container(
            height: 28,
            padding: const EdgeInsets.symmetric(horizontal: 12),
            decoration: BoxDecoration(
              color: TravelDesign.secondary,
              borderRadius: BorderRadius.circular(999),
            ),
            child: const Center(
              child: Text(
                "规划完成",
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                  color: TravelDesign.secondaryForeground,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _backButton(BuildContext context) {
    return Transform.translate(
      offset: const Offset(-8, 0),
      child: InkWell(
        borderRadius: BorderRadius.circular(6),
        onTap: () {
          if (widget.onBack != null) {
            widget.onBack!();
          } else if (Navigator.of(context).canPop()) {
            Navigator.of(context).pop();
          }
        },
        child: Container(
          height: 36,
          padding: const EdgeInsets.symmetric(horizontal: 8),
          child: const Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(Icons.chevron_left, size: 18, color: TravelDesign.foreground),
              Text(
                "返回",
                style: TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w500,
                  color: TravelDesign.foreground,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  // ── Hero 简报 ────────────────────────────────────────────────────
  Widget _buildHero(bool narrow) {
    final String dest =
        _plan.destination.isNotEmpty ? _plan.destination : _plan.title;
    final String title =
        _plan.title.isNotEmpty ? _plan.title : (dest.isEmpty ? "行程概览" : "$dest 行程");
    final String dateLine = _buildDateLine();
    final double total = _computeBudget().total;

    if (narrow) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _heroLeft(dest, title, dateLine),
          const SizedBox(height: 12),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: <Widget>[
              _originalPrice(total),
              const SizedBox(width: 12),
              _priceMain(total),
            ],
          ),
        ],
      );
    }
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: <Widget>[
        _heroLeft(dest, title, dateLine),
        Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: <Widget>[
            _priceMain(total),
            const SizedBox(height: 6),
            _originalPrice(total),
          ],
        ),
      ],
    );
  }

  Widget _heroLeft(String dest, String title, String dateLine) {
    return Flexible(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Container(
            height: 28,
            padding: const EdgeInsets.symmetric(horizontal: 12),
            decoration: BoxDecoration(
              color: TravelDesign.secondary,
              borderRadius: BorderRadius.circular(999),
            ),
            child: Center(
              child: Text(
                dest,
                style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                  color: TravelDesign.secondaryForeground,
                ),
              ),
            ),
          ),
          const SizedBox(height: 12),
          Text(
            title,
            style: const TextStyle(
              fontSize: 28,
              fontWeight: FontWeight.w700,
              height: 1.2,
              letterSpacing: -0.01,
              color: TravelDesign.foreground,
            ),
          ),
          const SizedBox(height: 12),
          Text(
            dateLine,
            style: const TextStyle(
              fontSize: 14,
              color: TravelDesign.mutedForeground,
            ),
          ),
        ],
      ),
    );
  }

  Widget _priceMain(double total) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: <Widget>[
        const Text(
          "预估总费用",
          style: TextStyle(
            fontSize: 12,
            color: TravelDesign.mutedForeground,
          ),
        ),
        const SizedBox(height: 2),
        Text(
          _formatMoney(total),
          style: const TextStyle(
            fontSize: 24,
            fontWeight: FontWeight.w700,
            height: 1.2,
            letterSpacing: -0.01,
            color: TravelDesign.foreground,
          ),
        ),
      ],
    );
  }

  Widget _originalPrice(double total) {
    if (total <= 0) return const SizedBox.shrink();
    return Text(
      _formatMoney(total * 1.2),
      style: const TextStyle(
        fontSize: 13,
        decoration: TextDecoration.lineThrough,
        color: TravelDesign.mutedForeground,
      ),
    );
  }

  String _buildDateLine() {
    final String start = _formatDate(_plan.startDate);
    final String end = _formatDate(_plan.endDate);
    final int days = _plan.days.length;
    final String range =
        start.isNotEmpty && end.isNotEmpty ? "$start — $end" : "";
    final String nights = days > 1 ? "$days天${days - 1}晚" : "$days天";
    if (range.isNotEmpty) return "$range · $nights";
    return nights;
  }

  static String _formatDate(String ymd) {
    final RegExpMatch? m =
        RegExp(r'^(\d{4})-(\d{1,2})-(\d{1,2})$').firstMatch(ymd.trim());
    if (m == null) return ymd.trim();
    return "${int.parse(m.group(2)!).toString()  }月${int.parse(m.group(3)!).toString()}日";
  }

  // ── KPI 四宫格 ───────────────────────────────────────────────────
  Widget _buildKpiGrid(bool narrow) {
    final _BudgetStat s = _computeBudget();
    final int totalSpots = s.attraction + s.restaurant + s.hotel + s.transport;
    return GridView.count(
      crossAxisCount: narrow ? 2 : 4,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      crossAxisSpacing: 12,
      mainAxisSpacing: 12,
      childAspectRatio: 1.9,
      children: <Widget>[
        _kpiCard(s.days, "天数"),
        _kpiCard(s.attraction, "景点"),
        _kpiCard(s.restaurant, "餐厅"),
        _kpiCard(totalSpots, "总地点"),
      ],
    );
  }

  Widget _kpiCard(int num, String label) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 20),
      decoration: BoxDecoration(
        color: TravelDesign.card,
        border: Border.all(color: TravelDesign.border),
        borderRadius: BorderRadius.circular(TravelDesign.radius),
      ),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          Text(
            "$num",
            style: const TextStyle(
              fontSize: 28,
              fontWeight: FontWeight.w700,
              height: 1,
              letterSpacing: -0.01,
              color: TravelDesign.foreground,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            label,
            style: const TextStyle(
              fontSize: 12,
              color: TravelDesign.mutedForeground,
            ),
          ),
        ],
      ),
    );
  }

  // ── 预算构成 ─────────────────────────────────────────────────────
  Widget _buildBudget(bool narrow) {
    final _BudgetStat s = _computeBudget();
    final List<(String, double, Color)> segments = <(String, double, Color)>[
      ("住宿", s.stay, TravelDesign.chart1),
      ("餐饮", s.food, TravelDesign.chart2),
      ("门票", s.ticket, TravelDesign.chart3),
      ("交通", s.transportCost, TravelDesign.chart4),
    ];
    final double total = s.total;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const Text(
          "预算构成",
          style: TextStyle(
            fontSize: 18,
            fontWeight: FontWeight.w600,
            color: TravelDesign.foreground,
          ),
        ),
        const SizedBox(height: 16),
        ClipRRect(
          borderRadius: BorderRadius.circular(999),
          child: SizedBox(
            height: 12,
            child: total > 0
                ? Row(
                    children: <Widget>[
                      for (final (_, double amt, Color c) in segments)
                        if (amt > 0)
                          Expanded(
                            flex: (amt * 100).round(),
                            child: ColoredBox(color: c),
                          ),
                    ],
                  )
                : ColoredBox(color: TravelDesign.muted),
          ),
        ),
        const SizedBox(height: 16),
        GridView.count(
          crossAxisCount: narrow ? 2 : 4,
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          crossAxisSpacing: 12,
          mainAxisSpacing: 12,
          childAspectRatio: 2.6,
          children: <Widget>[
            for (final (String name, double amt, Color c) in segments)
              _budgetLegendItem(name, amt, c, total),
          ],
        ),
      ],
    );
  }

  Widget _budgetLegendItem(String name, double amt, Color c, double total) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Container(
          width: 10,
          height: 10,
          decoration: BoxDecoration(
            color: c,
            borderRadius: BorderRadius.circular(3),
          ),
        ),
        const SizedBox(height: 4),
        Text(
          name,
          style: const TextStyle(
            fontSize: 12,
            color: TravelDesign.mutedForeground,
          ),
        ),
        const SizedBox(height: 1),
        Text(
          total > 0 ? _formatMoney(amt) : "—",
          style: const TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w600,
            color: TravelDesign.foreground,
          ),
        ),
      ],
    );
  }

  // ── 每日路线 ─────────────────────────────────────────────────────
  Widget _buildDaily() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const Text(
          "每日路线",
          style: TextStyle(
            fontSize: 18,
            fontWeight: FontWeight.w600,
            color: TravelDesign.foreground,
          ),
        ),
        const SizedBox(height: 6),
        const Text(
          "点击展开查看，不喜欢可直接更换",
          style: TextStyle(
            fontSize: 13,
            color: TravelDesign.mutedForeground,
          ),
        ),
        const SizedBox(height: 16),
        for (int i = 0; i < _plan.days.length; i++) ...<Widget>[
          _buildDayBlock(i),
          if (i != _plan.days.length - 1) const SizedBox(height: 16),
        ],
      ],
    );
  }

  Widget _buildDayBlock(int index) {
    final TravelPlanDay day = _plan.days[index];
    final bool isExpanded = _expanded.contains(index);
    return Container(
      decoration: BoxDecoration(
        color: TravelDesign.card,
        border: Border.all(
          color: isExpanded ? TravelDesign.borderStrong : TravelDesign.border,
        ),
        borderRadius: BorderRadius.circular(TravelDesign.radius),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        children: <Widget>[
          InkWell(
            onTap: () => setState(() {
              if (!_expanded.add(index)) _expanded.remove(index);
            }),
            child: Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
              child: Row(
                children: <Widget>[
                  Container(
                    height: 26,
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                    decoration: BoxDecoration(
                      color: TravelDesign.primary,
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Center(
                      child: Text(
                        "Day ${index + 1}",
                        style: const TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w600,
                          letterSpacing: 0.02,
                          color: TravelDesign.primaryForeground,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Text(
                    _dayName(index, day),
                    style: const TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                      color: TravelDesign.foreground,
                    ),
                  ),
                  if (_formatDate(day.date).isNotEmpty) ...<Widget>[
                    const SizedBox(width: 8),
                    Text(
                      _formatDate(day.date),
                      style: const TextStyle(
                        fontSize: 13,
                        color: TravelDesign.mutedForeground,
                      ),
                    ),
                  ],
                  const Spacer(),
                  Text(
                    "${day.entries.length}个地点",
                    style: const TextStyle(
                      fontSize: 12,
                      color: TravelDesign.mutedForeground,
                    ),
                  ),
                  const SizedBox(width: 8),
                  AnimatedRotation(
                    turns: isExpanded ? 0.5 : 0,
                    duration: const Duration(milliseconds: 250),
                    curve: Curves.easeInOut,
                    child: const Icon(
                      Icons.keyboard_arrow_down,
                      size: 18,
                      color: TravelDesign.mutedForeground,
                    ),
                  ),
                ],
              ),
            ),
          ),
          AnimatedCrossFade(
            firstChild: const SizedBox(width: double.infinity),
            secondChild: _buildSpotList(day.entries),
            crossFadeState: isExpanded
                ? CrossFadeState.showSecond
                : CrossFadeState.showFirst,
            duration: const Duration(milliseconds: 300),
            sizeCurve: Curves.easeInOut,
          ),
        ],
      ),
    );
  }

  String _dayName(int index, TravelPlanDay day) {
    if (day.subtitle.isNotEmpty) return day.subtitle;
    return "第 ${index + 1} 天";
  }

  Widget _buildSpotList(List<TravelDayEntry> entries) {
    if (entries.isEmpty) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.all(20),
        decoration: BoxDecoration(
          border: Border(top: BorderSide(color: TravelDesign.border)),
        ),
        child: const Text(
          "这一天暂无安排",
          style: TextStyle(
            fontSize: 12,
            color: TravelDesign.mutedForeground,
          ),
        ),
      );
    }
    return Column(
      children: <Widget>[
        for (int i = 0; i < entries.length; i++) _buildSpotItem(entries[i], i),
      ],
    );
  }

  Widget _buildSpotItem(TravelDayEntry entry, int index) {
    final (String label, Color color) =
        travelKindLabelAndColor(entry.type.isEmpty ? entry.kind.name : entry.type);
    final String price = entry.priceInfo.trim().isEmpty ? "" : entry.priceInfo.trim();
    final String detail = price.isEmpty ? label : "$label · $price";
    return Container(
      decoration: BoxDecoration(
        border: Border(
          top: index == 0
              ? BorderSide(color: TravelDesign.border)
              : BorderSide(color: TravelDesign.border),
        ),
      ),
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Container(width: 4, color: color),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
                child: Row(
                  children: <Widget>[
                    SizedBox(
                      width: 60,
                      child: Text(
                        entry.time,
                        style: const TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w500,
                          fontFeatures: <FontFeature>[
                            FontFeature.tabularFigures(),
                          ],
                          color: TravelDesign.mutedForeground,
                        ),
                      ),
                    ),
                    const SizedBox(width: 16),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Text(
                            entry.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 15,
                              fontWeight: FontWeight.w600,
                              color: TravelDesign.foreground,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            detail,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 12,
                              color: TravelDesign.mutedForeground,
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 12),
                    _swapButton(),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _swapButton() {
    return InkWell(
      borderRadius: BorderRadius.circular(999),
      onTap: () {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text("点击「开始浏览行程」进入行程详情后可更换"),
            duration: Duration(seconds: 2),
            behavior: SnackBarBehavior.floating,
          ),
        );
      },
      child: Container(
        height: 28,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(
          color: TravelDesign.card,
          border: Border.all(color: TravelDesign.border),
          borderRadius: BorderRadius.circular(999),
        ),
        child: const Center(
          child: Text(
            "换一个",
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w500,
              color: TravelDesign.mutedForeground,
            ),
          ),
        ),
      ),
    );
  }

  // ── 底部行动区 ───────────────────────────────────────────────────
  Widget _buildActions(BuildContext context) {
    return Row(
      children: <Widget>[
        _ghostButton("重新生成", () {
          if (widget.onRegenerate != null) {
            widget.onRegenerate!();
          } else {
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(
                content: Text("请告诉助手重新规划一次行程"),
                duration: Duration(seconds: 2),
                behavior: SnackBarBehavior.floating,
              ),
            );
          }
        }),
        const SizedBox(width: 12),
        Expanded(
          child: InkWell(
            borderRadius: BorderRadius.circular(6),
            onTap: () {
              Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (BuildContext context) => TravelPlanFullscreenPage(
                    data: widget.data,
                  ),
                ),
              );
            },
            child: Container(
              height: 44,
              decoration: BoxDecoration(
                color: TravelDesign.primary,
                borderRadius: BorderRadius.circular(6),
              ),
              child: const Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: <Widget>[
                  Text(
                    "开始浏览行程",
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w500,
                      color: TravelDesign.primaryForeground,
                    ),
                  ),
                  SizedBox(width: 8),
                  Icon(
                    Icons.chevron_right,
                    size: 16,
                    color: TravelDesign.primaryForeground,
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _ghostButton(String label, VoidCallback onTap) {
    return InkWell(
      borderRadius: BorderRadius.circular(6),
      onTap: onTap,
      child: Container(
        height: 44,
        padding: const EdgeInsets.symmetric(horizontal: 20),
        decoration: BoxDecoration(
          color: Colors.transparent,
          border: Border.all(color: TravelDesign.border),
          borderRadius: BorderRadius.circular(6),
        ),
        child: Center(
          child: Text(
            label,
            style: const TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w500,
              color: TravelDesign.foreground,
            ),
          ),
        ),
      ),
    );
  }

  // ── 预算统计 ─────────────────────────────────────────────────────
  _BudgetStat _computeBudget() {
    int days = _plan.days.length;
    int attraction = 0, restaurant = 0, hotel = 0, transport = 0;
    double stay = 0, food = 0, ticket = 0, transportCost = 0;
    for (final TravelPlanDay d in _plan.days) {
      for (final TravelDayEntry e in d.entries) {
        switch (e.kind) {
          case TravelEntryKind.attraction:
            attraction++;
            ticket += e.numericPrice ?? 0;
            break;
          case TravelEntryKind.restaurant:
            restaurant++;
            food += e.numericPrice ?? 0;
            break;
          case TravelEntryKind.hotel:
            hotel++;
            stay += e.numericPrice ?? 0;
            break;
          case TravelEntryKind.transport:
            transport++;
            transportCost += e.numericPrice ?? 0;
            break;
          case TravelEntryKind.other:
            ticket += e.numericPrice ?? 0;
            break;
        }
      }
    }
    return _BudgetStat(
      days: days,
      attraction: attraction,
      restaurant: restaurant,
      hotel: hotel,
      transport: transport,
      stay: stay,
      food: food,
      ticket: ticket,
      transportCost: transportCost,
    );
  }

  static String _formatMoney(double v) {
    if (v <= 0) return "¥0";
    final int i = v.round();
    final String s = i.toString();
    final StringBuffer b = StringBuffer();
    for (int k = 0; k < s.length; k++) {
      b.write(s[k]);
      final int remaining = s.length - k - 1;
      if (remaining > 0 && remaining % 3 == 0) b.write(",");
    }
    return "¥$b";
  }
}

class _BudgetStat {
  const _BudgetStat({
    required this.days,
    required this.attraction,
    required this.restaurant,
    required this.hotel,
    required this.transport,
    required this.stay,
    required this.food,
    required this.ticket,
    required this.transportCost,
  });

  final int days;
  final int attraction;
  final int restaurant;
  final int hotel;
  final int transport;
  final double stay;
  final double food;
  final double ticket;
  final double transportCost;

  double get total => stay + food + ticket + transportCost;
}
