import "package:flutter/material.dart";

import "../../core/theme/app_theme.dart";

/// Agent 安全设置页面
class SecuritySettingsPage extends StatefulWidget {
  const SecuritySettingsPage({super.key});

  @override
  State<SecuritySettingsPage> createState() => _SecuritySettingsPageState();
}

class _SecuritySettingsPageState extends State<SecuritySettingsPage> {
  bool _biometricEnabled = false;
  bool _requireConfirmation = true;
  final TextEditingController _autoApprovalController =
      TextEditingController(text: "100");

  final List<double> _recommendedLimits = <double>[50, 100, 200, 500, 1000];

  @override
  void dispose() {
    _autoApprovalController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final TextTheme text = Theme.of(context).textTheme;

    return Scaffold(
      appBar: AppBar(title: const Text("安全设置")),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: <Widget>[
          _buildSectionTitle("Agent 自主决策", cs, text),
          Card(
            child: Column(
              children: <Widget>[
                SwitchListTile(
                  title: Text("生物识别验证", style: text.titleSmall),
                  subtitle: Text(
                    "大额操作需要指纹/面容验证",
                    style: text.bodySmall?.copyWith(color: cs.onSurfaceVariant),
                  ),
                  value: _biometricEnabled,
                  onChanged: (bool value) {
                    setState(() => _biometricEnabled = value);
                  },
                ),
                Divider(color: cs.outline.withValues(alpha: 0.35)),
                SwitchListTile(
                  title: Text("操作确认", style: text.titleSmall),
                  subtitle: Text(
                    "每笔交易都需要用户确认",
                    style: text.bodySmall?.copyWith(color: cs.onSurfaceVariant),
                  ),
                  value: _requireConfirmation,
                  onChanged: (bool value) {
                    setState(() => _requireConfirmation = value);
                  },
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),
          _buildSectionTitle("自动审批额度", cs, text),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text("单笔自动审批上限", style: text.titleSmall),
                  const SizedBox(height: 8),
                  Text(
                    "低于此金额的交易，Agent 可自主决定",
                    style: text.bodySmall?.copyWith(color: cs.onSurfaceVariant),
                  ),
                  const SizedBox(height: 16),
                  TextFormField(
                    controller: _autoApprovalController,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(
                      hintText: "输入金额",
                      prefixText: "¥ ",
                      suffixText: "元",
                      contentPadding: EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 12,
                      ),
                    ),
                    onChanged: (String value) {
                      final double? amount = double.tryParse(value);
                      if (amount != null && amount >= 0 && amount <= 10000) {
                        setState(() {});
                      }
                    },
                  ),
                  const SizedBox(height: 16),
                  Text(
                    "推荐额度",
                    style: text.labelMedium?.copyWith(color: cs.onSurfaceVariant),
                  ),
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: _recommendedLimits.map((double limit) {
                      final bool isSelected =
                          _autoApprovalController.text == limit.toString();
                      return InkWell(
                        onTap: () {
                          setState(() {
                            _autoApprovalController.text = limit.toString();
                          });
                        },
                        borderRadius: BorderRadius.circular(20),
                        child: Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 16,
                            vertical: 8,
                          ),
                          decoration: AppTheme.subNavChip(
                            cs,
                            selected: isSelected,
                          ),
                          child: Text(
                            "¥${limit.toInt()}",
                            style: text.labelMedium?.copyWith(
                              color: isSelected
                                  ? cs.onSurface
                                  : cs.onSurfaceVariant,
                              fontWeight: isSelected
                                  ? FontWeight.bold
                                  : FontWeight.normal,
                            ),
                          ),
                        ),
                      );
                    }).toList(),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 24),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: <Widget>[
                  Icon(Icons.info_outline, color: cs.onSurfaceVariant, size: 20),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      "建议开启生物识别验证以提高账户安全性",
                      style: text.bodySmall?.copyWith(color: cs.onSurfaceVariant),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildSectionTitle(String title, ColorScheme cs, TextTheme text) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Text(
        title,
        style: text.labelLarge?.copyWith(
          color: cs.onSurface,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}
