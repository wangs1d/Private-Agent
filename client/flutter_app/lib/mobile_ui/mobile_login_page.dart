import "dart:async";

import "package:flutter/material.dart";
import "package:flutter/services.dart";

import "../core/services/email_login_api.dart";

/// 手机端登录页：仅提供邮箱登录（与桌面端同一账号体系）。
///
/// 版式对齐桌面端注册页左列（register_page.dart）：品牌大标题在顶、
/// 问候与「登录」白胶囊按钮沉底，整页固定深色品牌面（与 App 主题解耦）；
/// 文案统一 NEXTBOT 品牌（不再出现「智能助手」）。
///
/// 两步式与桌面端 /accounts/web 网页登录完全同协议：
///  1. 输入邮箱 → 「获取验证码」→ 服务端发 6 位验证码（OTP 闸关闭时提示免码直登）
///  2. 输入验证码 → 「登录」→ 新邮箱即注册、已注册即登录（幂等）
///
/// 登录成功后邮箱作为 userId 落到 [ApiConfig.runtimeUserId]，与桌面端
/// 「登录邮箱=运行时身份覆盖」同源：聊天/记忆/画像等数据按同一账号共享。
class MobileLoginPage extends StatefulWidget {
  const MobileLoginPage({super.key, required this.onLoggedIn, this.onDebugSkip});

  /// 登录成功回调（参数=已归一化邮箱）。
  final ValueChanged<String> onLoggedIn;

  /// 调试跳过登录（仅 debug 构建由根组件注入；不落盘会话，重启即回登录页）。
  final VoidCallback? onDebugSkip;

  @override
  State<MobileLoginPage> createState() => _MobileLoginPageState();
}

class _MobileLoginPageState extends State<MobileLoginPage> {
  final EmailLoginApi _api = EmailLoginApi();
  final TextEditingController _email = TextEditingController();
  final TextEditingController _code = TextEditingController();
  final FocusNode _codeFocus = FocusNode();

  // ── 品牌登录面固定深色（对齐桌面端注册页 /accounts/web 设计语言）──
  static const Color _bg = Color(0xFF000000);
  static const Color _fieldBg = Color(0xFF101010);
  static const Color _fieldBorder = Color(0xFF3D3D3D);
  static const Color _textPrimary = Color(0xFFF2F2F2);
  static const Color _textSecondary = Color(0xFF9B9B9B);
  static const Color _textMuted = Color(0xFF6B6B6B);
  static const Color _errorRed = Color(0xFFF2604E);

  /// 正在请求（发码/登录）。
  bool _busy = false;

  /// 验证码重发倒计时（秒；>0 时按钮禁用）。
  int _countdown = 0;
  Timer? _countdownTimer;

  /// 服务端 OTP 闸关闭：免验证码直登。
  bool _otpDisabled = false;

  String? _message;
  bool _messageError = false;

  @override
  void dispose() {
    _countdownTimer?.cancel();
    _email.dispose();
    _code.dispose();
    _codeFocus.dispose();
    super.dispose();
  }

  void _showMessage(String text, {required bool error}) {
    setState(() {
      _message = text;
      _messageError = error;
    });
  }

  void _startCountdown(int seconds) {
    _countdownTimer?.cancel();
    setState(() => _countdown = seconds);
    _countdownTimer = Timer.periodic(const Duration(seconds: 1), (Timer t) {
      if (!mounted) {
        t.cancel();
        return;
      }
      setState(() => _countdown -= 1);
      if (_countdown <= 0) t.cancel();
    });
  }

  /// 步骤 1：获取验证码。
  Future<void> _requestOtp() async {
    final String email = _email.text.trim().toLowerCase();
    if (!EmailLoginApi.isValidEmail(email)) {
      _showMessage("请输入有效的邮箱地址", error: true);
      return;
    }
    setState(() {
      _busy = true;
      _message = null;
    });
    final EmailLoginResult r = await _api.startOtp(email);
    if (!mounted) return;
    setState(() => _busy = false);
    if (r.ok) {
      _startCountdown(r.retryAfterSeconds ?? 60);
      _codeFocus.requestFocus();
      _showMessage("验证码已发送到 $email，请查收（可能在垃圾箱）", error: false);
      return;
    }
    if (r.otpChannelDisabled) {
      // 服务端未开 OTP 闸：免验证码，直接点「登录」即可
      setState(() => _otpDisabled = true);
      _showMessage("邮件验证通道未开启，可直接点击「登录」", error: false);
      return;
    }
    if (r.retryAfterSeconds != null && r.retryAfterSeconds! > 0) {
      _startCountdown(r.retryAfterSeconds!);
    }
    _showMessage(r.error ?? "验证码发送失败，请稍后重试", error: true);
  }

  /// 步骤 2：登录（新邮箱即注册，幂等）。
  Future<void> _login() async {
    final String email = _email.text.trim().toLowerCase();
    if (!EmailLoginApi.isValidEmail(email)) {
      _showMessage("请输入有效的邮箱地址", error: true);
      return;
    }
    final String code = _code.text.trim();
    if (!_otpDisabled && code.isEmpty) {
      _showMessage("请先获取验证码并输入 6 位验证码", error: true);
      return;
    }
    setState(() {
      _busy = true;
      _message = null;
    });
    final EmailLoginResult r =
        await _api.registerOrLogin(email, code: code.isEmpty ? null : code);
    if (!mounted) return;
    if (r.ok) {
      // 先落本机登录态再切界面（根组件负责 runtimeUserId 覆盖与进主壳）
      widget.onLoggedIn(email);
      return;
    }
    setState(() {
      _busy = false;
      _message = r.error;
      _messageError = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    // 桌面端左列版式的手机适配：品牌大标题在顶、表单居中、问候与
    // 登录按钮沉底；小屏/键盘弹出时整体可滚动（IntrinsicHeight 撑满视口）。
    return Scaffold(
      backgroundColor: _bg,
      body: SafeArea(
        child: LayoutBuilder(
          builder: (BuildContext context, BoxConstraints c) => SingleChildScrollView(
            child: ConstrainedBox(
              constraints: BoxConstraints(minHeight: c.maxHeight),
              child: IntrinsicHeight(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(28, 48, 28, 28),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      // 品牌眉题 + 大标题（对齐桌面端「欢迎来到 NEXTBOT 桌面端」）
                      const Text(
                        "NEXTBOT",
                        style: TextStyle(
                          color: _textPrimary,
                          fontSize: 13,
                          fontWeight: FontWeight.w700,
                          letterSpacing: 3.2,
                        ),
                      ),
                      const SizedBox(height: 14),
                      const Text(
                        "欢迎来到\nNEXTBOT 手机端",
                        style: TextStyle(
                          color: _textPrimary,
                          fontSize: 28,
                          height: 1.35,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 10),
                      const Text(
                        "使用邮箱登录，与桌面端同一账号，数据自动同步。",
                        style: TextStyle(
                          color: _textSecondary,
                          fontSize: 14,
                          height: 1.6,
                        ),
                      ),
                      const SizedBox(height: 36),
                      // ── 表单区 ──
                      const Text(
                        "邮箱",
                        style: TextStyle(
                          color: _textPrimary,
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: 8),
                      _buildField(
                        controller: _email,
                        hint: "you@example.com",
                        keyboardType: TextInputType.emailAddress,
                        enabled: !_busy,
                      ),
                      if (!_otpDisabled) ...<Widget>[
                        const SizedBox(height: 20),
                        const Text(
                          "验证码",
                          style: TextStyle(
                            color: _textPrimary,
                            fontSize: 13,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const SizedBox(height: 8),
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            Expanded(
                              child: _buildField(
                                controller: _code,
                                hint: "6 位数字",
                                keyboardType: TextInputType.number,
                                inputFormatters: <TextInputFormatter>[
                                  FilteringTextInputFormatter.digitsOnly,
                                  LengthLimitingTextInputFormatter(6),
                                ],
                                enabled: !_busy,
                                focusNode: _codeFocus,
                              ),
                            ),
                            const SizedBox(width: 10),
                            _buildOtpButton(),
                          ],
                        ),
                      ],
                      // 中段弹性留白：问候与按钮沉底（与桌面端左列同构）
                      const Expanded(child: SizedBox.shrink()),
                      const SizedBox(height: 32),
                      const Text(
                        "Hi，朋友",
                        style: TextStyle(
                          color: _textPrimary,
                          fontSize: 20,
                          height: 1.3,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: 10),
                      const Text(
                        "登录后，就可以开启我们的旅程了。",
                        style: TextStyle(
                          color: _textSecondary,
                          fontSize: 14,
                          height: 1.5,
                        ),
                      ),
                      const SizedBox(height: 28),
                      _buildLoginButton(),
                      if (_message != null) ...<Widget>[
                        const SizedBox(height: 14),
                        Text(
                          _message!,
                          style: TextStyle(
                            color: _messageError ? _errorRed : _textSecondary,
                            fontSize: 13,
                            height: 1.5,
                          ),
                        ),
                      ],
                      // 调试预览直进（仅 debug 构建显示；release 无此回调自动隐藏）
                      if (widget.onDebugSkip != null) ...<Widget>[
                        const SizedBox(height: 18),
                        Center(
                          child: TextButton(
                            onPressed: widget.onDebugSkip,
                            style: TextButton.styleFrom(
                              foregroundColor: _textMuted,
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 16, vertical: 8),
                            ),
                            child: const Text(
                              "跳过登录，先随便看看（调试）",
                              style: TextStyle(fontSize: 12),
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildField({
    required TextEditingController controller,
    required String hint,
    TextInputType? keyboardType,
    List<TextInputFormatter>? inputFormatters,
    bool enabled = true,
    FocusNode? focusNode,
  }) {
    return TextField(
      controller: controller,
      focusNode: focusNode,
      enabled: enabled,
      keyboardType: keyboardType,
      inputFormatters: inputFormatters,
      style: const TextStyle(color: _textPrimary, fontSize: 15),
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: const TextStyle(color: _textMuted, fontSize: 15),
        filled: true,
        fillColor: _fieldBg,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: const BorderSide(color: _fieldBorder),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: const BorderSide(color: _fieldBorder),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: const BorderSide(color: _textPrimary),
        ),
      ),
    );
  }

  Widget _buildOtpButton() {
    final bool cooling = _countdown > 0;
    return SizedBox(
      height: 48,
      child: OutlinedButton(
        onPressed: (_busy || cooling) ? null : _requestOtp,
        style: OutlinedButton.styleFrom(
          foregroundColor: _textPrimary,
          side: BorderSide(color: cooling ? _fieldBorder : _textSecondary),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        ),
        child: Text(
          cooling ? "重新发送(${_countdown}s)" : "获取验证码",
          style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
        ),
      ),
    );
  }

  /// 登录按钮：白底胶囊（对齐桌面端「立即登录」）。
  Widget _buildLoginButton() {
    return SizedBox(
      width: double.infinity,
      height: 48,
      child: FilledButton(
        onPressed: _busy ? null : _login,
        style: FilledButton.styleFrom(
          backgroundColor: Colors.white,
          disabledBackgroundColor: const Color(0xFF2E2E2E),
          foregroundColor: const Color(0xFF0A0A0A),
          disabledForegroundColor: _textSecondary,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
        ),
        child: _busy
            ? const SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(
                  strokeWidth: 2.2,
                  valueColor: AlwaysStoppedAnimation<Color>(Color(0xFF0A0A0A)),
                ),
              )
            : const Text(
                "登录",
                style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
              ),
      ),
    );
  }
}
