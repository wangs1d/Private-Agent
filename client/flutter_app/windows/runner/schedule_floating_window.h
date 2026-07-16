#ifndef RUNNER_SCHEDULE_FLOATING_WINDOW_H_
#define RUNNER_SCHEDULE_FLOATING_WINDOW_H_

#include <windows.h>

#include <functional>
#include <memory>
#include <string>
#include <vector>

/// 今日安排独立悬浮窗（同进程 HWND + GDI 自绘，不依赖 Electron）。
///
/// 设计目标（对齐豆包桌面端体验）：
///   - WS_POPUP + WS_EX_TOPMOST + WS_EX_TOOLWINDOW，与主 Flutter 窗口同进程
///   - 可在桌面自由拖动（标题栏 WM_NCHITTEST -> HTCAPTION）
///   - 顶栏：📅 今日安排 + 日期 + 折叠按钮 + 关闭按钮
///   - 内容：日程卡片列表（时间 + 标题），空态提示
///   - 折叠时只剩顶栏
///
/// 通过 MethodChannel `pai/schedule_floating` 与 Dart 端通信：
///   - Dart -> C++：create / show / hide / destroy / setBounds / setSchedule
///   - C++ -> Dart：onClose / onCollapseChanged
class ScheduleFloatingWindow {
 public:
  /// 一条日程事项。
  struct ScheduleItem {
    std::string id;         // 唯一 id
    std::string time_text;  // "HH:MM" 展示文本
    std::string title;      // 标题
    std::string notes;      // 备注（可选，空字符串表示无备注）
    bool completed = false; // 是否已完成
  };

  /// 事件回调类型。
  enum class EventType {
    kCloseClicked,        // 用户点 ✕
    kCollapseChanged,     // 折叠状态变化（payload: "true" / "false"）
  };
  using EventCallback = std::function<void(EventType type, const std::string& payload)>;

  ScheduleFloatingWindow();
  ~ScheduleFloatingWindow();

  ScheduleFloatingWindow(const ScheduleFloatingWindow&) = delete;
  ScheduleFloatingWindow& operator=(const ScheduleFloatingWindow&) = delete;

  /// 第一次调用真正创建 HWND；后续调用只是 Show。
  bool Create();
  void Destroy();

  void Show();
  void Hide();
  bool IsVisible() const;
  bool IsCreated() const { return window_handle_ != nullptr; }

  /// 设置 / 取消置顶。
  void SetOnTop(bool on_top);
  bool IsOnTop() const { return on_top_; }

  /// 设置窗口位置和尺寸。
  void SetBounds(int x, int y, int width, int height);
  RECT GetBounds() const;

  /// 设置折叠状态（true=只显示顶栏）。
  void SetCollapsed(bool collapsed);
  bool IsCollapsed() const { return collapsed_; }

  /// 替换整个日程列表。
  void SetSchedule(std::vector<ScheduleItem> items);

  /// 注册事件回调。
  void SetEventCallback(EventCallback cb) { event_callback_ = std::move(cb); }

 private:
  static constexpr const wchar_t* kClassName = L"PAI_ScheduleFloating_Window";
  static constexpr int kTitleBarHeight = 40;    // 顶栏高（对齐 in-app 卡片头部）
  static constexpr int kMinWidth = 240;
  static constexpr int kDefaultWidth = 280;
  static constexpr int kDefaultHeight = 420;
  static constexpr int kItemHeight = 46;        // 单条日程行高（含时间+竖线+标题+备注）
  static constexpr int kBodyPadding = 14;       // 内容区内边距（对齐 in-app 14px）
  static constexpr int kMaxVisibleItems = 8;    // 不滚动时最多显示多少条
  static constexpr int kTimeColWidth = 42;      // 时间列宽（"HH:MM" + 竖线）
  static constexpr int kCloseBtnSize = 22;
  static constexpr int kCollapseBtnSize = 22;
  static constexpr int kCornerRadius = 12;
  static constexpr int kCalIconSize = 14;       // 标题栏日历图标尺寸

  static constexpr UINT_PTR kButtonCloseId = 2001;
  static constexpr UINT_PTR kButtonCollapseId = 2002;

  static LRESULT CALLBACK WndProc(HWND hwnd, UINT message,
                                  WPARAM wparam,
                                  LPARAM lparam) noexcept;
  LRESULT HandleMessage(HWND hwnd, UINT message,
                        WPARAM wparam,
                        LPARAM lparam) noexcept;

  static void EnsureClassRegistered();

  void EnsureButtons();
  void EnsureFonts();
  void LayoutChildren();
  void ApplyWindowRgn();
  void Paint(HWND hwnd, HDC hdc);
  void FireEvent(EventType type, const std::string& payload = "");

  std::wstring Utf8ToWide(const std::string& s) const;

  // 渲染辅助
  void DrawRoundedRect(HDC hdc, const RECT& rc, int radius,
                       COLORREF fill, COLORREF border);
  // 不能叫 DrawText —— windows.h 的 DrawText 宏会展开成 DrawTextW，撞 Win32 API。
  void DrawUiText(HDC hdc, const RECT& rc, const std::wstring& text,
                  HFONT font, COLORREF color,
                  UINT flags = DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS);
  /// 绘制标题栏日历图标（GDI 矢量绘制，避免 emoji 渲染不一致）。
  void DrawCalendarIcon(HDC hdc, int x, int y, int size, COLORREF color);
  /// 从 "HH:MM" 时间文本中解析小时。
  int ParseHour(const std::string& time_text) const;
  /// 根据小时返回时间文字颜色（对齐 in-app _buildScheduleRow 的配色）。
  COLORREF GetTimeColor(const std::string& time_text) const;

  /// 根据当前日程数量 + 折叠状态计算需要的窗口高度。
  int CalculateWindowHeight() const;

  HWND window_handle_ = nullptr;

  // 顶栏按钮
  HWND btn_collapse_ = nullptr;
  HWND btn_close_ = nullptr;
  HFONT font_ui_ = nullptr;
  HFONT font_title_ = nullptr;
  HFONT font_time_ = nullptr;
  HFONT font_notes_ = nullptr;  // 备注小字号（10pt）

  // 状态
  bool on_top_ = true;
  bool collapsed_ = false;
  std::vector<ScheduleItem> items_;

  EventCallback event_callback_;
};

#endif  // RUNNER_SCHEDULE_FLOATING_WINDOW_H_
