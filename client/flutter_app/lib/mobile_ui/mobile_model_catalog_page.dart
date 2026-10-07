import "dart:async";
import "dart:convert";

import "package:flutter/material.dart";
import "package:http/http.dart" as http;
import "package:url_launcher/url_launcher.dart";

import "../core/config/api_config.dart";
import "mobile_theme.dart";

/// 手机端「模型服务」页(只读目录)。
///
/// GET /api/model-providers 实时读取服务端 config/model-providers.json,
/// 展示已接入的服务商与默认模型。局域网/云端形态下 API Key 在服务端
/// config.env 配置,手机端不存密钥,故只读。
class MobileModelCatalogPage extends StatefulWidget {
  const MobileModelCatalogPage({super.key});

  @override
  State<MobileModelCatalogPage> createState() => _MobileModelCatalogPageState();
}

class _MobileModelCatalogPageState extends State<MobileModelCatalogPage> {
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _providers = const <Map<String, dynamic>>[];

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final Uri uri = Uri.parse("${ApiConfig.httpBase}/api/model-providers");
      final http.Client client = http.Client();
      final http.Response res =
          await client.get(uri).timeout(const Duration(seconds: 15));
      client.close();
      if (res.statusCode != 200) {
        throw Exception("服务端返回 ${res.statusCode}");
      }
      final Map<String, dynamic> body =
          jsonDecode(res.body) as Map<String, dynamic>;
      if (body["ok"] != true) {
        throw Exception(body["error"]?.toString() ?? "未知错误");
      }
      final List<dynamic> providers =
          (body["providers"] as List<dynamic>?) ?? const <dynamic>[];
      if (!mounted) return;
      setState(() {
        _providers = providers.whereType<Map<String, dynamic>>().toList();
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Scaffold(
      backgroundColor: p.background,
      appBar: AppBar(title: const Text("模型服务")),
      body: _buildBody(context, p),
    );
  }

  Widget _buildBody(BuildContext context, MobilePalette p) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.cloud_off_outlined, size: 40, color: p.textMuted),
              const SizedBox(height: 12),
              Text(
                "目录获取失败\n请确认已连接服务器(${ApiConfig.httpBase})",
                textAlign: TextAlign.center,
                style: TextStyle(color: p.textSecondary, fontSize: 14),
              ),
              const SizedBox(height: 16),
              OutlinedButton(onPressed: () => unawaited(_load()), child: const Text("重试")),
            ],
          ),
        ),
      );
    }
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 12),
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
          child: Text(
            "已接入 ${_providers.length} 家模型服务商。切换模型或填写 API Key 在服务器端完成(局域网形态为部署机的 config.env),手机端只读展示。",
            style: TextStyle(color: p.textSecondary, fontSize: 13, height: 1.5),
          ),
        ),
        for (final Map<String, dynamic> provider in _providers)
          _ProviderCard(provider: provider),
        const SizedBox(height: 24),
      ],
    );
  }
}

class _ProviderCard extends StatelessWidget {
  const _ProviderCard({required this.provider});

  final Map<String, dynamic> provider;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    final String name = provider["name"]?.toString() ?? provider["id"]?.toString() ?? "未知服务商";
    final String tagline = provider["tagline"]?.toString() ?? "";
    final String defaultModel = provider["defaultModel"]?.toString() ?? "";
    final List<dynamic> models = (provider["models"] as List<dynamic>?) ?? const <dynamic>[];
    final String? consoleUrl = provider["consoleUrl"]?.toString();
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 8, 16, 0),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  name,
                  style: TextStyle(
                    color: p.textPrimary,
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              Text(
                "${models.length} 个模型",
                style: TextStyle(color: p.textMuted, fontSize: 12),
              ),
            ],
          ),
          if (tagline.isNotEmpty) ...<Widget>[
            const SizedBox(height: 4),
            Text(tagline, style: TextStyle(color: p.textSecondary, fontSize: 13)),
          ],
          if (defaultModel.isNotEmpty) ...<Widget>[
            const SizedBox(height: 10),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: BoxDecoration(
                color: p.background,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(
                "默认 $defaultModel",
                style: TextStyle(color: p.textSecondary, fontSize: 12),
              ),
            ),
          ],
          if (consoleUrl != null && consoleUrl.isNotEmpty) ...<Widget>[
            const SizedBox(height: 10),
            GestureDetector(
              onTap: () => unawaited(
                  launchUrl(Uri.parse(consoleUrl), mode: LaunchMode.externalApplication)),
              child: Text(
                "控制台 ↗",
                style: TextStyle(
                  color: Theme.of(context).colorScheme.primary,
                  fontSize: 13,
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
