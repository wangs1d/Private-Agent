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
///   - 顶栏：📅 今日安排 + 完成计数 + 日期 + 折叠按钮 + 关闭按钮
///   - 内容：24h 日程带（now 游标）+ 下一事项焦点卡 + 点线时间轴，
///     视觉对齐 in-app「焦点时间轴」卡片（docs/design/today-schedule-redesign）
///   - 空态提示；折叠时只剩顶栏
///
/// 通过 MethodChannel `pai/schedule_floating` 与 Dart 端通信：
///   - Dart -> C++：create / show / hide / destroy / setBounds / setSchedule / setTheme
///   - C++ -> Dart：onClose / onCollapseChanged
class ScheduleFloatingWindow {
 public:
  /// 主题调色板：逐字段对齐 right_side_panel.dart 的 _SchedSkin
  /// （_dark / _warm 两套皮肤）。半透明色按「alpha 混入对应底层」预计算为实色
  /// （GDI 不支持 alpha），保证与 in-app 卡片逐层叠加后的最终渲染色一致。
  struct Palette {
    COLORREF surface_bg;      // 窗口卡底 = surfaceContainer 上叠 cardFill 后的实色
    COLORREF border;          // 窗口描边 = cardBorder 混合后实色
    COLORREF text_primary;    // titleText 顶栏标题 / 空态标题
    COLORREF text_body;       // bodyText 事项标题
    COLORREF text_secondary;  // mutedText 次文字（未完成时间 / 底部计数）
    COLORREF text_dim;        // dimTitle 完成标题
    COLORREF text_strike;     // dimStrike 完成删除线
    COLORREF time_dim;        // dimTime 完成时间
    COLORREF accent;          // accent（深色皮肤为纯黑，见 _SchedSkin._dark）
    COLORREF accent_soft;     // accentSoft「接下来·倒计时」/ NOW 文字 / done 计数
    COLORREF focus_border;    // focusBorder 混合后实色
    COLORREF focus_time;      // focusTime 焦点时间
    COLORREF focus_note;      // focusNote 焦点备注
    COLORREF dot_blue;        // dotBlue（<10 点）
    COLORREF dot_amber;       // dotAmber（10-14 点）
    COLORREF dot_green;       // dotGreen（14-18 点）
    COLORREF dot_gray;        // dotGray（其它时段）
    COLORREF glow_blue;       // 圆点光晕 = dot 色 alpha 混入卡底
    COLORREF glow_amber;
    COLORREF glow_green;
    COLORREF glow_gray;
    COLORREF glow_accent;     // 下一事项光晕 = accent alpha 混入卡底
    COLORREF dot_done_fill;   // doneDotFill 完成圆点
    COLORREF dot_done_ring;   // doneDotRing 完成圆环
    COLORREF timeline_line;   // line 竖向点线
    COLORREF track;           // 日程带轨道
    COLORREF elapsed_start;   // 已流逝段渐变起点
    COLORREF elapsed_end;     // 已流逝段渐变终点
    COLORREF needle;          // now 游标
    COLORREF needle_glow;     // now 游标光晕
    COLORREF tick_label;      // tickLabel 刻度标签
    COLORREF now_tag_bg;      // NOW 标签底 = accent 12% 混入卡底
    COLORREF all_done_fill;   // 完成横幅底 = dotGreen 8% 混入卡底
    COLORREF all_done_border; // 完成横幅描边 = dotGreen 25% 混入卡底
    COLORREF all_done_text;   // 完成横幅文字 = dotGreen
    COLORREF btn_bg;          // 顶栏按钮底（in-app 无对应，随主题取中性色）
    COLORREF btn_border;      // 顶栏按钮描边
    COLORREF btn_text;        // 顶栏按钮文字
    COLORREF chip_grad_top;    // 头部图标底座渐变起点（chipGradient[0] 混入卡底）
    COLORREF chip_grad_bottom; // 头部图标底座渐变终点（chipGradient[1] 混入卡底）
    COLORREF focus_grad_top;   // 焦点卡渐变起点（focusGradient[0] 混入卡底）
    COLORREF focus_grad_bottom;// 焦点卡渐变终点（focusGradient[1] 混入卡底）
    COLORREF empty_icon_border; // 空态插画边框 = accent 22% 混入卡底
    COLORREF empty_bar;         // 空态插画顶部横条 = accent 45% 混入卡底
    COLORREF empty_cell;        // 空态插画格子 = emptyCell 混入卡底
  };

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

  /// 设置主题配色（true=深色 / false=浅色暖色），变化时立即重绘。
  /// 对齐 in-app AppThemeVariant.dark / warm（_SchedSkin._dark / _warm）。
  void SetTheme(bool dark);
  bool IsDarkTheme() const { return dark_theme_; }

  /// 由 Dart 端下发 FlutterView 的 devicePixelRatio 作为缩放系数
  /// （进程内 GetDpiForWindow 可能被虚拟化，DPR 才是与 in-app 一致的基准）。
  void SetDpiScale(double scale) {
    if (scale > 0.1 && scale < 10.0) dpi_scale_ = scale;
  }

  /// 注册事件回调。
  void SetEventCallback(EventCallback cb) { event_callback_ = std::move(cb); }

 private:
  static constexpr const wchar_t* kClassName = L"PAI_ScheduleFloating_Window";
  // 布局常量均为逻辑像素（96 DPI 基准），渲染时经 [S] 按窗口 DPI 等比放大，
  // 与 in-app 220 逻辑宽面板视觉一致。
  static constexpr int kTitleBarHeight = 40;    // 顶栏高
  static constexpr int kMinWidth = 200;
  static constexpr int kDefaultWidth = 220;     // 对齐 in-app 面板宽
  static constexpr int kDefaultHeight = 420;
  static constexpr int kBodyPadding = 12;       // 内容区内边距（对齐 in-app 卡片 12px）
  static constexpr int kStripBlockHeight = 30;  // 24h 日程带区块（4px 条 + 刻度标签）
  static constexpr int kFocusHeightNoNotes = 54; // 焦点卡高（无备注）
  static constexpr int kFocusHeightNotes = 68;   // 焦点卡高（含备注行）
  static constexpr int kAllDoneBannerHeight = 28; // 全部完成横幅高
  static constexpr int kRowHeight = 24;          // 时间轴单行高（恒定，对齐 in-app）
  static constexpr int kFooterHeight = 26;       // 底部「还有 N 项」行高
  static constexpr int kMaxVisibleItems = 5;     // 时间轴最多展示条数（对齐 in-app）
  static constexpr int kTimeColWidth = 38;       // 时间列宽
  static constexpr int kNodeColWidth = 18;       // 圆点节点列宽
  static constexpr int kCloseBtnSize = 22;
  static constexpr int kCollapseBtnSize = 22;
  static constexpr int kCornerRadius = 16;   // 窗口四角圆角
  static constexpr int kHeaderChipSize = 20;    // 标题栏图标底座（圆角方块）
  static constexpr int kCalIconSize = 11;       // 标题栏日历图标尺寸

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
  void DestroyFonts();
  void LayoutChildren();
  void ApplyWindowRgn();
  void Paint(HWND hwnd, HDC hdc);
  void FireEvent(EventType type, const std::string& payload = "");

  std::wstring Utf8ToWide(const std::string& s) const;

  /// 逻辑像素 -> 物理像素（按窗口 DPI 等比缩放）。
  int S(int v) const;
  double Sd(double v) const;
  /// 读取窗口当前 DPI 更新缩放系数（创建后 / WM_DPICHANGED 时调用）。
  void UpdateDpiScale();

  // 渲染辅助
  void DrawRoundedRect(HDC hdc, const RECT& rc, int radius,
                       COLORREF fill, COLORREF border);
  // 不能叫 DrawText —— windows.h 的 DrawText 宏会展开成 DrawTextW，撞 Win32 API。
  void DrawUiText(HDC hdc, const RECT& rc, const std::wstring& text,
                  HFONT font, COLORREF color,
                  UINT flags = DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS);
  /// 绘制标题栏日历图标（GDI 矢量绘制，避免 emoji 渲染不一致）。
  void DrawCalendarIcon(HDC hdc, int x, int y, int size, COLORREF color);
  /// 绘制实心圆（时间轴圆点 / 日程带刻度）。
  void DrawCircle(HDC hdc, int cx, int cy, double radius, COLORREF fill,
                  COLORREF ring = 0);
  /// 绘制带圆角裁剪的纵向渐变圆角矩形（对齐 in-app 的渐变卡片/底座）。
  void DrawGradientRounded(HDC hdc, const RECT& rc, int radius,
                           COLORREF top, COLORREF bottom);
  /// 24h 日程带：4px 轨道 + 事项刻度 + now 游标 + 0/6/12/18/24 点标签。
  void DrawDayStrip(HDC hdc, int y, int width);
  /// 下一事项焦点卡：倒计时说明 + 时间 + 标题 + 备注。
  void DrawFocusCard(HDC hdc, int y, int width, const ScheduleItem& next,
                     int minutes_ahead);
  /// 「今日安排已全部完成」横幅。
  void DrawAllDoneBanner(HDC hdc, int y, int width);
  /// 点线时间轴（圆点压在连续竖线上，行高恒定保证对齐）。
  void DrawTimeline(HDC hdc, int y, int width, const ScheduleItem* next);
  /// 底部「还有 N 项安排」。
  void DrawFooter(HDC hdc, int y, int width, int hidden_count);
  /// 空态：插画式日历块 + 文案 + 新建按钮（对齐 in-app 空态）。
  void DrawEmptyState(HDC hdc, int y, int width);
  /// 从 "HH:MM" 时间文本解析当天分钟数，失败返回 -1。
  int ParseMinutes(const std::string& time_text) const;
  /// 从 "HH:MM" 时间文本中解析小时。
  int ParseHour(const std::string& time_text) const;
  /// 当前主题调色板（深 / 浅两套，见 .cpp 中 kDarkPalette / kLightPalette）。
  const Palette& pal() const;
  /// 根据小时返回类别圆点颜色（<10 蓝 / <14 琥珀 / <18 绿 / 其它灰）。
  COLORREF CategoryColor(int hour) const;
  /// 距下一事项的倒计时文案（分钟数）。
  std::wstring CountdownLabel(int minutes_ahead) const;
  /// 下一事项指针（首个未完成项），没有则 nullptr。
  const ScheduleItem* NextItem() const;

  /// 根据当前日程数量 + 折叠状态计算需要的窗口高度。
  int CalculateWindowHeight() const;

  HWND window_handle_ = nullptr;

  // 顶栏按钮
  HWND btn_collapse_ = nullptr;
  HWND btn_close_ = nullptr;
  HFONT font_ui_ = nullptr;
  HFONT font_title_ = nullptr;
  HFONT font_time_ = nullptr;
  HFONT font_notes_ = nullptr;   // 备注小字号
  HFONT font_caption_ = nullptr; // 焦点卡说明/刻度标签小字
  HFONT font_strike_ = nullptr;  // 完成事项删除线
  HFONT font_focus_time_ = nullptr; // 焦点卡时间大字
  HFONT font_body_lg_ = nullptr; // 空态引导/按钮正文（加大加粗）

  // 状态
  bool on_top_ = true;
  bool collapsed_ = false;
  bool dark_theme_ = true;  // true=深色皮肤（_SchedSkin._dark）/ false=暖色（_warm）
  double dpi_scale_ = 1.0;  // 窗口 DPI / 96，渲染几何与字号按此缩放
  std::vector<ScheduleItem> items_;

  EventCallback event_callback_;
};

#endif  // RUNNER_SCHEDULE_FLOATING_WINDOW_H_
