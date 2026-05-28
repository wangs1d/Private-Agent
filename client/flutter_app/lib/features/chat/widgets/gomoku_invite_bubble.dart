import "package:flutter/material.dart";

import "../../../core/theme/app_theme.dart";
import "../../../core/utils/play_url_utils.dart";

/// 五子棋邀请气泡（App / Flutter Web 共用）：固定灰褐色，不使用 theme primary。
class GomokuInviteBubble extends StatelessWidget {
  const GomokuInviteBubble({
    super.key,
    required this.text,
    required this.playUrl,
    this.onOpen,
  });

  final String text;
  final String playUrl;
  final void Function(String playUrlOrTableId)? onOpen;

  static String displayBody(String rawText, String playUrl) {
    return PlayUrlUtils.displayText(rawText, playUrl: playUrl);
  }

  void _open(BuildContext context) {
    if (onOpen != null) {
      onOpen!(playUrl);
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text("无法打开对局：未配置内嵌入口")),
    );
  }

  @override
  Widget build(BuildContext context) {
    final TextTheme tt = Theme.of(context).textTheme;
    final String body = displayBody(text, playUrl);
    return Container(
      constraints: const BoxConstraints(maxWidth: 320),
      margin: const EdgeInsets.symmetric(vertical: 4),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppPalette.gomokuCardBg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppPalette.gomokuCardBorder),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Row(
            children: <Widget>[
              const Icon(Icons.grid_on, size: 18, color: AppPalette.gomokuCardBody),
              const SizedBox(width: 6),
              Text(
                "五子棋对局",
                style: tt.titleSmall?.copyWith(
                  color: AppPalette.gomokuCardTitle,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          if (body.isNotEmpty) ...<Widget>[
            const SizedBox(height: 8),
            Text(
              body,
              style: tt.bodyMedium?.copyWith(
                color: AppPalette.gomokuCardBody,
                height: 1.35,
              ),
            ),
          ],
          const SizedBox(height: 10),
          Material(
            color: AppPalette.gomokuCardButtonBg,
            borderRadius: BorderRadius.circular(20),
            child: InkWell(
              onTap: () => _open(context),
              borderRadius: BorderRadius.circular(20),
              splashColor: AppPalette.gomokuCardBorder.withValues(alpha: 0.4),
              highlightColor: AppPalette.gomokuCardBorder.withValues(alpha: 0.25),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    const Icon(
                      Icons.sports_esports,
                      size: 18,
                      color: AppPalette.gomokuCardButtonFg,
                    ),
                    const SizedBox(width: 6),
                    Text(
                      "在 App 内进入对局",
                      style: tt.labelLarge?.copyWith(
                        color: AppPalette.gomokuCardButtonFg,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
