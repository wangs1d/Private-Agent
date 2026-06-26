import "package:flutter/material.dart";


/// WebView 预热池：在应用启动阶段提前创建并初始化 Agent 球体 WebView 控制器，
/// 避免首次进入聊天页时才冷启动 WebView 引擎（引擎初始化、JS 上下文、资源加载）
/// 带来的可见延迟。实际需要球体时通过 [AgentSphereWebViewWarmup.consumeWarmed]
/// 取走已预热实例直接复用，省去冷启动开销。
///
/// 当前为非 Web / 非 Windows 平台占位；真实平台实现应在此处替换为对应控制器
/// （如 Web 的 `WebViewxController` / Windows 的 `InAppWebViewController`）的预热逻辑。
class AgentSphereWebViewWarmup {
  AgentSphereWebViewWarmup._();

  /// 预热的控制器占位（真实平台实现会替换为具体控制器类型）。
  static Object? _warmedController;
  static bool _prewarming = false;

  /// 应用启动时调用：异步创建并预热一个 WebView 控制器，放入预热池待复用。
  static Future<void> prewarm() async {
    if (_warmedController != null || _prewarming) return;
    _prewarming = true;
    try {
      // TODO(platform): 在 Web/Windows 平台替换为真实控制器创建与预热逻辑（加载空白页、注入基础 JS 等）。
      await Future<void>.delayed(Duration.zero);
      _warmedController = Object();
    } finally {
      _prewarming = false;
    }
  }

  /// 球体 WebView 需要时调用：若预热池中有可用实例则取走复用，否则返回 null。
  static Object? consumeWarmed() {
    final Object? c = _warmedController;
    _warmedController = null;
    return c;
  }

  /// 释放预热池中未被复用的实例（如应用退出时调用，避免悬空资源）。
  static void discard() {
    _warmedController = null;
  }
}

/// 非 Web / 非 Windows 平台占位
class AgentSphereWebView extends StatelessWidget {
  const AgentSphereWebView({
    super.key,
    this.showOverlayButton = true,
    this.onDragDelta,
    this.onDragStart,
    this.onDragEnd,
    this.visible = true,
  });

  final bool showOverlayButton;
  final ValueChanged<Offset>? onDragDelta;
  final VoidCallback? onDragStart;
  final VoidCallback? onDragEnd;
  final bool visible;

  @override
  Widget build(BuildContext context) {
    // 尝试复用预热实例：若预热池中有可用控制器则取走，避免冷启动。
    // 占位平台无需真正使用，但保留该消费点以便真实实现接入。
    AgentSphereWebViewWarmup.consumeWarmed();
    return Container(
      color: Colors.transparent,
      alignment: Alignment.center,
      child: Text(
        "3D Agent 需 Web 或 Windows 客户端",
        style: TextStyle(color: Colors.white.withValues(alpha: 0.6), fontSize: 12),
        textAlign: TextAlign.center,
      ),
    );
  }
}
