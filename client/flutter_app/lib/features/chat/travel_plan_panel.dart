import "package:flutter/material.dart";

import "../../core/utils/agent_result_parser.dart";

/// 行程条目类型（决定右栏时间线图标）。
enum TravelEntryKind {
  attraction,
  restaurant,
  hotel,
  transport,
  other,
}

/// 单条行程条目（右栏时间线的一行）。
class TravelDayEntry {
  const TravelDayEntry({
    required this.time,
    required this.title,
    required this.note,
    required this.kind,
  });

  /// 时间前缀（如「09:00」「上午」），查不到为空串。
  final String time;
  final String title;
  final String note;
  final TravelEntryKind kind;
}

/// 按天分组（左栏一个 tab）。
class TravelPlanDay {
  const TravelPlanDay({
    required this.label,
    this.subtitle = "",
    required this.entries,
  });

  final String label;
  final String subtitle;
  final List<TravelDayEntry> entries;
}

/// 双面板行程界面数据（优先来自服务端结构化 travelPlan，兜底从卡 items 文本启发式解析）。
class TravelPlanData {
  const TravelPlanData({
    required this.title,
    required this.destination,
    required this.days,
    this.footer = "",
    this.rawItems = const <String>[],
  });

  final String title;
  final String destination;
  final List<TravelPlanDay> days;
  final String footer;
  final List<String> rawItems;

  /// 从 [AgentResultData] 构建：优先读结构化 travelPlan，缺失时回退文本解析。
  factory TravelPlanData.from(AgentResultData data) {
    final Map<String, dynamic>? tp = data.travelPlan;
    final List<dynamic>? tpDays = tp?["days"] as List<dynamic>?;
    if (tp != null && tpDays != null && tpDays.isNotEmpty) {
      final TravelPlanData built = TravelPlanData._fromTravelPlan(tp);
      // 结构化数据异常（如全空天）时仍回退文本解析
      if (built.days.any((TravelPlanDay d) => d.entries.isNotEmpty)) return built;
    }
    return TravelPlanData.fromCard(data);
  }

  /// 服务端结构化行程（travel.plan-itinerary 产出）→ 直接渲染数据。
  static TravelPlanData _fromTravelPlan(Map<String, dynamic> tp) {
    final String title = tp["title"]?.toString() ?? "";
    final Object? destRawO = tp["destination"];
    final String destRaw = (destRawO?.toString() ?? "").trim();
    final String destination =
        destRaw.isNotEmpty ? destRaw : _inferDestination(title, const <String>[]);

    final List<dynamic> rawDays = tp["days"] as List<dynamic>? ?? const <dynamic>[];
    final List<TravelPlanDay> days = <TravelPlanDay>[];
    for (int i = 0; i < rawDays.length; i++) {
      final Map<String, dynamic> rawDay =
          (rawDays[i] as Map<String, dynamic>?) ?? const <String, dynamic>{};
      final String date = rawDay["date"]?.toString() ?? "";
      final List<dynamic> rawItems = rawDay["items"] as List<dynamic>? ?? const <dynamic>[];
      final List<TravelDayEntry> entries = <TravelDayEntry>[
        for (final dynamic raw in rawItems)
          if (raw is Map<String, dynamic>) _entryFromJson(raw),
      ];
      days.add(TravelPlanDay(
        label: date.isEmpty ? "Day ${i + 1}" : date,
        subtitle: date.isEmpty ? "" : "第 ${i + 1} 天",
        entries: entries,
      ));
    }

    return TravelPlanData(
      title: title.trim(),
      destination: destination,
      days: days,
      footer: "",
    );
  }

  /// 结构化行程条目 → 时间线行（type 直接映射图标，免正则推断）。
  static TravelDayEntry _entryFromJson(Map<String, dynamic> raw) {
    final String name = raw["name"]?.toString() ?? "";
    final String startTime = raw["startTime"]?.toString() ?? "";
    final String address = raw["address"]?.toString() ?? "";
    final String priceInfo = raw["priceInfo"]?.toString() ?? "";
    final String description = raw["description"]?.toString() ?? "";
    final String tip = (raw["tips"] as List<dynamic>?)?.join("；") ?? "";

    final List<String> noteParts = <String>[
      if (priceInfo.trim().isNotEmpty) priceInfo.trim(),
      if (description.trim().isNotEmpty) description.trim(),
      if (tip.trim().isNotEmpty) tip.trim(),
      if (address.trim().isNotEmpty) address.trim(),
    ];

    final String type = raw["type"]?.toString() ?? "";
    return TravelDayEntry(
      time: startTime,
      title: name.isEmpty ? "行程安排" : name,
      note: noteParts.join(" · "),
      kind: _kindFromType(type),
    );
  }

  static TravelEntryKind _kindFromType(String type) {
    switch (type) {
      case "attraction":
        return TravelEntryKind.attraction;
      case "hotel":
        return TravelEntryKind.hotel;
      case "restaurant":
        return TravelEntryKind.restaurant;
      case "transport":
        return TravelEntryKind.transport;
      default:
        return TravelEntryKind.other;
    }
  }

  /// 解析行程卡（cardType = travel_itinerary）为按天分组的结构化数据（文本兜底）。
  factory TravelPlanData.fromCard(AgentResultData data) {
    final List<String> raw = <String>[
      for (final AgentResultItem it in data.items)
        if (it.text.trim().isNotEmpty) it.text.trim(),
    ];

    final List<TravelPlanDay> days = <TravelPlanDay>[];
    TravelPlanDay? current;
    for (final String line in raw) {
      final DayHeader? header = _parseDayHeader(line);
      if (header != null) {
        if (current != null) days.add(current);
        current = TravelPlanDay(
          label: header.label,
          subtitle: header.subtitle,
          entries: <TravelDayEntry>[],
        );
        continue;
      }
      (current ??= TravelPlanDay(
                label: "全程",
                entries: <TravelDayEntry>[],
              ))
          .entries
          .add(_parseEntry(line));
    }
    if (current != null) days.add(current);

    // 兜底：没解析出任何行时给一个空整天，保证双栏骨架完整可渲染
    if (days.isEmpty) {
      days.add(const TravelPlanDay(label: "全程", entries: <TravelDayEntry>[]));
    }

    return TravelPlanData(
      title: data.title.trim(),
      destination: _inferDestination(data.title, raw),
      days: days,
      footer: data.footer.trim(),
      rawItems: raw,
    );
  }

  /// 「Day N / 第N天」行 → 天分组头；非天标题行返回 null。
  static DayHeader? _parseDayHeader(String line) {
    final RegExp re = RegExp(
      r'^(?:第\s*([0-9一二三四五六七八九十百]+)\s*天|[dD]ay\s*([0-9一二三四五六七八九十百]+))[\s:：、-]*(.*)$',
    );
    final RegExpMatch? m = re.firstMatch(line);
    if (m == null) return null;
    final String? num = m.group(1) ?? m.group(2);
    if (num == null) return null;
    final String subtitle = (m.group(3) ?? "").trim();
    final String label = "Day $num";
    // 纯标题行（无余下内容）直接作为分组头
    if (subtitle.isEmpty) return DayHeader(label: label, subtitle: "");
    // 余下内容较长 → 视作首条行程条目而非分组副标题
    if (subtitle.length > 14) return null;
    return DayHeader(label: label, subtitle: subtitle);
  }

  /// 单行 → 行程条目（拆时间前缀 + 名称 + 备注 + 类型图标）。
  static TravelDayEntry _parseEntry(String line) {
    // 时间前缀：HH:mm / HH:mm-HH:mm / X点 / 上午 等
    final RegExp timeRe = RegExp(
      r'^(?:(\d{1,2}\s*[:：]\s*\d{2}\s*(?:[-~至]\s*\d{1,2}\s*[:：]\s*\d{2})?)'
      r'|(\d{1,2}\s*点\s*[半整一二三四五六七八九十]?)'
      r'|(清晨|早上|上午|中午|下午|傍晚|晚上|凌晨|夜里|白天|下午茶))\s*[:：、]?\s*',
    );
    final RegExpMatch? tm = timeRe.firstMatch(line);
    String rest = line;
    String time = "";
    if (tm != null) {
      time = tm.group(0)!.trim().replaceFirst(RegExp(r'[:：、]?\s*$'), "");
      rest = line.substring(tm.end).trim();
    }

    // 名称：第一个分隔符（：:，,、;；）之前的片段做名称，之后做备注
    final RegExp sepRe = RegExp(r'^(.{1,18}?)…?\s*([：:，,、;；|｜\-—]\s*)(.+)$');
    final RegExpMatch? sep = sepRe.firstMatch(rest);
    String title = rest;
    String note = "";
    if (sep != null) {
      title = sep.group(1)!.trim();
      note = sep.group(3)!.trim();
    }
    // 超长标题且无分隔符：直接截断标题，不做备注拆分（避免误切地名）；
    // 有分隔符时保留完整标题 + 备注
    if (title.length > 16 && note.isEmpty) {
      title = title.substring(0, 16);
    }

    return TravelDayEntry(
      time: time,
      title: title,
      note: note,
      kind: _inferKind(title, note),
    );
  }

  /// 目的地推断：优先 items 中「目的地：XXX」；否则从标题剥离天数/后缀词。
  static String _inferDestination(String title, List<String> raw) {
    for (final String line in raw) {
      final RegExpMatch? m =
          RegExp(r'目的地\s*[:：]\s*([\u4e00-\u9fa5A-Za-z·]{2,12})').firstMatch(line);
      if (m != null) return m.group(1)!.trim();
      final RegExpMatch? m2 =
          RegExp(r'(?:去|到|前往)\s*(.+?)\.put?').firstMatch(line);
      // 忽略复杂解析，仅在「目的地：」形式下命中
      if (m2 != null) { /* noop */ }
    }
    final String cleaned = title
        .replaceAll(
            RegExp(r'\d+\s*日游|\d+\s*天\s*游|日游|行程|规划|计划|自由行|攻略|旅游|安排|[·\-—|]\s*.*$'),
            '')
        .trim();
    if (cleaned.length >= 2 && cleaned.length <= 12) return cleaned;
    return title.isEmpty ? "行程" : title.substring(0, title.length.clamp(1, 8));
  }

  static TravelEntryKind _inferKind(String title, String note) {
    final String t = "$title $note";
    if (RegExp(r'餐|美食|火锅|小吃|面|馆|菜|咖啡|茶|早餐|午餐|晚餐|夜宵|外卖').hasMatch(t)) {
      return TravelEntryKind.restaurant;
    }
    if (RegExp(r'酒店|民宿|住宿|入住|旅馆|客栈|大厦|公寓').hasMatch(t)) {
      return TravelEntryKind.hotel;
    }
    if (RegExp(r'交通|地铁|公交|巴士|高铁|动车|飞机|打车|出租|导航|渡轮|轮船|步行|骑行|车程').hasMatch(t)) {
      return TravelEntryKind.transport;
    }
    if (RegExp(r'景点|游览|游玩|公园|寺|祠|街|巷|山|湖|河|馆|宫|塔|博物馆|遗址|古镇|门票|演出|show').hasMatch(t)) {
      return TravelEntryKind.attraction;
    }
    return TravelEntryKind.other;
  }
}

class DayHeader {
  const DayHeader({required this.label, required this.subtitle});
  final String label;
  final String subtitle;
}

// ═══════════════════════════════════════════════════════════════════
// 双面板行程规划界面
// ═══════════════════════════════════════════════════════════════════

const Color _kAccentBlue = Color(0xFF18D6F3);
const Color _kAccentGreen = Color(0xFF1ED7A6);
const Color _kAccentOrange = Color(0xFFD7B85A);

/// 双面板行程规划界面（左栏天数 + 右栏当日行程）。
///
/// 既可用于右侧分栏面板（聊天 + 规划界面双面板并行），
/// 也可经全屏入口在独立页面中以更大尺寸呈现。
class TravelPlanPanel extends StatefulWidget {
  const TravelPlanPanel({
    super.key,
    required this.data,
    this.fullscreen = false,
    this.onClose,
  });

  final AgentResultData data;

  /// 是否为全屏模式（全屏页时隐藏内部关闭按钮、强制深色渲染）。
  final bool fullscreen;

  /// 关闭回调（右侧面板模式传 [RightSidePanel] 的关闭，全屏页自身有返回键）。
  final VoidCallback? onClose;

  @override
  State<TravelPlanPanel> createState() => _TravelPlanPanelState();
}

class _TravelPlanPanelState extends State<TravelPlanPanel> {
  late final TravelPlanData _plan = TravelPlanData.from(widget.data);
  int _selectedDay = 0;

  void _openFullscreen() {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (BuildContext context) => TravelPlanFullscreenPage(
          data: widget.data,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final bool full = widget.fullscreen;
    final double leftWidth = full ? 260 : 216;

    return ColoredBox(
      color: full ? cs.surface : cs.surfaceContainer,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          _buildHeader(cs, full),
          const Divider(height: 1),
          Expanded(
            child: _plan.days.length > 1
                ? Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      SizedBox(
                        width: leftWidth,
                        child: _buildDayList(cs),
                      ),
                      VerticalDivider(width: 1, color: cs.outline.withValues(alpha: 0.18)),
                      Expanded(child: _buildDayDetail(cs, full)),
                    ],
                  )
                : _buildDayDetail(cs, full),
          ),
        ],
      ),
    );
  }

  // ── 顶栏：目的地 + 标题 + 全屏/关闭 ─────────────────────────────
  Widget _buildHeader(ColorScheme cs, bool full) {
    final String dest =
        _plan.destination.isNotEmpty ? _plan.destination : "行程规划";
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
      decoration: BoxDecoration(
        color: cs.surfaceContainerLow,
        border: Border(
          bottom: BorderSide(color: cs.outline.withValues(alpha: 0.18)),
        ),
      ),
      child: Row(
        children: <Widget>[
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              color: _kAccentBlue.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(999),
              border: Border.all(
                  color: _kAccentBlue.withValues(alpha: 0.35)),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                const Icon(Icons.flag_outlined, size: 13, color: _kAccentBlue),
                const SizedBox(width: 4),
                Text(
                  dest,
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: _kAccentBlue,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              _plan.title.isNotEmpty ? _plan.title : "$dest 行程",
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 13.5,
                fontWeight: FontWeight.w600,
                color: cs.onSurface,
              ),
            ),
          ),
          const SizedBox(width: 4),
          if (!full)
            IconButton(
              icon: const Icon(Icons.open_in_full, size: 17),
              tooltip: "全屏查看行程规划",
              visualDensity: VisualDensity.compact,
              color: cs.onSurfaceVariant,
              onPressed: _openFullscreen,
            ),
          if (widget.onClose != null)
            IconButton(
              icon: Icon(Icons.close, size: 17, color: cs.onSurfaceVariant),
              tooltip: "关闭",
              visualDensity: VisualDensity.compact,
              onPressed: widget.onClose,
            ),
        ],
      ),
    );
  }

  // ── 左栏：天数列表 ──────────────────────────────────────────────
  Widget _buildDayList(ColorScheme cs) {
    return ListView.builder(
      padding: const EdgeInsets.symmetric(vertical: 10),
      itemCount: _plan.days.length + (_plan.footer.isEmpty ? 0 : 1),
      itemBuilder: (BuildContext context, int index) {
        if (index == _plan.days.length) return _buildFooterCard(cs);
        final TravelPlanDay day = _plan.days[index];
        final bool selected = index == _selectedDay;
        return _DayCard(
          day: day,
          selected: selected,
          onTap: () => setState(() => _selectedDay = index),
        );
      },
    );
  }

  Widget _buildFooterCard(ColorScheme cs) {
    if (_plan.footer.isEmpty) return const SizedBox.shrink();
    return Container(
      margin: const EdgeInsets.fromLTRB(10, 6, 10, 2),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHighest.withValues(alpha: 0.45),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        _plan.footer,
        style: TextStyle(
          fontSize: 11,
          height: 1.45,
          color: cs.onSurfaceVariant,
        ),
      ),
    );
  }

  // ── 右栏：当日行程时间线 ────────────────────────────────────────
  Widget _buildDayDetail(ColorScheme cs, bool full) {
    final TravelPlanDay day = _plan.days[_selectedDay.clamp(0, _plan.days.length - 1)];
    final List<TravelDayEntry> entries = day.entries;

    return CustomScrollView(
      slivers: <Widget>[
        SliverToBoxAdapter(
          child: Padding(
            padding: EdgeInsets.fromLTRB(full ? 22 : 16, 14, full ? 22 : 16, 6),
            child: Row(
              children: <Widget>[
                Icon(Icons.calendar_today_outlined,
                    size: 14, color: _kAccentBlue),
                const SizedBox(width: 6),
                Text(
                  day.label,
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: cs.onSurface,
                  ),
                ),
                if (day.subtitle.isNotEmpty) ...<Widget>[
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      day.subtitle,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 11,
                        color: cs.onSurfaceVariant,
                      ),
                    ),
                  ),
                ],
                const Spacer(),
                Text(
                  "${entries.length} 项安排",
                  style: TextStyle(
                    fontSize: 10.5,
                    color: cs.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ),
        if (entries.isEmpty)
          SliverFillRemaining(
            hasScrollBody: false,
            child: Center(
              child: Text(
                "这一天的行程还在安排中",
                style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
              ),
            ),
          )
        else
          SliverList(
            delegate: SliverChildBuilderDelegate(
              (BuildContext context, int i) => _EntryTile(
                entry: entries[i],
                last: i == entries.length - 1,
              ),
              childCount: entries.length,
            ),
          ),
        if (_plan.footer.isNotEmpty)
          SliverToBoxAdapter(
            child: Padding(
              padding: EdgeInsets.fromLTRB(full ? 22 : 16, 12, full ? 22 : 16, 20),
              child: _buildInfoPanel(cs),
            ),
          ),
      ],
    );
  }

  /// 底部信息区：价格/实用信息提示（footer）。
  Widget _buildInfoPanel(ColorScheme cs) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHigh.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: cs.outline.withValues(alpha: 0.15)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Icon(Icons.lightbulb_outline, size: 14, color: _kAccentOrange),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              _plan.footer,
              style: TextStyle(
                fontSize: 11.5,
                height: 1.5,
                color: cs.onSurfaceVariant,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ── 左栏天数卡片 ─────────────────────────────────────────────────
class _DayCard extends StatelessWidget {
  const _DayCard({
    required this.day,
    required this.selected,
    required this.onTap,
  });

  final TravelPlanDay day;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
      child: Material(
        color: selected
            ? _kAccentBlue.withValues(alpha: 0.12)
            : Colors.transparent,
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: onTap,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(8),
              border: Border.all(
                color: selected
                    ? _kAccentBlue.withValues(alpha: 0.4)
                    : Colors.transparent,
              ),
            ),
            child: Row(
              children: <Widget>[
                Icon(
                  Icons.place_outlined,
                  size: 14,
                  color: selected ? _kAccentBlue : cs.onSurfaceVariant,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        day.label,
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: selected
                              ? FontWeight.w700
                              : FontWeight.w500,
                          color: selected ? _kAccentBlue : cs.onSurface,
                        ),
                      ),
                      Text(
                        "${day.entries.length} 项",
                        style: TextStyle(
                          fontSize: 10,
                          color: cs.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

// ── 右栏时间线条目 ───────────────────────────────────────────────
class _EntryTile extends StatelessWidget {
  const _EntryTile({required this.entry, required this.last});

  final TravelDayEntry entry;
  final bool last;

  Color get _kindColor {
    switch (entry.kind) {
      case TravelEntryKind.restaurant:
        return _kAccentOrange;
      case TravelEntryKind.hotel:
        return _kAccentGreen;
      case TravelEntryKind.transport:
        return const Color(0xFF5B7BE0);
      case TravelEntryKind.attraction:
        return _kAccentBlue;
      case TravelEntryKind.other:
        return const Color(0xFF9AA0A6);
    }
  }

  IconData get _kindIcon {
    switch (entry.kind) {
      case TravelEntryKind.restaurant:
        return Icons.restaurant_outlined;
      case TravelEntryKind.hotel:
        return Icons.hotel_outlined;
      case TravelEntryKind.transport:
        return Icons.directions_transit_outlined;
      case TravelEntryKind.attraction:
        return Icons.attractions_outlined;
      case TravelEntryKind.other:
        return Icons.place_outlined;
    }
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 2),
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            // 时间列
            SizedBox(
              width: 46,
              child: Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  entry.time,
                  textAlign: TextAlign.right,
                  style: TextStyle(
                    fontSize: 10.5,
                    fontWeight: FontWeight.w600,
                    color: cs.onSurfaceVariant,
                  ),
                ),
              ),
            ),
            const SizedBox(width: 10),
            // 时间轴
            Column(
              children: <Widget>[
                Container(
                  width: 22,
                  height: 22,
                  margin: const EdgeInsets.only(top: 3),
                  decoration: BoxDecoration(
                    color: _kindColor.withValues(alpha: 0.12),
                    shape: BoxShape.circle,
                    border: Border.all(
                        color: _kindColor.withValues(alpha: 0.45)),
                  ),
                  child: Icon(_kindIcon, size: 12, color: _kindColor),
                ),
                if (!last)
                  Expanded(
                    child: Container(
                      width: 1.5,
                      color: _kindColor.withValues(alpha: 0.15),
                    ),
                  ),
              ],
            ),
            const SizedBox(width: 10),
            // 内容
            Expanded(
              child: Container(
                margin: const EdgeInsets.only(bottom: 12),
                padding: const EdgeInsets.symmetric(
                    horizontal: 12, vertical: 8),
                decoration: BoxDecoration(
                  color: cs.surfaceContainerHigh,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(
                      color: cs.outline.withValues(alpha: 0.12)),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      entry.title,
                      style: TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w600,
                        color: cs.onSurface,
                      ),
                    ),
                    if (entry.note.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 3),
                        child: Text(
                          entry.note,
                          style: TextStyle(
                            fontSize: 11,
                            height: 1.45,
                            color: cs.onSurfaceVariant,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 全屏行程规划页：独立路由，沉浸式浏览双面板行程。
class TravelPlanFullscreenPage extends StatelessWidget {
  const TravelPlanFullscreenPage({super.key, required this.data});

  final AgentResultData data;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Scaffold(
      backgroundColor: cs.surface,
      appBar: AppBar(
        title: const Text("行程规划"),
        backgroundColor: cs.surfaceContainer,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          tooltip: "返回",
          onPressed: () => Navigator.of(context).pop(),
        ),
      ),
      body: TravelPlanPanel(data: data, fullscreen: true),
    );
  }
}