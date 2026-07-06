import "region_capabilities.dart";

/// 当前构建的区域（编译期常量，由 `--dart-define=REGION` 注入）。
///
/// 默认 `domestic`，保持与现有行为兼容；国际版构建用：
/// `flutter build windows --dart-define=REGION=intl`
class RegionConfig {
  RegionConfig._();

  /// `--dart-define=REGION` 原始字符串。
  static const String _regionRaw = String.fromEnvironment(
    "REGION",
    defaultValue: "domestic",
  );

  /// 当前构建的 [Region]。
  static final Region region = parseRegion(_regionRaw);

  /// 当前构建的 [RegionCapabilities]（取 [RegionCapabilities.forRegion] 默认值）。
  ///
  /// 若某些环境需要覆盖默认值（如 dev 环境用国际版 cap 跑国内 LLM），
  /// 改成 getter 形式 + 在 main 启动时设置 [override] 即可。
  static RegionCapabilities? _override;

  static RegionCapabilities get capabilities =>
      _override ?? RegionCapabilities.forRegion(region);

  /// 仅供 main.dart 启动时调用，覆盖默认 cap。
  /// 普通业务代码不要调这个方法，请直接读 [capabilities]。
  static void override(RegionCapabilities cap) {
    _override = cap;
  }
}
