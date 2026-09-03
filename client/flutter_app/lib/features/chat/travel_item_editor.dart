import "dart:async";

import "package:flutter/material.dart";

import "travel_plan_api.dart";
import "travel_plan_models.dart";

/// 单项编辑器结果。
class TravelItemEditorResult {
  const TravelItemEditorResult.replace(this.item) : comment = null;
  const TravelItemEditorResult.comment(this.comment) : item = null;

  /// 替换用的 POI JSON（name/type/latitude/longitude/address/priceInfo/...）。
  final Map<String, dynamic>? item;

  /// 「提意见换一个」的意见文本。
  final String? comment;
}

/// 单项编辑器弹窗 —— 移植自 3D-Travel 的 _openItemEditor：
/// 搜索备选（350ms 防抖）+ 同类型推荐 + 意见文本框（让 AI 重推荐）。
class TravelItemEditor extends StatefulWidget {
  const TravelItemEditor({
    super.key,
    required this.entry,
    required this.destination,
  });

  final TravelDayEntry entry;
  final String destination;

  /// 弹出编辑器；取消返回 null。
  static Future<TravelItemEditorResult?> show(
    BuildContext context, {
    required TravelDayEntry entry,
    required String destination,
  }) {
    return showDialog<TravelItemEditorResult>(
      context: context,
      builder: (BuildContext context) => TravelItemEditor(
        entry: entry,
        destination: destination,
      ),
    );
  }

  @override
  State<TravelItemEditor> createState() => _TravelItemEditorState();
}

class _TravelItemEditorState extends State<TravelItemEditor> {
  final TextEditingController _searchCtrl = TextEditingController();
  final TextEditingController _commentCtrl = TextEditingController();
  Timer? _debounce;
  List<Map<String, dynamic>>? _results;
  String? _error;
  bool _loading = false;

  @override
  void dispose() {
    _debounce?.cancel();
    _searchCtrl.dispose();
    _commentCtrl.dispose();
    super.dispose();
  }

  void _onSearchChanged(String value) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), () => _fetch(value));
  }

  Future<void> _fetch(String keyword) async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final List<Map<String, dynamic>> pois = await TravelPlanApi().searchPois(
        widget.destination,
        type: widget.entry.type.isNotEmpty
            ? widget.entry.type
            : _kindToType(widget.entry.kind),
        keyword: keyword,
      );
      if (!mounted) return;
      setState(() {
        _results = pois;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = "搜索失败：$e";
        _loading = false;
      });
    }
  }

  static String _kindToType(TravelEntryKind kind) {
    switch (kind) {
      case TravelEntryKind.attraction:
        return "attraction";
      case TravelEntryKind.restaurant:
        return "restaurant";
      case TravelEntryKind.hotel:
        return "hotel";
      case TravelEntryKind.transport:
        return "transport";
      case TravelEntryKind.other:
        return "";
    }
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Dialog(
      backgroundColor: cs.surfaceContainer,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520, maxHeight: 560),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              // 头部：当前条目
              Row(
                children: <Widget>[
                  const Icon(Icons.edit_location_alt_outlined,
                      size: 18, color: Color(0xFF18D6F3)),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      "编辑：${widget.entry.title}",
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                          fontSize: 14, fontWeight: FontWeight.w700),
                    ),
                  ),
                  IconButton(
                    icon: const Icon(Icons.close, size: 18),
                    onPressed: () => Navigator.of(context).pop(),
                    visualDensity: VisualDensity.compact,
                  ),
                ],
              ),
              const Divider(height: 16),
              // 搜索备选
              TextField(
                controller: _searchCtrl,
                onChanged: _onSearchChanged,
                decoration: InputDecoration(
                  isDense: true,
                  hintText: "搜索备选地点（同类型优先）",
                  prefixIcon: const Icon(Icons.search, size: 18),
                  border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(10)),
                  contentPadding:
                      const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                ),
              ),
              const SizedBox(height: 10),
              Expanded(child: _buildResults(cs)),
              const Divider(height: 16),
              // 提意见换一个
              Row(
                children: <Widget>[
                  const Icon(Icons.auto_awesome, size: 15, color: Color(0xFFD7B85A)),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      "不满意？提意见让 AI 重新推荐",
                      style: TextStyle(
                          fontSize: 12, color: cs.onSurfaceVariant),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Row(
                children: <Widget>[
                  Expanded(
                    child: TextField(
                      controller: _commentCtrl,
                      style: const TextStyle(fontSize: 13),
                      decoration: InputDecoration(
                        isDense: true,
                        hintText: "例如：人太多 / 想要安静一点 / 换个便宜的",
                        border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(10)),
                        contentPadding: const EdgeInsets.symmetric(
                            horizontal: 12, vertical: 10),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  FilledButton(
                    style: FilledButton.styleFrom(
                      visualDensity: VisualDensity.compact,
                      padding: const EdgeInsets.symmetric(
                          horizontal: 14, vertical: 12),
                    ),
                    onPressed: () {
                      final String comment = _commentCtrl.text.trim();
                      if (comment.isEmpty) return;
                      Navigator.of(context)
                          .pop(TravelItemEditorResult.comment(comment));
                    },
                    child: const Text("重新推荐",
                        style: TextStyle(fontSize: 13)),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildResults(ColorScheme cs) {
    if (_loading) {
      return const Center(
          child: SizedBox(
              width: 22,
              height: 22,
              child: CircularProgressIndicator(strokeWidth: 2)));
    }
    if (_error != null) {
      return Center(
          child: Text(_error!,
              style: TextStyle(fontSize: 12, color: cs.error)));
    }
    final List<Map<String, dynamic>> list = _results ?? const <Map<String, dynamic>>[];
    if (list.isEmpty) {
      return Center(
          child: Text(
            _searchCtrl.text.isEmpty ? "输入关键词搜索备选地点" : "没有找到备选地点",
            style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
          ));
    }
    return ListView.separated(
      itemCount: list.length,
      separatorBuilder: (_, __) => const SizedBox(height: 6),
      itemBuilder: (BuildContext context, int i) {
        final Map<String, dynamic> poi = list[i];
        final String name = poi["name"]?.toString() ?? "";
        final String address = poi["address"]?.toString() ?? "";
        final String priceInfo = poi["priceInfo"]?.toString() ?? "";
        return Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          decoration: BoxDecoration(
            color: cs.surfaceContainerHigh,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: cs.outline.withValues(alpha: 0.15)),
          ),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                            fontSize: 13, fontWeight: FontWeight.w600)),
                    if (address.isNotEmpty || priceInfo.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text(
                          <String>[if (priceInfo.isNotEmpty) priceInfo, address]
                              .join(" · "),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                              fontSize: 11, color: cs.onSurfaceVariant),
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              OutlinedButton(
                style: OutlinedButton.styleFrom(
                  visualDensity: VisualDensity.compact,
                  padding:
                      const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                  textStyle: const TextStyle(fontSize: 12),
                ),
                onPressed: () => Navigator.of(context)
                    .pop(TravelItemEditorResult.replace(poi)),
                child: const Text("替换"),
              ),
            ],
          ),
        );
      },
    );
  }
}
