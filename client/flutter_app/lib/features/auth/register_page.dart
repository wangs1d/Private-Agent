import "dart:async";
import "dart:convert";
import "dart:developer" as developer;
import "dart:io" show Platform;
import "dart:math" as math;

import "package:flutter/foundation.dart";
import "package:flutter/material.dart";
import "package:flutter/services.dart";
import "package:http/http.dart" as http;
import "package:window_manager/window_manager.dart";

import "../../core/config/api_config.dart";
import "../../core/theme/app_theme.dart";
import "../../widgets/app_window_titlebar.dart";

/// 注册界面（NEXTBOT 创建账号）。
///
/// 按设计稿还原的整页注册界面：左侧表单（邮箱/密码/确认密码），
/// 右侧机器人形象面板（CustomPainter 手绘的暗色球体 + 发光眼睛）。
///
/// 集成约定：页面自身不依赖任何全局服务，注册动效通过 [RegisterPage.onRegister]
/// 回调外抛（null 时走 1.2s 模拟延迟，供预览/验收）。后续接入真实注册 API 时
/// 在调用方注入回调即可，页面无需改动。
///
/// 预览入口：环境变量 `PAI_REGISTER_PREVIEW=1` 启动独立预览窗口
/// （不 bootstrap 主应用任何服务），见 [runRegisterPreviewWindow]。

/// 独立预览窗口模式的环境变量开关（在 main.dart 最早期检查）。
const String kRegisterPreviewEnv = "PAI_REGISTER_PREVIEW";

/// 独立预览窗口入口：以设计稿同比例（16:10）的窗口只渲染注册页。
Future<void> runRegisterPreviewWindow() async {
  WidgetsFlutterBinding.ensureInitialized();
  await windowManager.ensureInitialized();
  const WindowOptions options = WindowOptions(
    // 与设计稿 1600x1000 同比例（16:10），小屏自动按内容自适应
    size: Size(1440, 900),
    minimumSize: Size(980, 680),
    center: true,
    title: "NEXTBOT — 创建账号",
    backgroundColor: Colors.transparent,
    // 无系统标题栏：整页沉浸还原设计稿，顶部留透明拖拽条
    titleBarStyle: TitleBarStyle.hidden,
  );
  await windowManager.waitUntilReadyToShow(options, () async {
    await windowManager.show();
    // 后台脚本/服务上下文拉起时窗口可能带最小化态启动，恢复正常显示
    if (await windowManager.isMinimized()) {
      await windowManager.restore();
    }
    await windowManager.focus();
  });
  runApp(const _RegisterPreviewApp());
}

class _RegisterPreviewApp extends StatelessWidget {
  const _RegisterPreviewApp();

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: AppTheme.of(AppThemeVariant.dark).copyWith(
        scaffoldBackgroundColor: Colors.black,
      ),
      home: RegisterPage(onRegister: _registerToControlPlane),
    );
  }

  /// 真实注册：名单落后台账号服务（`POST /accounts/register`，email 已透传）。
  /// 开发/单机形态 [ApiConfig.controlPlaneBase] 回落 httpBase（127.0.0.1:3000
  /// 本地 server，与管理后台同库）；发版形态烤入 CONTROL_PLANE_URL 指云端后台。
  Future<void> _registerToControlPlane(String email, String password) async {
    final String mail = email.trim();
    final http.Client client = http.Client();
    try {
      final http.Response res = await client
          .post(
            Uri.parse("${ApiConfig.controlPlaneBase}/accounts/register"),
            headers: const <String, String>{
              "Content-Type": "application/json",
            },
            body: jsonEncode(<String, String>{
              // 名单主键用邮箱：后台用户列表 userId/email 同值，一眼可辨
              "userId": mail,
              "displayName": mail.split("@").first,
              "email": mail,
            }),
          )
          .timeout(const Duration(seconds: 10));
      final Map<String, dynamic> data =
          jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode == 200 && data["ok"] == true) return;
      final String message =
          data["message"]?.toString() ?? "注册失败（HTTP ${res.statusCode}）";
      throw Exception(message);
    } finally {
      client.close();
    }
  }
}

/// 注册页回调载荷：注册成功后携带邮箱（预留，接真实 API 时用）。
typedef OnRegister = Future<void> Function(String email, String password);

/// 注册界面整页。
///
/// 布局：黑色页底 + 居中大圆角卡片；卡片左半是表单列，右半是机器人面板。
/// 窄窗口（宽 < 900）时隐藏机器人面板，只保留表单列。
class RegisterPage extends StatefulWidget {
  const RegisterPage({
    super.key,
    this.onRegister,
    this.onGoLogin,
  });

  /// 注册提交回调（null = 模拟延迟，预览用）。
  final OnRegister? onRegister;

  /// 「已有账号？登录」点击回调（null = 无动作，接登录页时注入）。
  final VoidCallback? onGoLogin;

  @override
  State<RegisterPage> createState() => _RegisterPageState();
}

class _RegisterPageState extends State<RegisterPage> {
  // ── 配色（按设计稿取色，深色独占，不随主题切换）──
  static const Color pageBg = Color(0xFF000000);
  static const Color cardBg = Color(0xFF141414);
  static const Color cardBorder = Color(0xFF232323);
  static const Color panelBg = Color(0xFF0D0D0D);
  static const Color fieldBorder = Color(0xFF3D3D3D);
  static const Color fieldBorderFocused = Color(0xFFE8E8E8);
  static const Color fieldBorderError = Color(0xFFF2604E);
  static const Color fieldBg = Color(0xFF101010);
  static const Color textPrimary = Color(0xFFF2F2F2);
  static const Color textSecondary = Color(0xFF9B9B9B);
  static const Color textMuted = Color(0xFF6B6B6B);
  static const Color errorRed = Color(0xFFF2604E);
  static const Color pillDark = Color(0xFF1F1F1F);
  static const Color pillBorder = Color(0xFF303030);

  final TextEditingController _emailCtrl = TextEditingController();
  final TextEditingController _passwordCtrl = TextEditingController();
  final TextEditingController _confirmCtrl = TextEditingController();
  final FocusNode _emailFocus = FocusNode();
  final FocusNode _passwordFocus = FocusNode();
  final FocusNode _confirmFocus = FocusNode();

  bool _submitAttempted = false;
  bool _submitting = false;
  bool _registered = false;
  String? _emailError;
  String? _passwordError;
  String? _confirmError;
  String? _apiError;

  @override
  void initState() {
    super.initState();
    _emailCtrl.addListener(_onFieldChanged);
    _passwordCtrl.addListener(_onFieldChanged);
    _confirmCtrl.addListener(_onFieldChanged);
    // debug 预览的 VM service 直调通道：脚本无法往被遮挡的窗口注入键盘/鼠标
    // （全屏游戏等前景遮挡时 SendKeys/点击会落 elsewhere），预览模式下注册
    // 一个扩展，经 VM service websocket 直接驱动表单做真机取证。
    if (kDebugMode &&
        Platform.environment[kRegisterPreviewEnv] == "1") {
      developer.registerExtension("ext.pai.debug.registerFill", (
        String method,
        Map<String, String> parameters,
      ) async {
        Future<void>.sync(() {
          _emailCtrl.text = parameters["email"] ?? "";
          _passwordCtrl.text = parameters["password"] ?? "";
          _confirmCtrl.text = parameters["confirm"] ?? "";
          if (parameters["submit"] == "1") {
            unawaited(_submit());
          }
        });
        return developer.ServiceExtensionResponse.result(
          jsonEncode(<String, dynamic>{"ok": true}),
        );
      });
    }
  }

  @override
  void dispose() {
    _emailCtrl.dispose();
    _passwordCtrl.dispose();
    _confirmCtrl.dispose();
    _emailFocus.dispose();
    _passwordFocus.dispose();
    _confirmFocus.dispose();
    super.dispose();
  }

  /// 首次提交后输入即实时重校验（错误随修正消失，与设计稿错误态配合）。
  void _onFieldChanged() {
    if (!_submitAttempted || _submitting || _registered) return;
    setState(_validate);
  }

  void _validate() {
    _emailError = _validateEmail(_emailCtrl.text);
    _passwordError = _validatePassword(_passwordCtrl.text);
    _confirmError = _validateConfirm(
      _confirmCtrl.text,
      _passwordCtrl.text,
    );
  }

  static String? _validateEmail(String v) {
    final String t = v.trim();
    if (t.isEmpty) return "请输入邮箱";
    final RegExp email = RegExp(r"^[^\s@]+@[^\s@]+\.[^\s@]+$");
    if (!email.hasMatch(t)) return "请输入有效的邮箱地址";
    return null;
  }

  static String? _validatePassword(String v) {
    if (v.isEmpty) return "请输入密码";
    final bool hasLetter = v.contains(RegExp(r"[A-Za-z]"));
    final bool hasDigit = v.contains(RegExp(r"[0-9]"));
    if (v.length < 8 || !hasLetter || !hasDigit) return "至少 8 位，含字母与数字";
    return null;
  }

  static String? _validateConfirm(String v, String password) {
    if (v.isEmpty) return "请再次输入密码";
    if (v != password) return "两次输入的密码不一致";
    return null;
  }

  Future<void> _submit() async {
    if (_submitting || _registered) return;
    setState(() {
      _submitAttempted = true;
      _apiError = null;
      _validate();
    });
    if (_emailError != null) {
      _emailFocus.requestFocus();
      return;
    }
    if (_passwordError != null) {
      _passwordFocus.requestFocus();
      return;
    }
    if (_confirmError != null) {
      _confirmFocus.requestFocus();
      return;
    }
    setState(() => _submitting = true);
    try {
      if (widget.onRegister != null) {
        await widget.onRegister!(_emailCtrl.text.trim(), _passwordCtrl.text);
      } else {
        // 预览/验收：模拟一次真实注册的往返延迟
        await Future<void>.delayed(const Duration(milliseconds: 1200));
      }
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _registered = true;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _apiError = e.toString();
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: pageBg,
      body: CallbackShortcuts(
        bindings: <ShortcutActivator, VoidCallback>{
          const SingleActivator(LogicalKeyboardKey.escape): () {
            windowManager.close();
          },
        },
        child: Focus(
          autofocus: true,
          child: Column(
            children: <Widget>[
              // 自绘标题栏：与主窗口同款（拖拽/双击最大化 + 最小化/最大化/关闭）
              const AppWindowTitleBar(),
              Expanded(
                child: LayoutBuilder(
                  builder: (BuildContext context, BoxConstraints c) {
                    final double w = c.maxWidth;
                    final double h = c.maxHeight;
                    final bool compact = w < 900;
                    // 卡片外边距：随窗口缩放，黑边留白与设计稿比例一致
                    final double mx = (w * 0.085).clamp(36.0, 150.0);
                    final double my = (h * 0.065).clamp(28.0, 72.0);
                    return Padding(
                      padding: EdgeInsets.symmetric(horizontal: mx, vertical: my),
                      child: Container(
                        decoration: BoxDecoration(
                          color: cardBg,
                          borderRadius: BorderRadius.circular(24),
                          border: Border.all(color: cardBorder),
                        ),
                        child: compact
                            ? _buildFormColumn()
                            : Row(
                                crossAxisAlignment: CrossAxisAlignment.stretch,
                                children: <Widget>[
                                  Expanded(flex: 47, child: _buildFormColumn()),
                                  Expanded(flex: 53, child: _buildRobotPanel()),
                                ],
                              ),
                      ),
                    );
                  },
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  // ═══════════════════════════════════════════════════════════
  // 左侧表单列
  // ═══════════════════════════════════════════════════════════

  Widget _buildFormColumn() {
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(56, 52, 56, 36),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const Text(
              "NEXTBOT",
              style: TextStyle(
                fontFamily: AppTheme.appFontFamily,
                fontSize: 14,
                height: 1.2,
                fontWeight: FontWeight.w700,
                letterSpacing: 3.2,
                color: textPrimary,
              ),
            ),
            const SizedBox(height: 48),
            const Text(
              "创建账号",
              style: TextStyle(
                fontFamily: AppTheme.appFontFamily,
                fontSize: 32,
                height: 1.25,
                fontWeight: FontWeight.w700,
                color: textPrimary,
              ),
            ),
            const SizedBox(height: 10),
            const Text(
              "注册后，即刻开启我们的旅程",
              style: TextStyle(
                fontFamily: AppTheme.appFontFamily,
                fontSize: 14,
                height: 1.5,
                color: textSecondary,
              ),
            ),
            const SizedBox(height: 44),
            _buildField(
              label: "邮箱",
              controller: _emailCtrl,
              focus: _emailFocus,
              hint: "you@example.com",
              error: _emailError,
              obscure: false,
              enabled: !_registered,
            ),
            const SizedBox(height: 22),
            _buildField(
              label: "密码",
              controller: _passwordCtrl,
              focus: _passwordFocus,
              hint: "至少 8 位，含字母与数字",
              error: _passwordError,
              obscure: true,
              enabled: !_registered,
            ),
            const SizedBox(height: 22),
            _buildField(
              label: "确认密码",
              controller: _confirmCtrl,
              focus: _confirmFocus,
              hint: "再次输入密码",
              error: _confirmError,
              obscure: true,
              enabled: !_registered,
              onSubmitted: (_) => unawaited(_submit()),
            ),
            const SizedBox(height: 36),
            if (_apiError != null) ...<Widget>[
              Text(
                _apiError!,
                style: const TextStyle(
                  fontFamily: AppTheme.appFontFamily,
                  fontSize: 12,
                  height: 1.3,
                  color: errorRed,
                ),
              ),
              const SizedBox(height: 12),
            ],
            _buildSubmitButton(),
            const SizedBox(height: 40),
            _buildLoginRow(),
          ],
        ),
      ),
    );
  }

  Widget _buildField({
    required String label,
    required TextEditingController controller,
    required FocusNode focus,
    required String hint,
    required String? error,
    required bool obscure,
    required bool enabled,
    ValueChanged<String>? onSubmitted,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          label,
          style: const TextStyle(
            fontFamily: AppTheme.appFontFamily,
            fontSize: 13,
            height: 1.3,
            fontWeight: FontWeight.w600,
            color: textPrimary,
          ),
        ),
        const SizedBox(height: 8),
        AnimatedBuilder(
          animation: focus,
          builder: (BuildContext context, Widget? _) {
            final bool hasFocus = focus.hasFocus;
            final Color border = error != null
                ? fieldBorderError
                : (hasFocus ? fieldBorderFocused : fieldBorder);
            return Container(
              height: 48,
              decoration: BoxDecoration(
                color: fieldBg,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: border, width: 1),
              ),
              padding: const EdgeInsets.symmetric(horizontal: 16),
              alignment: Alignment.centerLeft,
              child: TextField(
                controller: controller,
                focusNode: focus,
                obscureText: obscure,
                enabled: enabled,
                onSubmitted: onSubmitted,
                style: const TextStyle(
                  fontFamily: AppTheme.appFontFamily,
                  fontSize: 14,
                  color: textPrimary,
                ),
                cursorColor: textPrimary,
                decoration: InputDecoration(
                  isCollapsed: true,
                  // 页面自绘容器边框，TextField 自身四种边框全部关掉，
                  // 避免主题 InputDecorationTheme 在容器内再画一圈
                  border: InputBorder.none,
                  enabledBorder: InputBorder.none,
                  focusedBorder: InputBorder.none,
                  disabledBorder: InputBorder.none,
                  errorBorder: InputBorder.none,
                  hintText: hint,
                  hintStyle: const TextStyle(
                    fontFamily: AppTheme.appFontFamily,
                    fontSize: 14,
                    color: textMuted,
                  ),
                ),
              ),
            );
          },
        ),
        if (error != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              error,
              style: const TextStyle(
                fontFamily: AppTheme.appFontFamily,
                fontSize: 12,
                height: 1.3,
                color: errorRed,
              ),
            ),
          ),
      ],
    );
  }

  Widget _buildSubmitButton() {
    final bool busy = _submitting;
    final bool done = _registered;
    return MouseRegion(
      cursor: (busy || done) ? SystemMouseCursors.basic : SystemMouseCursors.click,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 160),
        width: double.infinity,
        height: 48,
        decoration: BoxDecoration(
          color: done ? const Color(0xFF2E2E2E) : Colors.white,
          borderRadius: BorderRadius.circular(24),
        ),
        child: TextButton(
          onPressed: busy || done ? null : () => unawaited(_submit()),
          style: TextButton.styleFrom(
            foregroundColor: done ? textSecondary : const Color(0xFF0A0A0A),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(24),
            ),
          ),
          child: busy
              ? const SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(
                    strokeWidth: 2.2,
                    valueColor: AlwaysStoppedAnimation<Color>(Color(0xFF0A0A0A)),
                  ),
                )
              : Text(
                  done ? "✓ 账号创建成功" : "创建账号",
                  style: TextStyle(
                    fontFamily: AppTheme.appFontFamily,
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                    color: done ? textSecondary : const Color(0xFF0A0A0A),
                  ),
                ),
        ),
      ),
    );
  }

  Widget _buildLoginRow() {
    final VoidCallback? go = widget.onGoLogin;
    return Row(
      children: <Widget>[
        Text(
          "已有账号？",
          style: const TextStyle(
            fontFamily: AppTheme.appFontFamily,
            fontSize: 13,
            color: textSecondary,
          ),
        ),
        MouseRegion(
          cursor: SystemMouseCursors.click,
          child: GestureDetector(
            onTap: go,
            child: Text(
              "登录",
              style: TextStyle(
                fontFamily: AppTheme.appFontFamily,
                fontSize: 13,
                fontWeight: FontWeight.w600,
                color: go == null ? textPrimary : textPrimary,
                decoration: TextDecoration.underline,
                decorationColor: textPrimary,
              ),
            ),
          ),
        ),
      ],
    );
  }

  // ═══════════════════════════════════════════════════════════
  // 右侧机器人面板
  // ═══════════════════════════════════════════════════════════

  Widget _buildRobotPanel() {
    return Padding(
      padding: const EdgeInsets.all(20),
      child: Container(
        decoration: BoxDecoration(
          color: panelBg,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: cardBorder),
        ),
        child: LayoutBuilder(
          builder: (BuildContext context, BoxConstraints c) {
            // DG2 机器人头为纯 UI 复刻（CustomPainter，无服务依赖），
            // 大小按设计稿比例：约占面板宽度 2/3，垂直略偏上给台词留位。
            final double headSize = (c.maxWidth * 0.66).clamp(300.0, 420.0);
            return Stack(
              fit: StackFit.expand,
              children: <Widget>[
                // 球体为暗色高光材质，背后垫一圈径向微光增强轮廓对比。
                DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: RadialGradient(
                      center: const Alignment(0, -0.15),
                      radius: 0.55,
                      colors: <Color>[
                        Colors.white.withValues(alpha: 0.07),
                        Colors.white.withValues(alpha: 0.02),
                        Colors.transparent,
                      ],
                      stops: const <double>[0, 0.5, 1],
                    ),
                  ),
                ),
                Center(
                  child: Padding(
                    padding: const EdgeInsets.only(bottom: 96),
                    child: SizedBox(
                      width: headSize,
                      height: headSize,
                      child: const _RobotHead(),
                    ),
                  ),
                ),
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 24,
                  child: Column(
                    children: const <Widget>[
                      _DelayedAppear(
                        delay: Duration(milliseconds: 500),
                        child: _SpeechBubble(text: "嗨，等你挺久了。"),
                      ),
                      SizedBox(height: 14),
                      _DelayedAppear(
                        delay: Duration(milliseconds: 1000),
                        child: _SpeechBubble(text: "你的麻烦事，我全包了。"),
                      ),
                    ],
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════
// 气泡与入场动画
// ═══════════════════════════════════════════════════════════

class _SpeechBubble extends StatelessWidget {
  final String text;

  const _SpeechBubble({required this.text});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
      decoration: BoxDecoration(
        color: _RegisterPageState.pillDark,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: _RegisterPageState.pillBorder),
      ),
      child: Text(
        text,
        style: const TextStyle(
          fontFamily: AppTheme.appFontFamily,
          fontSize: 14,
          height: 1.4,
          color: _RegisterPageState.textPrimary,
        ),
      ),
    );
  }
}

/// 延迟入场：透明度 + 轻微上浮，用于机器人台词先后出现。
class _DelayedAppear extends StatefulWidget {
  final Duration delay;
  final Widget child;

  const _DelayedAppear({required this.delay, required this.child});

  @override
  State<_DelayedAppear> createState() => _DelayedAppearState();
}

class _DelayedAppearState extends State<_DelayedAppear> {
  bool _visible = false;

  @override
  void initState() {
    super.initState();
    Timer(widget.delay, () {
      if (mounted) setState(() => _visible = true);
    });
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedOpacity(
      opacity: _visible ? 1 : 0,
      duration: const Duration(milliseconds: 420),
      curve: Curves.easeOut,
      child: AnimatedSlide(
        offset: _visible ? Offset.zero : const Offset(0, 0.25),
        duration: const Duration(milliseconds: 420),
        curve: Curves.easeOut,
        child: widget.child,
      ),
    );
  }
}
// ═══════════════════════════════════════════════════════════
// DG2 机器人头（纯 UI 复刻，无服务依赖）
// ═══════════════════════════════════════════════════════════

/// 按 agent-sphere-avatar 的 DG2.obj 真实比例复刻的机器人头：
/// 头球直径 10，两侧耳盘直径 7.1（71%）、各凸出头壳 5.7%、位于正中高度
/// （数据来自 obj 顶点簇分析）。纯 CustomPainter 绘制，零外部资源。
class _RobotHead extends StatefulWidget {
  const _RobotHead();

  @override
  State<_RobotHead> createState() => _RobotHeadState();
}

class _RobotHeadState extends State<_RobotHead>
    with SingleTickerProviderStateMixin {
  late final AnimationController _breath = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 3600),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _breath.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _breath,
      builder: (BuildContext context, Widget? _) {
        // 眼睛辉光呼吸：0.72 ~ 1.0，缓慢往复
        final double glow =
            0.72 + 0.28 * Curves.easeInOut.transform(_breath.value);
        return CustomPaint(
          painter: _RobotHeadPainter(glow: glow),
          size: Size.infinite,
        );
      },
    );
  }
}

class _RobotHeadPainter extends CustomPainter {
  /// 眼睛辉光强度（0~1，呼吸动画驱动）。
  final double glow;

  _RobotHeadPainter({required this.glow});

  @override
  void paint(Canvas canvas, Size size) {
    final double w = size.width;
    final double h = size.height;
    final Offset c = Offset(w / 2, h * 0.5);
    final double headR = math.min(w, h) * 0.5 * 0.96;

    // ── 两侧耳盘（DG2：直径 0.71×头径，凸出 5.7%，画在头壳后面）──
    final double earR = headR * 0.355;
    final double earDx = headR * 0.775;
    for (final int sign in const <int>[-1, 1]) {
      final Offset ec = c.translate(sign * earDx, 0);
      final Rect earRect = Rect.fromCircle(center: ec, radius: earR);
      canvas.drawCircle(
        ec,
        earR,
        Paint()
          ..shader = RadialGradient(
            center: const Alignment(-0.3, -0.3),
            radius: 1.1,
            colors: <Color>[
              const Color(0xFF3E4450),
              const Color(0xFF181C23),
              const Color(0xFF07080C),
            ],
            stops: const <double>[0, 0.55, 1],
          ).createShader(earRect),
      );
      // 耳盘外缘冷光弧
      canvas.drawArc(
        earRect.deflate(earR * 0.08),
        _deg(sign > 0 ? -80 : 160),
        _deg(100),
        false,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = earR * 0.07
          ..strokeCap = StrokeCap.round
          ..color = const Color(0x249FB6D0),
      );
    }

    // ── 头壳球体：左上冷光 → 深黑，暗色金属质感 ──
    final Rect headRect = Rect.fromCircle(center: c, radius: headR);
    canvas.drawCircle(
      c,
      headR,
      Paint()
        ..shader = RadialGradient(
          focal: const Alignment(-0.42, -0.48),
          focalRadius: 0.12,
          radius: 1.02,
          colors: const <Color>[
            Color(0xFF4A5262),
            Color(0xFF1B202A),
            Color(0xFF06070B),
          ],
          stops: const <double>[0, 0.5, 1],
        ).createShader(headRect),
    );
    // 头壳左上边缘高光弧
    canvas.drawArc(
      headRect.deflate(headR * 0.045),
      _deg(-152),
      _deg(64),
      false,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = headR * 0.045
        ..strokeCap = StrokeCap.round
        ..color = const Color(0x3DAFC4DE),
    );
    // 右下青色环境反光（呼吸同步）
    canvas.drawArc(
      headRect.deflate(headR * 0.06),
      _deg(28),
      _deg(48),
      false,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = headR * 0.05
        ..strokeCap = StrokeCap.round
        ..color = Color.lerp(
            const Color(0x0A5FE8FF), const Color(0x2E5FE8FF), glow)!,
    );

    // ── 面部玻璃穹顶：近黑 + 顶部斜向高光 ──
    final double faceR = headR * 0.80;
    final Rect faceRect = Rect.fromCircle(center: c.translate(0, headR * 0.02), radius: faceR);
    canvas.drawCircle(
      faceRect.center,
      faceR,
      Paint()
        ..shader = RadialGradient(
          center: const Alignment(-0.3, -0.35),
          radius: 1.15,
          colors: const <Color>[
            Color(0xFF11161E),
            Color(0xFF05070C),
            Color(0xFF020305),
          ],
          stops: const <double>[0, 0.55, 1],
        ).createShader(faceRect),
    );
    // 玻璃斜向高光（两道，右上 → 左下）
    canvas.drawArc(
      faceRect.deflate(faceR * 0.07),
      _deg(-168),
      _deg(52),
      false,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = faceR * 0.085
        ..strokeCap = StrokeCap.round
        ..color = const Color(0x16FFFFFF),
    );
    canvas.drawArc(
      faceRect.deflate(faceR * 0.15),
      _deg(-102),
      _deg(26),
      false,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = faceR * 0.05
        ..strokeCap = StrokeCap.round
        ..color = const Color(0x0DFFFFFF),
    );

    // ── 眼睛：两道 ∩ 形发光弧（青色，呼吸辉光）──
    final double eyeDx = faceR * 0.42;
    final double eyeDy = faceR * 0.06;
    final double eyeR = faceR * 0.21;
    final double eyeStroke = faceR * 0.115;

    // 眼下穹顶青色余晖（大而淡）
    canvas.drawCircle(
      c.translate(0, faceR * 0.30),
      faceR * 0.5,
      Paint()
        ..color = Color.lerp(
            const Color(0x005FE8FF), const Color(0x165FE8FF), glow)!
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 24),
    );

    for (final int sign in const <int>[-1, 1]) {
      final Offset eyeC = c.translate(sign * eyeDx, eyeDy);
      final Rect eyeRect = Rect.fromCircle(center: eyeC, radius: eyeR);

      // 外层辉光（模糊放大）
      canvas.drawArc(
        eyeRect,
        _deg(196),
        _deg(148),
        false,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = eyeStroke * (1.0 + 1.1 * glow)
          ..strokeCap = StrokeCap.round
          ..color = Color.lerp(
              const Color(0x335FE8FF), const Color(0xA65FE8FF), glow)!
          ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 10),
      );
      // 实体弧（青色渐变，上亮下深）
      canvas.drawArc(
        eyeRect,
        _deg(198),
        _deg(144),
        false,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = eyeStroke
          ..strokeCap = StrokeCap.round
          ..shader = LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: <Color>[
              Color.lerp(const Color(0xFF9FF3FF), const Color(0xFFD9FBFF), glow)!,
              const Color(0xFF2FC9EC),
            ],
          ).createShader(eyeRect),
      );
    }
  }

  static double _deg(double d) => d * math.pi / 180;

  @override
  bool shouldRepaint(_RobotHeadPainter oldDelegate) => oldDelegate.glow != glow;
}
