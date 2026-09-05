import "package:flutter/material.dart";

import "../../core/presentation/emotion_ball_ids.dart";
import "../../core/services/agent_sphere_mood_bridge.dart";
import "emotion_ball_view.dart";

/// 跟随 [AgentSphereMoodBridge] 全局情绪的 emotion-ball 小球。
///
/// 桥上的 mood(listening / thinking / speaking / happy / alert / idle)经
/// [EmotionBallIds.fromMood] 映射为表情 ID 并自动切换;任务完成后桥会先发
/// happy 再自动回 idle,小球随之「完成 → 待机」。
///
/// [toolOverride] 用于本地已知的强状态(如工具调用中 → 检索资料),
/// 非空时优先于桥上 mood;[fallback] 用于桥上尚无 mood(挂载初期)时的兜底。
class MoodDrivenEmotionBall extends StatefulWidget {
  const MoodDrivenEmotionBall({
    super.key,
    this.fallback = EmotionBallIds.idle,
    this.toolOverride,
    this.size,
    this.bodyColor,
    this.eyeColor,
    this.eyeScale,
  });

  /// 桥上尚无 mood(或 mood 不可识别)时使用的表情。
  final String fallback;

  /// 本地强状态覆盖(优先级最高),变化时立即生效。
  final String? toolOverride;

  final double? size;
  final Color? bodyColor;
  final Color? eyeColor;
  final double? eyeScale;

  @override
  State<MoodDrivenEmotionBall> createState() => _MoodDrivenEmotionBallState();
}

class _MoodDrivenEmotionBallState extends State<MoodDrivenEmotionBall> {
  String? _moodFromBridge;

  @override
  void initState() {
    super.initState();
    AgentSphereMoodBridge.instance.addListener(_onPatch);
  }

  @override
  void dispose() {
    AgentSphereMoodBridge.instance.removeListener(_onPatch);
    super.dispose();
  }

  void _onPatch(AgentSpherePatch patch) {
    if (!mounted || patch.mood == _moodFromBridge) return;
    setState(() => _moodFromBridge = patch.mood);
  }

  String get _emotion =>
      widget.toolOverride ??
      EmotionBallIds.fromMood(_moodFromBridge) ??
      widget.fallback;

  @override
  Widget build(BuildContext context) {
    return EmotionBallView(
      emotion: _emotion,
      size: widget.size,
      bodyColor: widget.bodyColor,
      eyeColor: widget.eyeColor,
      eyeScale: widget.eyeScale,
    );
  }
}
