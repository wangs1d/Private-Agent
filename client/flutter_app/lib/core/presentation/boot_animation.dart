import "dart:math" as math;
import "dart:ui" as ui;

import "package:flutter/material.dart";

/// 开场时长。原型为 2.4s；应用内按用户要求放慢为 3.6s，
/// 各阶段占比与原型完全一致（光扫 54.2%、收匀 35.4%）。
const double _kIntroSec = 3.6;

/// N 淡出时长（原型 markWrap 的 CSS transition opacity 1.1s）。
const double _kExitSec = 1.1;

/// 启动开场动画：太阳光从右向左扫过 N，光照投影随光移动、由浅到深，
/// 高光段沿笔画行进，落定后受光面收匀为亮白，整层淡出进主界面。
/// 与原型 nextbot-boot-v2.html 的 renderIntro / SVG 结构逐参数对齐。
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
      duration:
          Duration(milliseconds: ((_kIntroSec + _kExitSec) * 1000).round()),
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
        // LayoutBuilder 实测约束：N 的中心 = 实际可用区域中心。
        return LayoutBuilder(
          builder: (BuildContext context, BoxConstraints constraints) {
            return Opacity(
              opacity: overlayOpacity,
              child: CustomPaint(
                size: constraints.biggest,
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

  final double t; // 开场内秒数（≤ _kIntroSec）

  static const Color _bg = Color(0xFF161616); // 纯色干净背景；提亮一档让黑色投影可读

  static double _clamp(double v, double lo, double hi) =>
      v < lo ? lo : (v > hi ? hi : v);

  /// 原型签名缓动 cubic-bezier(.22,1,.36,1)（markWrap 淡入/缩放）。
  static double _cssEase(double x) {
    const double x1 = 0.22, y1 = 1.0, x2 = 0.36, y2 = 1.0;
    double bez(double u, double a, double b) =>
        (1 - 3 * b + 3 * a) * u * u * u + (3 * b - 6 * a) * u * u + 3 * a * u;
    double lo = 0, hi = 1;
    for (int i = 0; i < 24; i++) {
      final double mid = (lo + hi) / 2;
      if (bez(mid, x1, x2) < x) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return bez((lo + hi) / 2, y1, y2);
  }

  // N 字标轮廓（自 nextbot-icon-monogram.png 矢量描摹，32 单位盒，高 16 单位）。
  // 字标由两件互扣的圆头笔画组成（左竖+上斜笔、右竖+下斜笔），斜笔中段留一道
  // 折叠暗缝；格式为 [点数, x0,y0, x1,y1, ...] 逐轮廓拼接。
  static const List<double> _kNOutline = <double>[
    50, 22.35, 8.03, 21.85, 8, 21.47, 8.01, 21.33, 8.04, 21.1, 8.14, 20.91, 8.26, 20.67, 8.51, 20.53, 8.79, 20.47, 9.06, 20.45, 20.99, 20.41, 21.14, 20.32, 21.27, 20.16, 21.35, 19.97, 21.35, 19.83, 21.29, 19.72, 21.21, 14.57, 15.85, 14.31, 15.65, 14.04, 15.53, 13.71, 15.47, 13.39, 15.5, 13.17, 15.57, 12.9, 15.73, 12.72, 15.91, 12.56, 16.18, 12.48, 16.47, 12.47, 16.76, 12.53, 17.12, 12.64, 17.37, 12.87, 17.69, 13.66, 18.49, 18.56, 23.63, 18.79, 23.81, 19.02, 23.92, 19.34, 23.99, 22.23, 23.99, 22.38, 23.96, 22.67, 23.85, 22.82, 23.76, 22.97, 23.62, 23.09, 23.47, 23.21, 23.24, 23.3, 22.94, 23.32, 22.73, 23.32, 9.18, 23.23, 8.77, 23.17, 8.65, 23.03, 8.43, 22.75, 8.19, 22.55, 8.08,
    43, 11.37, 8, 9.8, 8, 9.57, 8.04, 9.37, 8.12, 9.14, 8.27, 8.87, 8.57, 8.76, 8.79, 8.66, 9.16, 8.66, 22.8, 8.77, 23.26, 8.85, 23.42, 9, 23.62, 9.12, 23.74, 9.3, 23.86, 9.45, 23.93, 9.69, 23.99, 10.54, 23.99, 10.8, 23.92, 11.01, 23.81, 11.21, 23.62, 11.32, 23.47, 11.42, 23.26, 11.52, 22.88, 11.55, 11.13, 17.34, 17.23, 17.68, 17.56, 17.9, 17.68, 18.21, 17.77, 18.59, 17.77, 18.87, 17.69, 19.01, 17.62, 19.18, 17.49, 19.37, 17.27, 19.51, 17, 19.57, 16.7, 19.57, 16.45, 19.52, 16.15, 19.4, 15.86, 19.25, 15.66, 12.58, 8.53, 12.32, 8.31, 12.09, 8.18, 11.68, 8.04,
  ];

  /// 高光骨架：沿笔画行进（右上帽心→右竖底→折入下斜笔→跨暗缝接上斜笔→
  /// 顶部折弯→左竖→左下帽心），行走方向与原型一致（右上入、左下出）。
  static const List<double> _kNSpine = <double>[
    21.89, 9.54, 21.89, 22.2, 20.14, 21.69, 17.76, 20.98, 16.46, 19.63, 15.16, 18.27, 14.35, 16.76, 17.88, 16.11, 16.95, 15.03, 13.89, 11.78, 11.87, 9.61, 10.52, 8.28, 10.1, 9.61, 10.1, 22.55,
  ];

  static final Path _markPath = _buildOutline(_kNOutline);
  static final Path _spinePath = _buildPolyline(_kNSpine);

  static Path _buildOutline(List<double> data) {
    final Path path = Path();
    int i = 0;
    while (i < data.length) {
      final int n = data[i++].round();
      if (n < 1 || i + n * 2 > data.length) break;
      path.moveTo(data[i], data[i + 1]);
      i += 2;
      for (int j = 1; j < n; j++) {
        path.lineTo(data[i], data[i + 1]);
        i += 2;
      }
      path.close();
    }
    return path;
  }

  static Path _buildPolyline(List<double> data) {
    final Path path = Path()..moveTo(data[0], data[1]);
    for (int i = 2; i + 1 < data.length; i += 2) {
      path.lineTo(data[i], data[i + 1]);
    }
    return path;
  }

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = _bg);

    // 原型 #markWrap 尺寸：min(30vh, 200px)
    final double s = math.min(size.height * 0.30, 200.0);
    final double u = s / 32;
    final Offset c = Offset(size.width / 2, size.height / 2);

    // 原型时间轴（2.4s 基准 → 按总时长等比换算）
    final double tn = t / _kIntroSec;
    final double p1 = _clamp((tn - 0.104) / 0.542, 0, 1); // 光扫
    final double eL = 1 - math.pow(1 - p1, 3).toDouble(); // easeOutCubic
    final double settle = _clamp((tn - 0.646) / 0.354, 0, 1); // 收匀

    // markWrap 淡入（1.1s 签名缓动）+ 缩放 0.97→1
    final double fadeIn = _cssEase(_clamp(t / 1.1, 0, 1));
    final double markScale = 0.97 + 0.03 * fadeIn;

    final Path path = _markPath;

    canvas.save();
    canvas.translate(c.dx, c.dy);
    canvas.scale(u * markScale);
    canvas.translate(-16, -16); // 盒子中心 (16,16) 对准绘制中心

    /* 立体感全部由 N 主面的明暗渐变承担：受光面亮、背光面深，
       背景保持绝对干净的纯色，不放任何投影元素。 */

    // 主面（原型 pFace：白→灰渐变，高光位随光右→左，落定后收匀为亮白）
    final double g = 26 - 34 * eL;
    final Paint face = Paint()
      ..style = PaintingStyle.fill
      ..shader = ui.Gradient.linear(
        Offset(g, 0),
        Offset(g + 32, 0),
        <ui.Color>[
          const ui.Color(0xFFFFFFFF),
          ui.Color.lerp(const ui.Color(0xFF8F8F8F),
              const ui.Color(0xFFFFFFFF), settle)!,
        ],
        <double>[0.0, 1 - 0.92 * settle],
      );
    final double faceAlpha = math.min(1.0, 0.22 + t / 0.8) * fadeIn;
    if (faceAlpha > 0.004) {
      canvas.drawPath(path, face..color = Colors.white.withValues(alpha: faceAlpha));
    }

    // 高光扫掠（原型 pSpec：亮段沿笔画行进、扫过即熄；骨架裁剪进字标，
    // 暗缝处自然断开，模拟光掠过折叠笔画）
    final double specAlpha = 0.78 * math.sin(math.pi * p1) * fadeIn;
    if (p1 > 0.05 && p1 < 0.98 && specAlpha > 0.004) {
      final double b = 1 - p1;
      final double a = math.max(0.0, b - 0.22);
      final ui.PathMetric metric = _spinePath.computeMetrics().first;
      final Path seg = metric.extractPath(a * metric.length, b * metric.length);
      canvas.save();
      canvas.clipPath(path);
      canvas.drawPath(
          seg,
          Paint()
            ..style = PaintingStyle.stroke
            ..strokeWidth = 2.5
            ..strokeCap = StrokeCap.round
            ..color = const ui.Color(0xFFFFFFFF).withValues(alpha: specAlpha)
            ..maskFilter = MaskFilter.blur(BlurStyle.normal, 0.4 * u));
      canvas.restore();
    }

    canvas.restore();
  }


  @override
  bool shouldRepaint(covariant _BootPainter oldDelegate) => oldDelegate.t != t;
}
