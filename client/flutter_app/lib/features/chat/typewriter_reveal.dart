import "dart:async";

import "package:flutter/foundation.dart";

/// 打字机式流式显示控制器(桌面端与手机端共用)。
///
/// 后端 chunk 可能整段/大块到达,这里在渲染层把「已 reveal」的原文前缀
/// 逐字放大,模拟真人打字;历史消息与用户消息直接显示全文。
/// 节奏自适应(模拟真人语速):短句打得快、长句放慢,句末按本句长度
/// 停顿再进下一句。
///
/// 用法:监听 [addListener] 重建,把 [revealed] 作为「已显示前缀」
/// 传给消息渲染器,[isRevealing] && [cursorOn] 时渲染闪烁光标。
class TypewriterReveal extends ChangeNotifier {
  /// [animate] 为 true 时从零开始逐字 reveal(流式新消息,
  /// 覆盖整段一次性到达的场景);否则直接显示全文(历史消息)。
  TypewriterReveal(String initialTarget, {required bool animate})
      : _target = initialTarget {
    if (animate && initialTarget.isNotEmpty) {
      _revealed = "";
      _sentenceChars = 0;
      _scheduleTypeTick(_stepNormal);
    } else {
      _revealed = initialTarget;
    }
  }

  // ===== 打字节奏 =====
  static const int _charsPerTick = 1;
  static const Duration _cursorBlink = Duration(milliseconds: 480);
  // 逐字步进间隔:短句(剩余≤12字)15ms 快打、中句(13-30字)20ms、长句(>30字)28ms 放慢
  static const Duration _stepFast = Duration(milliseconds: 15);
  static const Duration _stepNormal = Duration(milliseconds: 20);
  static const Duration _stepSlow = Duration(milliseconds: 28);
  // 句末停顿:本句越短停顿越短(260/380/500ms),长句收尾后多歇一会,像真人换气
  static const Duration _pauseShort = Duration(milliseconds: 260);
  static const Duration _pauseMid = Duration(milliseconds: 380);
  static const Duration _pauseLong = Duration(milliseconds: 500);
  // 句边界标点:命中并在其后还有内容时,进入句末停顿
  static final RegExp _sentenceEnd = RegExp(r'[。！？!?；;\n]');

  String _target;
  String _revealed = "";

  /// 当前句已 reveal 的字符数,用于句末自适应停顿(遇句边界后清零)。
  int _sentenceChars = 0;
  Timer? _typeTimer;
  Timer? _cursorTimer;
  bool _cursorOn = false;

  /// 完整目标文本。
  String get target => _target;

  /// 原始文本(未 strip)的已显示前缀。
  String get revealed => _revealed;

  /// 是否尚未显示完全部内容(打字中)。
  bool get isPartial => _revealed.length < _target.length;

  /// 打字机进行中(在打字,或光标仍在闪烁)。
  bool get active => _typeTimer != null || _cursorTimer != null;

  /// 是否正在逐字打字(typeTimer 存活)。
  bool get isRevealing => _typeTimer != null;

  /// 光标当前亮/灭状态(打字时以 480ms 周期闪烁)。
  bool get cursorOn => _cursorOn;

  /// 目标文本更新(流式追加 / 内容替换)。
  ///
  /// - 前缀延伸 = 流式追加:继续逐字 reveal;
  /// - 内容被替换(如删除重发):直接显示全文。
  void updateTarget(String target) {
    _target = target;
    if (target.startsWith(_revealed)) {
      if (_revealed.length < target.length && _typeTimer == null) {
        _sentenceChars = _countRevealedOfCurrentSentence(target);
        _scheduleTypeTick(_stepForTarget(target));
      }
    } else {
      showAll();
    }
  }

  /// 立即显示全部内容并停止打字(用户消息 / 历史消息 / 内容被替换)。
  void showAll() {
    _revealed = _target;
    _stopTypeTimers();
    notifyListeners();
  }

  /// 用一次性 Timer 排定下一次 tick(替代固定周期 periodic,实现逐字变速 + 句末停顿)。
  void _scheduleTypeTick(Duration delay) {
    _typeTimer?.cancel();
    _typeTimer = Timer(delay, _typeTick);
  }

  /// 逐字步进 + 按句长变速 + 句末停顿,并自我重排下一个 tick。
  void _typeTick() {
    _typeTimer = null;
    if (_revealed.length >= _target.length) {
      _stopTypeTimers();
      notifyListeners();
      return;
    }
    int end = _revealed.length + _charsPerTick;
    if (end > _target.length) end = _target.length;
    final int added = end - _revealed.length;
    _revealed = _target.substring(0, end);
    _sentenceChars += added;
    _cursorTimer ??= Timer.periodic(_cursorBlink, (_) {
      _cursorOn = !_cursorOn;
      notifyListeners();
    });
    notifyListeners();

    if (_revealed.length >= _target.length) {
      _stopTypeTimers();
      notifyListeners();
      return;
    }
    // 打标点/换行收尾且后面还有内容 → 句末停顿(按本句长度成比例),否则按灵敏度续打。
    if (_endedSentence) {
      _scheduleTypeTick(_pauseForCurrentSentence());
      _sentenceChars = 0;
    } else {
      _scheduleTypeTick(_stepForTarget(_target));
    }
  }

  /// 本句剩余字数(预览到句边界前)。用于决定当前语速:剩得越少打得越快(尾声提速)。
  int _charsUntilSentenceEnd(String target) {
    for (int i = _revealed.length; i < target.length; i++) {
      if (_sentenceEnd.hasMatch(target[i])) return i - _revealed.length;
    }
    return target.length - _revealed.length;
  }

  /// 语速步进:长句放慢、短句/句尾加快。
  Duration _stepForTarget(String target) {
    final int remaining = _charsUntilSentenceEnd(target);
    if (remaining > 30) return _stepSlow;
    if (remaining >= 12) return _stepNormal;
    return _stepFast;
  }

  /// 刚才 reveal 的最后一个字符是否为句边界,且其后还有内容(才会停顿)。
  bool get _endedSentence {
    if (_revealed.isEmpty) return false;
    final String lastChar = _revealed[_revealed.length - 1];
    return _sentenceEnd.hasMatch(lastChar) && _revealed.length < _target.length;
  }

  /// 句末停顿:本句越短停顿越短,长句多歇一会换气。
  Duration _pauseForCurrentSentence() {
    if (_sentenceChars >= 30) return _pauseLong;
    if (_sentenceChars >= 15) return _pauseMid;
    return _pauseShort;
  }

  /// 从已 reveal 文本的尾部往当前句起点回数,算出"当前句已 reveal 字数"(同步中途进场时用)。
  int _countRevealedOfCurrentSentence(String target) {
    if (_revealed.isEmpty) return 0;
    int count = 0;
    for (int i = _revealed.length - 1; i >= 0; i--) {
      final String ch = target[i];
      count++;
      if (_sentenceEnd.hasMatch(ch) && count > 1) break;
    }
    return count;
  }

  void _stopTypeTimers() {
    _typeTimer?.cancel();
    _typeTimer = null;
    _cursorTimer?.cancel();
    _cursorTimer = null;
    _cursorOn = false;
  }

  @override
  void dispose() {
    _typeTimer?.cancel();
    _cursorTimer?.cancel();
    super.dispose();
  }
}
