import "package:flutter/material.dart";
import "../../core/db/isar_local_history_store.dart";
import "../../core/config/api_config.dart";

class PhoneRegistrationPage extends StatefulWidget {
  const PhoneRegistrationPage({
    super.key,
    required this.onRegistrationComplete,
  });

  final VoidCallback onRegistrationComplete;

  @override
  State<PhoneRegistrationPage> createState() => _PhoneRegistrationPageState();
}

class _PhoneRegistrationPageState extends State<PhoneRegistrationPage> {
  late final IsarLocalHistoryStore _store;
  final TextEditingController _phoneController = TextEditingController();
  final TextEditingController _codeController = TextEditingController();
  
  bool _isSendingCode = false;
  bool _isVerifying = false;
  String _statusText = '';
  int _countdown = 0;

  @override
  void initState() {
    super.initState();
    _store = IsarLocalHistoryStore(userPin: ApiConfig.localPin);
  }

  @override
  void dispose() {
    _phoneController.dispose();
    _codeController.dispose();
    super.dispose();
  }

  Future<void> _sendVerificationCode() async {
    final phone = _phoneController.text.trim();
    
    if (phone.isEmpty || phone.length != 11) {
      setState(() {
        _statusText = '请输入有效的11位手机号';
      });
      return;
    }

    setState(() {
      _isSendingCode = true;
      _statusText = '正在发送验证码...';
    });

    // 模拟发送验证码
    await Future.delayed(const Duration(seconds: 1));

    setState(() {
      _isSendingCode = false;
      _statusText = '验证码已发送（演示模式：任意6位数字）';
      _countdown = 60;
    });

    // 开始倒计时
    _startCountdown();
  }

  void _startCountdown() {
    Future.doWhile(() async {
      await Future.delayed(const Duration(seconds: 1));
      setState(() {
        if (_countdown > 0) {
          _countdown--;
        }
      });
      return _countdown > 0;
    });
  }

  Future<void> _verifyAndRegister() async {
    final phone = _phoneController.text.trim();
    final code = _codeController.text.trim();

    if (phone.isEmpty || phone.length != 11) {
      setState(() {
        _statusText = '请输入有效的11位手机号';
      });
      return;
    }

    if (code.isEmpty || code.length != 6) {
      setState(() {
        _statusText = '请输入6位验证码';
      });
      return;
    }

    setState(() {
      _isVerifying = true;
      _statusText = '正在验证...';
    });

    // 模拟验证（演示模式：任意6位数字都通过）
    await Future.delayed(const Duration(seconds: 1));

    // 保存用户信息
    await _store.savePreference('phoneNumber', phone);
    await _store.savePreference('userId', 'user_${phone.substring(7)}');

    setState(() {
      _isVerifying = false;
      _statusText = '✓ 注册成功！';
    });

    // 延迟后回调
    Future.delayed(const Duration(milliseconds: 500), () {
      widget.onRegistrationComplete();
    });
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;

    return Scaffold(
      backgroundColor: const Color(0xFF0F0F0F),
      body: Center(
        child: Container(
          constraints: const BoxConstraints(maxWidth: 450),
          padding: const EdgeInsets.all(32),
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // 标题
                const Text(
                  '用户注册',
                  style: TextStyle(
                    color: Colors.white,
                    fontSize: 28,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  '请输入手机号完成注册',
                  style: TextStyle(
                    color: Colors.white.withValues(alpha: 0.6),
                    fontSize: 14,
                  ),
                ),
                const SizedBox(height: 32),

                // 手机号输入
                const Text(
                  '手机号',
                  style: TextStyle(
                    color: Colors.white,
                    fontSize: 16,
                    fontWeight: FontWeight.w500,
                  ),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: _phoneController,
                  keyboardType: TextInputType.phone,
                  maxLength: 11,
                  style: const TextStyle(color: Colors.white),
                  decoration: InputDecoration(
                    hintText: '请输入11位手机号',
                    hintStyle: TextStyle(color: Colors.white.withValues(alpha: 0.4)),
                    filled: true,
                    fillColor: Colors.white.withValues(alpha: 0.05),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                      borderSide: BorderSide(color: Colors.white.withValues(alpha: 0.2)),
                    ),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                      borderSide: BorderSide(color: Colors.white.withValues(alpha: 0.2)),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                      borderSide: BorderSide(color: cs.primary),
                    ),
                    counterText: '',
                  ),
                ),
                const SizedBox(height: 24),

                // 验证码输入
                const Text(
                  '验证码',
                  style: TextStyle(
                    color: Colors.white,
                    fontSize: 16,
                    fontWeight: FontWeight.w500,
                  ),
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _codeController,
                        keyboardType: TextInputType.number,
                        maxLength: 6,
                        style: const TextStyle(color: Colors.white),
                        decoration: InputDecoration(
                          hintText: '请输入6位验证码',
                          hintStyle: TextStyle(color: Colors.white.withValues(alpha: 0.4)),
                          filled: true,
                          fillColor: Colors.white.withValues(alpha: 0.05),
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(12),
                            borderSide: BorderSide(color: Colors.white.withValues(alpha: 0.2)),
                          ),
                          enabledBorder: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(12),
                            borderSide: BorderSide(color: Colors.white.withValues(alpha: 0.2)),
                          ),
                          focusedBorder: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(12),
                            borderSide: BorderSide(color: cs.primary),
                          ),
                          counterText: '',
                        ),
                      ),
                    ),
                    const SizedBox(width: 12),
                    SizedBox(
                      width: 120,
                      child: ElevatedButton(
                        onPressed: _countdown > 0 || _isSendingCode ? null : _sendVerificationCode,
                        style: ElevatedButton.styleFrom(
                          backgroundColor: _countdown > 0 || _isSendingCode
                              ? Colors.grey.withValues(alpha: 0.3)
                              : cs.surfaceContainerHighest,
                          foregroundColor: Colors.white,
                          padding: const EdgeInsets.symmetric(vertical: 16),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(12),
                          ),
                        ),
                        child: Text(
                          _countdown > 0 ? '${_countdown}s' : (_isSendingCode ? '发送中...' : '获取验证码'),
                          style: const TextStyle(fontSize: 14),
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 32),

                // 状态提示
                if (_statusText.isNotEmpty)
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: _statusText.contains('✓') 
                          ? Colors.green.withValues(alpha: 0.1)
                          : _statusText.contains('错误') || _statusText.contains('失败')
                              ? Colors.red.withValues(alpha: 0.1)
                              : Colors.white.withValues(alpha: 0.05),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(
                        color: _statusText.contains('✓') 
                            ? Colors.green.withValues(alpha: 0.3)
                            : _statusText.contains('错误') || _statusText.contains('失败')
                                ? Colors.red.withValues(alpha: 0.3)
                                : Colors.white.withValues(alpha: 0.1),
                      ),
                    ),
                    child: Text(
                      _statusText,
                      style: TextStyle(
                        color: _statusText.contains('✓') 
                            ? Colors.green
                            : _statusText.contains('错误') || _statusText.contains('失败')
                                ? Colors.red
                                : Colors.white,
                        fontSize: 14,
                      ),
                      textAlign: TextAlign.center,
                    ),
                  ),
                
                const SizedBox(height: 32),

                // 注册按钮
                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton(
                    onPressed: _isVerifying ? null : _verifyAndRegister,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: cs.surfaceContainerHighest,
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(vertical: 16),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                    child: Text(
                      _isVerifying ? '注册中...' : '注册',
                      style: const TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 16),

                // 直接进入按钮（调试用）
                SizedBox(
                  width: double.infinity,
                  child: OutlinedButton(
                    onPressed: () {
                      // 保存默认用户信息
                      _store.savePreference('phoneNumber', '13800138000');
                      _store.savePreference('userId', 'user_debug');
                      widget.onRegistrationComplete();
                    },
                    style: OutlinedButton.styleFrom(
                      foregroundColor: Colors.white.withValues(alpha: 0.7),
                      side: BorderSide(color: Colors.white.withValues(alpha: 0.3)),
                      padding: const EdgeInsets.symmetric(vertical: 16),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                    child: const Text(
                      '直接进入（调试）',
                      style: TextStyle(fontSize: 16),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
