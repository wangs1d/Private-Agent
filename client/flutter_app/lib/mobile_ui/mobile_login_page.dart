import "dart:async";

import "package:flutter/material.dart";
import "package:flutter/services.dart";

import "../core/services/email_login_api.dart";
import "mobile_theme.dart";

/// 手机端登录页：仅提供邮箱登录（与桌面端同一账号体系）。
///
/// 两步式与桌面端 /accounts/web 网页登录完全同协议：
///  1. 输入邮箱 → 「获取验证码」→ 服务端发 6 位验证码（OTP 闸关闭时提示免码直登）
///  2. 输入验证码 → 「登录」→ 新邮箱即注册、已注册即登录（幂等）
///
/// 登录成功后邮箱作为 userId 落到 [ApiConfig.runtimeUserId]，与桌面端
/// 「登录邮箱=运行时身份覆盖」同源：聊天/记忆/画像等数据按同一账号共享。
class MobileLoginPage extends StatefulWidget {
  const MobileLoginPage({super.key, required this.onLoggedIn});

  /// 登录成功回调（参数=已归一化邮箱）。
  final ValueChanged<String> onLoggedIn;

  @override
  State<MobileLoginPage> createState() => _MobileLoginPageState();
}

class _MobileLoginPageState extends State<MobileLoginPage> {
  final EmailLoginApi _api = EmailLoginApi();
  final TextEditingController _email = TextEditingController();
  final TextEditingController _code = TextEditingController();
  final FocusNode _codeFocus = FocusNode();

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
    final MobilePalette p = MobileTheme.of(context);
    return Scaffold(
      backgroundColor: p.background,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Center(
                  child: Container(
                    width: 64,
                    height: 64,
                    decoration: BoxDecoration(
                      color: p.surface,
                      shape: BoxShape.circle,
                    ),
                    child: Icon(
                      Icons.auto_awesome_outlined,
                      size: 30,
                      color: p.textPrimary,
                    ),
                  ),
                ),
                const SizedBox(height: 20),
                Text(
                  "智能助手",
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: p.textPrimary,
                    fontSize: 20,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 0.4,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  "使用邮箱登录\n与桌面端同一账号，数据自动同步",
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: p.textSecondary,
                    fontSize: 13,
                    height: 1.6,
                  ),
                ),
                const SizedBox(height: 32),
                _buildField(
                  p,
                  controller: _email,
                  hint: "邮箱地址",
                  keyboardType: TextInputType.emailAddress,
                  enabled: !_busy,
                ),
                if (!_otpDisabled) ...<Widget>[
                  const SizedBox(height: 12),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Expanded(
                        child: _buildField(
                          p,
                          controller: _code,
                          hint: "6 位验证码",
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
                      _buildOtpButton(p),
                    ],
                  ),
                ],
                const SizedBox(height: 24),
                _buildLoginButton(p),
                if (_message != null) ...<Widget>[
                  const SizedBox(height: 14),
                  Text(
                    _message!,
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      color: _messageError
                          ? Theme.of(context).colorScheme.error
                          : p.textSecondary,
                      fontSize: 13,
                      height: 1.5,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildField(
    MobilePalette p, {
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
      style: TextStyle(color: p.textPrimary, fontSize: 15),
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: TextStyle(color: p.textMuted, fontSize: 15),
        filled: true,
        fillColor: p.surface,
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide.none,
        ),
      ),
    );
  }

  Widget _buildOtpButton(MobilePalette p) {
    final bool cooling = _countdown > 0;
    return SizedBox(
      height: 48,
      child: OutlinedButton(
        onPressed: (_busy || cooling) ? null : _requestOtp,
        style: OutlinedButton.styleFrom(
          foregroundColor: p.textPrimary,
          side: BorderSide(color: cooling ? p.divider : p.textSecondary),
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        ),
        child: Text(
          cooling ? "重新发送(${_countdown}s)" : "获取验证码",
          style: const TextStyle(fontSize: 13),
        ),
      ),
    );
  }

  Widget _buildLoginButton(MobilePalette p) {
    return SizedBox(
      height: 48,
      child: FilledButton(
        onPressed: _busy ? null : _login,
        style: FilledButton.styleFrom(
          backgroundColor: p.accent,
          foregroundColor: p.onAccent,
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        ),
        child: _busy
            ? SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: p.onAccent,
                ),
              )
            : const Text("登录", style: TextStyle(fontSize: 16)),
      ),
    );
  }
}
