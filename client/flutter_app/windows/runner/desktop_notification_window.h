#ifndef RUNNER_DESKTOP_NOTIFICATION_WINDOW_H_
#define RUNNER_DESKTOP_NOTIFICATION_WINDOW_H_

#include <windows.h>

#include <functional>
#include <string>

// ── 新版桌面通知：macOS 风格深色半透明毛玻璃 ──
//    360×172 · 20px 圆角 · 顶部图标胶囊+标题/副标题+圆形关闭
//    分隔线 · 正文标题+正文内容 · 底部稍后/知道了双按钮
class DesktopNotificationWindow {
 public:
  using ConfirmCallback = std::function<void()>;
  using DismissCallback = std::function<void()>;
  using TimeoutCallback = std::function<void()>;

  DesktopNotificationWindow();
  ~DesktopNotificationWindow();

  void SetCallbacks(ConfirmCallback on_confirm,
                    DismissCallback on_dismiss,
                    TimeoutCallback on_timeout);

  void Show(const std::string& title,
            const std::string& message,
            const std::string& priority,
            bool show_confirm_button,
            const std::string& confirm_text,
            int auto_close_ms);
  void Hide();
  bool IsVisible() const;

 private:
  static LRESULT CALLBACK WndProc(HWND hwnd, UINT message,
                                  WPARAM wparam, LPARAM lparam) noexcept;
  LRESULT HandleMessage(HWND hwnd, UINT message,
                        WPARAM wparam, LPARAM lparam) noexcept;

  void EnsureClassRegistered();
  bool CreateWindowIfNeeded();
  void PositionAtBottomRight();
  void LayoutChildren();
  void DestroyNativeWindow();
  void StartTimer();
  void StopTimer();

  // ── 绘制 ──
  void Paint(HWND hwnd, HDC hdc);
  void DrawRoundedFill(HDC hdc, const RECT& rc, int radius, COLORREF fill);
  void DrawBellIcon(HDC hdc, const RECT& rc, COLORREF bg, COLORREF glyph);
  void DrawCloseButton(HDC hdc, const RECT& rc, bool hovered);
  void DrawRoundedPillButton(HDC hdc, const RECT& rc, COLORREF fill,
                             COLORREF border, const std::wstring& label,
                             COLORREF text_color);
  void DrawHeaderText(HDC hdc, const std::wstring& main,
                      const std::wstring& sub, const RECT& rc);

  // ── 窗口句柄 / 控件 ──
  HWND window_handle_ = nullptr;
  HWND dismiss_btn_ = nullptr;   // 稍后（左）
  HWND confirm_btn_ = nullptr;   // 知道了（右）
  HWND close_btn_ = nullptr;     // 右上角圆形 ×
  HBRUSH dismiss_brush_ = nullptr;
  HBRUSH dismiss_border_brush_ = nullptr;
  HBRUSH confirm_brush_ = nullptr;

  // ── 文本 ──
  std::wstring header_title_;
  std::wstring message_;
  std::wstring priority_;
  std::wstring confirm_text_;
  std::wstring dismiss_text_;
  bool show_confirm_button_ = false;
  int auto_close_ms_ = 0;

  // ── 悬停状态 ──
  bool close_hovered_ = false;

  // ── 回调 ──
  ConfirmCallback on_confirm_;
  DismissCallback on_dismiss_;
  TimeoutCallback on_timeout_;

  // ── 常量 ──
  static constexpr UINT_PTR kAutoCloseTimerId = 3001;
  static constexpr int kWindowWidth  = 360;
  static constexpr int kWindowHeight = 172;
  static constexpr int kCornerRadius = 20;
  static constexpr int kMargin       = 16;
  static constexpr int kIdDismiss    = 21;
  static constexpr int kIdConfirm    = 22;
  static constexpr int kIdClose      = 23;
  static constexpr const wchar_t* kClassName =
      L"PAI_DesktopNotification_Window";
};

#endif  // RUNNER_DESKTOP_NOTIFICATION_WINDOW_H_
