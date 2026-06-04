/// 虚拟电话 UI 文案（6 位号登记在 Agent 名下，即用户联络号，与 Agent 共用）。
class VirtualPhoneUiLabels {
  VirtualPhoneUiLabels._();

  static const String featureTitle = "联系 Agent";
  static const String featureSubtitle =
      "您的虚拟号码由 Agent 代为持有，供其他 Agent 拨打；在 App 内联系 Agent 无需另输号码。";
  static const String callMyAgentButton = "呼叫我的 Agent";
  static const String callOtherAgentDivider = "或通过 Agent ID 呼叫";
  static const String chatTooltip = "呼叫 Agent";
  static const String idleStatusHint = "可呼叫你的 Agent；虚拟联络号与 Agent 共用";

  /// 来电主叫展示（[direction] 见 payload：`agent_to_user` / 其他为 Agent 互拨）。
  static String incomingCallerLabel({
    required String direction,
    String? fromPhone,
  }) {
    final String phone = (fromPhone ?? "").trim();
    if (direction == "agent_to_user") {
      return phone.isNotEmpty ? "你的 Agent（$phone）" : "你的 Agent";
    }
    return phone.isNotEmpty
        ? "其他 Agent · $phone"
        : "其他 Agent（未知虚拟号）";
  }

  static String calleeAgentLine(String toPhone) {
    final String p = toPhone.trim();
    if (p.isEmpty || p == "—") return "";
    return "你的 Agent 接听线路：$p";
  }

  static String floatingIncoming(String? detail) {
    if (detail != null && detail.isNotEmpty) {
      return "Agent 来电 · $detail";
    }
    return "Agent 来电";
  }

  static String callStatusLabel(String? status) {
    switch (status) {
      case "incoming":
        return "Agent 来电中";
      case "ringing":
        return "正在呼叫 Agent";
      case "connected":
        return "与 Agent 通话中";
      case "agent_handling":
        return "Agent 代接中";
      case "agent_handled":
        return "代接已完成";
      case "answered_by_user":
        return "你已接听";
      case "ended":
        return "通话已结束";
      default:
        return status ?? "";
    }
  }

  static const String peerIncomingTitle = "其他 Agent 来电";
  static const String peerIncomingHint =
      "请先选择是否接听。若不方便，可让 Agent 代接，代接后会向你说明来电内容。";
  static const String peerAccept = "接听";
  static const String peerDelegate = "Agent 代接";
  static const String peerDecline = "拒接（Agent 转告）";
}
