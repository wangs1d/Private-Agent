import "dart:async";

import "package:flutter/material.dart";

import "../../core/services/approvals_api.dart";
import "../../core/services/attention_api.dart";

/// 「决策中心」—— 嵌入右侧面板（面板顶栏已提供标题）。
///
/// 分级触达的收口界面（ReachRouter / AttentionStore）：
///  - **需要你拍板**：花钱类待确认（批准执行 / 拒绝，走 /api/approvals/resolve
///    的 hub 执行路径，同时闭合注意力记录停止升级）
///  - **需要你知晓**：其他挂起的主动事件（日程临期等）——「知道了」即 ack，
///    服务端升级计时（对话→弹窗→语音）看到 ack 即停
///  - **今天已处理**：已闭合的触达记录（含服务端如何升级过的痕迹）
///
/// 每条未决事项展示投递历史（已通过对话/弹窗提醒 N 次），打开时拉取一次、
/// 面板存续期间每 30 秒轮询。
class ApprovalsPanel extends StatefulWidget {
  const ApprovalsPanel({super.key, this.api, this.attentionApi});

  final ApprovalsApi? api;
  final AttentionApi? attentionApi;

  @override
  State<ApprovalsPanel> createState() => _ApprovalsPanelState();
}

class _ApprovalsPanelState extends State<ApprovalsPanel> {
  late final ApprovalsApi _api;
  late final AttentionApi _attentionApi;
  List<AttentionRecord> _pending = const <AttentionRecord>[];
  List<AttentionRecord> _done = const <AttentionRecord>[];
  bool _loading = true;
  String? _error;
  final Set<String> _busyIds = <String>{};
  Timer? _pollTimer;

  @override
  void initState() {
    super.initState();
    _api = widget.api ?? ApprovalsApi();
    _attentionApi = widget.attentionApi ?? AttentionApi();
    _refresh();
    _pollTimer = Timer.periodic(
      const Duration(seconds: 30),
      (_) => _refresh(silent: true),
    );
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    super.dispose();
  }

  Future<void> _refresh({bool silent = false}) async {
    if (!silent) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    final result = await _attentionApi.snapshot();
    if (!mounted) return;
    setState(() {
      _loading = false;
      if (result.ok) {
        final snapshot = result.value ?? const AttentionSnapshot();
        _pending = snapshot.pending;
        _done = snapshot.doneToday;
        _error = null;
      } else if (!silent) {
        _error = result.error;
      }
    });
  }

  /// 花钱类：批准 / 拒绝（走 hub 执行路径；服务端同步闭合注意力记录）。
  Future<void> _resolve(AttentionRecord record, bool approve) async {
    final String? confirmId = record.confirmId;
    if (confirmId == null) return;
    setState(() => _busyIds.add(record.id));
    final result = await _api.resolve(
      item: ApprovalItem(
        id: confirmId,
        source: "proactivity",
        kind: record.kind,
        title: record.title,
        summary: record.summary,
        createdAt: record.createdAt,
        spend: true,
      ),
      approve: approve,
    );
    if (!mounted) return;
    setState(() => _busyIds.remove(record.id));
    if (!result.ok) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        SnackBar(content: Text("操作失败：${result.error}")),
      );
      _refresh(silent: true);
      return;
    }
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      SnackBar(
        content: Text(
          result.value?.isNotEmpty == true
              ? result.value!
              : (approve ? "已批准并执行" : "已拒绝"),
        ),
        duration: const Duration(seconds: 2),
      ),
    );
    _refresh(silent: true);
  }

  /// 非花钱类：「知道了」→ ack 归一（升级即停）。
  Future<void> _acknowledge(AttentionRecord record) async {
    setState(() => _busyIds.add(record.id));
    final result = await _attentionApi.ack(record.id, via: "inbox");
    if (!mounted) return;
    setState(() => _busyIds.remove(record.id));
    if (!result.ok) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        SnackBar(content: Text("操作失败：${result.error}")),
      );
      return;
    }
    _refresh(silent: true);
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _pending.isEmpty && _done.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null && _pending.isEmpty && _done.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(_error!, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: () => _refresh(),
              icon: const Icon(Icons.refresh),
              label: const Text("重试"),
            ),
          ],
        ),
      );
    }
    final List<AttentionRecord> confirmItems =
        _pending.where((AttentionRecord e) => e.decision == "confirm").toList();
    final List<AttentionRecord> fyiItems =
        _pending.where((AttentionRecord e) => e.decision != "confirm").toList();
    if (confirmItems.isEmpty && fyiItems.isEmpty && _done.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(
              Icons.inbox_outlined,
              size: 44,
              color: Theme.of(context).hintColor,
            ),
            const SizedBox(height: 12),
            Text(
              "没有待处理的事项",
              style: TextStyle(color: Theme.of(context).hintColor),
            ),
            const SizedBox(height: 4),
            Text(
              "Agent 要花钱做事前会来这里征求你同意；\n紧急的事会直接弹窗、语音甚至来电",
              textAlign: TextAlign.center,
              style: TextStyle(
                color: Theme.of(context).hintColor,
                fontSize: 12,
              ),
            ),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: () => _refresh(),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
        children: <Widget>[
          if (confirmItems.isNotEmpty) ...<Widget>[
            _SectionHeader(
              icon: Icons.payments_outlined,
              label: "需要你拍板（涉及花钱）",
              count: confirmItems.length,
            ),
            const SizedBox(height: 8),
            for (final AttentionRecord record in confirmItems) ...<Widget>[
              _ConfirmCard(
                record: record,
                busy: _busyIds.contains(record.id),
                onApprove: () => _resolve(record, true),
                onDecline: () => _resolve(record, false),
              ),
              const SizedBox(height: 10),
            ],
          ],
          if (fyiItems.isNotEmpty) ...<Widget>[
            _SectionHeader(
              icon: Icons.campaign_outlined,
              label: "需要你知晓",
              count: fyiItems.length,
            ),
            const SizedBox(height: 8),
            for (final AttentionRecord record in fyiItems) ...<Widget>[
              _FyiCard(
                record: record,
                busy: _busyIds.contains(record.id),
                onAck: () => _acknowledge(record),
              ),
              const SizedBox(height: 10),
            ],
          ],
          if (_done.isNotEmpty) ...<Widget>[
            const SizedBox(height: 8),
            _SectionHeader(
              icon: Icons.history,
              label: "今天已处理",
              count: _done.length,
            ),
            const SizedBox(height: 4),
            for (final AttentionRecord record in _done.take(20))
              _DoneTile(record: record),
          ],
        ],
      ),
    );
  }
}

/// 分区标题。
class _SectionHeader extends StatelessWidget {
  const _SectionHeader({
    required this.icon,
    required this.label,
    this.count = 0,
  });

  final IconData icon;
  final String label;
  final int count;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Row(
      children: <Widget>[
        Icon(icon, size: 15, color: theme.colorScheme.primary),
        const SizedBox(width: 6),
        Text(
          label,
          style: theme.textTheme.labelLarge
              ?.copyWith(fontWeight: FontWeight.w600),
        ),
        if (count > 0) ...<Widget>[
          const SizedBox(width: 6),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1),
            decoration: BoxDecoration(
              color: theme.colorScheme.primaryContainer,
              borderRadius: BorderRadius.circular(9),
            ),
            child: Text(
              "$count",
              style: TextStyle(
                fontSize: 11,
                color: theme.colorScheme.onPrimaryContainer,
              ),
            ),
          ),
        ],
      ],
    );
  }
}

/// 投递/升级状态行（「已通过对话提醒 2 次 · 14:30 截止」）。
Widget _deliveryStatusLine(BuildContext context, AttentionRecord record) {
  final ThemeData theme = Theme.of(context);
  final String escalation = record.escalationLabel;
  final DateTime? deadline = record.deadlineAt;
  final String deadlineLabel = deadline == null
      ? ""
      : " · ${deadline.hour.toString().padLeft(2, "0")}:${deadline.minute.toString().padLeft(2, "0")} 截止";
  return Text(
    "$escalation$deadlineLabel",
    style: TextStyle(
      color: theme.hintColor,
      fontSize: 11.5,
    ),
  );
}

/// 需要拍板的（花钱）卡片：批准 / 拒绝。
class _ConfirmCard extends StatelessWidget {
  const _ConfirmCard({
    required this.record,
    required this.busy,
    required this.onApprove,
    required this.onDecline,
  });

  final AttentionRecord record;
  final bool busy;
  final VoidCallback onApprove;
  final VoidCallback onDecline;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                  decoration: BoxDecoration(
                    color: theme.colorScheme.errorContainer,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Text(
                    "涉及花钱",
                    style: TextStyle(
                      color: theme.colorScheme.onErrorContainer,
                      fontSize: 11,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: _deliveryStatusLine(context, record),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              record.title,
              style: theme.textTheme.titleSmall
                  ?.copyWith(fontWeight: FontWeight.w600),
            ),
            if (record.summary.isNotEmpty) ...<Widget>[
              const SizedBox(height: 4),
              Text(
                record.summary,
                style: TextStyle(
                  color: theme.hintColor,
                  fontSize: 13,
                  height: 1.4,
                ),
              ),
            ],
            const SizedBox(height: 12),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: <Widget>[
                TextButton(
                  onPressed: busy ? null : onDecline,
                  child: const Text("拒绝"),
                ),
                const SizedBox(width: 8),
                FilledButton.icon(
                  onPressed: busy ? null : onApprove,
                  icon: busy
                      ? const SizedBox(
                          width: 14,
                          height: 14,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.check, size: 16),
                  label: const Text("批准执行"),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// 需要知晓的卡片：「知道了」即 ack，服务端升级即停。
class _FyiCard extends StatelessWidget {
  const _FyiCard({
    required this.record,
    required this.busy,
    required this.onAck,
  });

  final AttentionRecord record;
  final bool busy;
  final VoidCallback onAck;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final bool urgent = record.urgency == "interrupt";
    return Card(
      margin: EdgeInsets.zero,
      color: urgent ? theme.colorScheme.errorContainer.withValues(alpha: 0.4) : null,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Expanded(
                  child: Text(
                    record.title,
                    style: theme.textTheme.bodyMedium
                        ?.copyWith(fontWeight: FontWeight.w600),
                  ),
                ),
                if (busy)
                  const SizedBox(
                    width: 14,
                    height: 14,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                else
                  TextButton(
                    onPressed: onAck,
                    child: const Text("知道了"),
                  ),
              ],
            ),
            if (record.summary.isNotEmpty)
              Text(
                record.summary,
                style: TextStyle(
                  color: theme.hintColor,
                  fontSize: 12.5,
                  height: 1.4,
                ),
              ),
            const SizedBox(height: 4),
            _deliveryStatusLine(context, record),
          ],
        ),
      ),
    );
  }
}

/// 今天已处理的时间线瓦片。
class _DoneTile extends StatelessWidget {
  const _DoneTile({required this.record});

  final AttentionRecord record;

  String get _timeLabel {
    final DateTime? closed = record.resolvedAt ?? record.ackAt;
    final DateTime at = closed ?? record.createdAt ?? DateTime.now();
    return "${at.hour.toString().padLeft(2, "0")}:${at.minute.toString().padLeft(2, "0")}";
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String outcome = switch (record.state) {
      "acked" => "已知晓",
      "resolved" => record.resolveNote ?? "已处理",
      "expired" => "已超时",
      _ => "已处理",
    };
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.only(top: 3),
            child: Icon(
              Icons.check_circle_outline,
              size: 14,
              color: theme.hintColor,
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              record.title,
              style: theme.textTheme.bodySmall,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(width: 8),
          Text(
            outcome,
            style: TextStyle(color: theme.hintColor, fontSize: 11.5),
          ),
          const SizedBox(width: 8),
          Text(
            _timeLabel,
            style: TextStyle(color: theme.hintColor, fontSize: 11.5),
          ),
        ],
      ),
    );
  }
}
