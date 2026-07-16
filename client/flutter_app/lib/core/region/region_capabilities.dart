/// 区域版本枚举。
///
/// 通过 `--dart-define=REGION=domestic|intl` 在构建时注入。
/// - [domestic]：国内版（默认，向后兼容现有行为）
/// - [intl]：国际版
///
/// 添加新区域时同步更新 [parseRegion] 与 [RegionCapabilities.forRegion]。
enum Region { domestic, intl }

/// 解析 `--dart-define=REGION` 字符串，未配置时回落到 [Region.domestic]
/// （保持现有行为不变）。
Region parseRegion(String? raw) {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "intl":
    case "international":
    case "global":
    case "overseas":
      return Region.intl;
    case "domestic":
    case "cn":
    case "china":
    case "":
      return Region.domestic;
    default:
      return Region.domestic;
  }
}

/// 区域功能开关表。
///
/// 设计原则：
/// - **共享层永远不直接读这个表**，由调用方（sidebar / 路由 / service 注册）
///   传 capabilities 进来决定是否渲染/注册。
/// - 这里只放「区域相关」的差异，区域无关的功能不进这张表。
/// - 新增字段时同步在 [forRegion] 给两个区域都补默认值。
class RegionCapabilities {
  const RegionCapabilities({
    required this.region,
    required this.wechatClaw,
    required this.voiceCallBridge,
    required this.wallet,
    required this.phoneAuth,
    required this.oauthProviders,
    required this.defaultLlmProvider,
    required this.supportedTargetLanguages,
  });

  /// 国内版默认能力表。
  static const RegionCapabilities domestic = RegionCapabilities(
    region: Region.domestic,
    wechatClaw: true,
    voiceCallBridge: true,
    wallet: true,
    phoneAuth: true,
    oauthProviders: <OAuthProvider>[],
    defaultLlmProvider: "moonshot-kimi",
    supportedTargetLanguages: <String>[
      "中文",
      "English",
      "日本語",
      "한국어",
      "Français",
      "Deutsch",
      "Español",
      "Русский",
      "繁體",
    ],
  );

  /// 国际版默认能力表。
  static const RegionCapabilities intl = RegionCapabilities(
    region: Region.intl,
    wechatClaw: false,
    voiceCallBridge: false,
    wallet: false,
    phoneAuth: false,
    oauthProviders: <OAuthProvider>[
      OAuthProvider.google,
      OAuthProvider.apple,
      OAuthProvider.email,
    ],
    defaultLlmProvider: "openai",
    supportedTargetLanguages: <String>[
      "English",
      "中文",
      "日本語",
      "한국어",
      "Français",
      "Deutsch",
      "Español",
      "Русский",
      "Português",
      "العربية",
    ],
  );

  /// 按 [Region] 取默认能力表。需要覆盖默认值时直接 copyWith。
  static RegionCapabilities forRegion(Region r) {
    switch (r) {
      case Region.domestic:
        return domestic;
      case Region.intl:
        return RegionCapabilities.intl;
    }
  }

  final Region region;

  /// 微信 Claw 绑定（仅国内）。
  final bool wechatClaw;

  /// 虚拟电话 / 手机桥接（仅国内，依赖微信生态）。
  final bool voiceCallBridge;

  /// 钱包 / 支付（国内走微信支付 + 支付宝，国际版走 Stripe）。
  /// 国际版钱包 UI 暂不开放，待 Stripe 接入后再开。
  final bool wallet;

  /// 手机号 + 短信验证码登录（仅国内）。
  final bool phoneAuth;

  /// 国际版支持的第三方 OAuth 列表；国内版为空。
  final List<OAuthProvider> oauthProviders;

  /// 默认 LLM provider id（与服务端 EXTERNAL_MODEL_PROVIDER 对齐）。
  final String defaultLlmProvider;

  /// 翻译组件目标语言下拉的可选项（区域不同默认排序与可选语种不同）。
  final List<String> supportedTargetLanguages;

  /// 是否国际版（便于在少量无法用单一 bool 表达的位置做分支；
  /// 优先使用具体能力字段而不是这个）。
  bool get isIntl => region == Region.intl;

  RegionCapabilities copyWith({
    bool? wechatClaw,
    bool? voiceCallBridge,
    bool? wallet,
    bool? phoneAuth,
    List<OAuthProvider>? oauthProviders,
    String? defaultLlmProvider,
    List<String>? supportedTargetLanguages,
  }) {
    return RegionCapabilities(
      region: region,
      wechatClaw: wechatClaw ?? this.wechatClaw,
      voiceCallBridge: voiceCallBridge ?? this.voiceCallBridge,
      wallet: wallet ?? this.wallet,
      phoneAuth: phoneAuth ?? this.phoneAuth,
      oauthProviders: oauthProviders ?? this.oauthProviders,
      defaultLlmProvider: defaultLlmProvider ?? this.defaultLlmProvider,
      supportedTargetLanguages:
          supportedTargetLanguages ?? this.supportedTargetLanguages,
    );
  }
}

/// 国际版支持的第三方登录方式。
enum OAuthProvider { google, apple, email }
