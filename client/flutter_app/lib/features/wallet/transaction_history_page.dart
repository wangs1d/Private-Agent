import "package:flutter/material.dart";

/// 交易记录模型
class TransactionRecord {
  TransactionRecord({
    required this.id,
    required this.type,
    required this.title,
    required this.amount,
    required this.balance,
    required this.createdAt,
    this.recipient,
    this.remark,
    this.status = 'completed',
  });

  final String id;
  final String type; // income: 收入, expense: 支出, transfer: 转账
  final String title;
  final double amount;
  final double balance;
  final DateTime createdAt;
  final String? recipient;
  final String? remark;
  final String status; // completed, pending, failed
}

/// 消费记录页面
class TransactionHistoryPage extends StatefulWidget {
  const TransactionHistoryPage({super.key});

  @override
  State<TransactionHistoryPage> createState() => _TransactionHistoryPageState();
}

class _TransactionHistoryPageState extends State<TransactionHistoryPage> {
  // 模拟数据 - 实际应该从API获取
  final List<TransactionRecord> _transactions = [
    TransactionRecord(
      id: 'tx_001',
      type: 'expense',
      title: '技能购买 - 数据分析助手',
      amount: -299.00,
      balance: 701.00,
      createdAt: DateTime.now().subtract(const Duration(hours: 2)),
      remark: '自动审批通过',
    ),
    TransactionRecord(
      id: 'tx_002',
      type: 'transfer',
      title: '转账给 Agent-A',
      amount: -500.00,
      balance: 1000.00,
      createdAt: DateTime.now().subtract(const Duration(days: 1)),
      recipient: 'agent_a_session_123',
      remark: '项目协作费用',
    ),
    TransactionRecord(
      id: 'tx_003',
      type: 'income',
      title: '充值',
      amount: 2000.00,
      balance: 1500.00,
      createdAt: DateTime.now().subtract(const Duration(days: 2)),
    ),
    TransactionRecord(
      id: 'tx_004',
      type: 'expense',
      title: '游戏消费 - 五子棋',
      amount: -50.00,
      balance: -500.00,
      createdAt: DateTime.now().subtract(const Duration(days: 3)),
      remark: 'Agent自主决策',
    ),
  ];

  String _filterType = 'all'; // all, income, expense, transfer

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final TextTheme text = Theme.of(context).textTheme;
    final List<TransactionRecord> filteredTransactions = _filterType == 'all'
        ? _transactions
        : _transactions.where((TransactionRecord t) => t.type == _filterType).toList();

    return Scaffold(
      appBar: AppBar(
        title: const Text('消费记录'),
        actions: <Widget>[
          PopupMenuButton<String>(
            icon: Icon(Icons.filter_list, color: cs.onSurface),
            color: cs.surface,
            onSelected: (String value) {
              setState(() => _filterType = value);
            },
            itemBuilder: (BuildContext context) => <PopupMenuEntry<String>>[
              PopupMenuItem<String>(
                value: 'all',
                child: Text('全部', style: text.bodyMedium),
              ),
              PopupMenuItem<String>(
                value: 'income',
                child: Text('收入', style: text.bodyMedium),
              ),
              PopupMenuItem<String>(
                value: 'expense',
                child: Text('支出', style: text.bodyMedium),
              ),
              PopupMenuItem<String>(
                value: 'transfer',
                child: Text('转账', style: text.bodyMedium),
              ),
            ],
          ),
        ],
      ),
      body: filteredTransactions.isEmpty
          ? _buildEmptyState(cs, text)
          : ListView.builder(
              padding: const EdgeInsets.all(16),
              itemCount: filteredTransactions.length,
              itemBuilder: (BuildContext context, int index) {
                return _buildTransactionItem(filteredTransactions[index], cs, text);
              },
            ),
    );
  }

  Widget _buildEmptyState(ColorScheme cs, TextTheme text) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          Icon(Icons.receipt_long, size: 64, color: cs.outline),
          const SizedBox(height: 16),
          Text(
            '暂无交易记录',
            style: text.titleSmall?.copyWith(color: cs.onSurfaceVariant),
          ),
          const SizedBox(height: 8),
          Text(
            '开始使用钱包功能后，交易记录将显示在这里',
            style: text.bodySmall?.copyWith(color: cs.onSurfaceVariant),
          ),
        ],
      ),
    );
  }

  Widget _buildTransactionItem(
    TransactionRecord transaction,
    ColorScheme cs,
    TextTheme text,
  ) {
    final isIncome = transaction.type == 'income';
    final amountColor = isIncome ? Colors.green[400] : Colors.red[400];
    final amountPrefix = isIncome ? '+' : '-';
    final iconData = _getIconForType(transaction.type);
    final iconColor = _getIconColorForType(transaction.type);

    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                      color: iconColor.withValues(alpha: 0.35),
                    ),
                  ),
                  child: Icon(iconData, color: iconColor, size: 24),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        transaction.title,
                        style: text.titleSmall?.copyWith(
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                      if (transaction.recipient != null) ...<Widget>[
                        const SizedBox(height: 4),
                        Text(
                          '收款人：${transaction.recipient}',
                          style: text.labelSmall?.copyWith(
                            color: cs.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: <Widget>[
                    Text(
                      '$amountPrefix¥${transaction.amount.abs().toStringAsFixed(2)}',
                      style: text.titleSmall?.copyWith(
                        color: amountColor,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      '余额 ¥${transaction.balance.toStringAsFixed(2)}',
                      style: text.labelSmall?.copyWith(color: cs.onSurfaceVariant),
                    ),
                  ],
                ),
              ],
            ),
            if (transaction.remark != null || transaction.status != 'completed') ...<Widget>[
              Divider(height: 24, color: cs.outline.withValues(alpha: 0.35)),
              Row(
                children: <Widget>[
                  if (transaction.remark != null)
                    Expanded(
                      child: Text(
                        transaction.remark!,
                        style: text.labelSmall?.copyWith(
                          color: cs.onSurfaceVariant,
                        ),
                      ),
                    ),
                  if (transaction.status != 'completed')
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 2,
                      ),
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(4),
                        border: Border.all(
                          color: _getStatusColor(transaction.status)
                              .withValues(alpha: 0.45),
                        ),
                      ),
                      child: Text(
                        _getStatusText(transaction.status),
                        style: text.labelSmall?.copyWith(
                          color: _getStatusColor(transaction.status),
                        ),
                      ),
                    ),
                ],
              ),
            ],
            const SizedBox(height: 8),
            Text(
              _formatDateTime(transaction.createdAt),
              style: text.labelSmall?.copyWith(color: cs.outline),
            ),
          ],
        ),
      ),
    );
  }

  IconData _getIconForType(String type) {
    switch (type) {
      case 'income':
        return Icons.arrow_downward;
      case 'expense':
        return Icons.shopping_cart;
      case 'transfer':
        return Icons.swap_horiz;
      default:
        return Icons.receipt;
    }
  }

  Color _getIconColorForType(String type) {
    switch (type) {
      case 'income':
        return Colors.green[400]!;
      case 'expense':
        return Colors.orange[400]!;
      case 'transfer':
        return Colors.blue[400]!;
      default:
        return Colors.grey[400]!;
    }
  }

  Color _getStatusColor(String status) {
    switch (status) {
      case 'completed':
        return Colors.green[400]!;
      case 'pending':
        return Colors.orange[400]!;
      case 'failed':
        return Colors.red[400]!;
      default:
        return Colors.grey[400]!;
    }
  }

  String _getStatusText(String status) {
    switch (status) {
      case 'completed':
        return '已完成';
      case 'pending':
        return '处理中';
      case 'failed':
        return '失败';
      default:
        return status;
    }
  }

  String _formatDateTime(DateTime dateTime) {
    final now = DateTime.now();
    final difference = now.difference(dateTime);

    if (difference.inDays == 0) {
      if (difference.inHours == 0) {
        return '${difference.inMinutes}分钟前';
      }
      return '${difference.inHours}小时前';
    } else if (difference.inDays < 7) {
      return '${difference.inDays}天前';
    } else {
      return '${dateTime.year}-${dateTime.month.toString().padLeft(2, '0')}-${dateTime.day.toString().padLeft(2, '0')}';
    }
  }
}
