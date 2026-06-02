import "package:flutter/material.dart";

/// 桌面应用进场动画
/// 
/// 动画流程：
/// 1. 全黑屏幕
/// 2. 中心出现微弱白光点
/// 3. 光点扩散成光晕
/// 4. 光晕继续扩散并淡出
/// 5. 完全显示应用内容
class EntranceAnimation extends StatefulWidget {
  final VoidCallback? onAnimationComplete;
  
  const EntranceAnimation({super.key, this.onAnimationComplete});

  @override
  State<EntranceAnimation> createState() => _EntranceAnimationState();
}

class _EntranceAnimationState extends State<EntranceAnimation>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _blackFade;
  late Animation<double> _lightOpacity;
  late Animation<double> _lightSize;
  late Animation<double> _haloOpacity;
  late Animation<double> _haloSize;

  @override
  void initState() {
    super.initState();

    _controller = AnimationController(
      duration: const Duration(milliseconds: 3000),
      vsync: this,
    );

    // 黑屏淡出：前60%保持，然后逐渐消失
    _blackFade = Tween<double>(
      begin: 1.0,
      end: 0.0,
    ).animate(CurvedAnimation(
      parent: _controller,
      curve: const Interval(0.0, 0.7, curve: Curves.easeInOut),
    ));

    // 白光点：从暗到亮再到消失
    _lightOpacity = TweenSequence<double>(<TweenSequenceItem<double>>[
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 0.0, end: 0.0),
        weight: 10,
      ),
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 0.0, end: 1.0),
        weight: 10,
      ),
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 1.0, end: 0.7),
        weight: 30,
      ),
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 0.7, end: 0.0),
        weight: 50,
      ),
    ]).animate(CurvedAnimation(
      parent: _controller,
      curve: Curves.easeInOut,
    ));

    // 光点大小变化
    _lightSize = TweenSequence<double>(<TweenSequenceItem<double>>[
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 2.0, end: 2.0),
        weight: 10,
      ),
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 2.0, end: 4.0),
        weight: 10,
      ),
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 4.0, end: 6.0),
        weight: 20,
      ),
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 6.0, end: 10.0),
        weight: 20,
      ),
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 10.0, end: 16.0),
        weight: 40,
      ),
    ]).animate(CurvedAnimation(
      parent: _controller,
      curve: Curves.easeInOut,
    ));

    // 光晕透明度
    _haloOpacity = TweenSequence<double>(<TweenSequenceItem<double>>[
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 0.0, end: 0.0),
        weight: 15,
      ),
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 0.0, end: 1.0),
        weight: 10,
      ),
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 1.0, end: 0.6),
        weight: 35,
      ),
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 0.6, end: 0.0),
        weight: 40,
      ),
    ]).animate(CurvedAnimation(
      parent: _controller,
      curve: Curves.easeInOut,
    ));

    // 光晕大小变化
    _haloSize = TweenSequence<double>(<TweenSequenceItem<double>>[
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 4.0, end: 4.0),
        weight: 15,
      ),
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 4.0, end: 8.0),
        weight: 10,
      ),
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 8.0, end: 40.0),
        weight: 25,
      ),
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 40.0, end: 120.0),
        weight: 20,
      ),
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 120.0, end: 200.0),
        weight: 30,
      ),
    ]).animate(CurvedAnimation(
      parent: _controller,
      curve: Curves.easeInOut,
    ));

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
        return Stack(
          fit: StackFit.expand,
          children: <Widget>[
            // 黑屏层
            FadeTransition(
              opacity: _blackFade,
              child: Container(
                color: Colors.black,
              ),
            ),
            // 中心光点
            Center(
              child: Opacity(
                opacity: _lightOpacity.value,
                child: Container(
                  width: _lightSize.value,
                  height: _lightSize.value,
                  decoration: BoxDecoration(
                    color: Colors.white,
                    shape: BoxShape.circle,
                    boxShadow: <BoxShadow>[
                      BoxShadow(
                        color: Colors.white.withValues(alpha: 0.8),
                        blurRadius: 10,
                        spreadRadius: 2,
                      ),
                    ],
                  ),
                ),
              ),
            ),
            // 外围光晕
            Center(
              child: Opacity(
                opacity: _haloOpacity.value,
                child: Container(
                  width: _haloSize.value,
                  height: _haloSize.value,
                  decoration: BoxDecoration(
                    color: Colors.white.withValues(alpha: 0.5),
                    shape: BoxShape.circle,
                    boxShadow: <BoxShadow>[
                      BoxShadow(
                        color: Colors.white.withValues(alpha: 0.3),
                        blurRadius: 20,
                        spreadRadius: 5,
                      ),
                      BoxShadow(
                        color: Colors.white.withValues(alpha: 0.1),
                        blurRadius: 60,
                        spreadRadius: 10,
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        );
      },
    );
  }
}
