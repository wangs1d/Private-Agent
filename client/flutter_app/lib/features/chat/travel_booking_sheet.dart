import "package:flutter/material.dart";

import "travel_plan_api.dart";

const Color _kAccentBlue = Color(0xFF18D6F3);
const Color _kAccentGreen = Color(0xFF1ED7A6);
const Color _kAccentOrange = Color(0xFFD7B85A);

/// 绑定平台账户（对齐 3D-Travel state.boundPlatforms 形状与服务端 pricing-service 目录）。
class BoundPlatform {
  const BoundPlatform({
    required this.platform,
    required this.accountLevel,
    required this.displayName,
  });

  factory BoundPlatform.fromJson(Map<String, dynamic> json) => BoundPlatform(
        platform: json["platform"]?.toString() ?? "",
        accountLevel: json["accountLevel"]?.toString() ?? "",
        displayName: json["displayName"]?.toString() ?? "",
      );

  Map<String, String> toJson() => <String, String>{
        "platform": platform,
        "accountLevel": accountLevel,
        "displayName": displayName,
      };

  final String platform;
  final String accountLevel;
  final String displayName;
}

/// 平台目录（与服务端 pricing-service._loadPlatformBenefits 的平台/等级一一对应）。
class PlatformCatalogEntry {
  const PlatformCatalogEntry(this.platform, this.displayName, this.category, this.levels);
  final String platform;
  final String displayName;
  final String category;
  final List<String> levels;
}

const List<PlatformCatalogEntry> kTravelPlatformCatalog = <PlatformCatalogEntry>[
  PlatformCatalogEntry("booking", "Booking.com", "国际酒店", <String>["genius-1", "genius-2", "genius-3"]),
  PlatformCatalogEntry("agoda", "Agoda", "国际酒店", <String>["silver", "gold", "platinum"]),
  PlatformCatalogEntry("trip", "Trip.com", "国际综合", <String>["silver", "gold"]),
  PlatformCatalogEntry("ctrip", "携程", "综合OTA", <String>["silver", "gold", "diamond"]),
  PlatformCatalogEntry("fliggy", "飞猪", "综合OTA", <String>["F1", "F2", "F3"]),
  PlatformCatalogEntry("meituan", "美团", "本地生活", <String>["green", "yellow", "black"]),
  PlatformCatalogEntry("dianping", "大众点评", "本地生活", <String>["yellow", "orange"]),
  PlatformCatalogEntry("klook", "Klook", "玩乐活动", <String>["priority", "elite"]),
  PlatformCatalogEntry("kkday", "KKday", "玩乐活动", <String>["member", "vip"]),
];

const Map<String, String> kMemberTierLabels = <String, String>{
  "normal": "普通会员（无折扣）",
  "silver": "银卡会员 9.5折",
  "gold": "金卡会员 9折",
  "diamond": "钻石会员 8.5折",
  "platinum": "黑金会员 8折",
};

/// 预订清单条目（服务端 POST /travel/plans/:id/booking 返回；checked 可勾选切换）。
class TravelBookingItem {
  TravelBookingItem({
    required this.name,
    required this.type,
    required this.unitPrice,
    required this.count,
    required this.originalPrice,
    required this.finalPrice,
    this.description = "",
    this.discounts = const <String>[],
    this.checked = true,
  });

  factory TravelBookingItem.fromJson(Map<String, dynamic> json) {
    return TravelBookingItem(
      name: json["name"]?.toString() ?? "",
      type: json["type"]?.toString() ?? "",
      unitPrice: (num.tryParse(json["unitPrice"]?.toString() ?? "") ?? 0).toDouble(),
      count: num.tryParse(json["count"]?.toString() ?? "")?.toInt() ?? 1,
      originalPrice: (num.tryParse(json["originalPrice"]?.toString() ?? "") ?? 0).toDouble(),
      finalPrice: (num.tryParse(json["finalPrice"]?.toString() ?? "") ?? 0).toDouble(),
      description: json["description"]?.toString() ?? "",
      discounts: <String>[
        for (final dynamic d in (json["discounts"] as List<dynamic>? ?? const <dynamic>[]))
          if (d != null) d.toString(),
      ],
    );
  }

  final String name;
  final String type;
  final double unitPrice;
  final int count;
  final double originalPrice;
  final double finalPrice;
  final String description;
  final List<String> discounts;
  bool checked;
}

/// 预订清单面板 —— 移植自 3D-Travel 的 booking-panel：
/// 从行程提取酒店/门票/餐饮，勾选、删除、合计、已省金额，会员 + 平台价格设置。
class TravelBookingSheet extends StatefulWidget {
  const TravelBookingSheet({
    super.key,
    required this.planId,
    this.initialTier = "normal",
    this.initialPlatforms = const <BoundPlatform>[],
  });

  final String planId;
  final String initialTier;
  final List<BoundPlatform> initialPlatforms;

  /// 弹出面板；返回应用后的价格设置（供面板状态留存），取消返回 null。
  static Future<(String, List<BoundPlatform>)?> show(
    BuildContext context, {
    required String planId,
    String initialTier = "normal",
    List<BoundPlatform> initialPlatforms = const <BoundPlatform>[],
  }) {
    return showModalBottomSheet<(String, List<BoundPlatform>)>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (BuildContext context) => TravelBookingSheet(
        planId: planId,
        initialTier: initialTier,
        initialPlatforms: initialPlatforms,
      ),
    );
  }

  @override
  State<TravelBookingSheet> createState() => _TravelBookingSheetState();
}

class _TravelBookingSheetState extends State<TravelBookingSheet> {
  String _tier = "normal";
  List<BoundPlatform> _platforms = <BoundPlatform>[];
  List<TravelBookingItem> _items = <TravelBookingItem>[];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _tier = widget.initialTier;
    _platforms = List<BoundPlatform>.from(widget.initialPlatforms);
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final Map<String, dynamic> data = await TravelPlanApi().computeBooking(
        widget.planId,
        memberTier: _tier,
        boundPlatforms: <Map<String, String>>[
          for (final BoundPlatform p in _platforms) p.toJson(),
        ],
      );
      if (!mounted) return;
      setState(() {
        _items = <TravelBookingItem>[
          for (final dynamic it in (data["items"] as List<dynamic>? ?? const <dynamic>[]))
            if (it is Map<String, dynamic>) TravelBookingItem.fromJson(it),
        ];
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = "计价失败：$e";
        _loading = false;
      });
    }
  }

  double get _totalFinal => _items.fold<double>(
      0, (double s, TravelBookingItem it) => s + (it.checked ? it.finalPrice : 0));
  double get _totalOriginal => _items.fold<double>(
      0, (double s, TravelBookingItem it) => s + (it.checked ? it.originalPrice : 0));

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return DraggableScrollableSheet(
      initialChildSize: 0.72,
      maxChildSize: 0.92,
      minChildSize: 0.4,
      builder: (BuildContext context, ScrollController scrollController) {
        return Container(
          decoration: BoxDecoration(
            color: cs.surfaceContainer,
            borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
          ),
          child: Column(
            children: <Widget>[
              // 头部
              Container(
                padding: const EdgeInsets.fromLTRB(16, 14, 8, 10),
                child: Row(
                  children: <Widget>[
                    const Icon(Icons.receipt_long_outlined,
                        size: 18, color: _kAccentGreen),
                    const SizedBox(width: 8),
                    const Text("预订清单",
                        style: TextStyle(
                            fontSize: 14.5, fontWeight: FontWeight.w700)),
                    const SizedBox(width: 8),
                    Text("${_items.length} 项",
                        style: TextStyle(
                            fontSize: 11, color: cs.onSurfaceVariant)),
                    const Spacer(),
                    IconButton(
                      tooltip: "刷新价格",
                      icon: const Icon(Icons.refresh, size: 18),
                      onPressed: _refresh,
                    ),
                    IconButton(
                      tooltip: "会员/平台价格设置",
                      icon: const Icon(Icons.workspace_premium_outlined,
                          size: 18, color: _kAccentOrange),
                      onPressed: _openPriceSettings,
                    ),
                    IconButton(
                      tooltip: "关闭",
                      icon: const Icon(Icons.close, size: 18),
                      onPressed: () => Navigator.of(context).pop(),
                    ),
                  ],
                ),
              ),
              _buildDiscountBar(cs),
              const Divider(height: 1),
              Expanded(
                child: _loading
                    ? const Center(
                        child: SizedBox(
                            width: 24,
                            height: 24,
                            child: CircularProgressIndicator(strokeWidth: 2)))
                    : _error != null
                        ? Center(
                            child: Text(_error!,
                                style: TextStyle(
                                    fontSize: 12, color: cs.error)))
                        : _items.isEmpty
                            ? Center(
                                child: Text(
                                  "行程里暂无可预订项目",
                                  style: TextStyle(
                                      fontSize: 12, color: cs.onSurfaceVariant),
                                ))
                            : ListView.separated(
                                controller: scrollController,
                                padding: const EdgeInsets.all(12),
                                itemCount: _items.length,
                                separatorBuilder: (_, __) =>
                                    const SizedBox(height: 8),
                                itemBuilder: (BuildContext context, int i) =>
                                    _buildItemRow(cs, i),
                              ),
              ),
              // 底部合计
              Container(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 14),
                decoration: BoxDecoration(
                  color: cs.surfaceContainerHigh,
                  borderRadius:
                      const BorderRadius.vertical(top: Radius.circular(12)),
                ),
                child: Row(
                  children: <Widget>[
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Text("实付合计",
                              style: TextStyle(
                                  fontSize: 10.5, color: cs.onSurfaceVariant)),
                          Text("¥${_totalFinal.toStringAsFixed(0)}",
                              style: const TextStyle(
                                  fontSize: 19,
                                  fontWeight: FontWeight.w800,
                                  color: _kAccentOrange)),
                        ],
                      ),
                    ),
                    if (_totalOriginal > _totalFinal)
                      Text(
                        "已省 ¥${(_totalOriginal - _totalFinal).toStringAsFixed(0)}",
                        style: const TextStyle(
                            fontSize: 12.5,
                            fontWeight: FontWeight.w600,
                            color: _kAccentGreen),
                      ),
                  ],
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  /// 折扣条：当前会员等级 + 已绑定平台标签（对应 _renderDiscountBar）。
  Widget _buildDiscountBar(ColorScheme cs) {
    final List<String> tags = <String>[
      if (_tier != "normal") kMemberTierLabels[_tier] ?? _tier,
      for (final BoundPlatform p in _platforms) "${p.displayName}(${p.accountLevel})",
    ];
    if (tags.isEmpty) return const SizedBox.shrink();
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      color: _kAccentOrange.withValues(alpha: 0.08),
      child: Row(
        children: <Widget>[
          const Icon(Icons.local_offer_outlined, size: 13, color: _kAccentOrange),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              tags.join(" · "),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 11, color: _kAccentOrange),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildItemRow(ColorScheme cs, int i) {
    final TravelBookingItem it = _items[i];
    final IconData icon = switch (it.type) {
      "hotel" => Icons.hotel_outlined,
      "attraction" => Icons.attractions_outlined,
      "restaurant" => Icons.restaurant_outlined,
      _ => Icons.receipt_outlined,
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: cs.outline.withValues(alpha: 0.15)),
      ),
      child: Row(
        children: <Widget>[
          Checkbox(
            value: it.checked,
            visualDensity: VisualDensity.compact,
            activeColor: _kAccentGreen,
            onChanged: (bool? v) =>
                setState(() => _items[i].checked = v ?? true),
          ),
          Icon(icon, size: 17, color: _kAccentBlue),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(it.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        fontSize: 12.5, fontWeight: FontWeight.w600)),
                const SizedBox(height: 2),
                Text(
                  <String>[
                    if (it.description.isNotEmpty) it.description,
                    "¥${it.unitPrice.toStringAsFixed(0)} × ${it.count}",
                    ...it.discounts,
                  ].join(" · "),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                      fontSize: 10.5, color: cs.onSurfaceVariant),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: <Widget>[
              Text("¥${it.finalPrice.toStringAsFixed(0)}",
                  style: const TextStyle(
                      fontSize: 13.5,
                      fontWeight: FontWeight.w700,
                      color: _kAccentOrange)),
              if (it.originalPrice > it.finalPrice)
                Text(
                  "¥${it.originalPrice.toStringAsFixed(0)}",
                  style: TextStyle(
                    fontSize: 10,
                    color: cs.onSurfaceVariant,
                    decoration: TextDecoration.lineThrough,
                  ),
                ),
            ],
          ),
          IconButton(
            tooltip: "移除",
            visualDensity: VisualDensity.compact,
            icon: Icon(Icons.close, size: 15, color: cs.onSurfaceVariant),
            onPressed: () => setState(() => _items.removeAt(i)),
          ),
        ],
      ),
    );
  }

  // ── 价格设置弹窗（会员等级 + 平台绑定，对应 openPriceSettings）──────
  Future<void> _openPriceSettings() async {
    String tempTier = _tier;
    final List<BoundPlatform> tempPlatforms = List<BoundPlatform>.from(_platforms);
    final bool? applied = await showDialog<bool>(
      context: context,
      builder: (BuildContext context) => StatefulBuilder(
        builder: (BuildContext context, void Function(void Function()) setDialog) {
          final ColorScheme cs = Theme.of(context).colorScheme;
          return Dialog(
            backgroundColor: cs.surfaceContainer,
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 480, maxHeight: 620),
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    const Text("价格设置",
                        style: TextStyle(
                            fontSize: 15, fontWeight: FontWeight.w700)),
                    const SizedBox(height: 4),
                    Text("会员等级与绑定账户将用于计算平台专属价",
                        style: TextStyle(
                            fontSize: 11, color: cs.onSurfaceVariant)),
                    const SizedBox(height: 12),
                    // 会员等级
                    Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      children: <Widget>[
                        for (final String tier in kMemberTierLabels.keys)
                          ChoiceChip(
                            label: Text(kMemberTierLabels[tier]!,
                                style: const TextStyle(fontSize: 11)),
                            selected: tempTier == tier,
                            onSelected: (_) =>
                                setDialog(() => tempTier = tier),
                          ),
                      ],
                    ),
                    const Divider(height: 20),
                    // 平台绑定列表
                    Expanded(
                      child: ListView.builder(
                        itemCount: kTravelPlatformCatalog.length,
                        itemBuilder: (BuildContext context, int i) {
                          final PlatformCatalogEntry p =
                              kTravelPlatformCatalog[i];
                          final int idx = tempPlatforms
                              .indexWhere((BoundPlatform b) => b.platform == p.platform);
                          final BoundPlatform? bound = idx >= 0 ? tempPlatforms[idx] : null;
                          return Container(
                            margin: const EdgeInsets.only(bottom: 6),
                            padding: const EdgeInsets.symmetric(
                                horizontal: 10, vertical: 6),
                            decoration: BoxDecoration(
                              borderRadius: BorderRadius.circular(10),
                              border: Border.all(
                                color: bound != null
                                    ? _kAccentBlue.withValues(alpha: 0.4)
                                    : cs.outline.withValues(alpha: 0.2),
                              ),
                            ),
                            child: Row(
                              children: <Widget>[
                                Checkbox(
                                  visualDensity: VisualDensity.compact,
                                  value: bound != null,
                                  onChanged: (bool? checked) => setDialog(() {
                                    if (checked ?? false) {
                                      tempPlatforms.add(BoundPlatform(
                                        platform: p.platform,
                                        accountLevel: p.levels.first,
                                        displayName: p.displayName,
                                      ));
                                    } else {
                                      tempPlatforms.removeWhere(
                                          (BoundPlatform b) => b.platform == p.platform);
                                    }
                                  }),
                                ),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: <Widget>[
                                      Text(p.displayName,
                                          style: const TextStyle(
                                              fontSize: 12.5,
                                              fontWeight: FontWeight.w600)),
                                      Text(p.category,
                                          style: TextStyle(
                                              fontSize: 10,
                                              color: cs.onSurfaceVariant)),
                                    ],
                                  ),
                                ),
                                if (bound != null)
                                  DropdownButton<String>(
                                    value: p.levels.contains(bound.accountLevel)
                                        ? bound.accountLevel
                                        : p.levels.first,
                                    underline: const SizedBox.shrink(),
                                    isDense: true,
                                    items: <DropdownMenuItem<String>>[
                                      for (final String lv in p.levels)
                                        DropdownMenuItem<String>(
                                            value: lv, child: Text(lv,
                                                style: const TextStyle(
                                                    fontSize: 11))),
                                    ],
                                    onChanged: (String? lv) => setDialog(() {
                                      if (lv == null) return;
                                      if (idx >= 0) {
                                        tempPlatforms[idx] = BoundPlatform(
                                          platform: bound.platform,
                                          accountLevel: lv,
                                          displayName: bound.displayName,
                                        );
                                      }
                                    }),
                                  ),
                              ],
                            ),
                          );
                        },
                      ),
                    ),
                    const SizedBox(height: 10),
                    Row(
                      children: <Widget>[
                        TextButton(
                          onPressed: () => setDialog(() {
                            tempTier = "normal";
                            tempPlatforms.clear();
                          }),
                          child: const Text("清空",
                              style: TextStyle(fontSize: 12.5)),
                        ),
                        const Spacer(),
                        TextButton(
                          onPressed: () => Navigator.of(context).pop(false),
                          child: const Text("取消",
                              style: TextStyle(fontSize: 12.5)),
                        ),
                        const SizedBox(width: 6),
                        FilledButton(
                          onPressed: () => Navigator.of(context).pop(true),
                          child: const Text("应用",
                              style: TextStyle(fontSize: 12.5)),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
    if (applied ?? false) {
      setState(() {
        _tier = tempTier;
        _platforms = List<BoundPlatform>.from(tempPlatforms);
      });
      _refresh();
      // 应用设置后关闭清单面板，并把最终设置带回给宿主留存
      if (mounted) {
        Navigator.of(context).pop((_tier, List<BoundPlatform>.from(_platforms)));
      }
    }
  }
}
