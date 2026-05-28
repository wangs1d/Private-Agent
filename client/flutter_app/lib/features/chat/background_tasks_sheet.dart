import "package:flutter/material.dart";

/// 展示子 Agent 后台任务与委派报告。
class BackgroundTasksSheet extends StatefulWidget {
  const BackgroundTasksSheet({
    super.key,
    required this.initialSnapshot,
    this.onRefresh,
  });

  final Map<String, dynamic> initialSnapshot;
  final Future<Map<String, dynamic>> Function()? onRefresh;

  @override
  State<BackgroundTasksSheet> createState() => _BackgroundTasksSheetState();
}

class _BackgroundTasksSheetState extends State<BackgroundTasksSheet> {
  late Map<String, dynamic> _snapshot;
  bool _refreshing = false;

  @override
  void initState() {
    super.initState();
    _snapshot = widget.initialSnapshot;
  }

  static String _agentLabel(String type) {
    const Map<String, String> names = <String, String>{
      "life": "生活全能",
      "tech": "技术操控",
      "info": "信息检索",
      "creative": "创意内容",
      "security": "安全审计",
      "general": "通用助手",
    };
    return names[type] ?? type;
  }

  Future<void> _refresh() async {
    if (widget.onRefresh == null || _refreshing) return;
    setState(() => _refreshing = true);
    try {
      final Map<String, dynamic> next = await widget.onRefresh!();
      if (mounted) setState(() => _snapshot = next);
    } finally {
      if (mounted) setState(() => _refreshing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final bool ok = _snapshot["ok"] == true;
    final List<dynamic> running =
        ok ? (_snapshot["running"] as List<dynamic>? ?? <dynamic>[]) : <dynamic>[];
    final List<dynamic> completedBg = ok
        ? (_snapshot["backgroundCompleted"] as List<dynamic>? ?? <dynamic>[])
        : <dynamic>[];
    final List<dynamic> reports =
        ok ? (_snapshot["reports"] as List<dynamic>? ?? <dynamic>[]) : <dynamic>[];
    final int inFlight = ok ? (_snapshot["inFlightInTurn"] as int? ?? 0) : 0;
    final int slots = ok ? (_snapshot["activeSubAgentSlots"] as int? ?? 0) : 0;
    final int maxParallel = ok ? (_snapshot["maxParallelTasks"] as int? ?? 1) : 1;

    return SafeArea(
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * 0.55,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Row(
                children: <Widget>[
                  Expanded(
                    child: Text(
                      "后台子 Agent 任务",
                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                            fontWeight: FontWeight.w600,
                          ),
                    ),
                  ),
                  if (widget.onRefresh != null)
                    IconButton(
                      tooltip: "刷新",
                      onPressed: _refreshing ? null : _refresh,
                      icon: _refreshing
                          ? SizedBox(
                              width: 20,
                              height: 20,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: cs.primary,
                              ),
                            )
                          : const Icon(Icons.refresh),
                    ),
                  IconButton(
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.close),
                  ),
                ],
              ),
              if (!ok)
                Text(
                  _snapshot["error"]?.toString() ?? "无法加载后台任务",
                  style: TextStyle(color: cs.error),
                )
              else ...<Widget>[
                Text(
                  "并行槽位 $slots / $maxParallel · 本轮进行中 $inFlight",
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: cs.onSurfaceVariant,
                      ),
                ),
                const SizedBox(height: 12),
                Expanded(
                  child: running.isEmpty && completedBg.isEmpty && reports.isEmpty
                      ? Center(
                          child: Text(
                            "当前没有后台子任务",
                            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                                  color: cs.onSurfaceVariant,
                                ),
                          ),
                        )
                      : ListView(
                          children: <Widget>[
                            if (running.isNotEmpty) ...<Widget>[
                              Text("运行中", style: Theme.of(context).textTheme.labelLarge),
                              const SizedBox(height: 6),
                              ...running.map(
                                (dynamic j) =>
                                    _jobTile(context, j as Map<String, dynamic>, running: true),
                              ),
                              const SizedBox(height: 12),
                            ],
                            if (completedBg.isNotEmpty) ...<Widget>[
                              Text("后台已完成", style: Theme.of(context).textTheme.labelLarge),
                              const SizedBox(height: 6),
                              ...completedBg.map(
                                (dynamic j) =>
                                    _jobTile(context, j as Map<String, dynamic>, running: false),
                              ),
                              const SizedBox(height: 12),
                            ],
                            if (reports.isNotEmpty) ...<Widget>[
                              Text("委派报告", style: Theme.of(context).textTheme.labelLarge),
                              const SizedBox(height: 6),
                              ...reports.map((dynamic r) {
                                final Map<String, dynamic> item = r as Map<String, dynamic>;
                                final bool success = item["success"] == true;
                                return Padding(
                                  padding: const EdgeInsets.only(bottom: 8),
                                  child: ListTile(
                                    tileColor: cs.surfaceContainerHighest,
                                    shape: RoundedRectangleBorder(
                                      borderRadius: BorderRadius.circular(10),
                                    ),
                                    title: Text(
                                      "${_agentLabel(item["agentType"]?.toString() ?? "?")} · ${success ? "成功" : "失败"}",
                                    ),
                                    subtitle: Text(
                                      item["reportPreview"]?.toString() ?? "",
                                      maxLines: 4,
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                    isThreeLine: true,
                                  ),
                                );
                              }),
                            ],
                          ],
                        ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _jobTile(BuildContext context, Map<String, dynamic> job, {required bool running}) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final String type = job["agentType"]?.toString() ?? "?";
    final String name = job["agentName"]?.toString() ?? _agentLabel(type);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        tileColor: running ? cs.primaryContainer.withOpacity(0.35) : cs.surfaceContainerHigh,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        leading: Icon(
          running ? Icons.hourglass_top : Icons.check_circle_outline,
          color: running ? cs.primary : cs.outline,
        ),
        title: Text(name),
        subtitle: Text(
          running ? "执行中…" : (job["error"]?.toString() ?? job["report"]?.toString() ?? "已完成"),
          maxLines: 3,
          overflow: TextOverflow.ellipsis,
        ),
      ),
    );
  }
}
