import "package:flutter/material.dart";
import "package:highlight/highlight.dart" as hl;

/// 代码块语法高亮:`highlight`(highlight.js 的 Dart 移植)解析源码为
/// Node 树,再转成 [TextSpan],配合 `SelectableText.rich` 保持
/// 「可选中复制」的体验。
///
/// 配色取自经典主题:深色代码底用 Atom One Dark,浅色用 GitHub Light。
/// 代码区背景独立于 app 主题 surface(固定色),保证高亮配色始终可读。

/// 深色代码区背景
const Color codeBackgroundDark = Color(0xFF16181D);

/// 浅色代码区背景
const Color codeBackgroundLight = Color(0xFFF6F8FA);

/// 一套高亮配色:背景 + 各 hljs 类名到前景色的映射。
class CodeHighlightTheme {
  const CodeHighlightTheme({
    required this.background,
    required this.rootColor,
    required this.colors,
  });

  final Color background;

  /// 普通代码文字的颜色
  final Color rootColor;

  /// hljs 类名 → 前景色
  final Map<String, Color> colors;

  /// Atom One Dark(深色)
  static const CodeHighlightTheme dark = CodeHighlightTheme(
    background: codeBackgroundDark,
    rootColor: Color(0xFFABB2BF),
    colors: <String, Color>{
      "keyword": Color(0xFFC678DD),
      "built_in": Color(0xFFE5C07B),
      "type": Color(0xFFE5C07B),
      "class": Color(0xFFE5C07B),
      "title": Color(0xFF61AFEF),
      "title.function_": Color(0xFF61AFEF),
      "title.class_": Color(0xFFE5C07B),
      "string": Color(0xFF98C379),
      "number": Color(0xFFD19A66),
      "literal": Color(0xFFD19A66),
      "comment": Color(0xFF5C6370),
      "quote": Color(0xFF5C6370),
      "attr": Color(0xFFD19A66),
      "attribute": Color(0xFFD19A66),
      "variable": Color(0xFFE06C75),
      "template-variable": Color(0xFFE06C75),
      "tag": Color(0xFFE06C75),
      "name": Color(0xFFE06C75),
      "meta": Color(0xFF61AFEF),
      "meta .keyword": Color(0xFFC678DD),
      "regexp": Color(0xFF98C379),
      "subst": Color(0xFFE06C75),
      "symbol": Color(0xFF56B6C2),
      "selector-tag": Color(0xFFE06C75),
      "selector-id": Color(0xFF61AFEF),
      "selector-class": Color(0xFFD19A66),
      "addition": Color(0xFF98C379),
      "deletion": Color(0xFFE06C75),
      "section": Color(0xFF61AFEF),
      "link": Color(0xFF61AFEF),
      "params": Color(0xFFE5C07B),
      "operator": Color(0xFF56B6C2),
      "punctuation": Color(0xFFABB2BF),
      "property": Color(0xFFE06C75),
    },
  );

  /// GitHub Light(浅色)
  static const CodeHighlightTheme light = CodeHighlightTheme(
    background: codeBackgroundLight,
    rootColor: Color(0xFF1F2328),
    colors: <String, Color>{
      "keyword": Color(0xFFCF222E),
      "built_in": Color(0xFF953800),
      "type": Color(0xFF953800),
      "class": Color(0xFF953800),
      "title": Color(0xFF8250DF),
      "title.function_": Color(0xFF8250DF),
      "title.class_": Color(0xFF953800),
      "string": Color(0xFF0A3069),
      "number": Color(0xFF0550AE),
      "literal": Color(0xFF0550AE),
      "comment": Color(0xFF6E7781),
      "quote": Color(0xFF6E7781),
      "attr": Color(0xFF0550AE),
      "attribute": Color(0xFF0550AE),
      "variable": Color(0xFF953800),
      "template-variable": Color(0xFF953800),
      "tag": Color(0xFF116329),
      "name": Color(0xFF116329),
      "meta": Color(0xFF8250DF),
      "regexp": Color(0xFF0A3069),
      "subst": Color(0xFF1F2328),
      "symbol": Color(0xFF0550AE),
      "selector-tag": Color(0xFF116329),
      "selector-id": Color(0xFF8250DF),
      "selector-class": Color(0xFF953800),
      "addition": Color(0xFF116329),
      "deletion": Color(0xFFCF222E),
      "section": Color(0xFF8250DF),
      "link": Color(0xFF0550AE),
      "params": Color(0xFF953800),
      "operator": Color(0xFF0550AE),
      "punctuation": Color(0xFF1F2328),
      "property": Color(0xFF953800),
    },
  );
}

/// 把源码解析为高亮 [TextSpan] 树。
///
/// - [language] 为空 → 自动检测语言;
/// - 语言未知或解析失败 → 整段回退为普通文本(不中断渲染);
/// - 解析结果为空(如纯文本语言)→ 回退普通文本。
TextSpan buildHighlightedCode(
  String code,
  String? language,
  TextStyle base,
  CodeHighlightTheme theme,
) {
  final TextStyle rootStyle = base.copyWith(color: theme.rootColor);
  try {
    final hl.Result result = hl.highlight.parse(
      code,
      language: (language == null || language.isEmpty) ? null : language,
      autoDetection: language == null || language.isEmpty,
    );
    final List<hl.Node>? nodes = result.nodes;
    if (nodes == null || nodes.isEmpty) {
      return TextSpan(text: code, style: rootStyle);
    }
    return TextSpan(
      style: rootStyle,
      children: _nodesToSpans(nodes, rootStyle, theme.colors),
    );
  } catch (_) {
    return TextSpan(text: code, style: rootStyle);
  }
}

List<TextSpan> _nodesToSpans(
  List<hl.Node> nodes,
  TextStyle base,
  Map<String, Color> colors,
) {
  final List<TextSpan> spans = <TextSpan>[];
  for (final hl.Node node in nodes) {
    final String? className = node.className;
    final TextStyle style = (className != null && colors.containsKey(className))
        ? base.copyWith(color: colors[className])
        : base;
    final String text = node.value ?? "";
    final List<hl.Node>? children = node.children;
    if (children == null || children.isEmpty) {
      if (text.isNotEmpty) spans.add(TextSpan(text: text, style: style));
    } else {
      spans.add(
        TextSpan(
          style: style,
          children: _nodesToSpans(children, base, colors),
        ),
      );
    }
  }
  return spans;
}
