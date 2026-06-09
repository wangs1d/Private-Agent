import "package:flutter/material.dart";

import "../../core/theme/app_theme.dart";
import "security_settings_page.dart";
import "spending_alert_page.dart";
import "transaction_history_page.dart";

/// 钱包弹窗 —— 精简版，以 [showDialog] 弹出使用。
class WalletDialog extends StatelessWidget {
  const WalletDialog({
    super.key,
    required this.balance,
  });

  final double balance;

  /// 弹出钱包弹窗的便捷方法
  static Future<void> show(
    BuildContext context, {
    required double balance,
  }) {
    return showDialog<void>(
      context: context,
      builder: (BuildContext context) => WalletDialog(balance: balance),
    );
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final TextTheme text = Theme.of(context).textTheme;

    return Dialog(
      backgroundColor: AppPalette.locationDialogBg,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 360),
        child: IntrinsicWidth(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              // 标题栏
              _buildHeader(context, cs, text),
              // 余额卡片
              _buildBalanceCard(cs, text),
              const SizedBox(height: 16),
              // 快捷操作
              _buildQuickActions(context, cs, text),
              const SizedBox(height: 20),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildHeader(BuildContext context, ColorScheme cs, TextTheme text) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 20, 12, 0),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: <Widget>[
          Row(
            children: <Widget>[
              Icon(Icons.account_balance_wallet, color: cs.primary, size: 22),
              const SizedBox(width: 10),
              Text(
                "我的钱包",
                style: text.titleMedium?.copyWith(
                  color: cs.onSurface,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          IconButton(
            icon: Icon(Icons.close, color: cs.onSurfaceVariant, size: 20),
            onPressed: () => Navigator.of(context).pop(),
            visualDensity: VisualDensity.compact,
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
          ),
        ],
      ),
    );
  }

  Widget _buildBalanceCard(ColorScheme cs, TextTheme text) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.fromLTRB(20, 16, 20, 0),
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: <Color>[
            cs.primary.withValues(alpha: 0.15),
            cs.tertiary.withValues(alpha: 0.08),
          ],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: cs.outline.withValues(alpha: 0.3)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            "可用余额",
            style: text.labelMedium?.copyWith(color: cs.onSurfaceVariant),
          ),
          const SizedBox(height: 6),
          Text(
            "\u00a5${balance.toStringAsFixed(2)}",
            style: text.headlineMedium?.copyWith(
              color: cs.onSurface,
              fontWeight: FontWeight.bold,
              letterSpacing: -0.5,
            ),
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
    final List<({IconData icon, String label, VoidCallback onTap})> actions =
        <({IconData icon, String label, VoidCallback onTap})>[
          (
            icon: Icons.security,
            label: "安全设置",
            onTap: () {
              Navigator.pop(context);
              Navigator.push(
                context,
                MaterialPageRoute<void>(
                  builder: (BuildContext context) =>
                      const SecuritySettingsPage(),
                ),
              );
            },
          ),
          (
            icon: Icons.notifications_active,
            label: "消费提醒",
            onTap: () {
              Navigator.pop(context);
              Navigator.push(
                context,
                MaterialPageRoute<void>(
                  builder: (BuildContext context) =>
                      const SpendingAlertPage(),
                ),
              );
            },
          ),
          (
            icon: Icons.receipt_long,
            label: "消费记录",
            onTap: () {
              Navigator.pop(context);
              Navigator.push(
                context,
                MaterialPageRoute<void>(
                  builder: (BuildContext context) =>
                      const TransactionHistoryPage(),
                ),
              );
            },
          ),
        ];

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 20),
      child: Row(
        children: actions.map((action) {
          return Expanded(
            child: Padding(
              padding: EdgeInsets.only(left: actions.indexOf(action) > 0 ? 8 : 0),
              child: _actionTile(cs, text, action.icon, action.label, action.onTap),
            ),
          );
        }).toList(),
      ),
    );
  }

  Widget _actionTile(
    ColorScheme cs,
    TextTheme text,
    IconData icon,
    String label,
    VoidCallback onTap,
  ) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 14),
        decoration: AppTheme.borderedPanel(cs, radius: 12),
        child: Column(
          children: <Widget>[
            Icon(icon, color: cs.onSurfaceVariant, size: 22),
            const SizedBox(height: 6),
            Text(
              label,
              style: text.labelSmall?.copyWith(color: cs.onSurfaceVariant),
            ),
          ],
        ),
      ),
    );
  }
}

/// 保留原有类名以便向后兼容，内部委托给 [WalletDialog]。
@Deprecated("请使用 WalletDialog.show() 弹出钱包")
class WalletPage extends StatelessWidget {
  const WalletPage({
    super.key,
    required this.balance,
  });

  final double balance;

  @override
  Widget build(BuildContext context) {
    // 延迟弹出对话框
    WidgetsBinding.instance.addPostFrameCallback((_) {
      WalletDialog.show(context, balance: balance);
      Navigator.of(context).pop(); // 返回上一页
    });

    return const SizedBox.shrink();
  }
}
