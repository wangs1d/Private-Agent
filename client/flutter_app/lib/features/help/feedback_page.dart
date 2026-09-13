import "dart:async";
import "dart:io";

import "package:flutter/material.dart";

import "../../core/config/api_config.dart";
import "../../core/services/access_auth_api.dart";
import "../../core/services/feedback_api.dart";

/// 「帮助与反馈」页 —— 用户菜单「帮助与反馈」入口。
///
/// 分区：
///  - 提交反馈：类型 / 标题 / 描述 / 联系方式（选填）
///  - 诊断信息：随反馈附带的环境信息，默认可见、逐项可关
///  - 我的反馈：已提交记录与处理状态
///
/// 反馈提交到私有部署服务端（POST /api/feedback），管理员在服务端查看并流转状态。
class FeedbackPage extends StatefulWidget {
  const FeedbackPage({super.key, this.api});

  final FeedbackApi? api;

  @override
  State<FeedbackPage> createState() => _FeedbackPageState();
}

class _FeedbackPageState extends State<FeedbackPage> {
  late final FeedbackApi _api;

  final TextEditingController _titleCtrl = TextEditingController();
  final TextEditingController _descriptionCtrl = TextEditingController();
  final TextEditingController _contactCtrl = TextEditingController();

  String _type = "bug";
  bool _submitting = false;

  // —— 诊断信息开关（默认全开，提交内容在下方实时可见） ——
  bool _includeVersion = true;
  bool _includePlatform = true;
  bool _includeDeviceId = true;
  bool _includeServer = true;

  bool _loadingHistory = true;
  List<FeedbackRecord> _history = const <FeedbackRecord>[];

  @override
  void initState() {
    super.initState();
    _api = widget.api ?? FeedbackApi();
    _reloadHistory();
  }

  @override
  void dispose() {
    _titleCtrl.dispose();
    _descriptionCtrl.dispose();
    _contactCtrl.dispose();
    super.dispose();
  }

  Future<void> _reloadHistory() async {
    final FeedbackResult<List<FeedbackRecord>> res = await _api.listMine();
    if (!mounted) return;
    setState(() {
      _loadingHistory = false;
      _history = res.value ?? const <FeedbackRecord>[];
    });
  }

  Future<void> _submit() async {
    final String title = _titleCtrl.text.trim();
    final String description = _descriptionCtrl.text.trim();
    if (title.isEmpty) {
      _toast("请填写标题");
      return;
    }
    if (description.isEmpty) {
      _toast("请填写问题描述或建议内容");
      return;
    }
    setState(() => _submitting = true);
    final FeedbackResult<FeedbackRecord> res = await _api.submit(
      type: _type,
      title: title,
      description: description,
      contact: _contactCtrl.text.trim(),
      diagnostics: _collectDiagnostics(),
    );
    if (!mounted) return;
    setState(() => _submitting = false);
    if (res.ok) {
      _toast("已提交，感谢反馈");
      _titleCtrl.clear();
      _descriptionCtrl.clear();
      unawaited(_reloadHistory());
    } else {
      _toast(res.error ?? "提交失败，请检查服务连接");
    }
  }

  Map<String, Object> _collectDiagnostics() {
    return <String, Object>{
      if (_includeVersion) "客户端版本": "0.1.0",
      if (_includePlatform)
        "操作系统": "${Platform.operatingSystem} ${Platform.operatingSystemVersion}",
      if (_includeDeviceId)
        "设备标识": AccessCredentialStore.instance.deviceId,
      if (_includeServer) "服务地址": ApiConfig.httpBase,
    };
  }

  void _toast(String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), duration: const Duration(seconds: 2)),
    );
  }

  Color _statusColor(String status) {
    return switch (status) {
      "open" => Colors.orange,
      "processing" => Colors.blue,
      "resolved" => Colors.green,
      _ => Colors.grey,
    };
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text("帮助与反馈")),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: <Widget>[
          _buildFormCard(),
          const SizedBox(height: 16),
          _buildDiagnosticsCard(),
          const SizedBox(height: 16),
          _buildHistoryCard(),
        ],
      ),
    );
  }

  Widget _buildFormCard() {
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text("提交反馈", style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              children: <String>["bug", "suggestion", "other"]
                  .map(
                    (String type) => ChoiceChip(
                      label: Text(switch (type) {
                        "bug" => "问题报障",
                        "suggestion" => "功能建议",
                        _ => "其他",
                      }),
                      selected: _type == type,
                      onSelected: (bool selected) {
                        if (selected) setState(() => _type = type);
                      },
                    ),
                  )
                  .toList(),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _titleCtrl,
              maxLength: 80,
              decoration: const InputDecoration(
                labelText: "标题",
                hintText: "一句话概括问题或建议",
                border: OutlineInputBorder(),
                counterText: "",
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _descriptionCtrl,
              maxLength: 4000,
              minLines: 4,
              maxLines: 8,
              decoration: const InputDecoration(
                labelText: "详细描述",
                hintText: "报障请尽量写清操作步骤与预期/实际表现",
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _contactCtrl,
              maxLength: 120,
              decoration: const InputDecoration(
                labelText: "联系方式（选填）",
                hintText: "方便管理员跟进时联系你",
                border: OutlineInputBorder(),
                counterText: "",
              ),
            ),
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: _submitting ? null : _submit,
                icon: _submitting
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.send_outlined),
                label: Text(_submitting ? "提交中…" : "提交反馈"),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildDiagnosticsCard() {
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                const Icon(Icons.bug_report_outlined, size: 18),
                const SizedBox(width: 8),
                Text("诊断信息", style: Theme.of(context).textTheme.titleMedium),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              "勾选的项会随本条反馈提交给服务端管理员，用于定位问题；取消勾选即不提交。"
              "提交本身会附带你的身份标识，便于回复。",
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: 8),
            _diagTile(
              value: _includeVersion,
              onChanged: (bool v) => setState(() => _includeVersion = v),
              label: "客户端版本",
              detail: "0.1.0",
            ),
            _diagTile(
              value: _includePlatform,
              onChanged: (bool v) => setState(() => _includePlatform = v),
              label: "操作系统",
              detail:
                  "${Platform.operatingSystem} ${Platform.operatingSystemVersion}",
            ),
            _diagTile(
              value: _includeDeviceId,
              onChanged: (bool v) => setState(() => _includeDeviceId = v),
              label: "设备标识",
              detail: AccessCredentialStore.instance.deviceId,
            ),
            _diagTile(
              value: _includeServer,
              onChanged: (bool v) => setState(() => _includeServer = v),
              label: "服务地址",
              detail: ApiConfig.httpBase,
            ),
          ],
        ),
      ),
    );
  }

  Widget _diagTile({
    required bool value,
    required ValueChanged<bool> onChanged,
    required String label,
    required String detail,
  }) {
    return CheckboxListTile(
      value: value,
      onChanged: (bool? v) => onChanged(v ?? false),
      controlAffinity: ListTileControlAffinity.leading,
      contentPadding: EdgeInsets.zero,
      dense: true,
      title: Text(label),
      subtitle: Text(detail, maxLines: 1, overflow: TextOverflow.ellipsis),
    );
  }

  Widget _buildHistoryCard() {
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                const Icon(Icons.history, size: 18),
                const SizedBox(width: 8),
                Text("我的反馈", style: Theme.of(context).textTheme.titleMedium),
                const Spacer(),
                IconButton(
                  onPressed: _reloadHistory,
                  icon: const Icon(Icons.refresh, size: 20),
                  tooltip: "刷新",
                ),
              ],
            ),
            const SizedBox(height: 8),
            if (_loadingHistory)
              const Padding(
                padding: EdgeInsets.all(16),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_history.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 16),
                child: Text(
                  "还没有提交过反馈",
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              )
            else
              ..._history.map(_buildHistoryTile),
          ],
        ),
      ),
    );
  }

  Widget _buildHistoryTile(FeedbackRecord record) {
    return ExpansionTile(
      tilePadding: EdgeInsets.zero,
      title: Text(
        record.title,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      subtitle: Text(
        "${record.typeLabel} · "
        "${record.createdAt?.toLocal().toString().split(".").first ?? ""}",
        style: Theme.of(context).textTheme.bodySmall,
      ),
      trailing: Chip(
        label: Text(
          record.statusLabel,
          style: TextStyle(
            fontSize: 12,
            color: _statusColor(record.status),
          ),
        ),
        visualDensity: VisualDensity.compact,
        side: BorderSide(color: _statusColor(record.status)),
        backgroundColor: Colors.transparent,
      ),
      children: <Widget>[
        Align(
          alignment: Alignment.centerLeft,
          child: Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                SelectableText(record.description),
                if (record.replyNote != null && record.replyNote!.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(8),
                      decoration: BoxDecoration(
                        color: Theme.of(context)
                            .colorScheme
                            .surfaceContainerHighest
                            .withValues(alpha: 0.5),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: SelectableText(
                        "管理员回复：${record.replyNote}",
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}
