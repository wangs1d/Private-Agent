/// emotion-ball 表情 ID 常量与映射。
///
/// 表情库来源:https://github.com/sam70361/aora-bot(emotion-ball/,32 种状态表情)。
/// 完整清单见 assets/emotion_ball/host.html 内嵌的 emotions.js;
/// 使用处统一引用本常量,避免魔法字符串散落。
class EmotionBallIds {
  EmotionBallIds._();

  // ---- life 组 ----
  static const String sleep = "00"; // 睡眠
  static const String idle = "02"; // 待机放空
  static const String curious = "03"; // 好奇
  static const String loadingWake = "05"; // 加载苏醒

  // ---- emotion 组 ----
  static const String happy = "10"; // 开心
  static const String surprised = "13"; // 惊讶
  static const String focused = "16"; // 专注
  static const String satisfied = "19"; // 满意

  // ---- agent 组 ----
  static const String thinking = "30"; // 思考中
  static const String receivingTask = "31"; // 接收任务
  static const String processingBusy = "32"; // 处理中忙碌
  static const String taskDone = "33"; // 任务完成
  static const String error = "34"; // 出错
  static const String waitingInput = "35"; // 等待输入
  static const String netLoading = "36"; // 联网加载
  static const String refused = "38"; // 拒绝/受限
  static const String outputReply = "39"; // 输出回复
  static const String retrieving = "40"; // 检索资料
  static const String stopped = "41"; // 停止终止

  /// [AgentSphereMoodBridge] 的 mood 值 → 表情 ID。
  /// 未知 mood 返回 null,由调用方决定回退值。
  static String? fromMood(String? mood) {
    switch (mood) {
      case "listening":
        return waitingInput;
      case "thinking":
        return thinking;
      case "speaking":
        return outputReply;
      case "happy":
        return taskDone;
      case "alert":
        return error;
      case "idle":
        return idle;
    }
    return null;
  }
}
