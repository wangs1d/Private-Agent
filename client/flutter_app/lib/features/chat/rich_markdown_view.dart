import "package:flutter/material.dart";

import "content_summary_detail_formatter.dart";

/// 普通回复的富文本块级渲染视图。
///
/// 负责把 LLM 的 plain 正文按 Markdown 语义块级呈现：
///   - 块级渲染：标题 / 列表 / 有序列表 / 代码块 / 引用 / 表格 / 行内加粗链接等
///     （复用 [formatContentSummaryDetailLines] 的解析能力）
///   - 章节化 + 目录折叠：检测到 ≥2 个标题时，顶部渲染目录条（点击跳转），
///     每个标题可点击折叠/展开该节
///   - 来源引用块：独立 URL 行提升为「来源」引用块，可点击打开
///   - 裸 URL 自动链接化（可点击）
///
/// 接入点：chat_page._buildMessageTextInner 的 plain 分支（替换原行内渲染）。
class RichMarkdownView extends StatefulWidget {
  const RichMarkdownView({
    super.key,
    required this.text,
    required this.colorScheme,
    required this.textTheme,
  });

  final String text;
  final ColorScheme colorScheme;
  final TextTheme textTheme;

  @override
  State<RichMarkdownView> createState() => _RichMarkdownViewState();
}

class _RichMarkdownViewState extends State<RichMarkdownView> {
  /// 已折叠的节（按标题行 key 记录）。
  final Set<String> _collapsed = <String>{};

  ColorScheme get cs => widget.colorScheme;
  TextTheme get textTheme => widget.textTheme;

  /// 预处理：裸 URL 链接化；独立 URL 行提升为「来源」引用块。
  String _preprocess(String text) {
    final List<String> out = <String>[];
    for (final String raw in text.split("\n")) {
      final String line = raw.trimRight();
      final String trimmed = line.trim();
      final RegExpMatch? urlOnly = RegExp(r"^(https?://\S+)$").firstMatch(trimmed);
      if (urlOnly != null) {
        final String url = urlOnly.group(0)!;
        final String label = url.length > 48 ? "${url.substring(0, 48)}…" : url;
        out.add("> 🔗 [$label]($url)");
        continue;
      }
      out.add(_linkifyBareUrls(line));
    }
    return out.join("\n");
  }

  /// 把正文里的裸 URL（非 markdown 链接括号内的）提升为可点击链接格式。
  String _linkifyBareUrls(String text) {
    if (text.isEmpty) return text;
    return text.replaceAllMapped(
      RegExp(r"(?<!\]\()(https?://[^\s)\]}，。；、！？\u201d\u201c]+)"),
      (Match m) {
        final String url = m.group(1)!;
        return "[$url]($url)";
      },
    );
  }

  /// 解析出所有节（标题行 + 该节正文）。
  List<_Section> _parseSections(String text) {
    final List<String> lines = text.split("\n");
    final List<_Section> sections = <_Section>[];
    _Section? current;

    for (final String raw in lines) {
      final String trimmed = raw.trim();
      final _ParsedHeading? heading = _tryParseHeading(trimmed);
      if (heading != null) {
        current = _Section(keyId: heading.title, title: heading.title, body: <String>[]);
        sections.add(current);
      } else if (current != null) {
        current.body.add(raw);
      }
    }

    return sections;
  }

  /// 解析标题行：`#` markdown 标题，或较短的中文序号标题（如 `一、`/`1.` 单独成行）。
  _ParsedHeading? _tryParseHeading(String line) {
    final RegExpMatch? md = RegExp(r"^(#{1,6})\s+(.+)$").firstMatch(line);
    if (md != null) {
      final String title = md.group(2)!.trim();
      if (title.isNotEmpty && title.length <= 60) {
        return _ParsedHeading(title);
      }
      return null;
    }

    // 中文序号 / 数字序号标题：单独成行且较短，避免误判正文里的列举
    final RegExpMatch? seq = RegExp(
      r"^(?:[一二三四五六七八九十]+|[（(]?[0-9]{1,2}[)）]?)[、.．]\s*(.{1,40})$",
    ).firstMatch(line);
    if (seq != null) {
      final String title = seq.group(1)!.trim();
      if (title.isNotEmpty && title.length <= 40) {
        return _ParsedHeading(title);
      }
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final String processed = _preprocess(widget.text);
    final List<_Section> sections = _parseSections(processed);

    // 无标题 → 纯块级渲染（无目录、无折叠）
    if (sections.length < 2) {
      return _buildBody(processed);
    }

    final Map<String, GlobalKey> sectionKeys = <String, GlobalKey>{
      for (final _Section s in sections) s.keyId: GlobalKey(),
    };

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        // 章节目录条
        _buildToc(sections, sectionKeys),
        const SizedBox(height: 6),
        // 各节（标题可折叠）
        for (final _Section s in sections) _buildSection(s, sectionKeys[s.keyId]!),
      ],
    );
  }

  Widget _buildToc(List<_Section> sections, Map<String, GlobalKey> sectionKeys) {
    return SizedBox(
      height: 32,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: sections.length,
        separatorBuilder: (_, __) => const SizedBox(width: 6),
        itemBuilder: (BuildContext context, int i) {
          final _Section s = sections[i];
          final bool active = !_collapsed.contains(s.keyId);
          return ActionChip(
            label: Text(
              s.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 12,
                color: active ? cs.onSecondaryContainer : cs.onSurfaceVariant,
              ),
            ),
            backgroundColor: active
                ? cs.secondaryContainer.withValues(alpha: 0.7)
                : cs.surfaceContainerHigh,
            side: BorderSide(color: cs.outline.withValues(alpha: 0.18)),
            padding: const EdgeInsets.symmetric(horizontal: 6),
            visualDensity: VisualDensity.compact,
            materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
            onPressed: () => _scrollToSection(sectionKeys[s.keyId]!),
          );
        },
      ),
    );
  }

  Widget _buildSection(_Section s, GlobalKey key) {
    final bool collapsed = _collapsed.contains(s.keyId);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        // 节标题（可点击折叠/展开）
        InkWell(
          key: key,
          onTap: () {
            setState(() {
              if (collapsed) {
                _collapsed.remove(s.keyId);
              } else {
                _collapsed.add(s.keyId);
              }
            });
          },
          borderRadius: BorderRadius.circular(8),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 5, horizontal: 4),
            child: Row(
              children: <Widget>[
                Expanded(
                  child: Text(
                    s.title,
                    style: textTheme.titleSmall?.copyWith(
                      color: cs.onSurface,
                      fontWeight: FontWeight.w700,
                      height: 1.35,
                    ),
                  ),
                ),
                Icon(
                  collapsed ? Icons.expand_more : Icons.expand_less,
                  size: 18,
                  color: cs.onSurfaceVariant,
                ),
              ],
            ),
          ),
        ),
        if (!collapsed) _buildBody(s.body.join("\n")),
      ],
    );
  }

  Widget _buildBody(String text) {
    return SelectionArea(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: formatContentSummaryDetailLines(text, cs, textTheme),
      ),
    );
  }

  Future<void> _scrollToSection(GlobalKey key) async {
    final BuildContext? ctx = key.currentContext;
    if (ctx == null) return;
    await Scrollable.ensureVisible(
      ctx,
      alignment: 0.0,
      duration: const Duration(milliseconds: 250),
      curve: Curves.easeOut,
    );
  }
}

class _Section {
  const _Section({required this.keyId, required this.title, required this.body});

  final String keyId;
  final String title;
  final List<String> body;
}

class _ParsedHeading {
  const _ParsedHeading(this.title);

  final String title;
}
