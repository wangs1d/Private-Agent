import "package:flutter/material.dart";

class PhoneDialerPage extends StatefulWidget {
  const PhoneDialerPage({super.key, this.onCallSent, this.onCallMyAgent});

  final void Function(String agentId, String? message)? onCallSent;
  final void Function(String? message)? onCallMyAgent;

  @override
  State<PhoneDialerPage> createState() => _PhoneDialerPageState();
}

class _PhoneDialerPageState extends State<PhoneDialerPage> {
  final TextEditingController _agentIdController = TextEditingController();
  final TextEditingController _messageController = TextEditingController();
  bool _isCalling = false;

  @override
  void dispose() {
    _agentIdController.dispose();
    _messageController.dispose();
    super.dispose();
  }

  Future<void> _callMyAgent() async {
    setState(() => _isCalling = true);
    try {
      widget.onCallMyAgent?.call(_messageController.text.trim());
      if (mounted) {
        Navigator.of(context).pop();
      }
    } finally {
      if (mounted) setState(() => _isCalling = false);
    }
  }

  Future<void> _makeCall() async {
    final agentId = _agentIdController.text.trim();
    if (agentId.isEmpty) {
      _showSnackBar("请输入 Agent ID");
      return;
    }
    setState(() => _isCalling = true);
    try {
      widget.onCallSent?.call(agentId, _messageController.text.trim());
      if (mounted) {
        Navigator.of(context).pop();
      }
    } finally {
      if (mounted) setState(() => _isCalling = false);
    }
  }

  void _showSnackBar(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), duration: const Duration(seconds: 2)),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text("📞 网络电话")),
      body: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Card(
              child: Padding(
                padding: const EdgeInsets.all(18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    const Row(
                      children: <Widget>[
                        Icon(Icons.dialpad, size: 22),
                        SizedBox(width: 8),
                        Text("网络电话",
                            style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text("直接给 Agent 打电话，无需对方有号码",
                        style: TextStyle(color: Colors.grey[600], fontSize: 13)),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 20),

            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: _isCalling ? null : _callMyAgent,
                icon: _isCalling
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.smart_toy, size: 22),
                label: Text(_isCalling ? "呼叫中…" : "📞 呼叫我的 Agent"),
                style: FilledButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  textStyle: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
                  backgroundColor: Colors.blue,
                  foregroundColor: Colors.white,
                ),
              ),
            ),

            Padding(
              padding: const EdgeInsets.symmetric(vertical: 14),
              child: Row(
                children: <Widget>[
                  Expanded(child: Divider(color: Colors.grey[300])),
                  Padding(
                    padding: EdgeInsets.symmetric(horizontal: 12),
                    child: Text("或拨打指定 Agent",
                        style: TextStyle(color: Colors.grey, fontSize: 12)),
                  ),
                  Expanded(child: Divider(color: Colors.grey[300])),
                ],
              ),
            ),

            TextField(
              controller: _agentIdController,
              decoration: InputDecoration(
                labelText: "Agent ID *",
                hintText: "输入目标 Agent 的 ID",
                prefixIcon: const Icon(Icons.person),
                border: const OutlineInputBorder(),
              ),
              textCapitalization: TextCapitalization.none,
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _messageController,
              decoration: InputDecoration(
                labelText: "留言（可选）",
                hintText: "想对 Agent 说的话…",
                prefixIcon: const Icon(Icons.chat_bubble_outline),
                border: const OutlineInputBorder(),
              ),
              maxLines: 3,
              minLines: 1,
            ),
            const Spacer(),
            FilledButton.icon(
              onPressed: _isCalling ? null : _makeCall,
              icon: _isCalling
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.phone_in_talk),
              label: Text(_isCalling ? "呼叫中…" : "拨打电话"),
              style: FilledButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 14),
                textStyle: const TextStyle(fontSize: 16),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
