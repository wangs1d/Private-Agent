import "dart:math" as math;

import "package:flutter/material.dart";

String agentAvatarAssetPath(String? preset) {
  switch (preset) {
    case "ember":
      return "assets/agent_avatars/ember.png";
    case "tide":
      return "assets/agent_avatars/tide.png";
    case "eclipse":
      return "assets/agent_avatars/eclipse.png";
    case "neon":
      return "assets/agent_avatars/neon.png";
    case "mist":
      return "assets/agent_avatars/mist.png";
    case "dawn":
    default:
      return "assets/agent_avatars/dawn.png";
  }
}

class AgentAvatarPalette {
  const AgentAvatarPalette(this.colors);

  final List<Color> colors;

  static AgentAvatarPalette fromPreset(String? preset) {
    switch (preset) {
      case "ember":
        return const AgentAvatarPalette(<Color>[
          Color(0xFFFFA24B),
          Color(0xFFFF5A36),
          Color(0xFFC12A2A),
        ]);
      case "tide":
        return const AgentAvatarPalette(<Color>[
          Color(0xFF62D6FF),
          Color(0xFF118AB2),
          Color(0xFF124E78),
        ]);
      case "eclipse":
        return const AgentAvatarPalette(<Color>[
          Color(0xFF8C7DFF),
          Color(0xFF473BF0),
          Color(0xFF171738),
        ]);
      case "neon":
        return const AgentAvatarPalette(<Color>[
          Color(0xFFB8FF52),
          Color(0xFF00C853),
          Color(0xFF00796B),
        ]);
      case "mist":
        return const AgentAvatarPalette(<Color>[
          Color(0xFFB0BEC5),
          Color(0xFF78909C),
          Color(0xFF455A64),
        ]);
      case "dawn":
      default:
        return const AgentAvatarPalette(<Color>[
          Color(0xFF3DA4FF),
          Color(0xFF0D6EFD),
          Color(0xFF123A9E),
        ]);
    }
  }
}

/// Agent 头像的统一渲染：程序化绘制的「轨道光球」。
///
/// 取代旧的卡通形象 PNG——球体配色跟随 [AgentAvatarPalette] 的 preset，
/// 与桌面悬浮球形 Agent 的产品意象一致；所有尺寸（聊天 36px / 主页 92px）
/// 共用同一实现，纯矢量绘制，不依赖图片资源。
///
/// 视觉结构（自底向上）：
/// 1. 环境光晕（preset 主色的柔光）
/// 2. 轨道环的后半段（从球体后方绕过）
/// 3. 球体本体（左上高光的三段径向渐变）
/// 4. 左上镜面高光
/// 5. 轨道环的前半段（压在球体前面，形成 3D 环绕感）
class AgentOrbAvatar extends StatelessWidget {
  const AgentOrbAvatar({super.key, required this.size, this.palette});

  final double size;
  final AgentAvatarPalette? palette;

  @override
  Widget build(BuildContext context) {
    final AgentAvatarPalette colors =
        palette ?? AgentAvatarPalette.fromPreset(null);
    return CustomPaint(
      size: Size.square(size),
      painter: _AgentOrbPainter(palette: colors),
    );
  }
}

class _AgentOrbPainter extends CustomPainter {
  const _AgentOrbPainter({required this.palette});

  final AgentAvatarPalette palette;

  @override
  void paint(Canvas canvas, Size size) {
    final double s = size.shortestSide;
    final Offset center = Offset(size.width / 2, size.height / 2);
    final double sphereR = s * 0.44;

    // 1. 环境光晕
    final Paint glowPaint = Paint()
      ..color = palette.colors.first.withValues(alpha: 0.30)
      ..maskFilter = MaskFilter.blur(BlurStyle.normal, s * 0.09);
    canvas.drawCircle(center, sphereR * 1.02, glowPaint);

    // 2. 轨道环后半段（上半弧，绕到球体后面）
    final Paint ringPaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = math.max(1.2, s * 0.045)
      ..strokeCap = StrokeCap.round
      ..color = Colors.white.withValues(alpha: 0.38);
    final Rect ringRect = Rect.fromCenter(
      center: center,
      width: s * 0.94,
      height: s * 0.28,
    );
    final Path backRing = Path()
      ..addArc(ringRect, math.pi, math.pi);
    canvas.save();
    canvas.translate(center.dx, center.dy);
    canvas.rotate(-0.38);
    canvas.translate(-center.dx, -center.dy);
    canvas.drawPath(backRing, ringPaint);
    canvas.restore();

    // 3. 球体本体：左上方为光源的三段径向渐变
    final Paint spherePaint = Paint()
      ..shader = RadialGradient(
        center: const Alignment(-0.35, -0.4),
        radius: 1.1,
        colors: palette.colors,
        stops: const <double>[0.0, 0.55, 1.0],
      ).createShader(Rect.fromCircle(center: center, radius: sphereR));
    canvas.drawCircle(center, sphereR, spherePaint);

    // 4. 左上镜面高光（柔和白雾）
    final Offset glossCenter = center +
        Offset(-sphereR * 0.38, -sphereR * 0.42);
    final Paint glossPaint = Paint()
      ..color = Colors.white.withValues(alpha: 0.55)
      ..maskFilter = MaskFilter.blur(BlurStyle.normal, sphereR * 0.22);
    canvas.drawCircle(glossCenter, sphereR * 0.30, glossPaint);

    // 5. 轨道环前半段（下半弧，压在球体前）
    final Paint frontRingPaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = math.max(1.2, s * 0.05)
      ..strokeCap = StrokeCap.round
      ..color = Colors.white.withValues(alpha: 0.78);
    final Path frontRing = Path()
      ..addArc(ringRect, 0, math.pi);
    canvas.save();
    canvas.translate(center.dx, center.dy);
    canvas.rotate(-0.38);
    canvas.translate(-center.dx, -center.dy);
    canvas.drawPath(frontRing, frontRingPaint);
    canvas.restore();

    // 球体边缘发丝描边，增强与背景的分离度
    canvas.drawCircle(
      center,
      sphereR,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1
        ..color = Colors.white.withValues(alpha: 0.25),
    );
  }

  @override
  bool shouldRepaint(covariant _AgentOrbPainter oldDelegate) =>
      oldDelegate.palette != palette;
}
