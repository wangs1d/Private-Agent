#ifndef RUNNER_DESKTOP_NOTIFICATION_WINDOW_H_
#define RUNNER_DESKTOP_NOTIFICATION_WINDOW_H_

#include <windows.h>

#include <functional>
#include <string>

// ── macOS 风格系统通知弹窗（v2） ──
//    DWM Acrylic 真毛玻璃（桌面背景真实模糊）+ DWM 系统级圆角（无黑角）
//    全部控件由父窗口 GDI 自绘（无子控件黑底），点击热区自管理
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
  void ApplyAcrylicBlur(HWND hwnd);
  void ApplyRoundedCorners(HWND hwnd);
  void PositionAtBottomRight();
  void ComputeLayout();
  void DestroyNativeWindow();
  void StartTimer();
  void StopTimer();
  void Repaint();

  // ── 绘制 ──
  void Paint(HWND hwnd, HDC hdc);
  void FillSolidCircle(HDC hdc, const RECT& rc, COLORREF fill);
  void DrawBell(HDC hdc, int cx, int cy, COLORREF color);
  void DrawCloseGlyph(HDC hdc, const RECT& rc, COLORREF color);
  void DrawOutlineButton(HDC hdc, const RECT& rc,
                         const std::wstring& label, bool hovered);
  void DrawLine(HDC hdc, int x1, int y1, int x2, int y2, COLORREF color,
                int width);

  // 热区命中：0=无，1=关闭，2=稍后(dismiss)，3=知道了(confirm)
  int  HitTest(const POINT& pt) const;

  HWND window_handle_ = nullptr;

  std::wstring title_;         // 正文粗标题（原 title 字段）
  std::wstring message_;       // 正文描述
  std::wstring confirm_text_;  // 主按钮文字
  bool show_confirm_button_ = false;
  int auto_close_ms_ = 0;

  // 布局热区
  RECT rc_close_{};
  RECT rc_dismiss_{};
  RECT rc_confirm_{};

  // 交互状态
  int  hover_id_ = 0;
  bool mouse_tracking_ = false;

  ConfirmCallback on_confirm_;
  DismissCallback on_dismiss_;
  TimeoutCallback on_timeout_;

  static constexpr UINT_PTR kAutoCloseTimerId = 3001;
  static constexpr int kWindowWidth  = 360;
  static constexpr int kWindowHeight = 172;
  static constexpr int kMargin       = 16;
  static constexpr const wchar_t* kClassName =
      L"PAI_DesktopNotification_Window";
};

#endif  // RUNNER_DESKTOP_NOTIFICATION_WINDOW_H_
