import "package:flutter/material.dart";

/// 用户头像（真实图片 + fallback 回退）的共享渲染组件。
///
/// - [url] 为空 → 直接渲染 [fallback]；
/// - 有图 → ClipOval 方形裁圆加载，加载/解码失败回退 [fallback]；
/// - [gaplessPlayback] 保证换头像（URL 变化）时旧图停留到新图解码完成，不闪底色。
///
/// fallback 由调用方给（聊天面灰渐变球 / 侧栏首字母球 / 移动端账号卡球），
/// 各处保留自己原有的缺省形态。
class UserAvatar extends StatelessWidget {
  const UserAvatar({
    super.key,
    required this.url,
    required this.size,
    required this.fallback,
  });

  /// 绝对 URL（[UserAvatarApi.resolveUrl] 的产物）或 null。
  final String? url;

  /// 渲染尺寸（正方形边长，等于 fallback 的直径）。
  final double size;

  final Widget fallback;

  @override
  Widget build(BuildContext context) {
    final String? u = url;
    if (u == null || u.isEmpty) return fallback;
    return ClipOval(
      child: SizedBox(
        width: size,
        height: size,
        child: Image.network(
          u,
          width: size,
          height: size,
          fit: BoxFit.cover,
          gaplessPlayback: true,
          errorBuilder: (BuildContext context, Object error, StackTrace? stackTrace) => fallback,
        ),
      ),
    );
  }
}
