import "package:flutter/material.dart";

import "../../../core/services/image_preview_launcher.dart";
import "../../../core/utils/agent_result_parser.dart";
import "../media_thumbnail.dart";
import "effect_card_shell.dart";

/// A/B 双图对比滑杆。
///
/// 两张原图上下叠放：底层 B 图完整展示，上层 A 图按 [_position] 裁切宽度，
/// 拖动中央把手左右移动分割线即可逐像素对比两侧（如持妆前后对比）。
/// 图片本身不做任何缩放变形（BoxFit.cover 裁切），保留原始观感。
///
/// 交互：
///   - 水平拖动把手（或图面任意位置）→ 移动分割线；
///   - 单击（未拖动）→ 按点击位置打开对应侧的大图预览。
class CompareSlider extends StatefulWidget {
  const CompareSlider({
    super.key,
    required this.urlA,
    required this.urlB,
    required this.cs,
    this.labelA = "",
    this.labelB = "",
    this.gallery = const <String>[],
    this.aspectRatio = 4 / 3,
  });

  /// 左侧（A 侧）图片地址，已 resolve。
  final String urlA;

  /// 右侧（B 侧）图片地址，已 resolve。
  final String urlB;

  final ColorScheme cs;

  /// 两侧角标文案（如「A 品牌」「B 品牌」），空则不显示。
  final String labelA;
  final String labelB;

  /// 点击预览的图池（可切换查看两侧原图）。
  final List<String> gallery;

  final double aspectRatio;

  @override
  State<CompareSlider> createState() => _CompareSliderState();
}

class _CompareSliderState extends State<CompareSlider> {
  double _position = 0.5;

  void _onDrag(DragUpdateDetails details, double width) {
    setState(() {
      _position = (_position + details.delta.dx / width).clamp(0.06, 0.94);
    });
  }

  void _onTap(TapUpDetails details, double width) {
    final List<String> pool =
        widget.gallery.isNotEmpty ? widget.gallery : <String>[widget.urlA, widget.urlB];
    final String tapped = details.localPosition.dx / width < _position
        ? widget.urlA
        : widget.urlB;
    final int idx = pool.contains(tapped) ? pool.indexOf(tapped) : 0;
    ImagePreviewLauncher.open(
      url: tapped,
      title: "图片预览",
      gallery: pool,
      index: idx,
    );
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final double width = constraints.maxWidth;
        return GestureDetector(
          onHorizontalDragUpdate: (DragUpdateDetails d) => _onDrag(d, width),
          onTapUp: (TapUpDetails d) => _onTap(d, width),
          child: AspectRatio(
            aspectRatio: widget.aspectRatio,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: Stack(
                fit: StackFit.expand,
                children: <Widget>[
                  // 底层：B 图（完整）
                  MediaThumbnail(
                    url: widget.urlB,
                    cs: widget.cs,
                    borderRadius: 0,
                  ),
                  // 上层：A 图（按分割位置裁切左侧）
                  ClipRect(
                    child: Align(
                      alignment: Alignment.centerLeft,
                      widthFactor: _position,
                      child: MediaThumbnail(
                        url: widget.urlA,
                        cs: widget.cs,
                        borderRadius: 0,
                      ),
                    ),
                  ),
                  // 分割线 + 拖动把手
                  Positioned(
                    left: _position * width - 1,
                    top: 0,
                    bottom: 0,
                    child: Container(
                      width: 2,
                      color: Colors.white.withValues(alpha: 0.9),
                    ),
                  ),
                  Positioned(
                    left: (_position * width - 16).clamp(0.0, width - 32),
                    top: 0,
                    bottom: 0,
                    child: Center(
                      child: Container(
                        width: 32,
                        height: 32,
                        decoration: BoxDecoration(
                          color: Colors.white,
                          shape: BoxShape.circle,
                          boxShadow: <BoxShadow>[
                            BoxShadow(
                              color: Colors.black.withValues(alpha: 0.25),
                              blurRadius: 6,
                              offset: const Offset(0, 1),
                            ),
                          ],
                        ),
                        child: Icon(
                          Icons.compare_arrows,
                          size: 18,
                          color: widget.cs.onSurface,
                        ),
                      ),
                    ),
                  ),
                  // 两侧角标
                  if (widget.labelA.trim().isNotEmpty)
                    Positioned(
                      left: 8,
                      top: 8,
                      child: _CompareBadge(label: widget.labelA),
                    ),
                  if (widget.labelB.trim().isNotEmpty)
                    Positioned(
                      right: 8,
                      top: 8,
                      child: _CompareBadge(label: widget.labelB),
                    ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

/// 角标胶囊：半透明黑底白字，压在图片上仍可读。
class _CompareBadge extends StatelessWidget {
  const _CompareBadge({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.5),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w600,
          color: Colors.white,
          height: 1.2,
        ),
      ),
    );
  }
}

/// A/B 双图对比卡（cardType = "compare" 且恰好两侧各一张图时的效果）。
///
/// 由 [displayEffectsCard] 分发：解析 items 中 side=A / side=B 的各第一张
/// 图片，交给 [CompareSlider] 拖动对比；标签取 sideA/sideB 或条目 sideLabel。
class CompareEffectCard extends StatelessWidget {
  const CompareEffectCard({
    super.key,
    required this.data,
    required this.cs,
    required this.urlA,
    required this.urlB,
  });

  final AgentResultData data;
  final ColorScheme cs;
  final String urlA;
  final String urlB;

  @override
  Widget build(BuildContext context) {
    // 标题：分组维度标题（媒体分组路径）优先，否则用卡片标题（compare 工具路径）。
    final String groupTitle = (data.groupTitle ?? "").trim();
    final String title = groupTitle.isNotEmpty ? groupTitle : data.title.trim();
    // 侧标签：sideA/sideB 缺省时用 A/B 占位，保证滑杆两侧始终可辨识。
    final String labelA = (data.sideA ?? "").trim().isNotEmpty
        ? data.sideA!.trim()
        : "A";
    final String labelB = (data.sideB ?? "").trim().isNotEmpty
        ? data.sideB!.trim()
        : "B";
    return EffectCardShell(
      cs: cs,
      icon: Icons.compare_outlined,
      title: title,
      footer: data.footer,
      padding: const EdgeInsets.fromLTRB(10, 10, 10, 10),
      body: CompareSlider(
        urlA: urlA,
        urlB: urlB,
        labelA: labelA,
        labelB: labelB,
        gallery: <String>[urlA, urlB],
        cs: cs,
      ),
    );
  }
}
