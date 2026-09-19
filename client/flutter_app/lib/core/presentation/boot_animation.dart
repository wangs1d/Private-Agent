import "dart:math" as math;
import "dart:ui" as ui;

import "package:flutter/material.dart";

const double _kIntroSec = 3.6; // 开场时长（加长版）
const double _kExitSec = 0.25; // 整层淡出进主界面

/// 启动开场动画：太阳光从右向左扫过 N，投影在底部由浅到深。
/// 与原型 nextbot-boot-v2.html 的 renderIntro 逐参数对齐
/// （intro 2400ms + 250ms 整层淡出进主界面）。
class BootAnimation extends StatefulWidget {
  const BootAnimation({super.key, this.onAnimationComplete});

  final VoidCallback? onAnimationComplete;

  @override
  State<BootAnimation> createState() => _BootAnimationState();
}

class _BootAnimationState extends State<BootAnimation>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: Duration(milliseconds: ((_kIntroSec + _kExitSec) * 1000).round()),
    )..forward();
    _controller.addStatusListener((AnimationStatus status) {
      if (status == AnimationStatus.completed) {
        widget.onAnimationComplete?.call();
      }
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (BuildContext context, _) {
        final double t = _controller.value * (_kIntroSec + _kExitSec);
        final double overlayOpacity = t < _kIntroSec
            ? 1.0
            : math.max(0.0, 1 - (t - _kIntroSec) / _kExitSec);
        // 用 LayoutBuilder 实测约束居中：不依赖 MediaQuery，
        // 无论挂在哪一层，N 的中心 = 实际可用区域的中心。
        return LayoutBuilder(
          builder: (BuildContext context, BoxConstraints constraints) {
            final Size size = constraints.biggest;
            return Opacity(
              opacity: overlayOpacity,
              child: CustomPaint(
                size: size,
                painter: _BootPainter(t: math.min(t, _kIntroSec)),
              ),
            );
          },
        );
      },
    );
  }
}

class _BootPainter extends CustomPainter {
  _BootPainter({required this.t});

  final double t; // 开场内秒数（≤3.6）

  static const Color _bg = Color(0xFF0A0A0A);

  static double _clamp(double v, double lo, double hi) =>
      v < lo ? lo : (v > hi ? hi : v);

  // N 三段笔画（与原型 M9 24 V8 L23 24 V8 一致）
  static Path _nPath() => Path()
    ..moveTo(9, 24)
    ..lineTo(9, 8)
    ..lineTo(23, 24)
    ..lineTo(23, 8);

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = _bg);

    final double s = math.min(math.min(size.height * 0.34, size.width * 0.25), 260.0);
    final double u = s / 32;
    final Offset c = Offset(size.width / 2, size.height / 2);

    final double vis = math.min(1.0, t / 1.1);
    final double tn = t / _kIntroSec;                               // 0..1
    final double p1 = _clamp((tn - 0.104) / 0.542, 0, 1);          // 光扫（占全长 54.2%）
    final double eL = 1 - math.pow(1 - p1, 3).toDouble();
    final double settle = _clamp((tn - 0.646) / 0.354, 0, 1);      // 收匀（占全长 35.4%）

    final Path path = _nPath();

    // 接触影：紧贴笔画的窄投影，不向背景晕开（背景保持绝对干净的纯黑）
    _paintShadow(canvas, path, c, u,
        tx: 1.2, ty: 1.6, skewDeg: 0, sy: 1.0,
        width: 2.8, sigma: 0.35, alpha: 0.30 + 0.12 * p1, vis: vis);

    // 主面：高光随光位（右→左）移动，settle 后收匀为亮白
    final double g = 26 - 34 * eL;
    final Paint face = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2.4
      ..shader = ui.Gradient.linear(
        Offset(g, 0),
        Offset(g + 32, 0),
        <ui.Color>[
          const ui.Color(0xFFFFFFFF),
          ui.Color.lerp(
              const ui.Color(0xFF8F8F8F), const ui.Color(0xFFFFFFFF), settle)!,
        ],
        <double>[0.0, 1 - 0.92 * settle],
      );
    canvas.save();
    canvas.translate(c.dx - 16 * u, c.dy - 16 * u);
    canvas.scale(u, u);
    canvas.drawPath(path, face);
    canvas.restore();

    // 高光扫掠：光前沿的亮段沿笔画行进，扫过即熄
    if (p1 > 0.05 && p1 < 0.98) {
      final double b = 1 - p1;
      final double a = math.max(0.0, b - 0.22);
      final ui.PathMetric metric = path.computeMetrics().first;
      final Path seg =
          metric.extractPath(a * metric.length, b * metric.length);
      canvas.save();
      canvas.translate(c.dx - 16 * u, c.dy - 16 * u);
      canvas.scale(u, u);
      canvas.drawPath(
          seg,
          Paint()
            ..style = PaintingStyle.stroke
            ..strokeWidth = 2.8
            ..color = const Color(0xFFFFFFFF)
                .withValues(alpha: 0.9 * math.sin(math.pi * p1))
            ..maskFilter =
                MaskFilter.blur(BlurStyle.normal, (1.1 * 1.33 * u).clamp(0.0, 30)));
      canvas.restore();
    }
  }

  void _paintShadow(
    Canvas canvas,
    Path path,
    Offset c,
    double u, {
    required double tx,
    required double ty,
    required double skewDeg,
    required double sy,
    required double width,
    required double sigma,
    required double alpha,
    required double vis,
  }) {
    final double a = alpha * vis;
    if (a <= 0.004) return;
    canvas.save();
    canvas.translate(c.dx - 16 * u, c.dy - 16 * u);   // 盒子中心对准绘制中心
    canvas.scale(u, u);
    canvas.translate(tx, ty);        // 影子随光右→左滑
    canvas.skew(skewDeg * math.pi / 180, 0);
    canvas.scale(1, sy);
    canvas.drawPath(
        path,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = width
          ..color = const Color(0xFF000000).withValues(alpha: a)
          ..maskFilter = MaskFilter.blur(BlurStyle.normal, sigma * u));
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _BootPainter oldDelegate) => oldDelegate.t != t;
}
