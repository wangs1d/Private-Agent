class WalletLedgerItem {
  WalletLedgerItem({
    required this.id,
    required this.action,
    required this.amount,
    required this.success,
    required this.createdAt,
    this.reason,
  });

  final String id;
  final String action;
  final double amount;
  final bool success;
  final DateTime createdAt;
  final String? reason;
}
