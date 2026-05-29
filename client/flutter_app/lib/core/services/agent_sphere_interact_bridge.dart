/// 嵌入球形 Agent 向主 WS 发送交互（唤醒 / 聊天 / 聚焦）
class AgentSphereInteractBridge {
  AgentSphereInteractBridge._();

  static final AgentSphereInteractBridge instance = AgentSphereInteractBridge._();

  void Function(String action, {String? text})? _onSend;

  void bind(void Function(String action, {String? text}) onSend) {
    _onSend = onSend;
  }

  void unbind() {
    _onSend = null;
  }

  bool send(String action, {String? text}) {
    final handler = _onSend;
    if (handler == null) return false;
    handler(action, text: text);
    return true;
  }
}
