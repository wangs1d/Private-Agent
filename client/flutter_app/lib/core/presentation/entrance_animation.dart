import "dart:math" as math;

import "package:flutter/material.dart";

class EntranceAnimation extends StatefulWidget {
  final VoidCallback? onAnimationComplete;

  const EntranceAnimation({super.key, this.onAnimationComplete});

  @override
  State<EntranceAnimation> createState() => _EntranceAnimationState();
}

class _EntranceAnimationState extends State<EntranceAnimation>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  late final Animation<double> _overlayOpacity;
  late final Animation<double> _titleReveal;
  late final Animation<double> _titleOpacity;
  late final Animation<double> _titleGlow;
  late final Animation<double> _scanProgress;
  late final Animation<double> _scanOpacity;
  late final Animation<double> _scanWidth;
  late final Animation<double> _particleOpacity;
  late final Animation<double> _subtitleOpacity;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      duration: const Duration(milliseconds: 4200),
      vsync: this,
    );

    _overlayOpacity = TweenSequence<double>(<TweenSequenceItem<double>>[
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 1.0, end: 1.0),
        weight: 72,
      ),
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 1.0, end: 0.0),
        weight: 28,
      ),
    ]).animate(
      CurvedAnimation(parent: _controller, curve: Curves.easeInOutCubic),
    );

    _titleReveal = Tween<double>(begin: 0.0, end: 1.0).animate(
      CurvedAnimation(
        parent: _controller,
        curve: const Interval(0.14, 0.48, curve: Curves.easeOutExpo),
      ),
    );

    _titleOpacity = TweenSequence<double>(<TweenSequenceItem<double>>[
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 0.0, end: 0.0),
        weight: 18,
      ),
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 0.0, end: 1.0),
        weight: 24,
      ),
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 1.0, end: 1.0),
        weight: 58,
      ),
    ]).animate(
      CurvedAnimation(parent: _controller, curve: Curves.easeOutCubic),
    );

    _titleGlow = TweenSequence<double>(<TweenSequenceItem<double>>[
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 0.0, end: 0.42),
        weight: 28,
      ),
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 0.42, end: 1.0),
        weight: 24,
      ),
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 1.0, end: 0.45),
        weight: 48,
      ),
    ]).animate(
      CurvedAnimation(
        parent: _controller,
        curve: const Interval(0.16, 0.9, curve: Curves.easeOutCubic),
      ),
    );

    _scanProgress = Tween<double>(begin: -0.9, end: 0.9).animate(
      CurvedAnimation(
        parent: _controller,
        curve: const Interval(0.34, 0.74, curve: Curves.easeInOutCubic),
      ),
    );

    _scanOpacity = TweenSequence<double>(<TweenSequenceItem<double>>[
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 0.0, end: 0.0),
        weight: 28,
      ),
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 0.0, end: 1.0),
        weight: 18,
      ),
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 1.0, end: 0.0),
        weight: 54,
      ),
    ]).animate(
      CurvedAnimation(parent: _controller, curve: Curves.easeOutCubic),
    );

    _scanWidth = Tween<double>(begin: 18, end: 72).animate(
      CurvedAnimation(
        parent: _controller,
        curve: const Interval(0.34, 0.74, curve: Curves.easeInOutCubic),
      ),
    );

    _particleOpacity = Tween<double>(begin: 0.0, end: 1.0).animate(
      CurvedAnimation(
        parent: _controller,
        curve: const Interval(0.18, 0.74, curve: Curves.easeOut),
      ),
    );

    _subtitleOpacity = Tween<double>(begin: 0.0, end: 1.0).animate(
      CurvedAnimation(
        parent: _controller,
        curve: const Interval(0.34, 0.7, curve: Curves.easeOutCubic),
      ),
    );

    _controller.forward().whenComplete(() {
      widget.onAnimationComplete?.call();
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
      builder: (BuildContext context, Widget? child) {
        return Opacity(
          opacity: _overlayOpacity.value,
          child: DecoratedBox(
            decoration: const BoxDecoration(color: Colors.black),
            child: Stack(
              fit: StackFit.expand,
              children: <Widget>[
                const _BackgroundVignette(),
                _buildDustField(),
                _buildCenterComposition(context),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _buildDustField() {
    return IgnorePointer(
      child: CustomPaint(
        painter: _ParticlePainter(
          progress: _controller.value,
          opacity: _particleOpacity.value,
        ),
      ),
    );
  }

  Widget _buildCenterComposition(BuildContext context) {
    final Size size = MediaQuery.sizeOf(context);
    final double titleScale = 0.82 + (_titleReveal.value * 0.18);
    final double titleYOffset = (1 - _titleReveal.value) * 44;

    return Center(
      child: Transform.translate(
        offset: Offset(0, titleYOffset),
        child: Transform.scale(
          scale: titleScale,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              SizedBox(
                width: math.min(size.width * 0.88, 1080),
                child: Stack(
                  alignment: Alignment.center,
                  children: <Widget>[
                    _buildTitleShadow(),
                    _buildTitleFillWithScan(),
                  ],
                ),
              ),
              const SizedBox(height: 22),
              Opacity(
                opacity: _subtitleOpacity.value,
                child: Text(
                  "SYSTEM ONLINE",
                  style: TextStyle(
                    color: const Color(0xFFE8EEF8).withValues(alpha: 0.62),
                    fontSize: 11,
                    letterSpacing: 6.4,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildTitleShadow() {
    return Opacity(
      opacity: _titleOpacity.value,
      child: Transform(
        alignment: Alignment.center,
        transform: Matrix4.identity()..setEntry(0, 1, -0.08),
        child: Text(
          "NEXTBOT",
          textAlign: TextAlign.center,
          style: TextStyle(
            fontSize: 92,
            fontWeight: FontWeight.w800,
            letterSpacing: 7.5,
            height: 1,
            color: const Color(0xFFCBE6FF).withValues(
              alpha: 0.08 + (_titleGlow.value * 0.18),
            ),
            shadows: <Shadow>[
              Shadow(
                color: const Color(0xFFD7EEFF).withValues(
                  alpha: 0.18 * _titleGlow.value,
                ),
                blurRadius: 32,
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildTitleTextBase({required double glow}) {
    return Text(
      "NEXTBOT",
      textAlign: TextAlign.center,
      style: TextStyle(
        fontSize: 92,
        fontWeight: FontWeight.w800,
        letterSpacing: 7.5,
        height: 1,
        color: Colors.white,
        shadows: <Shadow>[
          Shadow(
            color: const Color(0xFFFFFFFF).withValues(alpha: 0.08 * glow),
            blurRadius: 12,
          ),
          Shadow(
            color: const Color(0xFFB3D9FF).withValues(alpha: 0.16 * glow),
            blurRadius: 58,
          ),
        ],
      ),
    );
  }

  Widget _buildTitleFillWithScan() {
    final double glow = _titleGlow.value;
    return Opacity(
      opacity: _titleOpacity.value,
      child: Transform(
        alignment: Alignment.center,
        transform: Matrix4.identity()..setEntry(0, 1, -0.08),
        child: Stack(
          alignment: Alignment.center,
          children: <Widget>[
            ShaderMask(
              blendMode: BlendMode.srcIn,
              shaderCallback: (Rect bounds) {
                return const LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: <Color>[
                    Color(0xFFFDFEFF),
                    Color(0xFFD8E1EC),
                    Color(0xFF6B7380),
                  ],
                  stops: <double>[0.0, 0.38, 1.0],
                ).createShader(bounds);
              },
              child: _buildTitleTextBase(glow: glow),
            ),
            ShaderMask(
              blendMode: BlendMode.srcIn,
              shaderCallback: (Rect bounds) {
                final double sweepCenter =
                    ((bounds.width * (_scanProgress.value + 1)) / 2)
                        .clamp(0.0, bounds.width);
                final double sweepHalf = _scanWidth.value / 2;
                final double start =
                    ((sweepCenter - sweepHalf) / bounds.width).clamp(0.0, 1.0);
                final double end =
                    ((sweepCenter + sweepHalf) / bounds.width).clamp(0.0, 1.0);
                final double innerStart =
                    (start + ((end - start) * 0.35)).clamp(0.0, 1.0);
                final double innerEnd =
                    (start + ((end - start) * 0.65)).clamp(0.0, 1.0);
                return LinearGradient(
                  begin: Alignment.centerLeft,
                  end: Alignment.centerRight,
                  colors: <Color>[
                    Colors.transparent,
                    const Color(0x80FFFFFF).withValues(alpha: 0.28 * _scanOpacity.value),
                    const Color(0xFFFFFFFF).withValues(alpha: 0.92 * _scanOpacity.value),
                    const Color(0x99D9EEFF).withValues(alpha: 0.60 * _scanOpacity.value),
                    Colors.transparent,
                  ],
                  stops: <double>[start, innerStart, (start + end) / 2, innerEnd, end],
                ).createShader(bounds);
              },
              child: _buildTitleTextBase(glow: glow + (_scanOpacity.value * 0.35)),
            ),
          ],
        ),
      ),
    );
  }
}

class _BackgroundVignette extends StatelessWidget {
  const _BackgroundVignette();

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(color: Colors.black),
      child: CustomPaint(
        painter: _HorizonPainter(),
      ),
    );
  }
}

class _HorizonPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {}

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

class _ParticlePainter extends CustomPainter {
  final double progress;
  final double opacity;

  const _ParticlePainter({
    required this.progress,
    required this.opacity,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final Paint paint = Paint()..style = PaintingStyle.fill;
    final double drift = progress * 26;

    for (int i = 0; i < 18; i += 1) {
      final double seed = i / 18;
      final double x = size.width * (0.12 + (seed * 0.76));
      final double baseY = size.height * (0.28 + ((i % 6) * 0.08));
      final double y = baseY + math.sin((progress * 6) + i) * 10 - drift * 0.2;
      final double radius = 0.9 + ((i % 4) * 0.55);
      final double alpha = opacity * (0.08 + ((i % 5) * 0.03));
      paint.color = const Color(0xFFF3FAFF).withValues(alpha: alpha);
      canvas.drawCircle(Offset(x, y), radius, paint);
    }
  }

  @override
  bool shouldRepaint(covariant _ParticlePainter oldDelegate) {
    return oldDelegate.progress != progress || oldDelegate.opacity != opacity;
  }
}
