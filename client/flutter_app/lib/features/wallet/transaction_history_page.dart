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
      title: '游戏消费 - 斗地主',
      amount: -50.00,
      balance: -500.00,
      createdAt: DateTime.now().subtract(const Duration(days: 3)),
      remark: 'Agent自主决策',
    ),
  ];

  String _filterType = 'all'; // all, income, expense, transfer

  @override
  Widget build(BuildContext context) {
    final filteredTransactions = _filterType == 'all'
        ? _transactions
        : _transactions.where((t) => t.type == _filterType).toList();

    return Scaffold(
      appBar: AppBar(
        title: const Text('消费记录'),
        backgroundColor: Colors.grey[800],
        actions: [
          PopupMenuButton<String>(
            icon: Icon(Icons.filter_list, color: Colors.grey[300]),
            color: Colors.grey[850],
            onSelected: (value) {
              setState(() {
                _filterType = value;
              });
            },
            itemBuilder: (context) => [
              const PopupMenuItem(
                value: 'all',
                child: Text('全部', style: TextStyle(color: Colors.white)),
              ),
              const PopupMenuItem(
                value: 'income',
                child: Text('收入', style: TextStyle(color: Colors.white)),
              ),
              const PopupMenuItem(
                value: 'expense',
                child: Text('支出', style: TextStyle(color: Colors.white)),
              ),
              const PopupMenuItem(
                value: 'transfer',
                child: Text('转账', style: TextStyle(color: Colors.white)),
              ),
            ],
          ),
        ],
      ),
      backgroundColor: Colors.grey[900],
      body: filteredTransactions.isEmpty
          ? _buildEmptyState()
          : ListView.builder(
              padding: const EdgeInsets.all(16),
              itemCount: filteredTransactions.length,
              itemBuilder: (context, index) {
                return _buildTransactionItem(filteredTransactions[index]);
              },
            ),
    );
  }

  Widget _buildEmptyState() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.receipt_long,
            size: 64,
            color: Colors.grey[600],
          ),
          const SizedBox(height: 16),
          Text(
            '暂无交易记录',
            style: TextStyle(
              color: Colors.grey[400],
              fontSize: 16,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            '开始使用钱包功能后，交易记录将显示在这里',
            style: TextStyle(
              color: Colors.grey[500],
              fontSize: 13,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildTransactionItem(TransactionRecord transaction) {
    final isIncome = transaction.type == 'income';
    final isTransfer = transaction.type == 'transfer';
    final amountColor = isIncome ? Colors.green[400] : Colors.red[400];
    final amountPrefix = isIncome ? '+' : '-';
    final iconData = _getIconForType(transaction.type);
    final iconColor = _getIconColorForType(transaction.type);

    return Card(
      color: Colors.grey[850],
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: iconColor.withOpacity(0.1),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Icon(
                    iconData,
                    color: iconColor,
                    size: 24,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        transaction.title,
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 15,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                      if (transaction.recipient != null) ...[
                        const SizedBox(height: 4),
                        Text(
                          '收款人：${transaction.recipient}',
                          style: TextStyle(
                            color: Colors.grey[500],
                            fontSize: 12,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Text(
                      '$amountPrefix¥${transaction.amount.abs().toStringAsFixed(2)}',
                      style: TextStyle(
                        color: amountColor,
                        fontSize: 16,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      '余额 ¥${transaction.balance.toStringAsFixed(2)}',
                      style: TextStyle(
                        color: Colors.grey[500],
                        fontSize: 12,
                      ),
                    ),
                  ],
                ),
              ],
            ),
            if (transaction.remark != null || transaction.status != 'completed') ...[
              const Divider(height: 24),
              Row(
                children: [
                  if (transaction.remark != null)
                    Expanded(
                      child: Text(
                        transaction.remark!,
                        style: TextStyle(
                          color: Colors.grey[400],
                          fontSize: 12,
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
                        color: _getStatusColor(transaction.status).withOpacity(0.2),
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: Text(
                        _getStatusText(transaction.status),
                        style: TextStyle(
                          color: _getStatusColor(transaction.status),
                          fontSize: 11,
                        ),
                      ),
                    ),
                ],
              ),
            ],
            const SizedBox(height: 8),
            Text(
              _formatDateTime(transaction.createdAt),
              style: TextStyle(
                color: Colors.grey[600],
                fontSize: 11,
              ),
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
