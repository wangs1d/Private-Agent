import "package:flutter/material.dart";

/// Agent 安全设置页面
class SecuritySettingsPage extends StatefulWidget {
  const SecuritySettingsPage({super.key});

  @override
  State<SecuritySettingsPage> createState() => _SecuritySettingsPageState();
}

class _SecuritySettingsPageState extends State<SecuritySettingsPage> {
  bool _biometricEnabled = false;
  bool _requireConfirmation = true;
  final TextEditingController _autoApprovalController = TextEditingController(text: '100');
  
  // 推荐额度
  final List<double> _recommendedLimits = [50, 100, 200, 500, 1000];

  @override
  void dispose() {
    _autoApprovalController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('安全设置'),
        backgroundColor: Colors.grey[800],
      ),
      backgroundColor: Colors.grey[900],
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // Agent 自主决策设置
          _buildSectionTitle('Agent 自主决策'),
          Card(
            color: Colors.grey[850],
            child: Column(
              children: [
                SwitchListTile(
                  title: const Text(
                    '生物识别验证',
                    style: TextStyle(color: Colors.white),
                  ),
                  subtitle: Text(
                    '大额操作需要指纹/面容验证',
                    style: TextStyle(color: Colors.grey[400]),
                  ),
                  value: _biometricEnabled,
                  activeColor: Colors.grey[600],
                  onChanged: (value) {
                    setState(() {
                      _biometricEnabled = value;
                    });
                  },
                ),
                Divider(color: Colors.grey[700]),
                SwitchListTile(
                  title: const Text(
                    '操作确认',
                    style: TextStyle(color: Colors.white),
                  ),
                  subtitle: Text(
                    '每笔交易都需要用户确认',
                    style: TextStyle(color: Colors.grey[400]),
                  ),
                  value: _requireConfirmation,
                  activeColor: Colors.grey[600],
                  onChanged: (value) {
                    setState(() {
                      _requireConfirmation = value;
                    });
                  },
                ),
              ],
            ),
          ),

          const SizedBox(height: 24),

          // 自动审批额度
          _buildSectionTitle('自动审批额度'),
          Card(
            color: Colors.grey[850],
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '单笔自动审批上限',
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 16,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    '低于此金额的交易，Agent 可自主决定',
                    style: TextStyle(
                      color: Colors.grey[400],
                      fontSize: 12,
                    ),
                  ),
                  const SizedBox(height: 16),
                  
                  // 输入框
                  TextFormField(
                    controller: _autoApprovalController,
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
                    onChanged: (value) {
                      // 验证输入
                      final amount = double.tryParse(value);
                      if (amount != null && amount >= 0 && amount <= 10000) {
                        setState(() {});
                      }
                    },
                  ),
                  
                  const SizedBox(height: 16),
                  
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
                    children: _recommendedLimits.map((limit) {
                      final isSelected = _autoApprovalController.text == limit.toString();
                      return InkWell(
                        onTap: () {
                          setState(() {
                            _autoApprovalController.text = limit.toString();
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
                ],
              ),
            ),
          ),

          const SizedBox(height: 24),

          // 安全提示
          Card(
            color: Colors.grey[850],
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  Icon(
                    Icons.info_outline,
                    color: Colors.grey[400],
                    size: 20,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      '建议开启生物识别验证以提高账户安全性',
                      style: TextStyle(
                        color: Colors.grey[400],
                        fontSize: 13,
                      ),
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

  Widget _buildSectionTitle(String title) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Text(
        title,
        style: TextStyle(
          color: Colors.grey[300],
          fontSize: 14,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}
