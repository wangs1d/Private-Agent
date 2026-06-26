import "package:flutter/material.dart";

/// 心情感知卡片：只读展示 Agent 推断的最近 7 天情绪走势。
class MoodInsightCard extends StatefulWidget {
  const MoodInsightCard({
    super.key,
    required this.sessionId,
    required this.api,
  });

  final String sessionId;
  final dynamic api; // MoodInferenceApi (defined below)

  @override
  State<MoodInsightCard> createState() => _MoodInsightCardState();
}

class _MoodInsightCardState extends State<MoodInsightCard> {
  Map<String, dynamic>? _today;
  List<dynamic> _aggregates = const [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final results = await Future.wait<dynamic>([
        widget.api.getTodayMood(widget.sessionId),
        widget.api.getDailyAggregates(widget.sessionId, days: 7),
      ]);
      if (!mounted) return;
      setState(() {
        _today = results[0] as Map<String, dynamic>?;
        _aggregates = results[1] as List<dynamic>;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  Color _moodColor(double score) {
    if (score >= 0.3) return Colors.green;
    if (score <= -0.3) return Colors.red;
    return Colors.amber;
  }

  String _moodLabel(double score) {
    if (score >= 0.5) return "挺不错";
    if (score >= 0.2) return "不错";
    if (score >= -0.2) return "平静";
    if (score >= -0.5) return "有点低落";
    return "需要关心";
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Card(
        child: Padding(
          padding: EdgeInsets.all(16),
          child: SizedBox(
            height: 60,
            child: Center(child: CircularProgressIndicator()),
          ),
        ),
      );
    }

    if (_error != null) {
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Text("心情数据加载失败", style: Theme.of(context).textTheme.bodySmall),
        ),
      );
    }

    final theme = Theme.of(context);
    final todayMood = _today?["mood"] as Map<String, dynamic>?;
    final score = (todayMood?["avgSentiment"] as num?)?.toDouble() ?? 0.0;
    final tags = (todayMood?["dominantTags"] as List?)?.cast<String>() ?? const [];
    final sampleCount = (todayMood?["sampleCount"] as num?)?.toInt() ?? 0;

    if (sampleCount == 0) {
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              const Icon(Icons.favorite_outline, size: 20),
              const SizedBox(width: 8),
              const Expanded(
                child: Text("Agent 正在感知你的心情…"),
              ),
            ],
          ),
        ),
      );
    }

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.favorite, color: _moodColor(score), size: 20),
                const SizedBox(width: 8),
                Text(
                  "今天：${_moodLabel(score)}",
                  style: theme.textTheme.titleMedium,
                ),
                const Spacer(),
                Text(
                  "$sampleCount 次采样",
                  style: theme.textTheme.labelSmall,
                ),
              ],
            ),
            if (tags.isNotEmpty) ...[
              const SizedBox(height: 8),
              Wrap(
                spacing: 6,
                children: tags
                    .map((t) => Chip(
                          label: Text(t),
                          padding: EdgeInsets.zero,
                          materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        ))
                    .toList(),
              ),
            ],
            const SizedBox(height: 12),
            _buildTrend(),
          ],
        ),
      ),
    );
  }

  Widget _buildTrend() {
    if (_aggregates.isEmpty) return const SizedBox.shrink();
    // 简单横向条形趋势
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: _aggregates.reversed.take(7).map((agg) {
        final m = agg as Map<String, dynamic>;
        final date = (m["date"] as String? ?? "").substring(5); // MM-DD
        final score = (m["avgSentiment"] as num?)?.toDouble() ?? 0.0;
        return Expanded(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 2),
            child: Column(
              children: [
                Container(
                  height: 4,
                  decoration: BoxDecoration(
                    color: _moodColor(score),
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  date,
                  style: const TextStyle(fontSize: 10),
                ),
              ],
            ),
          ),
        );
      }).toList(),
    );
  }
}
