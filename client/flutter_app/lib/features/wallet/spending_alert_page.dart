import "package:flutter/material.dart";

import "../../core/theme/app_theme.dart";

/// 消费提醒设置页面
class SpendingAlertPage extends StatefulWidget {
  const SpendingAlertPage({super.key});

  @override
  State<SpendingAlertPage> createState() => _SpendingAlertPageState();
}

class _SpendingAlertPageState extends State<SpendingAlertPage> {
  bool _largeAmountAlertEnabled = true;
  final TextEditingController _largeAmountController =
      TextEditingController(text: "500");
  final TextEditingController _dailyLimitController =
      TextEditingController(text: "2000");
  bool _dailyLimitEnabled = false;

  final List<double> _recommendedLargeAmounts =
      <double>[100, 300, 500, 1000, 2000];
  final List<double> _recommendedDailyLimits =
      <double>[1000, 2000, 5000, 10000];

  @override
  void dispose() {
    _largeAmountController.dispose();
    _dailyLimitController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final TextTheme text = Theme.of(context).textTheme;

    return Scaffold(
      appBar: AppBar(title: const Text("消费提醒")),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: <Widget>[
          Card(
            child: Column(
              children: <Widget>[
                SwitchListTile(
                  title: Text("大额消费通知", style: text.titleSmall),
                  subtitle: Text(
                    "超过设定金额时发送通知",
                    style: text.bodySmall?.copyWith(color: cs.onSurfaceVariant),
                  ),
                  value: _largeAmountAlertEnabled,
                  onChanged: (bool value) {
                    setState(() => _largeAmountAlertEnabled = value);
                  },
                ),
                if (_largeAmountAlertEnabled)
                  _buildLimitSection(
                    cs: cs,
                    text: text,
                    title: "大额消费阈值",
                    controller: _largeAmountController,
                    recommended: _recommendedLargeAmounts,
                    footer: "单笔消费超过此金额将发送通知",
                  ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          Card(
            child: Column(
              children: <Widget>[
                SwitchListTile(
                  title: Text("每日消费限额", style: text.titleSmall),
                  subtitle: Text(
                    "启用后，Agent 每日消费不能超过设定值",
                    style: text.bodySmall?.copyWith(color: cs.onSurfaceVariant),
                  ),
                  value: _dailyLimitEnabled,
                  onChanged: (bool value) {
                    setState(() => _dailyLimitEnabled = value);
                  },
                ),
                if (_dailyLimitEnabled)
                  _buildLimitSection(
                    cs: cs,
                    text: text,
                    title: "每日限额",
                    controller: _dailyLimitController,
                    recommended: _recommendedDailyLimits,
                    footer:
                        "今日已消费：¥0.00 / ¥${_dailyLimitController.text.isEmpty ? '0' : _dailyLimitController.text}",
                  ),
              ],
            ),
          ),
          const SizedBox(height: 24),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Row(
                    children: <Widget>[
                      Icon(Icons.lightbulb_outline,
                          color: cs.onSurfaceVariant, size: 20),
                      const SizedBox(width: 8),
                      Text(
                        "使用说明",
                        style: text.titleSmall?.copyWith(
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Text(
                    "• 大额消费通知：当单笔消费超过设定阈值时，会立即向您发送通知\n"
                    "• 每日消费限额：启用后，Agent 每日累计消费不能超过设定值\n"
                    "• 所有消费记录都会保存，可随时查看历史账单",
                    style: text.bodySmall?.copyWith(
                      color: cs.onSurfaceVariant,
                      height: 1.6,
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

  Widget _buildLimitSection({
    required ColorScheme cs,
    required TextTheme text,
    required String title,
    required TextEditingController controller,
    required List<double> recommended,
    required String footer,
  }) {
    return Column(
      children: <Widget>[
        Divider(color: cs.outline.withValues(alpha: 0.35)),
        Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(title, style: text.labelLarge),
              const SizedBox(height: 12),
              TextFormField(
                controller: controller,
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
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: 12),
              Text(
                "推荐额度",
                style: text.labelMedium?.copyWith(color: cs.onSurfaceVariant),
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: recommended.map((double limit) {
                  final bool isSelected =
                      controller.text == limit.toString();
                  return InkWell(
                    onTap: () {
                      setState(() => controller.text = limit.toString());
                    },
                    borderRadius: BorderRadius.circular(20),
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 16,
                        vertical: 8,
                      ),
                      decoration:
                          AppTheme.subNavChip(cs, selected: isSelected),
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
              const SizedBox(height: 8),
              Text(
                footer,
                style: text.labelSmall?.copyWith(color: cs.onSurfaceVariant),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
