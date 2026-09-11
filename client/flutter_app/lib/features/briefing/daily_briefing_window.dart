import "dart:async";
import "dart:convert";
import "dart:io";
import "dart:math";

import "package:flutter/material.dart";
import "package:flutter/services.dart";
import "package:http/http.dart" as http;
import "package:webview_windows/webview_windows.dart";
import "package:window_manager/window_manager.dart";

import "../../core/config/api_config.dart";
import "../../core/services/access_auth_api.dart";
import "../../core/services/daily_briefing_card_model.dart";
import "../../core/services/tts_player.dart";
import "../../core/services/windows_webview_bootstrap.dart";

// ═══════════════════════════════════════════════════════════════════
// 今日简报独立系统窗口（WebView 版，一比一还原 design/daily-briefing-
// floating.html「优化版 · 黑 · 简洁」设计稿）。
//
// 与行程规划窗口（travel_plan_window.dart）同款「独立进程」方案：主应用
// 把简报数据写到临时文件后 spawn 自己的 exe，并经环境变量传递文件路径；
// 子进程 main() 检测到该环境变量即走本文件的窗口分支。
//
// 为什么用独立进程 + WebView：设计稿是玻璃拟态 + CSS 动画，GDI 自绘还原
// 度不足；而 webview_windows 插件需要完整插件注册的 Flutter 引擎，独立
// 进程天然具备（行程地图 WebView 同理）。
//
// 交互契约（HTML JS bridge → Dart）：
//   postMessage {action:"close"}  → 销毁窗口退出进程
//   postMessage {action:"drag"}   → startDragging（顶部问候区拖动）
//   postMessage {action:"click"}  → 播报中=打断 / 空闲=重播
//   postMessage {action:"expand", open:bool} → Dart 同步调整窗口高度
// Dart → JS：executeScript 调 window.__setPlaying(posMs, durMs) /
//   window.__setIdle(label) 驱动播报行形态。
// ═══════════════════════════════════════════════════════════════════

/// 子进程窗口模式的环境变量名（值为载荷 JSON 文件路径）。
const String kDailyBriefingWindowEnv = "PAI_DAILY_BRIEFING_WINDOW";

/// 单字常见姓氏（与 server appellation.ts 同源的启发式子集）：
/// 用于把"连名带姓的 displayName"得体化为「姓氏+先生」。
const String _kCommonSingleSurnames =
    "王李张刘陈杨黄赵吴周徐孙马朱胡郭何林罗高郑梁谢宋唐许韩冯邓曹彭曾肖田董"
    "潘袁蔡蒋余于杜叶程魏苏吕丁任卢姚沈钟姜崔谭陆范汪廖石金韦贾夏付方邹熊白"
    "孟秦邱侯江尹薛闫段雷龙黎史陶贺毛郝顾龚邵万钱严覃武戴莫孔向汤温康施文柯"
    "柴倪凌米谷代桂";

/// 常见复姓（ displayName 以复姓开头时截复姓）。
const List<String> _kCompoundSurnames = [
  "欧阳", "司马", "上官", "诸葛", "东方", "夏侯", "皇甫", "尉迟", "公孙",
  "令狐", "慕容", "司徒", "长孙", "宇文", "南宫", "西门", "独孤", "司空",
];

/// 尾缀称谓词（王哥/王总/王先生/老王…）或昵称前缀（老王/小张/阿强）→
/// 本身就是得体称呼，原样保留。
final RegExp _kHonorificTail =
    RegExp(r"(先生|女士|小姐|老师|教授|博士|医生|大夫|老板|同学|哥|姐|弟|妹|叔|姨|伯|婶|舅|总|工|师)$");
final RegExp _kNicknameHead = RegExp(r"^(老|小|阿|大)");

/// 注册 displayName 得体化（业务硬规则：问候绝不直呼大名）。
/// 「王铭川」→「王先生」、「欧阳文山」→「欧阳先生」；已是称呼（王哥/老王/
/// Tony…）原样返回；无法判断时原样返回（宁可不改也不误伤用户指定的称呼）。
String politeDisplayName(String raw) {
  final v = raw.trim().replaceAll(RegExp(r"\s+"), "");
  if (v.isEmpty) return v;
  if (_kHonorificTail.hasMatch(v) || _kNicknameHead.hasMatch(v)) return v;
  final cjk = RegExp(r"^[\u4e00-\u9fff]{2,4}$");
  if (!cjk.hasMatch(v)) return v;

  for (final compound in _kCompoundSurnames) {
    if (v.startsWith(compound)) {
      return v.length >= 3 ? "$compound先生" : v;
    }
  }
  final head = v.substring(0, 1);
  if (!_kCommonSingleSurnames.contains(head)) return v;
  if (v.length == 2) {
    final tail = v.substring(1);
    if (_kHonorificTail.hasMatch(tail)) return v;
  }
  return "$head先生";
}

/// 卡片逻辑宽（= 设计稿宽，Flutter 逻辑像素与 CSS 像素 1:1）。
const double kCardWidth = 400;

/// 简报窗口载荷：口播稿 + 结构化简报 + 用户称呼。
class DailyBriefingWindowPayload {
  const DailyBriefingWindowPayload({
    required this.narrationText,
    required this.briefing,
    this.appellation = "",
  });

  final String narrationText;
  final Map<String, dynamic> briefing;

  /// 用户称呼（账号注册 displayName，如「王先生」）；空表示无称呼。
  final String appellation;

  String encode() => jsonEncode(<String, dynamic>{
        "version": 2,
        "narrationText": narrationText,
        "briefing": briefing,
        "appellation": appellation,
      });

  /// 解码失败（文件损坏/版本不符）时返回 null，宿主展示错误兜底。
  static DailyBriefingWindowPayload? tryDecode(String raw) {
    try {
      final Object? decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) return null;
      final Object? rawBriefing = decoded["briefing"];
      if (rawBriefing is! Map) return null;
      return DailyBriefingWindowPayload(
        narrationText: decoded["narrationText"]?.toString() ?? "",
        briefing: rawBriefing.cast<String, dynamic>(),
        appellation: decoded["appellation"]?.toString() ?? "",
      );
    } catch (_) {
      return null;
    }
  }
}

/// 简报独立窗口启动器（主应用侧调用）。
///
/// spawn 本应用 exe 并以环境变量传递载荷文件；同一时刻至多保留一个简报
/// 窗口——再次打开时结束旧进程，新简报取而代之。
class DailyBriefingWindowLauncher {
  DailyBriefingWindowLauncher._();

  static Process? _current;

  /// 称呼缓存（账号 displayName）：进程内只查一次，失败记空串不再重试。
  static String? _appellationCache;

  /// 用户称呼：取账号注册的 displayName（GET /accounts/me），如「王先生」。
  /// 未注册 / 接口失败 → 空串（问候退化为不带称呼）。
  static Future<String> resolveAppellation() async {
    final String? cached = _appellationCache;
    if (cached != null) return cached;
    try {
      final Uri uri = Uri
          .parse("${ApiConfig.httpBase}/accounts/me")
          .replace(queryParameters: ApiConfig.accountAuthQuery);
      final http.Response res = await http
          .get(uri, headers: AccessCredentialStore.instance.authHeaders)
          .timeout(const Duration(seconds: 4));
      if (res.statusCode == 200) {
        final Map<String, dynamic> data =
            jsonDecode(res.body) as Map<String, dynamic>;
        final Object? rawAccount = data["account"];
        if (data["registered"] == true && rawAccount is Map) {
          final String name =
              (rawAccount.cast<String, dynamic>()["displayName"] ?? "")
                  .toString()
                  .trim();
          // 业务硬规则：displayName 常是注册大名，问候前先得体化
          // （王铭川 → 王先生），绝不直呼大名。
          _appellationCache = politeDisplayName(name);
          return _appellationCache ?? "";
        }
      }
    } catch (_) {
      // 查询失败：本次不带称呼，不打断简报展示
    }
    _appellationCache = "";
    return "";
  }

  /// 尝试在独立系统窗口中展示简报；成功返回 true。
  /// 失败（非 Windows / spawn 失败）时由调用方退回通知/对话框路径。
  ///
  /// [appellation]：服务端简报已解析的用户称呼（记忆 user_profile）；
  /// 缺失时回退到账号 displayName（resolveAppellation）。
  static Future<bool> open({
    required String narrationText,
    required Map<String, dynamic> briefing,
    String? appellation,
  }) async {
    if (!Platform.isWindows) return false;
    try {
      final String resolvedAppellation =
          (appellation != null && appellation.trim().isNotEmpty)
              ? appellation.trim()
              : await resolveAppellation();
      final File payloadFile = await _writePayloadFile(
        DailyBriefingWindowPayload(
          narrationText: narrationText,
          briefing: briefing,
          appellation: resolvedAppellation,
        ),
      );
      // 旧窗口仍在 → 结束旧进程后重开，保证"最新简报在前"
      _current?.kill();
      final Process process = await Process.start(
        Platform.resolvedExecutable,
        const <String>[],
        environment: <String, String>{
          ...Platform.environment,
          kDailyBriefingWindowEnv: payloadFile.path,
        },
      );
      // 排空子进程 stdout/stderr：debug 构建日志量大，管道塞满会卡死子进程
      unawaited(process.stdout.drain<void>());
      unawaited(process.stderr.drain<void>());
      unawaited(process.exitCode.then((_) {
        if (identical(_current, process)) _current = null;
      }));
      _current = process;
      return true;
    } catch (_) {
      return false;
    }
  }

  /// 载荷写入 %TEMP%（子进程读取后自行删除）。
  static Future<File> _writePayloadFile(DailyBriefingWindowPayload payload) async {
    final String tempDir = Platform.environment["TEMP"] ??
        Platform.environment["TMP"] ??
        Directory.systemTemp.path;
    final String path = "$tempDir${Platform.pathSeparator}pai_daily_briefing_"
        "${DateTime.now().microsecondsSinceEpoch}.json";
    return File(path).writeAsString(payload.encode(), flush: true);
  }
}

// ═══════════════════════════════════════════════════════════════════
// 子进程窗口分支（main() 检测到环境变量后进入）
// ═══════════════════════════════════════════════════════════════════

/// 独立简报窗口的子进程入口：读载荷 → 配置窗口 → runApp。
///
/// 由 main() 在启动最早期调用（不 bootstrap 完整应用）。
Future<void> runDailyBriefingWindow(String payloadPath) async {
  DailyBriefingWindowPayload? payload;
  try {
    final String raw = await File(payloadPath).readAsString();
    unawaited(_deleteQuietly(payloadPath));
    payload = DailyBriefingWindowPayload.tryDecode(raw);
  } catch (_) {
    payload = null;
  }

  // WebView2 环境与访问凭据与主应用同款预热（TTS / 简报数据走 httpBase 直连）。
  // 环境初始化必须先于下方 WebviewController.initialize() 完成——
  // await 而非 unawaited，否则存在初始化竞争导致控制器创建失败。
  await bootstrapWindowsWebView();
  unawaited(AccessCredentialStore.instance.load());

  await windowManager.ensureInitialized();
  // 窗口用不透明深底 + 原生 DWM 系统圆角（runner 侧对简报子进程窗口生效）：
  // Flutter Windows 不支持逐像素透明窗口，此前 transparent 底色会在
  // 左侧圆角外留一条不透明残留带。
  const Color windowBg = Color(0xFF0A0B0E);
  final WindowOptions options = WindowOptions(
    size: Size(kCardWidth, collapsedWindowHeight(payload)),
    titleBarStyle: TitleBarStyle.hidden,
    backgroundColor: windowBg,
    title: "今日简报",
  );
  await windowManager.waitUntilReadyToShow(options, () async {
    await windowManager.setAlwaysOnTop(true);
    await windowManager.setBackgroundColor(windowBg);
    await _positionRightCenter();
    // 关键：inactive 显示——开机播报绝不抢走用户正在使用的窗口焦点
    await windowManager.show(inactive: true);
  });
  runApp(DailyBriefingWindowApp(payload: payload));
}

/// 右侧垂直居中定位（贴右缘留 24px）：工作区经同款 runner 的
/// pai/daily_briefing getWorkArea 查询（子进程与主应用运行同一 runner，
/// 通道可用），返回逻辑像素，与 window_manager.setPosition 的坐标系一致。
Future<void> _positionRightCenter() async {
  try {
    const MethodChannel channel = MethodChannel("pai/daily_briefing");
    final Map<dynamic, dynamic>? work =
        await channel.invokeMethod<Map<dynamic, dynamic>>("getWorkArea");
    if (work == null) return;
    final Size size = await windowManager.getSize();
    final double right = (work["right"] as num?)?.toDouble() ?? 0;
    final double left = (work["left"] as num?)?.toDouble() ?? 0;
    final double top = (work["top"] as num?)?.toDouble() ?? 0;
    final double bottom = (work["bottom"] as num?)?.toDouble() ?? 0;
    double x = right - size.width - 24;
    double y = top + ((bottom - top) - size.height) / 2;
    if (x < left) x = left;
    if (y < top) y = top;
    await windowManager.setPosition(Offset(x, y));
  } catch (_) {
    // 查询失败保持默认位置，不影响展示
  }
}

/// 收起态窗口高（逻辑像素）：与 buildBriefingHtml 的 CSS 布局 1:1 对应。
double collapsedWindowHeight(DailyBriefingWindowPayload? payload) {
  const double padTop = 20, greetH = 24, metaGap = 6, metaH = 17;
  const double scriptGap = 15, lineH = 25, rowGap = 15, rowH = 22;
  const double statsGap = 16, statsH = 22, btnGap = 16, btnH = 32;
  const double padBottom = 18;
  final int scriptLen = payload?.narrationText.trim().length ?? 0;
  // 400 - 22*2 内边距 = 356px 内容宽，14px 中文 ≈ 25 字/行
  final int lines = scriptLen == 0 ? 0 : max(1, (scriptLen / 25).ceil());
  final double h = padTop + greetH + metaGap + metaH + scriptGap +
      lines * lineH + (lines > 0 ? rowGap : 0) + rowH +
      statsGap + statsH + btnGap + btnH + padBottom;
  return h;
}

Future<void> _deleteQuietly(String path) async {
  try {
    await File(path).delete();
  } catch (_) {
    // 清理失败无害：文件在 %TEMP%，系统会回收
  }
}

// ═══════════════════════════════════════════════════════════════════
// 子进程窗口宿主：WebView 渲染设计稿 + TTS 播报编排
// ═══════════════════════════════════════════════════════════════════

class DailyBriefingWindowApp extends StatefulWidget {
  const DailyBriefingWindowApp({super.key, required this.payload});

  /// 解码失败时为 null，展示错误兜底。
  final DailyBriefingWindowPayload? payload;

  @override
  State<DailyBriefingWindowApp> createState() => _DailyBriefingWindowAppState();
}

class _DailyBriefingWindowAppState extends State<DailyBriefingWindowApp> {
  final WebviewController _controller = WebviewController();
  bool _webReady = false;
  bool _webFailed = false;
  Timer? _autoHideTimer;
  StreamSubscription<TtsPlaybackProgress>? _progressSub;
  bool _stopRequested = false;
  String? _audioBase64;
  DateTime _lastProgressPush = DateTime.fromMillisecondsSinceEpoch(0);

  DailyBriefingWindowPayload? get _payload => widget.payload;

  @override
  void initState() {
    super.initState();
    TtsPlayer.instance.addOnCompleted(_onPlaybackCompleted);
    _bootstrap();
  }

  @override
  void dispose() {
    _autoHideTimer?.cancel();
    _progressSub?.cancel();
    TtsPlayer.instance.removeOnCompleted(_onPlaybackCompleted);
    super.dispose();
  }

  Future<void> _bootstrap() async {
    try {
      // 双保险：入口处已 await 过，这里兜底（幂等）
      await bootstrapWindowsWebView();
      await _controller.initialize();
      // 与窗口底色一致（不透明深底），避免圆角/边缘露出白底或残留
      await _controller.setBackgroundColor(const Color(0xFF0A0B0E));
      // 注意：setPopupWindowPolicy 内部断言 isInitialized，必须在 initialize 之后
      await _controller.setPopupWindowPolicy(WebviewPopupWindowPolicy.deny);
      _controller.webMessage.listen(_onWebMessage);
      final File htmlFile = await _writeHtmlFile();
      await _controller.loadUrl(htmlFile.uri.toString());
      if (mounted) setState(() => _webReady = true);
      if (_payload != null) {
        unawaited(_speak(_payload!.narrationText.trim()));
      }
      _armAutoHide();
    } catch (e) {
      // WebView 初始化失败：展示兜底文案（而不是隐身退出），自动淡出兜底
      debugPrint("[DailyBriefingWindow] webview bootstrap failed: $e");
      if (mounted) setState(() => _webFailed = true);
      _autoHideTimer = Timer(const Duration(seconds: 30), () {
        unawaited(_close());
      });
    }
  }

  Future<File> _writeHtmlFile() async {
    final String tempDir = Platform.environment["TEMP"] ??
        Platform.environment["TMP"] ??
        Directory.systemTemp.path;
    final String path = "$tempDir${Platform.pathSeparator}"
        "pai_daily_briefing_${DateTime.now().microsecondsSinceEpoch}.html";
    final File file = File(path);
    await file.writeAsString(buildBriefingHtml(_payload), flush: true);
    // 窗口关闭后由 %TEMP% 系统回收，不主动删（WebView2 可能仍持有句柄）
    return file;
  }

  void _armAutoHide() {
    _autoHideTimer?.cancel();
    _autoHideTimer = Timer(const Duration(minutes: 5), () {
      unawaited(_close());
    });
  }

  Future<void> _close() async {
    try {
      await windowManager.destroy();
    } catch (_) {
      // destroy 失败（如窗口未就绪）也继续退出
    }
    // Flutter 进程在最后一个窗口销毁后不会自动退出，显式结束
    exit(0);
  }

  // ---- JS bridge ----

  Future<void> _onWebMessage(dynamic message) async {
    try {
      if (message is! Map) return;
      final Map<dynamic, dynamic> msg = message;
      switch (msg["action"]) {
        case "close":
          await _close();
          break;
        case "drag":
          await windowManager.startDragging();
          break;
        case "click":
          _onCardClicked();
          break;
        case "expand":
          await _syncWindowHeight(msg["open"] == true);
          break;
      }
    } catch (_) {
      // ignore malformed messages
    }
  }

  /// 展开详情 → 窗口高度随之伸长，且保持底边固定（右下角悬浮锚定语义）。
  Future<void> _syncWindowHeight(bool open) async {
    try {
      final Offset origin = await windowManager.getPosition();
      final Size size = await windowManager.getSize();
      final double collapsed = collapsedWindowHeight(_payload);
      final double extra = open ? _detailExtraHeight() : 0;
      final double newH = collapsed + extra;
      if ((size.height - newH).abs() < 1) return;
      await windowManager.setSize(Size(size.width, newH));
      // setSize 以左上角为锚（SWP_NOMOVE），底边会向下伸出屏幕——
      // 按高度差向上补偿，保持底边贴着任务栏上方。
      await windowManager.setPosition(
        Offset(origin.dx, origin.dy - (newH - size.height)),
      );
    } catch (_) {
      // 窗口未就绪等场景忽略
    }
  }

  double _detailExtraHeight() {
    final Map<String, dynamic>? briefing = _payload?.briefing;
    if (briefing == null) return 0;
    int listLen(String key) {
      final Object? raw = briefing[key];
      return raw is List ? raw.length : 0;
    }

    int todoPendingCount() {
      final Object? rawTodo = briefing["todoFollowups"];
      if (rawTodo is! Map) return 0;
      final Object? rawPending = rawTodo["pending"];
      return rawPending is List ? rawPending.length : 0;
    }

    const double labelH = 30, rowH = 34, sectionGap = 10, padH = 20;
    final double scheduleH = listLen("todaySchedule") > 0
        ? labelH + min(listLen("todaySchedule"), 3) * rowH + sectionGap
        : 0;
    final double todosH = todoPendingCount() > 0
        ? labelH + min(todoPendingCount(), 3) * rowH + sectionGap
        : 0;
    final double notesH = listLen("pendingNotes") > 0
        ? labelH + min(listLen("pendingNotes"), 3) * rowH + sectionGap
        : 0;
    if (scheduleH + todosH + notesH <= 0) return 0;
    return scheduleH + todosH + notesH + padH;
  }

  // ---- 语音播报 ----

  Future<void> _speak(String script) async {
    if (script.isEmpty) {
      await _pushIdle("语音暂不可用");
      return;
    }
    try {
      // 注意：authHeaders 未绑定时返回 const map，不能级联修改，需展开合并
      final Map<String, String> headers = <String, String>{
        "Content-Type": "application/json",
        ...AccessCredentialStore.instance.authHeaders,
      };
      debugPrint("[DailyBriefingWindow] tts request -> ${ApiConfig.httpBase}");
      final http.Response res = await http
          .post(
            Uri.parse("${ApiConfig.httpBase}/api/morning-briefing/tts"),
            headers: headers,
            body: jsonEncode(<String, dynamic>{"text": script}),
          )
          .timeout(const Duration(seconds: 15));
      debugPrint("[DailyBriefingWindow] tts response ${res.statusCode} "
          "len=${res.body.length}");
      if (res.statusCode != 200) {
        await _pushIdle("语音暂不可用 · 点击重试");
        return;
      }
      final Map<String, dynamic> data =
          jsonDecode(res.body) as Map<String, dynamic>;
      final String? base64Audio = data["base64"]?.toString();
      if (base64Audio == null || base64Audio.isEmpty) {
        await _pushIdle("语音暂不可用 · 点击重试");
        return;
      }
      _audioBase64 = base64Audio;
      await _playCached();
    } catch (_) {
      await _pushIdle("语音暂不可用 · 点击重试");
    }
  }

  Future<void> _playCached() async {
    final String? audio = _audioBase64;
    if (audio == null) return;
    await _progressSub?.cancel();
    _progressSub = TtsPlayer.instance.onProgress.listen(
      _onPlaybackProgress,
      onError: (_) {},
    );
    final bool ok = await TtsPlayer.instance.playFromBase64(audio);
    if (!ok) await _pushIdle("语音暂不可用 · 点击重试");
  }

  void _onPlaybackProgress(TtsPlaybackProgress progress) {
    // executeScript 有往返成本，节流到 ≥300ms 一次
    final DateTime now = DateTime.now();
    if (now.difference(_lastProgressPush) < const Duration(milliseconds: 300)) {
      return;
    }
    _lastProgressPush = now;
    unawaited(_runJs(
      "window.__setPlaying(${progress.position.inMilliseconds}, "
      "${progress.duration?.inMilliseconds ?? 0});",
    ));
  }

  void _onPlaybackCompleted() {
    final bool stopped = _stopRequested;
    _stopRequested = false;
    final DateTime now = DateTime.now();
    final String label = stopped
        ? "已停止播报 · 点击重播"
        : "已播报 · ${now.hour}:${now.minute.toString().padLeft(2, "0")}";
    unawaited(_pushIdle(label));
  }

  void _onCardClicked() {
    if (TtsPlayer.instance.isPlaying) {
      _stopRequested = true;
      unawaited(TtsPlayer.instance.stop());
      return;
    }
    // 空闲点击 = 重播
    if (_audioBase64 != null) {
      unawaited(_playCached());
    } else if (_payload != null) {
      unawaited(_speak(_payload!.narrationText.trim()));
    }
  }

  Future<void> _pushIdle(String label) async {
    await _runJs("window.__setIdle(${jsonEncode(label)});");
  }

  Future<void> _runJs(String script) async {
    try {
      if (_webReady) await _controller.executeScript(script);
    } catch (e) {
      debugPrint("[DailyBriefingWindow] executeScript failed: $e");
    }
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        scaffoldBackgroundColor: const Color(0xFF0A0B0E),
      ),
      home: Scaffold(
        backgroundColor: const Color(0xFF0A0B0E),
        body: _webReady
            ? Webview(_controller)
            : Container(
                width: kCardWidth,
                padding: const EdgeInsets.all(20),
                alignment: Alignment.centerLeft,
                child: Text(
                  _webFailed ? "简报显示组件加载失败" : "正在加载今日简报…",
                  style: const TextStyle(color: Color(0xFF8F97A3), fontSize: 12),
                ),
              ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// 设计稿 HTML（一比一还原 design/daily-briefing-floating.html）
// ═══════════════════════════════════════════════════════════════════

String _esc(String text) => text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");

/// 口播稿时间高亮：HH:MM → 白色加粗（设计稿 .hl）。
String _highlightScript(String plainEscaped) {
  return plainEscaped.replaceAllMapped(
    RegExp(r"(\d{1,2}:\d{2})"),
    (Match m) => "<b class=\"hl\">${m.group(1)}</b>",
  );
}

String _statsHtml(DailyBriefingCardContent content) {
  if (content.stats.isEmpty) return "";
  final StringBuffer buf = StringBuffer("<div class=\"stats\">");
  for (final DailyBriefingStat stat in content.stats.take(3)) {
    buf.write(
      "<div class=\"stat\"><span class=\"n\">${stat.count}</span>"
      "<span class=\"l\">${_esc(stat.label)}</span></div>",
    );
  }
  buf.write("</div>");
  return buf.toString();
}

String _detailHtml(Map<String, dynamic>? briefing) {
  if (briefing == null) return "";
  List<Map<String, dynamic>> listOf(String key) {
    final Object? raw = briefing[key];
    if (raw is! List) return const <Map<String, dynamic>>[];
    return raw
        .whereType<Map>()
        .map((Map e) => e.cast<String, dynamic>())
        .toList();
  }

  String section(String label, List<Map<String, dynamic>> items,
      {required bool withTime}) {
    if (items.isEmpty) return "";
    final StringBuffer rows = StringBuffer();
    for (final Map<String, dynamic> item in items.take(3)) {
      final String time = withTime ? item["time"]?.toString() ?? "" : "";
      final String title = _esc((item["title"] ?? item["name"] ?? "").toString());
      final String timeHtml =
          withTime ? "<span class=\"tm\">${_esc(time)}</span>" : "";
      rows.write(
        "<div class=\"row-item\">$timeHtml"
        "<div class=\"body\"><div class=\"tt\">$title</div></div></div>",
      );
    }
    return "<div class=\"sec\">"
        "<div class=\"sec-label\">$label</div>$rows</div>";
  }

  List<Map<String, dynamic>> pendingTodos() {
    final Object? rawTodo = briefing["todoFollowups"];
    if (rawTodo is! Map) return const <Map<String, dynamic>>[];
    final Object? rawPending = rawTodo["pending"];
    if (rawPending is! List) return const <Map<String, dynamic>>[];
    return rawPending
        .map((Object? e) => <String, dynamic>{"title": e?.toString() ?? ""})
        .where((Map<String, dynamic> m) => (m["title"] as String).isNotEmpty)
        .toList();
  }

  final String schedule = section("今日日程", listOf("todaySchedule"), withTime: true);
  final String todos = section("待办跟进", pendingTodos(), withTime: false);
  final String notes = section("待复习笔记", listOf("pendingNotes"), withTime: false);
  if (schedule.isEmpty && todos.isEmpty && notes.isEmpty) return "";
  return "<div id=\"detail\">$schedule$todos$notes</div>";
}

/// 生成简报卡片页面（与窗口同尺寸，透明背景 + 圆角卡片）。
String buildBriefingHtml(DailyBriefingWindowPayload? payload) {
  final DailyBriefingCardContent content = payload == null
      ? const DailyBriefingCardContent(
          greeting: "", meta: "", script: "", stats: <DailyBriefingStat>[])
      : buildDailyBriefingCard(
          briefing: payload.briefing,
          narrationText: payload.narrationText,
          appellation: payload.appellation,
        );
  final Map<String, dynamic>? briefing = payload?.briefing;

  final String scriptHtml = content.script.isEmpty
      ? ""
      : "<div class=\"script\">${_highlightScript(_esc(content.script))}</div>";

  return """
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: 100%; height: 100%;
    /* 不透明深底：与窗口/WebView 底色一致，圆角残留由原生 DWM 圆角裁掉 */
    background: rgb(10, 11, 14);
    font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
    user-select: none; overflow: hidden;
    color: #eceff4;
  }
  .widget {
    position: relative;
    width: ${kCardWidth}px;
    min-height: 100%;
    background: rgba(10, 11, 14, 0.86);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 16px;
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.5), inset 1px 0 0 rgba(255, 255, 255, 0.05);
    padding: 20px 22px 18px;
    overflow: hidden;
    cursor: pointer;
  }
  .close {
    position: absolute; top: 8px; right: 8px; z-index: 5;
    width: 34px; height: 34px; border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    color: rgba(255,255,255,0.45); cursor: pointer; transition: all .15s;
  }
  .close:hover { background: rgba(255,255,255,0.12); color: #eceff4; }
  .close svg { width: 16px; height: 16px; }

  .greet .name { font-size: 17px; font-weight: 600; letter-spacing: .3px; }
  .greet .meta { margin-top: 5px; font-size: 12px; color: #8f97a3; letter-spacing: .2px; }

  .script { margin-top: 15px; font-size: 14px; line-height: 25px; color: #ccd2db; letter-spacing: .2px; }
  .script .hl { color: #eceff4; font-weight: 600; }
  .script .hl-amber { color: #f0c052; font-weight: 600; }

  .wave-row { margin-top: 15px; display: flex; align-items: center; gap: 12px; height: 22px; }
  .wave { display: flex; align-items: center; gap: 3px; height: 16px; }
  .wave i { width: 3px; border-radius: 2px; background: #88bbff; animation: bar 1s ease-in-out infinite; }
  .wave i:nth-child(1) { height: 6px; animation-delay: 0s; }
  .wave i:nth-child(2) { height: 12px; animation-delay: .15s; }
  .wave i:nth-child(3) { height: 16px; animation-delay: .3s; }
  .wave i:nth-child(4) { height: 10px; animation-delay: .45s; }
  .wave i:nth-child(5) { height: 13px; animation-delay: .6s; }
  .wave i:nth-child(6) { height: 7px; animation-delay: .75s; }
  .wave i:nth-child(7) { height: 11px; animation-delay: .9s; }
  @keyframes bar { 0%,100% { transform: scaleY(.4); opacity: .5; } 50% { transform: scaleY(1); opacity: 1; } }
  .wave-row .label { font-size: 11px; color: #8f97a3; letter-spacing: 2px; }
  .wave-row .time { margin-left: auto; font-size: 11px; color: #8f97a3; font-variant-numeric: tabular-nums; }

  .idle-row {
    margin-top: 15px; padding-top: 12px; height: 22px;
    border-top: 1px solid rgba(255,255,255,.07);
    display: none; align-items: center; gap: 8px;
    font-size: 11px; color: #8f97a3; letter-spacing: 2px;
  }
  .idle-row .ok { width: 5px; height: 5px; border-radius: 50%; background: #88bbff; box-shadow: 0 0 6px rgba(136,187,255,.8); }

  .stats { margin-top: 16px; display: flex; align-items: center; }
  .stat { flex: 1; display: flex; align-items: baseline; gap: 7px; }
  .stat + .stat { border-left: 1px solid rgba(255,255,255,.07); padding-left: 22px; }
  .stat .n { font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .stat .l { font-size: 11px; color: #8f97a3; letter-spacing: .5px; }

  .foot { margin-top: 16px; }
  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 12px; color: #ccd2db; letter-spacing: 1px;
    padding: 8px 14px; border-radius: 9px; cursor: pointer; transition: all .15s;
    background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.07);
  }
  .btn:hover { background: rgba(255,255,255,.09); color: #eceff4; }
  .btn svg { width: 12px; height: 12px; transition: transform .2s; }
  .btn.open svg { transform: rotate(180deg); }

  #detail { display: none; margin-top: 18px; padding-top: 16px; border-top: 1px solid rgba(255,255,255,.06); }
  .sec { margin-top: 12px; }
  .sec:first-child { margin-top: 0; }
  .sec-label { display: flex; align-items: center; gap: 8px; font-size: 10.5px; color: #8f97a3; letter-spacing: 2px; font-weight: 600; }
  .sec-label::after { content: ""; flex: 1; height: 1px; background: rgba(255,255,255,.06); }
  .row-item { display: flex; align-items: center; gap: 10px; padding: 7px 6px; border-radius: 10px; }
  .row-item .tm { width: 42px; font-size: 12.5px; font-weight: 600; color: #a8c8ff; font-variant-numeric: tabular-nums; flex-shrink: 0; }
  .row-item .tt { font-size: 13px; color: #eceff4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
</head>
<body>
<div class="widget" id="card">
  <div class="close" id="close" title="关闭">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
  </div>

  <div class="greet" id="dragzone">
    <div>
      <div class="name">${_esc(content.greeting)}</div>
      <div class="meta">${_esc(content.meta)}</div>
    </div>
  </div>

  $scriptHtml

  <div class="wave-row" id="row-wave">
    <div class="wave"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
    <div class="label">语音播报中</div>
    <div class="time" id="tprog">00:00 / 00:00</div>
  </div>
  <div class="idle-row" id="row-idle"><span class="ok"></span><span id="idle-label">已播报</span></div>

  ${_statsHtml(content)}

  <div class="foot">
    <div class="btn" id="expand">
      展开详情
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
    </div>
  </div>

  ${_detailHtml(briefing)}
</div>

<script>
  var pai = function (m) { try { window.chrome.webview.postMessage(m); } catch (e) {} };
  function fmt(ms) {
    var t = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(t / 60), s = t % 60;
    var p = function (n) { return n < 10 ? "0" + n : "" + n; };
    return p(m) + ":" + p(s);
  }
  document.getElementById("close").addEventListener("click", function (e) {
    e.stopPropagation(); pai({ action: "close" });
  });
  document.getElementById("expand").addEventListener("click", function (e) {
    e.stopPropagation();
    var d = document.getElementById("detail");
    if (!d) return;
    var open = d.style.display !== "block";
    d.style.display = open ? "block" : "none";
    this.classList.toggle("open", open);
    pai({ action: "expand", open: open });
  });
  // 整卡点击/拖拽判定（此前只绑 greet 区 pointerdown 直接进原生拖拽，
  // 拖拽循环吞掉 click，导致顶部点击不播报）：
  //   按下后位移 ≤6px 松开 = 点击 → 播报/停止/重播；
  //   位移超阈值 = 拖拽 → startDragging（原生接管，不再回吐 click）。
  var card = document.getElementById("card");
  var downX = 0, downY = 0, pressed = false, dragSent = false;
  function onControl(t) { return !!(t && t.closest && t.closest("#close,#expand")); }
  card.addEventListener("pointerdown", function (e) {
    if (e.button !== 0 || onControl(e.target)) return;
    pressed = true; dragSent = false; downX = e.clientX; downY = e.clientY;
  });
  card.addEventListener("pointermove", function (e) {
    if (!pressed || dragSent) return;
    if (Math.abs(e.clientX - downX) > 6 || Math.abs(e.clientY - downY) > 6) {
      dragSent = true;
      pai({ action: "drag" });
    }
  });
  card.addEventListener("pointerup", function (e) {
    if (!pressed) return;
    var wasDrag = dragSent;
    pressed = false; dragSent = false;
    if (!wasDrag && e.button === 0 && !onControl(e.target)) pai({ action: "click" });
  });
  card.addEventListener("pointercancel", function () {
    pressed = false; dragSent = false;
  });
  window.__setPlaying = function (posMs, durMs) {
    document.getElementById("row-wave").style.display = "flex";
    document.getElementById("row-idle").style.display = "none";
    document.getElementById("tprog").textContent = fmt(posMs) + " / " + fmt(durMs || 0);
  };
  window.__setIdle = function (label) {
    document.getElementById("row-wave").style.display = "none";
    document.getElementById("row-idle").style.display = "flex";
    document.getElementById("idle-label").textContent = label;
  };
  // 无详情数据时隐藏「展开详情」（#detail 未生成）
  if (!document.getElementById("detail")) {
    document.getElementById("expand").style.display = "none";
  }
</script>
</body>
</html>
""";
}
