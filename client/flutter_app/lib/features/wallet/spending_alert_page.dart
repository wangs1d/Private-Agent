import "package:flutter/material.dart";

/// 消费提醒设置页面
class SpendingAlertPage extends StatefulWidget {
  const SpendingAlertPage({super.key});

  @override
  State<SpendingAlertPage> createState() => _SpendingAlertPageState();
}

class _SpendingAlertPageState extends State<SpendingAlertPage> {
  bool _largeAmountAlertEnabled = true;
  final TextEditingController _largeAmountController = TextEditingController(text: '500');
  final TextEditingController _dailyLimitController = TextEditingController(text: '2000');
  bool _dailyLimitEnabled = false;
  
  // 推荐额度
  final List<double> _recommendedLargeAmounts = [100, 300, 500, 1000, 2000];
  final List<double> _recommendedDailyLimits = [1000, 2000, 5000, 10000];

  @override
  void dispose() {
    _largeAmountController.dispose();
    _dailyLimitController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('消费提醒'),
        backgroundColor: Colors.grey[800],
      ),
      backgroundColor: Colors.grey[900],
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // 大额消费通知
          Card(
            color: Colors.grey[850],
            child: Column(
              children: [
                SwitchListTile(
                  title: const Text(
                    '大额消费通知',
                    style: TextStyle(color: Colors.white),
                  ),
                  subtitle: Text(
                    '超过设定金额时发送通知',
                    style: TextStyle(color: Colors.grey[400]),
                  ),
                  value: _largeAmountAlertEnabled,
                  activeColor: Colors.grey[600],
                  onChanged: (value) {
                    setState(() {
                      _largeAmountAlertEnabled = value;
                    });
                  },
                ),
                if (_largeAmountAlertEnabled) ...[
                  Divider(color: Colors.grey[700]),
                  Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '大额消费阈值',
                          style: TextStyle(
                            color: Colors.grey[300],
                            fontSize: 14,
                          ),
                        ),
                        const SizedBox(height: 12),
                        
                        // 输入框
                        TextFormField(
                          controller: _largeAmountController,
                          style: const TextStyle(color: Colors.white),
                          keyboardType: TextInputType.number,
                          decoration: InputDecoration(
                            hintText: '输入金额',
                            hintStyle: TextStyle(color: Colors.grey[500]),
                            prefixText: '¥ ',
                            prefixStyle: const TextStyle(
                              color: Colors.white,
                              fontSize: 16,
                            ),
                            suffixText: '元',
                            suffixStyle: TextStyle(color: Colors.grey[400]),
                            border: OutlineInputBorder(
                              borderRadius: BorderRadius.circular(8),
                              borderSide: BorderSide(color: Colors.grey[700]!),
                            ),
                            enabledBorder: OutlineInputBorder(
                              borderRadius: BorderRadius.circular(8),
                              borderSide: BorderSide(color: Colors.grey[700]!),
                            ),
                            focusedBorder: OutlineInputBorder(
                              borderRadius: BorderRadius.circular(8),
                              borderSide: const BorderSide(color: Colors.grey),
                            ),
                            contentPadding: const EdgeInsets.symmetric(
                              horizontal: 12,
                              vertical: 12,
                            ),
                          ),
                        ),
                        
                        const SizedBox(height: 12),
                        
                        // 推荐额度
                        Text(
                          '推荐额度',
                          style: TextStyle(
                            color: Colors.grey[400],
                            fontSize: 13,
                          ),
                        ),
                        const SizedBox(height: 8),
                        Wrap(
                          spacing: 8,
                          runSpacing: 8,
                          children: _recommendedLargeAmounts.map((limit) {
                            final isSelected = _largeAmountController.text == limit.toString();
                            return InkWell(
                              onTap: () {
                                setState(() {
                                  _largeAmountController.text = limit.toString();
                                });
                              },
                              child: Container(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 16,
                                  vertical: 8,
                                ),
                                decoration: BoxDecoration(
                                  color: isSelected ? Colors.grey[700] : Colors.grey[800],
                                  borderRadius: BorderRadius.circular(20),
                                  border: Border.all(
                                    color: isSelected ? Colors.grey[500]! : Colors.grey[700]!,
                                  ),
                                ),
                                child: Text(
                                  '¥${limit.toInt()}',
                                  style: TextStyle(
                                    color: isSelected ? Colors.white : Colors.grey[400],
                                    fontWeight: isSelected ? FontWeight.bold : FontWeight.normal,
                                  ),
                                ),
                              ),
                            );
                          }).toList(),
                        ),
                        Text(
                          '单笔消费超过此金额将发送通知',
                          style: TextStyle(
                            color: Colors.grey[500],
                            fontSize: 12,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ],
            ),
          ),

          const SizedBox(height: 16),

          // 每日消费限额
          Card(
            color: Colors.grey[850],
            child: Column(
              children: [
                SwitchListTile(
                  title: const Text(
                    '每日消费限额',
                    style: TextStyle(color: Colors.white),
                  ),
                  subtitle: Text(
                    '启用后，Agent 每日消费不能超过设定值',
                    style: TextStyle(color: Colors.grey[400]),
                  ),
                  value: _dailyLimitEnabled,
                  activeColor: Colors.grey[600],
                  onChanged: (value) {
                    setState(() {
                      _dailyLimitEnabled = value;
                    });
                  },
                ),
                if (_dailyLimitEnabled) ...[
                  Divider(color: Colors.grey[700]),
                  Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '每日限额',
                          style: TextStyle(
                            color: Colors.grey[300],
                            fontSize: 14,
                          ),
                        ),
                        const SizedBox(height: 12),
                        
                        // 输入框
                        TextFormField(
                          controller: _dailyLimitController,
                          style: const TextStyle(color: Colors.white),
                          keyboardType: TextInputType.number,
                          decoration: InputDecoration(
                            hintText: '输入金额',
                            hintStyle: TextStyle(color: Colors.grey[500]),
                            prefixText: '¥ ',
                            prefixStyle: const TextStyle(
                              color: Colors.white,
                              fontSize: 16,
                            ),
                            suffixText: '元',
                            suffixStyle: TextStyle(color: Colors.grey[400]),
                            border: OutlineInputBorder(
                              borderRadius: BorderRadius.circular(8),
                              borderSide: BorderSide(color: Colors.grey[700]!),
                            ),
                            enabledBorder: OutlineInputBorder(
                              borderRadius: BorderRadius.circular(8),
                              borderSide: BorderSide(color: Colors.grey[700]!),
                            ),
                            focusedBorder: OutlineInputBorder(
                              borderRadius: BorderRadius.circular(8),
                              borderSide: const BorderSide(color: Colors.grey),
                            ),
                            contentPadding: const EdgeInsets.symmetric(
                              horizontal: 12,
                              vertical: 12,
                            ),
                          ),
                        ),
                        
                        const SizedBox(height: 12),
                        
                        // 推荐额度
                        Text(
                          '推荐额度',
                          style: TextStyle(
                            color: Colors.grey[400],
                            fontSize: 13,
                          ),
                        ),
                        const SizedBox(height: 8),
                        Wrap(
                          spacing: 8,
                          runSpacing: 8,
                          children: _recommendedDailyLimits.map((limit) {
                            final isSelected = _dailyLimitController.text == limit.toString();
                            return InkWell(
                              onTap: () {
                                setState(() {
                                  _dailyLimitController.text = limit.toString();
                                });
                              },
                              child: Container(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 16,
                                  vertical: 8,
                                ),
                                decoration: BoxDecoration(
                                  color: isSelected ? Colors.grey[700] : Colors.grey[800],
                                  borderRadius: BorderRadius.circular(20),
                                  border: Border.all(
                                    color: isSelected ? Colors.grey[500]! : Colors.grey[700]!,
                                  ),
                                ),
                                child: Text(
                                  '¥${limit.toInt()}',
                                  style: TextStyle(
                                    color: isSelected ? Colors.white : Colors.grey[400],
                                    fontWeight: isSelected ? FontWeight.bold : FontWeight.normal,
                                  ),
                                ),
                              ),
                            );
                          }).toList(),
                        ),
                        Text(
                          '今日已消费：¥0.00 / ¥${_dailyLimitController.text.isEmpty ? '0' : _dailyLimitController.text}',
                          style: TextStyle(
                            color: Colors.grey[500],
                            fontSize: 12,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ],
            ),
          ),

          const SizedBox(height: 24),

          // 说明卡片
          Card(
            color: Colors.grey[850],
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Icon(
                        Icons.lightbulb_outline,
                        color: Colors.grey[400],
                        size: 20,
                      ),
                      const SizedBox(width: 8),
                      Text(
                        '使用说明',
                        style: TextStyle(
                          color: Colors.grey[300],
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Text(
                    '• 大额消费通知：当单笔消费超过设定阈值时，会立即向您发送通知\n'
                    '• 每日消费限额：启用后，Agent 每日累计消费不能超过设定值\n'
                    '• 所有消费记录都会保存，可随时查看历史账单',
                    style: TextStyle(
                      color: Colors.grey[400],
                      fontSize: 13,
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
}
