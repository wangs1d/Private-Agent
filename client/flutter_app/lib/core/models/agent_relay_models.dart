class AgentRelayMessage {
  AgentRelayMessage({
    required this.messageId,
    required this.fromSessionId,
    required this.toSessionId,
    required this.text,
    this.subject,
    required this.receivedAt,
  });

  final String messageId;
  final String fromSessionId;
  final String toSessionId;
  final String text;
  final String? subject;
  final DateTime receivedAt;
}
