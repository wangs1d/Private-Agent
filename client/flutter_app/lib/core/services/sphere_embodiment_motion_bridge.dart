/// 主 Agent WS 是否已连接（具身指令与自主移动仅在连接后生效）。
class SphereEmbodimentMotionBridge {
  SphereEmbodimentMotionBridge._();

  static final SphereEmbodimentMotionBridge instance = SphereEmbodimentMotionBridge._();

  bool mainAgentLinked = false;

  void setMainAgentLinked(bool linked) {
    mainAgentLinked = linked;
  }
}
