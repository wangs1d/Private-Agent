import "package:flutter/material.dart";
import "package:flutter/services.dart";

import "../../core/config/api_config.dart";
import "../../core/services/world_api_client.dart";

/// Agent 占位邮箱注册：与后端 `POST/GET /accounts/register/email/*` 对齐。
class AgentMailboxPage extends StatefulWidget {
  const AgentMailboxPage({super.key, required this.api});

  final WorldApiClient api;

  @override
  State<AgentMailboxPage> createState() => _AgentMailboxPageState();
}

class _AgentMailboxPageState extends State<AgentMailboxPage> {
  final TextEditingController _nameController = TextEditingController();
  final TextEditingController _codeController = TextEditingController();

  bool _accountLoading = true;
  bool? _registered;
  String? _accountDisplayName;
  String? _accountEmail;
  String? _accountId;

  bool _startBusy = false;
  bool _pendingBusy = false;
  bool _verifyBusy = false;

  String? _assignedEmail;
  String? _mailDomain;
  String? _expiresAt;
  Map<String, dynamic>? _pendingDetail;

  @override
  void initState() {
    super.initState();
    _loadAccount();
  }

  @override
  void dispose() {
    _nameController.dispose();
    _codeController.dispose();
    super.dispose();
  }

  Future<void> _loadAccount() async {
    setState(() => _accountLoading = true);
    try {
      final Map<String, dynamic> j = await widget.api.getAccountMe();
      if (!mounted) return;
      final bool reg = j["registered"] == true;
      final Map<String, dynamic>? acc =
          (j["account"] as Map?)?.cast<String, dynamic>();
      setState(() {
        _accountLoading = false;
        _registered = reg;
        _accountDisplayName = acc?["displayName"]?.toString();
        _accountEmail = acc?["email"]?.toString();
        _accountId = acc?["accountId"]?.toString();
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _accountLoading = false;
        _registered = null;
      });
    }
  }

  Future<void> _refreshPending() async {
    setState(() => _pendingBusy = true);
    try {
      final Map<String, dynamic> j = await widget.api.getEmailRegistrationPending();
      if (!mounted) return;
      if (j["ok"] == true) {
        final Map<String, dynamic>? p =
            (j["pending"] as Map?)?.cast<String, dynamic>();
        setState(() => _pendingDetail = p);
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text("拉取待验证信息失败")),
        );
      }
    } finally {
      if (mounted) setState(() => _pendingBusy = false);
    }
  }

  Future<void> _start() async {
    final String name = _nameController.text.trim();
    if (name.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("请输入显示名称")),
      );
      return;
    }
    setState(() => _startBusy = true);
    try {
      final Map<String, dynamic> res =
          await widget.api.startEmailRegistration(name);
      if (!mounted) return;
      if (res["ok"] == true) {
        setState(() {
          _assignedEmail = res["email"]?.toString();
          _mailDomain = res["mailDomain"]?.toString();
          _expiresAt = res["expiresAt"]?.toString();
        });
        await _refreshPending();
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text("已分配占位邮箱，请查看下方验证码或查收真实邮件")),
        );
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(res["message"]?.toString() ?? "发起失败")),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("请求失败: $e")),
        );
      }
    } finally {
      if (mounted) setState(() => _startBusy = false);
    }
  }

  Future<void> _verify() async {
    final String code = _codeController.text.trim();
    if (!RegExp(r"^\d{6}$").hasMatch(code)) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("请输入 6 位数字验证码")),
      );
      return;
    }
    setState(() => _verifyBusy = true);
    try {
      final Map<String, dynamic> res =
          await widget.api.verifyEmailRegistration(code);
      if (!mounted) return;
      if (res["ok"] == true) {
        _codeController.clear();
        setState(() {
          _assignedEmail = null;
          _mailDomain = null;
          _expiresAt = null;
          _pendingDetail = null;
        });
        await _loadAccount();
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text("邮箱验证完成，Agent 账号已创建")),
        );
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(res["message"]?.toString() ?? "验证失败")),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("请求失败: $e")),
        );
      }
    } finally {
      if (mounted) setState(() => _verifyBusy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return ListView(
      padding: const EdgeInsets.all(16),
      children: <Widget>[
        Text(
          "使用服务端分配的占位邮箱完成验证码注册；也可配置邮件网关将真实邮件 POST 到 "
          "`/accounts/register/email/inbound`。",
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 12),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text("登录主体", style: theme.textTheme.titleSmall),
                const SizedBox(height: 8),
                SelectableText(
                  ApiConfig.effectiveActorId,
                  style: theme.textTheme.bodyLarge?.copyWith(
                    fontFamily: "monospace",
                  ),
                ),
                Text(
                  ApiConfig.userId.trim().isNotEmpty
                      ? "当前使用 USER_ID 作为账号主体"
                      : "当前使用 SESSION_ID 作为账号主体",
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 16),
        if (_accountLoading)
          const LinearProgressIndicator(minHeight: 2)
        else if (_registered == null)
          Text(
            "无法连接服务端",
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.error,
            ),
          )
        else if (_registered == true)
          Card(
            color: theme.colorScheme.primaryContainer
                .withValues(alpha: 0.35),
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text("已注册", style: theme.textTheme.titleMedium),
                  const SizedBox(height: 8),
                  Text(
                    _accountDisplayName ?? "-",
                    style: theme.textTheme.bodyLarge,
                  ),
                  if (_accountEmail != null &&
                      _accountEmail!.trim().isNotEmpty) ...<Widget>[
                    const SizedBox(height: 4),
                    SelectableText(
                      _accountEmail!,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        fontFamily: "monospace",
                      ),
                    ),
                  ],
                  const SizedBox(height: 4),
                  Text(
                    "账号 ID: ${_accountId ?? "-"}",
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                  Align(
                    alignment: Alignment.centerRight,
                    child: TextButton.icon(
                      onPressed: _loadAccount,
                      icon: const Icon(Icons.refresh, size: 18),
                      label: const Text("刷新"),
                    ),
                  ),
                ],
              ),
            ),
          )
        else ...<Widget>[
          TextField(
            controller: _nameController,
            decoration: const InputDecoration(
              labelText: "显示名称",
              border: OutlineInputBorder(),
            ),
            enabled: !_startBusy,
            textCapitalization: TextCapitalization.words,
          ),
          const SizedBox(height: 12),
          FilledButton.icon(
            onPressed: _startBusy ? null : _start,
            icon: _startBusy
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.mark_email_unread_outlined),
            label: const Text("获取占位邮箱并开始验证"),
          ),
          if (_assignedEmail != null) ...<Widget>[
            const SizedBox(height: 16),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text("占位邮箱", style: theme.textTheme.titleSmall),
                    const SizedBox(height: 8),
                    SelectableText(
                      _assignedEmail!,
                      style: theme.textTheme.bodyLarge?.copyWith(
                        fontFamily: "monospace",
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    if (_mailDomain != null)
                      Text(
                        "域名: $_mailDomain",
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    if (_expiresAt != null)
                      Text(
                        "过期时间: $_expiresAt",
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ],
          const SizedBox(height: 16),
          Row(
            children: <Widget>[
              Text("验证码", style: theme.textTheme.titleSmall),
              const Spacer(),
              TextButton.icon(
                onPressed: (_pendingBusy || _assignedEmail == null)
                    ? null
                    : _refreshPending,
                icon: _pendingBusy
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.sync, size: 18),
                label: const Text("刷新"),
              ),
            ],
          ),
          if (_pendingDetail != null) ...<Widget>[
            const SizedBox(height: 8),
            _PendingCodesCard(detail: _pendingDetail!, theme: theme),
          ],
          const SizedBox(height: 12),
          TextField(
            controller: _codeController,
            decoration: const InputDecoration(
              labelText: "输入 6 位验证码",
              border: OutlineInputBorder(),
            ),
            keyboardType: TextInputType.number,
            inputFormatters: <TextInputFormatter>[
              FilteringTextInputFormatter.digitsOnly,
              LengthLimitingTextInputFormatter(6),
            ],
            enabled: !_verifyBusy,
            onSubmitted: (_) => _verify(),
          ),
          const SizedBox(height: 12),
          FilledButton.tonal(
            onPressed: _verifyBusy ? null : _verify,
            child: _verifyBusy
                ? const SizedBox(
                    width: 22,
                    height: 22,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text("提交验证并创建账号"),
          ),
        ],
      ],
    );
  }
}

class _PendingCodesCard extends StatelessWidget {
  const _PendingCodesCard({required this.detail, required this.theme});

  final Map<String, dynamic> detail;
  final ThemeData theme;

  @override
  Widget build(BuildContext context) {
    final List<dynamic>? inbound = detail["inboundCodes"] as List<dynamic>?;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(
              "服务端验证码（开发调试用）",
              style: theme.textTheme.labelLarge,
            ),
            SelectableText(
              detail["code"]?.toString() ?? "-",
              style: theme.textTheme.titleMedium?.copyWith(
                fontFamily: "monospace",
                letterSpacing: 2,
              ),
            ),
            if (inbound != null && inbound.isNotEmpty) ...<Widget>[
              const SizedBox(height: 12),
              Text(
                "邮件网关解析到的 6 位码",
                style: theme.textTheme.labelLarge,
              ),
              ...inbound.map(
                (dynamic c) => SelectableText(
                  c.toString(),
                  style: theme.textTheme.bodyMedium?.copyWith(
                    fontFamily: "monospace",
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
