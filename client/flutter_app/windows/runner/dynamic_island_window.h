#ifndef RUNNER_DYNAMIC_ISLAND_WINDOW_H_
#define RUNNER_DYNAMIC_ISLAND_WINDOW_H_

#include <windows.h>

#include <functional>
#include <memory>
#include <string>
#include <vector>

/// 桌面顶部灵动岛（同进程 HWND 自绘，GDI+ 逐像素透明分层窗口）。
///
/// 设计（对齐 Apple 灵动岛语言，替代原 in-app Flutter 岛与今日安排悬浮窗）：
///   - WS_POPUP + WS_EX_LAYERED + WS_EX_TOPMOST + WS_EX_TOOLWINDOW，
///     钉在主屏工作区顶部正中；岛形以外 alpha=0 自动点击穿透
///   - 待机态：小胶囊 + 中央金属球「镜头」（呼吸光）
///   - 内容态：胶囊横向撑开（图标 + 标题 + 尾注 / 呼吸活点 / 进度线）
///   - 展开态：胶囊本体向下生长成日程卡（圆角连续变形），头部行保留
///   - 前台全屏（D3D 全屏 / 放映模式）时自动隐藏，退出后恢复
///
/// 通过 MethodChannel `pai/dynamic_island` 与 Dart 端通信：
///   - Dart -> C++：create / destroy / setVisible / present / dismiss /
///     dismissAll / setAgenda / expand / collapse / setDpi
///   - C++ -> Dart：onNativeEvent（expandedChanged / action / tapped）
class DynamicIslandWindow {
 public:
  enum class Kind { kTask = 0, kUpdate, kSchedule, kBriefing, kInbox };

  /// 岛上的一条信息（compact 胶囊内容）。
  struct Entry {
    std::string id;
    std::string title;
    std::string trailing;  // 右侧弱化短文案（空 = 无）
    Kind kind = Kind::kTask;
    double progress = -1.0;  // [0,1] 画进度线；<0 不画
    bool spinning = false;   // 尾部呼吸活点
  };

  /// 展开态日程卡里的一行。
  struct AgendaItem {
    std::string time_text;  // "HH:MM"
    std::string title;
    std::string hint;  // 右侧提示（"25 分钟后" / "已完成" 等）
    bool completed = false;
  };

  enum class EventType {
    kExpandedChanged,  // payload: "true"/"false"
    kAction,           // 展开卡快捷按钮，payload = 按钮文案
    kTapped,           // 胶囊本体被点击（展开/收起之外的未来扩展）
  };
  using EventCallback = std::function<void(EventType type, const std::string& payload)>;

  DynamicIslandWindow();
  ~DynamicIslandWindow();

  DynamicIslandWindow(const DynamicIslandWindow&) = delete;
  DynamicIslandWindow& operator=(const DynamicIslandWindow&) = delete;

  /// 首次调用创建 HWND 并定位到主屏工作区顶部正中；后续只是 Show。
  bool Create();
  void Destroy();
  void Show();
  void Hide();
  bool IsVisible() const;

  void SetEntry(const Entry& entry);   // 空标题 = 回到待机态
  void ClearEntry();
  void SetAgenda(std::vector<AgendaItem> items);
  void SetExpanded(bool expanded);
  void StartAttention(const std::string& title, const std::string& trailing);
  void SetDpiScale(double scale);
  void SetEventCallback(EventCallback cb) { event_callback_ = std::move(cb); }

 private:
  static constexpr const wchar_t* kClassName = L"PAI_DynamicIsland_Window";
  // 窗口比岛大：给展开卡与呼吸光留余量；岛内容绘制在窗口顶部正中。
  static constexpr int kWindowW = 760;
  static constexpr int kWindowH = 460;
  static constexpr int kCapsuleH = 38;       // compact 胶囊高
  static constexpr int kRestCapsuleW = 108;  // 待机胶囊宽（用户拍板：长度 2 倍、高度不变）
  static constexpr int kExpandedW = 380;     // 展开卡宽
  static constexpr int kTopMargin = 5;       // 胶囊顶边距
  static constexpr int kRowH = 30;           // 日程行高
  static constexpr int kMaxRows = 5;         // 最多展示行数
  static constexpr int kBtnRowH = 42;        // 快捷按钮行高
  // attention 提醒动画：整体放大倍数与各阶段时长（秒）。
  // 1.6 系数 ≈ 底座加粗加大后渲染出来仍是「最初小胶囊的 2 倍」观感
  // （用户多轮反馈锚定的绝对大小，勿再上调到 2.0）。
  static constexpr double kAttentionScale = 1.6;
  static constexpr double kAttnInS = 0.45;   // 入场（easeOutBack）
  static constexpr double kAttnHoldS = 4.0;  // 保持高亮脉冲
  static constexpr double kAttnOutS = 0.35;  // 缩回

  static LRESULT CALLBACK WndProc(HWND hwnd, UINT message, WPARAM wparam,
                                  LPARAM lparam) noexcept;
  LRESULT HandleMessage(HWND hwnd, UINT message, WPARAM wparam,
                        LPARAM lparam) noexcept;
  static void EnsureClassRegistered();

  void PositionAtTopCenter();
  void UpdateAnimations();   // 定时器驱动：推进动画相位并重绘
  void Render();             // 整体重绘（GDI+ -> UpdateLayeredWindow）
  int CompactWidth() const;  // 当前条目的胶囊宽
  int ExpandedHeight() const;
  void StartAnimTimer();
  void StopAnimTimer();
  void UpdateFullscreenSuppression();
  int HoverButtonAt(int client_x, int client_y) const;
  void FireEvent(EventType type, const std::string& payload);
  double AttentionScale() const;  // 当前 attention 缩放（1 = 无）

  std::wstring Utf8ToWide(const std::string& s) const;
  int S(int v) const { return static_cast<int>(v * dpi_scale_ + 0.5); }

  HWND window_handle_ = nullptr;
  bool visible_ = false;
  bool expanded_ = false;
  bool suppressed_by_fullscreen_ = false;
  double dpi_scale_ = 1.0;

  Entry entry_;
  bool has_entry_ = false;
  std::vector<AgendaItem> agenda_;
  std::vector<RECT> button_rects_;  // 展开卡快捷按钮区（物理像素，命中测试用）

  // 动画相位（秒）
  double now_s_ = 0.0;          // 累计时间（呼吸/活点用）
  double morph_ = 0.0;          // 0=compact 1=expanded，缓动后
  double morph_from_ = 0.0;     // 形变起点值
  double morph_start_s_ = 0.0;  // 形变起点时刻
  bool anim_timer_on_ = false;
  ULONGLONG anim_epoch_ms_ = 0;

  // attention 提醒动画：0=无，>0 = attention 开始时刻（now_s_ 基准）
  double attention_start_s_ = -1.0;
  std::wstring attention_title_;    // 高亮时显示的标题（可选，空=沿用当前 entry）
  std::wstring attention_trailing_;

  // 鼠标交互
  bool hovering_ = false;
  bool tracking_mouse_ = false;
  int hover_btn_ = -1;  // 展开卡快捷按钮 hover 索引

  EventCallback event_callback_;
};

#endif  // RUNNER_DYNAMIC_ISLAND_WINDOW_H_
