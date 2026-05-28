/// 从 Agent 工具结果或回复文本中提取五子棋对局信息。
class PlayUrlUtils {
  PlayUrlUtils._();

  static final RegExp _gomokuTableIdPattern = RegExp(
    r'gomoku_[a-f0-9]+',
    caseSensitive: false,
  );

  static final RegExp _gomokuPlayUrlPattern = RegExp(
    r'https?://[^\s<>"\]]+(?:/play/gomoku/|#/gomoku/)[^\s<>"\]]+',
    caseSensitive: false,
  );

  static String? fromToolResult(Map<String, dynamic>? result) {
    if (result == null) return null;
    final dynamic raw = result['playUrl'] ?? result['watchUrl'];
    if (raw is! String) return null;
    final String url = raw.trim();
    return url.isEmpty ? null : url;
  }

  static String? fromAssistantText(String text) {
    final Match? m = _gomokuPlayUrlPattern.firstMatch(text);
    if (m != null) return m.group(0);
    return parseTableId(text) != null ? text : null;
  }

  /// 从 playUrl、完整链接或裸 tableId 解析桌号。
  static String? parseTableId(String input) {
    final String trimmed = input.trim();
    if (trimmed.isEmpty) return null;

    if (_gomokuTableIdPattern.hasMatch(trimmed) &&
        trimmed.startsWith("gomoku_") &&
        !trimmed.contains("/") &&
        !trimmed.contains("#")) {
      return trimmed;
    }

    final Uri? uri = Uri.tryParse(trimmed);
    if (uri != null) {
      final List<String> segments = uri.pathSegments;
      for (int i = 0; i < segments.length - 1; i++) {
        if (segments[i] == "gomoku") {
          final String id = segments[i + 1];
          if (_gomokuTableIdPattern.hasMatch(id)) return id;
        }
      }
      final String fragment = uri.fragment;
      if (fragment.startsWith("/gomoku/")) {
        final String id = fragment.substring("/gomoku/".length).split("/").first;
        if (_gomokuTableIdPattern.hasMatch(id)) return id;
      }
    }

    final Match? m = _gomokuTableIdPattern.firstMatch(trimmed);
    return m?.group(0);
  }

  static bool isGomokuPlayTool(String? toolName) {
    return toolName == 'world.gomoku.create_table' || toolName == 'world.gomoku.join';
  }

  /// 已有对局卡片时，去掉正文中的链接与 Agent 内部提示，避免重复展示地址。
  static String displayText(String text, {String? playUrl}) {
    final String trimmed = text.trim();
    if (playUrl == null || playUrl.isEmpty) return trimmed;

    String cleaned = trimmed
        .replaceAll(_gomokuPlayUrlPattern, '')
        .replaceAll(RegExp(r'https?://\S+'), '')
        .replaceAll(RegExp(r'\s{2,}'), ' ')
        .replaceAll(RegExp(r'[：:]\s*$'), '')
        .trim();

    if (cleaned.isEmpty ||
        cleaned.contains('playUrl') ||
        cleaned.contains('发给用户') ||
        cleaned.contains('Flutter') ||
        cleaned.contains('App 内')) {
      return '棋局已开好，你执白棋（后手）。点击下方按钮进入对局。';
    }
    return cleaned;
  }
}
