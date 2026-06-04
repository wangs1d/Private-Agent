import "dart:async";
import "dart:typed_data";

import "package:flutter/material.dart";
import "package:qr_flutter/qr_flutter.dart";

import "../../core/config/api_config.dart";
import "../../core/services/wechat_claw_api_client.dart";
import "../../core/theme/app_theme.dart";

/// 侧栏入口：立即弹出绑定窗，并行拉取状态与二维码。
Future<void> openWechatClawBinding(BuildContext context) async {
  final WechatClawApiClient api = WechatClawApiClient(baseUrl: ApiConfig.httpBase);

  final bool? ok = await showDialog<bool>(
    context: context,
    barrierDismissible: true,
    builder: (BuildContext ctx) => WechatClawBindingDialog(api: api),
  );
  if (ok == true && context.mounted) {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text("微信 Claw 绑定成功")),
    );
  }
}

Future<void> _showBoundDialog(
  BuildContext context,
  WechatClawApiClient api,
  WechatClawStatus status,
) async {
  final bool? unbind = await showDialog<bool>(
    context: context,
    builder: (BuildContext ctx) => AlertDialog(
      title: const Text("微信 Claw 已绑定"),
      content: Text(
        "Agent：${status.actorId}\n"
        "Gateway：${status.channelConnected ? "在线" : "离线"}",
      ),
      actions: <Widget>[
        TextButton(
          onPressed: () => Navigator.pop(ctx, false),
          child: const Text("关闭"),
        ),
        TextButton(
          onPressed: () => Navigator.pop(ctx, true),
          child: const Text("解除绑定"),
        ),
      ],
    ),
  );
  if (unbind != true || !context.mounted) return;

  final WechatClawApiResult<void> res = await api.unbind();
  if (!context.mounted) return;
  ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(
      content: Text(res.ok ? "已解除微信 Claw 绑定" : (res.error ?? "解除绑定失败")),
    ),
  );
}

/// 绑定弹窗：先展示 UI，并行检查状态 + 拉取二维码 + 服务端长轮询等待扫码。
class WechatClawBindingDialog extends StatefulWidget {
  const WechatClawBindingDialog({super.key, required this.api});

  final WechatClawApiClient api;

  @override
  State<WechatClawBindingDialog> createState() => _WechatClawBindingDialogState();
}

class _WechatClawBindingDialogState extends State<WechatClawBindingDialog> {
  String? _qrLink;
  String? _qrDataUrl;
  Uint8List? _qrImageBytes;
  String? _message;
  String? _error;
  bool _loadingQr = true;
  bool _waitingScan = false;
  bool _cancelled = false;

  @override
  void initState() {
    super.initState();
    unawaited(_bootstrap());
  }

  @override
  void dispose() {
    _cancelled = true;
    super.dispose();
  }

  void _applyLoginQr(WechatClawLoginResult login) {
    final String link = normalizeLiteappQrLink(login.qrLink);
    if (link.isNotEmpty) {
      _qrLink = link;
    }
    final String? dataUrl = login.qrDataUrl?.trim();
    if (dataUrl == null || dataUrl.isEmpty || dataUrl == _qrDataUrl) return;
    _qrDataUrl = dataUrl;
    final List<int>? decoded = decodeQrDataUrl(dataUrl);
    if (decoded != null) {
      _qrImageBytes = Uint8List.fromList(decoded);
    }
  }

  bool get _hasQrVisual {
    final String link = _qrLink?.trim() ?? "";
    if (link.isNotEmpty) return true;
    if (_qrImageBytes != null) return true;
    return isQrHttpUrl(_qrDataUrl);
  }

  Future<void> _bootstrap() async {
    unawaited(_loadQr(force: false));
    unawaited(_waitForScanLoop());

    final WechatClawApiResult<WechatClawStatus> status =
        await widget.api.fetchStatus();
    if (!mounted || _cancelled) return;

    if (status.ok && status.value?.bound == true) {
      _cancelled = true;
      Navigator.pop(context);
      if (mounted) {
        await _showBoundDialog(context, widget.api, status.value!);
      }
    }
  }

  Future<void> _loadQr({required bool force}) async {
    setState(() {
      _loadingQr = true;
      _error = null;
      if (force) {
        _qrLink = null;
        _qrDataUrl = null;
        _qrImageBytes = null;
      }
    });

    final WechatClawApiResult<WechatClawLoginResult> start =
        await widget.api.startLogin(force: force);
    if (!mounted || _cancelled) return;

    if (!start.ok || start.value == null) {
      setState(() {
        _loadingQr = false;
        _error = start.error ?? "无法获取二维码";
      });
      return;
    }

    final WechatClawLoginResult login = start.value!;
    if (login.connected) {
      Navigator.pop(context, true);
      return;
    }

    _applyLoginQr(login);
    setState(() {
      _loadingQr = false;
      _message = login.message;
      _error = !_hasQrVisual ? (login.message ?? "未返回二维码") : null;
    });
  }

  Future<void> _waitForScanLoop() async {
    await Future<void>.delayed(const Duration(milliseconds: 400));
    while (mounted && !_cancelled) {
      if (!_hasQrVisual || _loadingQr) {
        await Future<void>.delayed(const Duration(milliseconds: 500));
        continue;
      }

      setState(() {
        _waitingScan = true;
        _error = null;
      });

      final WechatClawApiResult<WechatClawLoginResult> wait = await widget.api.waitLogin(
        qrKnown: _hasQrVisual,
        timeoutMs: 28000,
      );
      if (!mounted || _cancelled) return;

      if (!wait.ok || wait.value == null) {
        setState(() {
          _waitingScan = false;
          _message = wait.networkError
              ? (wait.error ?? "连接中断，正在重试…")
              : (wait.error ?? "仍在等待扫码，请稍候…");
        });
        await Future<void>.delayed(const Duration(milliseconds: 800));
        continue;
      }

      final WechatClawLoginResult result = wait.value!;
      if (result.connected) {
        Navigator.pop(context, true);
        return;
      }

      final String? nextMessage = result.message;
      final String prevLink = _qrLink ?? "";
      _applyLoginQr(result);
      final bool qrChanged = (_qrLink ?? "") != prevLink;

      setState(() {
        _waitingScan = false;
        if (nextMessage != null && nextMessage.isNotEmpty) {
          _message = nextMessage;
        }
      });

      if (qrChanged) {
        setState(() {});
      }
    }
  }

  Widget _qrChild() {
    final String qrLink = _qrLink?.trim() ?? "";
    if (_loadingQr) {
      return const CircularProgressIndicator();
    }
    if (qrLink.isNotEmpty) {
      return QrImageView(
        data: qrLink,
        size: 220,
        version: QrVersions.auto,
        errorCorrectionLevel: QrErrorCorrectLevel.M,
        backgroundColor: Colors.white,
      );
    }
    if (_qrImageBytes != null) {
      return Image.memory(
        _qrImageBytes!,
        fit: BoxFit.contain,
        gaplessPlayback: true,
        filterQuality: FilterQuality.low,
      );
    }
    if (isQrHttpUrl(_qrDataUrl)) {
      return Image.network(
        _qrDataUrl!,
        fit: BoxFit.contain,
        gaplessPlayback: true,
        filterQuality: FilterQuality.low,
      );
    }
    return Icon(
      Icons.qr_code_2_rounded,
      size: 140,
      color: Colors.black.withValues(alpha: 0.35),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Dialog(
      backgroundColor: AppPalette.locationDialogBg,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: const BorderSide(color: AppPalette.locationDialogBorder),
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 360),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(22, 20, 22, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              const Text(
                "绑定微信 Claw",
                style: TextStyle(
                  color: AppPalette.locationDialogTitle,
                  fontSize: 18,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 16),
              RepaintBoundary(
                child: Container(
                  width: 240,
                  height: 240,
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: AppPalette.locationDialogBorder),
                  ),
                  alignment: Alignment.center,
                  child: _qrChild(),
                ),
              ),
              const SizedBox(height: 14),
              Text(
                _error ??
                    _message ??
                    (_waitingScan ? "等待微信扫码确认…" : "请使用微信扫描上方二维码"),
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: (_error != null
                          ? Colors.redAccent
                          : AppPalette.locationDialogBody)
                      .withValues(alpha: 0.92),
                  fontSize: 14,
                  height: 1.5,
                ),
              ),
              if (!_loadingQr && _hasQrVisual && _error == null)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    _waitingScan
                        ? "请在微信中确认授权；若微信提示网络错误，请点下方重新获取二维码"
                        : "扫码后在手机上确认授权",
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 12,
                      color: AppPalette.locationDialogBody.withValues(alpha: 0.75),
                    ),
                  ),
                ),
              if (_error != null && !_loadingQr)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: TextButton(
                    onPressed: () => unawaited(_loadQr(force: true)),
                    child: const Text("重新获取二维码"),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

bool isQrHttpUrl(String? dataUrl) {
  if (dataUrl == null || dataUrl.isEmpty) return false;
  return RegExp(r"^https?://").hasMatch(dataUrl.trim());
}

/// liteapp 链接需带 bot_type=3，否则微信扫码常报「网络错误」。
String normalizeLiteappQrLink(String? url) {
  final String trimmed = url?.trim() ?? "";
  if (trimmed.isEmpty || !trimmed.contains("liteapp.weixin.qq.com")) {
    return trimmed;
  }
  if (RegExp(r"[?&]bot_type=", caseSensitive: false).hasMatch(trimmed)) {
    return trimmed;
  }
  return "$trimmed${trimmed.contains("?") ? "&" : "?"}bot_type=3";
}
