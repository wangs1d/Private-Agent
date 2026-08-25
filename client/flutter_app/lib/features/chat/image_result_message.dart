import "package:flutter/material.dart";

import "../../core/config/api_config.dart";
import "../../core/services/image_preview_launcher.dart";
import "content_summary_detail_formatter.dart";
import "media_thumbnail.dart";

/// 识图结果外壳（[RENDER_AS:image_result] 的专属渲染）
///
/// 服务端对 vision/OCR 工具结果注入 `[RENDER_AS:image_result]`，正文是
/// 「结论 + 图片引用 + 要点」的混排文本。此组件把结构显式化为：
///   1. 头部徽标（🔍 识图结果）
///   2. 照片预览廊（从正文抽取图片链接 → 缩略图，点击开右侧大图预览）
///   3. 一句话结论（首行短句）
///   4. 要点细节（其余正文走结构化 Markdown 渲染：列表/表格/代码块）
///
/// 若正文里没有任何图片链接，则退化为 徽标 + 结论/要点，不展示图廊。
class ImageResultMessage extends StatelessWidget {
  const ImageResultMessage({
    super.key,
    required this.text,
    required this.cs,
    required this.textTheme,
    this.showCursor = false,
  });

  final String text;
  final ColorScheme cs;
  final TextTheme textTheme;
  final bool showCursor;

  static final RegExp _imgMarkdown = RegExp(r'!\[[^\]]*\]\(([^)\s]+)\)');
  static final RegExp _imgPath = RegExp(r'(/agent/images/[A-Za-z0-9_\-.%/]+)');
  static final RegExp _imgHttp = RegExp(
    r'(https?://[A-Za-z0-9_\-./:%?&=@#~+]+\.(?:png|jpe?g|gif|webp|avif)(?:[?&][A-Za-z0-9_\-./:%?&=@#~+]+)?)',
    caseSensitive: false,
  );

  /// 抽取正文中的图片链接（markdown 图 / 代理路径 / http 图片），去重、最多 6 张。
  static List<String> _extractImageUrls(String text) {
    if (text.isEmpty) return const <String>[];
    final List<String> out = <String>[];
    void add(String? url) {
      final String u = (url ?? "").trim();
      if (u.isEmpty || out.contains(u)) return;
      out.add(u);
    }

    for (final Match m in _imgMarkdown.allMatches(text)) {
      add(m.group(1));
    }
    for (final Match m in _imgPath.allMatches(text)) {
      add(m.group(1));
    }
    for (final Match m in _imgHttp.allMatches(text)) {
      add(m.group(1));
    }
    return out.take(6).toList(growable: false);
  }

  /// 剥离正文中的图片链接 token（保留行内其它文字，避免图廊与正文重复）。
  static String _stripImageTokens(String text) {
    if (text.isEmpty) return text;
    String result = text;
    void drop(List<String> tokens) {
      for (final String token in tokens) {
        if (token.isEmpty) continue;
        result = result.replaceAll(token, "");
      }
    }

    drop(_imgMarkdown.allMatches(text)
        .map((Match m) => m.group(0) ?? "")
        .toSet()
        .toList());
    drop(_imgPath.allMatches(text)
        .map((Match m) => m.group(1) ?? "")
        .toSet()
        .toList());
    drop(_imgHttp.allMatches(text)
        .map((Match m) => m.group(1) ?? "")
        .toSet()
        .toList());
    return result
        .replaceAll(RegExp(r'\n{3,}'), '\n\n')
        .replaceAll(RegExp(r'[ \t]{2,}'), " ")
        .trim();
  }

  /// 解析「结论 + 要点」：首行短句（≤32 字）作为结论，其余为要点正文。
  static String? _extractLead(String body) {
    final List<String> lines = body
        .split("\n")
        .map((String line) => line.trim())
        .where((String line) => line.isNotEmpty)
        .toList();
    if (lines.isEmpty) return null;
    final String first = lines.first;
    if (first.length > 32) return null;
    // 引导行/结论句：以 ：结尾 或 是一句完整短句（不含列表符号）
    final bool isIntrolike = first.endsWith("：") || first.endsWith(":");
    final bool isListLike = RegExp(r'^[-•*→▸‣◦·\d.、]\s*').hasMatch(first);
    if (isListLike) return null;
    if (!isIntrolike && lines.length < 2 && body.length <= 40) {
      return first;
    }
    return isIntrolike ? first : null;
  }

  static String _resolveMediaUrl(String url) {
    if (url.startsWith("http://") || url.startsWith("https://")) return url;
    final String base = ApiConfig.httpBase;
    if (url.startsWith("/")) return "$base$url";
    return "$base/$url";
  }

  @override
  Widget build(BuildContext context) {
    final String normalized = text.replaceAll("\r\n", "\n").trim();
    final List<String> rawUrls = _extractImageUrls(normalized);
    final List<String> urls = rawUrls.map(_resolveMediaUrl).toList();
    final String textOnly = _stripImageTokens(normalized);
    final String? lead = _extractLead(textOnly);

    final String body = lead == null
        ? textOnly
        : textOnly
            .split("\n")
            .map((String line) => line.trim())
            .where((String line) => line.isNotEmpty)
            .skip(1)
            .join("\n")
            .trim();

    final bool hasContent = urls.isNotEmpty || textOnly.isNotEmpty;
    if (!hasContent && !showCursor) {
      return const SizedBox.shrink();
    }

    final TextStyle bodyStyle = textTheme.bodyMedium!.copyWith(
      color: cs.onSurface,
      height: 1.56,
    );

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHighest.withValues(alpha: 0.22),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: cs.outline.withValues(alpha: 0.12)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          // 头部徽标
          Row(
            children: <Widget>[
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: cs.primary.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(
                  "🔍 识图结果${urls.isNotEmpty ? " · ${urls.length} 图" : ""}",
                  style: textTheme.labelSmall?.copyWith(
                        color: cs.primary,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 0.1,
                      ) ??
                      TextStyle(
                        fontSize: 11,
                        color: cs.primary,
                        fontWeight: FontWeight.w700,
                      ),
                ),
              ),
            ],
          ),
          // 照片预览廊
          if (urls.isNotEmpty) ...<Widget>[
            const SizedBox(height: 10),
            SizedBox(
              height: 96,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                physics: const BouncingScrollPhysics(),
                itemCount: urls.length,
                separatorBuilder: (_, __) => const SizedBox(width: 8),
                itemBuilder: (BuildContext context, int index) {
                  final String url = urls[index];
                  return GestureDetector(
                    onTap: () => ImagePreviewLauncher.open(
                      url: url,
                      title: "识图预览",
                      gallery: urls,
                      index: index,
                    ),
                    child: MediaThumbnail(
                      url: url,
                      cs: cs,
                      width: 96,
                      height: 96,
                      borderRadius: 10,
                    ),
                  );
                },
              ),
            ),
          ],
          // 一句话结论
          if (lead != null && lead.isNotEmpty) ...<Widget>[
            if (urls.isNotEmpty) const SizedBox(height: 10),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.fromLTRB(10, 7, 10, 7),
              decoration: BoxDecoration(
                color: cs.primaryContainer.withValues(alpha: 0.10),
                borderRadius: BorderRadius.circular(9),
                border: Border(
                  left: BorderSide(
                    color: cs.outline.withValues(alpha: 0.38),
                    width: 2.5,
                  ),
                ),
              ),
              child: buildInlineMarkdownText(
                lead,
                bodyStyle.copyWith(
                  fontWeight: FontWeight.w600,
                  color: cs.onSurfaceVariant,
                  height: 1.5,
                ),
                cs: cs,
              ),
            ),
          ],
          // 要点细节
          if (body.isNotEmpty) ...<Widget>[
            if (lead != null && lead.isNotEmpty || urls.isNotEmpty)
              const SizedBox(height: 8),
            ...formatContentSummaryDetailLines(body, cs, textTheme),
          ],
          if (showCursor)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                "▍",
                style: bodyStyle.copyWith(
                  color: cs.primary,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
        ],
      ),
    );
  }
}