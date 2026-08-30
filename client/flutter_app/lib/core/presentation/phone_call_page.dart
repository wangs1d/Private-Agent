import "dart:async";

import "package:flutter/material.dart";

import "../services/phone_call_session.dart";

/// 手机端全屏虚拟电话页（桌面端走 Win32 原生悬浮窗，不使用本页面）。
///
/// 由 `showPhoneCallPage` 以全屏对话框弹出，内容随 [PhoneCallSession.phase] 切换：
///   - incoming : 振铃接听（呼吸头像 + 倒计时 + 接听/挂断）
///   - inCall   : 通话中（计时 + 语音稿 + 回复输入 + 挂断）
/// 会话结束（session.end()）时自动关闭。
Future<void> showPhoneCallPage(BuildContext context) {
  return showGeneralDialog(
    context: context,
    barrierDismissible: false,
    barrierLabel: "虚拟电话",
    barrierColor: Colors.black87,
    transitionDuration: const Duration(milliseconds: 220),
    pageBuilder: (_, __, ___) => const PhoneCallPage(),
    transitionBuilder: (_, animation, __, child) => FadeTransition(
      opacity: CurvedAnimation(parent: animation, curve: Curves.easeOut),
      child: child,
    ),
  );
}

class PhoneCallPage extends StatefulWidget {
  const PhoneCallPage({super.key});

  @override
  State<PhoneCallPage> createState() => _PhoneCallPageState();
}

class _PhoneCallPageState extends State<PhoneCallPage>
    with SingleTickerProviderStateMixin {
  final PhoneCallSession _session = PhoneCallSession.instance;
  Timer? _tick;
  final TextEditingController _replyController = TextEditingController();
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  );

  @override
  void initState() {
    super.initState();
    _session.addListener(_onSessionChanged);
    _pulse.repeat(reverse: true);
    // 每秒刷新计时器/振铃倒计时
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _session.removeListener(_onSessionChanged);
    _pulse.dispose();
    _tick?.cancel();
    _replyController.dispose();
    super.dispose();
  }

  void _onSessionChanged() {
    if (!mounted) return;
    if (_session.phase == PhoneCallPhase.idle) {
      // 服务端 ended / 代接完成 / 拒接 → 关页
      Navigator.of(context).pop();
      return;
    }
    setState(() {});
  }

  void _submitReply() {
    final String text = _replyController.text.trim();
    if (text.isEmpty) return;
    _replyController.clear();
    _session.sendReply(text);
    setState(() {});
  }

  String get _callTimerText {
    final DateTime? started = _session.connectedAt;
    if (started == null) return "00:00";
    final int seconds = DateTime.now().difference(started).inSeconds;
    final String mm = (seconds ~/ 60).toString().padLeft(2, "0");
    final String ss = (seconds % 60).toString().padLeft(2, "0");
    return "$mm:$ss";
  }

  String get _ringCountdownText {
    final DateTime? deadline = _session.ringDeadline;
    if (deadline == null) return "";
    final int left = deadline.difference(DateTime.now()).inSeconds;
    if (left <= 0) return "";
    return "${left}s 后自动挂断";
  }

  @override
  Widget build(BuildContext context) {
    final bool incoming = _session.phase == PhoneCallPhase.incoming;
    return PopScope(
      canPop: false, // 通话页只能通过挂断/接听按钮或会话结束退出
      child: Scaffold(
        body: Container(
          width: double.infinity,
          decoration: const BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: <Color>[Color(0xFF20242B), Color(0xFF14161A)],
            ),
          ),
          child: incoming ? _buildIncomingBody() : _buildInCallBody(),
        ),
      ),
    );
  }

  // ---------------- 振铃接听 ----------------

  Widget _buildIncomingBody() {
    return Column(
      children: <Widget>[
        const Spacer(flex: 3),
        _buildAvatar(size: 112),
        const SizedBox(height: 24),
        Text(
          _session.callerLabel,
          style: const TextStyle(
            color: Colors.white,
            fontSize: 24,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 8),
        Text(
          _session.subtitle,
          style: TextStyle(color: Colors.white.withValues(alpha: 0.6), fontSize: 15),
        ),
        const SizedBox(height: 16),
        Text(
          _ringCountdownText,
          style: TextStyle(color: Colors.white.withValues(alpha: 0.45), fontSize: 13),
        ),
        const Spacer(flex: 4),
        SafeArea(
          minimum: const EdgeInsets.only(bottom: 48),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
            children: <Widget>[
              _CircleCallButton(
                icon: Icons.call_end,
                background: const Color(0xFFEF4444),
                label: "拒接",
                onTap: () {
                  _session.onDecline?.call();
                  _session.end();
                },
              ),
              _CircleCallButton(
                icon: Icons.call,
                background: const Color(0xFF22C55E),
                label: "接听",
                onTap: () {
                  _session.onAccept?.call();
                  // agent_to_user 来电服务端自动推进接通，本地先切"连接中"态
                  _session.markInCall();
                },
              ),
            ],
          ),
        ),
      ],
    );
  }

  // ---------------- 通话中 ----------------

  Widget _buildInCallBody() {
    return Column(
      children: <Widget>[
        const SizedBox(height: 24),
        Text(
          "通话中  $_callTimerText",
          style: const TextStyle(
            color: Colors.white,
            fontSize: 18,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 20),
        _buildAvatar(size: 96, talking: _session.agentTalking),
        const SizedBox(height: 10),
        Text(
          _session.callerLabel,
          style: TextStyle(color: Colors.white.withValues(alpha: 0.85), fontSize: 15),
        ),
        Text(
          _session.agentTalking ? "正在播报…" : "聆听中，可随时回复",
          style: TextStyle(color: Colors.white.withValues(alpha: 0.5), fontSize: 13),
        ),
        const SizedBox(height: 16),
        Expanded(child: _buildTranscriptList()),
        _buildReplyBar(),
        const SizedBox(height: 8),
        SafeArea(
          minimum: const EdgeInsets.only(bottom: 28),
          child: _CircleCallButton(
            icon: Icons.call_end,
            background: const Color(0xFFEF4444),
            label: "挂断",
            size: 68,
            onTap: () {
              _session.hangup();
              _session.onHangup?.call();
            },
          ),
        ),
      ],
    );
  }

  Widget _buildAvatar({double size = 96, bool talking = false}) {
    final Widget avatar = CircleAvatar(
      radius: size / 2,
      backgroundColor: const Color(0xFF3B82F6),
      child: Text(
        _session.callerInitial,
        style: TextStyle(
          color: Colors.white,
          fontSize: size * 0.4,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
    if (!talking) return avatar;
    // Agent 播报中：呼吸光晕
    return AnimatedBuilder(
      animation: _pulse,
      builder: (BuildContext context, Widget? child) {
        final double t = _pulse.value;
        return Container(
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            boxShadow: <BoxShadow>[
              BoxShadow(
                color: const Color(0xFF3B82F6).withValues(alpha: 0.35 * (1 - t)),
                blurRadius: 24 + 18 * t,
                spreadRadius: 2 + 5 * t,
              ),
            ],
          ),
          child: child,
        );
      },
      child: avatar,
    );
  }

  Widget _buildTranscriptList() {
    final List<PhoneCallTranscriptEntry> entries = _session.transcript;
    if (entries.isEmpty) {
      return Center(
        child: Text(
          "通话已接通",
          style: TextStyle(color: Colors.white.withValues(alpha: 0.35), fontSize: 13),
        ),
      );
    }
    return ListView.builder(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
      itemCount: entries.length,
      itemBuilder: (BuildContext context, int index) {
        final PhoneCallTranscriptEntry e = entries[index];
        final bool mine = e.fromUser;
        return Align(
          alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
          child: Container(
            margin: const EdgeInsets.symmetric(vertical: 4),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
            constraints: BoxConstraints(
              maxWidth: MediaQuery.of(context).size.width * 0.72,
            ),
            decoration: BoxDecoration(
              color: mine ? const Color(0xFF2F6FED) : const Color(0xFF2A2E35),
              borderRadius: BorderRadius.circular(14),
            ),
            child: Text(
              e.text,
              style: const TextStyle(color: Colors.white, fontSize: 14, height: 1.35),
            ),
          ),
        );
      },
    );
  }

  Widget _buildReplyBar() {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: Row(
        children: <Widget>[
          Expanded(
            child: TextField(
              controller: _replyController,
              style: const TextStyle(color: Colors.white, fontSize: 14),
              cursorColor: Colors.white70,
              textInputAction: TextInputAction.send,
              onSubmitted: (_) => _submitReply(),
              decoration: InputDecoration(
                isDense: true,
                hintText: "输入回复，Agent 会语音回应…",
                hintStyle: TextStyle(color: Colors.white.withValues(alpha: 0.35)),
                filled: true,
                fillColor: const Color(0xFF262A31),
                contentPadding:
                    const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(22),
                  borderSide: BorderSide.none,
                ),
              ),
            ),
          ),
          const SizedBox(width: 8),
          Material(
            color: const Color(0xFF2F6FED),
            shape: const CircleBorder(),
            child: InkWell(
              customBorder: const CircleBorder(),
              onTap: _submitReply,
              child: const SizedBox(
                width: 40,
                height: 40,
                child: Icon(Icons.send_rounded, size: 20, color: Colors.white),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _CircleCallButton extends StatelessWidget {
  const _CircleCallButton({
    required this.icon,
    required this.background,
    required this.label,
    required this.onTap,
    this.size = 74,
  });

  final IconData icon;
  final Color background;
  final String label;
  final VoidCallback onTap;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Material(
          color: background,
          shape: const CircleBorder(),
          child: InkWell(
            customBorder: const CircleBorder(),
            onTap: onTap,
            child: SizedBox(
              width: size,
              height: size,
              child: Icon(icon, color: Colors.white, size: size * 0.44),
            ),
          ),
        ),
        const SizedBox(height: 8),
        Text(
          label,
          style: TextStyle(color: Colors.white.withValues(alpha: 0.7), fontSize: 13),
        ),
      ],
    );
  }
}
