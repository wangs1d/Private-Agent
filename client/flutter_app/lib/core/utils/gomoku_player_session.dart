/// 五子棋人类选手 session：必须与 Agent（[actorId]）不同，否则会被识别为黑棋且无法开局。
class GomokuPlayerSession {
  GomokuPlayerSession._();

  static const String _suffix = "--human";

  static String humanId(String actorId) {
    final String base = actorId.trim();
    if (base.isEmpty) return "human-gomoku-player";
    if (base.endsWith(_suffix)) return base;
    return "$base$_suffix";
  }
}
