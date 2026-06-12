import "dart:async";

import "package:flutter/material.dart";

import "../../core/services/agent_sphere_voice_controller.dart";
import "agent_sphere_webview.dart";

/// 应用内常驻 3D Agent 面板 — 随 Tab 切换保留在同一列，不覆盖功能页。
class AgentSphereFullHost extends StatefulWidget {
  const AgentSphereFullHost({
    super.key,
    this.compact = false,
  });

  /// 侧栏窄面板模式（叠在主导航右侧）
  final bool compact;

  @override
  State<AgentSphereFullHost> createState() => _AgentSphereFullHostState();
}

class _AgentSphereFullHostState extends State<AgentSphereFullHost> {
  final AgentSphereVoiceController _voice = AgentSphereVoiceController.instance;

  @override
  void initState() {
    super.initState();
    _voice.state.addListener(_onVoiceState);
    unawaited(_voice.bootstrap());
  }

  @override
  void dispose() {
    _voice.state.removeListener(_onVoiceState);
    super.dispose();
  }

  void _onVoiceState() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final AgentSphereVoiceState vs = _voice.state.value;
    final bool compact = widget.compact;
    final double statusFontSize = compact ? 12.0 : 14.0;
    final double hintFontSize = compact ? 10.0 : 11.0;

    return ClipRect(
      child: Stack(
        fit: StackFit.expand,
        clipBehavior: Clip.hardEdge,
        children: <Widget>[
          const Positioned.fill(
            child: AgentSphereWebView(showOverlayButton: true),
          ),

        if (vs.isWaitingWake)
          Positioned(
            top: 12,
            left: 0,
            right: 0,
            child: Center(
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
                decoration: BoxDecoration(
                  color: Colors.white.withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(color: Colors.white.withValues(alpha: 0.35)),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Icon(Icons.graphic_eq, size: 16, color: Colors.white.withValues(alpha: 0.78)),
                    const SizedBox(width: 6),
                    Text(
                      "监听唤醒词",
                      style: TextStyle(color: Colors.white.withValues(alpha: 0.82), fontSize: 12),
                    ),
                  ],
                ),
              ),
            ),
          ),

        Positioned(
          top: 8,
          right: 8,
          child: IconButton.filledTonal(
            tooltip: "声纹注册",
            onPressed: _voice.onRequestVoiceprintRegistration,
            icon: Icon(Icons.fingerprint, color: Colors.white.withValues(alpha: 0.75), size: 22),
            style: IconButton.styleFrom(
              backgroundColor: Colors.black.withValues(alpha: 0.35),
            ),
          ),
        ),

        Positioned(
          left: 8,
          top: 8,
          child: IconButton.filledTonal(
            tooltip: vs.wakeEnabled ? "关闭语音唤醒" : "开启语音唤醒",
            onPressed: () => unawaited(_voice.toggleWakeEnabled()),
            icon: Icon(
              vs.wakeEnabled ? Icons.hearing : Icons.hearing_disabled,
              color: vs.wakeEnabled ? Colors.white.withValues(alpha: 0.78) : Colors.white38,
              size: 20,
            ),
            style: IconButton.styleFrom(
              backgroundColor: Colors.black.withValues(alpha: 0.35),
              foregroundColor: Colors.white70,
            ),
          ),
        ),

        Positioned(
          left: compact ? 8 : 16,
          right: compact ? 8 : 16,
          bottom: compact ? 8 : 12,
          child: IgnorePointer(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                if (vs.isSpeaking || vs.isWaitingWake)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 6),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: <Widget>[
                        SizedBox(
                          width: 10,
                          height: 10,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: vs.isWaitingWake
                                ? Colors.grey.shade300
                                : Colors.grey.shade400,
                          ),
                        ),
                        const SizedBox(width: 6),
                        Text(
                          vs.isWaitingWake ? "待唤醒" : "聆听中",
                          style: TextStyle(
                            color: vs.isWaitingWake
                                ? Colors.grey.shade300
                                : Colors.grey.shade400,
                            fontSize: hintFontSize,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                      ],
                    ),
                  ),
                Container(
                  width: double.infinity,
                  padding: EdgeInsets.symmetric(
                    horizontal: compact ? 10 : 14,
                    vertical: compact ? 8 : 10,
                  ),
                  decoration: BoxDecoration(
                    color: Colors.black.withValues(alpha: 0.45),
                    borderRadius: BorderRadius.circular(compact ? 10 : 14),
                    border: Border.all(color: Colors.white.withValues(alpha: 0.08)),
                  ),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      Text(
                        vs.statusText,
                        textAlign: TextAlign.center,
                        maxLines: compact ? 2 : 3,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: Colors.white,
                          fontSize: statusFontSize,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                      if (vs.verificationStatus.isNotEmpty) ...<Widget>[
                        const SizedBox(height: 4),
                        Text(
                          vs.verificationStatus,
                          textAlign: TextAlign.center,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: vs.verificationStatus.contains("✓")
                                ? Colors.greenAccent.withValues(alpha: 0.9)
                                : vs.verificationStatus.contains("✗")
                                    ? Colors.redAccent.withValues(alpha: 0.9)
                                    : Colors.white70,
                            fontSize: hintFontSize,
                          ),
                        ),
                      ],
                      if (!compact &&
                          vs.wakeHint.isNotEmpty &&
                          vs.isWaitingWake) ...<Widget>[
                        const SizedBox(height: 4),
                        Text(
                          "听到：${vs.wakeHint}",
                          style: TextStyle(
                            color: Colors.white.withValues(alpha: 0.4),
                            fontSize: hintFontSize,
                          ),
                        ),
                      ],
                      const SizedBox(height: 4),
                      Text(
                        vs.isSpeaking
                            ? "再次点击停止"
                            : vs.isWaitingWake
                                ? "唤醒词或点击"
                                : "点击开始说话",
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          color: Colors.white.withValues(alpha: 0.45),
                          fontSize: hintFontSize,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
        ],
      ),
    );
  }
}
