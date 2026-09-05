import "package:flutter/material.dart";

/// EmotionBallView 非 Windows / Web 平台占位实现。
///
/// Windows 真实实现见 [emotion_ball_view_io.dart](emotion_ball_view_io.dart)。
/// 占位保持尺寸但完全透明(避免出现多余的杂色图形)。
class EmotionBallView extends StatelessWidget {
  const EmotionBallView({
    super.key,
    this.emotion = "02",
    this.size,
    this.bodyColor,
    this.eyeColor,
    this.showEffects = false,
    this.eyeScale,
  });

  /// 当前表情 ID(emotion-ball 的 emotionId,如 "02" 待机放空 / "30" 思考中)。
  final String emotion;

  /// 小球显示尺寸(正方形边长),null 时撑满父级约束。
  final double? size;

  /// 球体主题色(传入后眼球默认白色);null 时使用 emotion-ball 默认配色。
  final Color? bodyColor;
  final Color? eyeColor;

  /// 彩带/撒花/zzz 等特效层开关(占位实现不渲染任何内容)。
  final bool showEffects;

  /// 眼睛占比放大系数(占位实现忽略)。
  final double? eyeScale;

  @override
  Widget build(BuildContext context) {
    return SizedBox(width: size, height: size);
  }
}
