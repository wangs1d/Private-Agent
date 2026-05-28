import "package:flutter/material.dart";

import "../../core/theme/app_theme.dart";
import "security_settings_page.dart";
import "spending_alert_page.dart";
import "transaction_history_page.dart";

class WalletPage extends StatelessWidget {
  const WalletPage({
    super.key,
    required this.balance,
  });

  final double balance;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final TextTheme text = Theme.of(context).textTheme;

    return MainPanel(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            _buildPocketCard(context, cs, text),
            const SizedBox(height: 24),
            _buildQuickActions(context, cs, text),
            const SizedBox(height: 24),
            _buildTransactionHistory(context, cs, text),
          ],
        ),
      ),
    );
  }

  Widget _buildPocketCard(
    BuildContext context,
    ColorScheme cs,
    TextTheme text,
  ) {
    return Container(
      width: 160,
      padding: const EdgeInsets.all(16),
      decoration: AppTheme.borderedPanel(cs, radius: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Icon(Icons.account_balance_wallet, color: cs.onSurface, size: 20),
              const SizedBox(width: 8),
              Text(
                "零钱",
                style: text.titleSmall?.copyWith(
                  color: cs.onSurface,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text(
            "¥${balance.toStringAsFixed(2)}",
            style: text.headlineSmall?.copyWith(
              color: cs.onSurface,
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            "可用余额",
            style: text.labelSmall?.copyWith(color: cs.onSurfaceVariant),
          ),
        ],
      ),
    );
  }

  Widget _buildQuickActions(
    BuildContext context,
    ColorScheme cs,
    TextTheme text,
  ) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          "快捷操作",
          style: text.titleSmall?.copyWith(
            color: cs.onSurface,
            fontWeight: FontWeight.bold,
          ),
        ),
        const SizedBox(height: 12),
        Row(
          children: <Widget>[
            _buildActionButton(
              context,
              cs: cs,
              text: text,
              icon: Icons.security,
              label: "安全设置",
              onTap: () {
                Navigator.push(
                  context,
                  MaterialPageRoute<void>(
                    builder: (BuildContext context) =>
                        const SecuritySettingsPage(),
                  ),
                );
              },
            ),
            const SizedBox(width: 12),
            _buildActionButton(
              context,
              cs: cs,
              text: text,
              icon: Icons.notifications_active,
              label: "消费提醒",
              onTap: () {
                Navigator.push(
                  context,
                  MaterialPageRoute<void>(
                    builder: (BuildContext context) =>
                        const SpendingAlertPage(),
                  ),
                );
              },
            ),
            const SizedBox(width: 12),
            _buildActionButton(
              context,
              cs: cs,
              text: text,
              icon: Icons.receipt_long,
              label: "消费记录",
              onTap: () {
                Navigator.push(
                  context,
                  MaterialPageRoute<void>(
                    builder: (BuildContext context) =>
                        const TransactionHistoryPage(),
                  ),
                );
              },
            ),
          ],
        ),
      ],
    );
  }

  Widget _buildActionButton(
    BuildContext context, {
    required ColorScheme cs,
    required TextTheme text,
    required IconData icon,
    required String label,
    required VoidCallback onTap,
  }) {
    return Expanded(
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 16),
          decoration: AppTheme.borderedPanel(cs, radius: 12),
          child: Column(
            children: <Widget>[
              Icon(icon, color: cs.onSurfaceVariant, size: 28),
              const SizedBox(height: 8),
              Text(
                label,
                style: text.labelMedium?.copyWith(color: cs.onSurfaceVariant),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildTransactionHistory(
    BuildContext context,
    ColorScheme cs,
    TextTheme text,
  ) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: <Widget>[
            Text(
              "最近交易",
              style: text.titleSmall?.copyWith(
                color: cs.onSurface,
                fontWeight: FontWeight.bold,
              ),
            ),
            TextButton(
              onPressed: () {
                Navigator.push(
                  context,
                  MaterialPageRoute<void>(
                    builder: (BuildContext context) =>
                        const TransactionHistoryPage(),
                  ),
                );
              },
              child: Text("查看全部", style: TextStyle(color: cs.onSurfaceVariant)),
            ),
          ],
        ),
        const SizedBox(height: 8),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(16),
          decoration: AppTheme.borderedPanel(cs, radius: 12),
          child: Column(
            children: <Widget>[
              Icon(Icons.receipt_long, size: 48, color: cs.outline),
              const SizedBox(height: 12),
              Text(
                "暂无交易记录",
                style: text.bodyMedium?.copyWith(color: cs.onSurfaceVariant),
              ),
              const SizedBox(height: 4),
              Text(
                "开始使用钱包功能后，交易记录将显示在这里",
                style: text.bodySmall?.copyWith(color: cs.onSurfaceVariant),
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      ],
    );
  }
}
