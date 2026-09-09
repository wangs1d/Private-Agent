#ifndef RUNNER_DESKTOP_NOTIFICATION_WINDOW_H_
#define RUNNER_DESKTOP_NOTIFICATION_WINDOW_H_

#include <windows.h>

#include <functional>
#include <string>

// ── 桌面通知弹窗（v3 精修版） ──
//    玻璃背景 = 低透明度 DWM Acrylic 模糊 + 自绘半透明渐变压暗层（通透度可控，
//    不依赖系统“透明效果”开关）；DWM 系统级圆角；
//    形状与文字全部 GDI+ 抗锯齿渲染（写入正确的预乘 alpha，玻璃表面无伪影）。
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
  void DrawBellGlyph(HDC hdc, const RECT& rc, COLORREF color);
  int  MeasureButtonWidth(HDC hdc, const std::wstring& label) const;
  int  MeasureMessageHeight(HDC hdc) const;

  // 热区命中：0=无，1=关闭，2=稍后(dismiss)，3=知道了(confirm)
  int  HitTest(const POINT& pt) const;

  HWND window_handle_ = nullptr;

  std::wstring title_;         // 正文粗标题（原 title 字段）
  std::wstring message_;       // 正文描述
  std::wstring confirm_text_;  // 主按钮文字
  bool show_confirm_button_ = false;
  int auto_close_ms_ = 0;
  COLORREF accent_color_ = RGB(0x7A, 0xA2, 0xFF);  // 按 priority 着色
  int window_height_ = 172;                        // Show 时按内容计算
  ULONGLONG show_tick_ = 0;                        // 自动关闭进度起点

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

  // GDI+ 生命周期
  ULONG_PTR gdiplus_token_ = 0;

  static constexpr UINT_PTR kTickTimerId = 3002;
  static constexpr int kWindowWidth  = 384;
  static constexpr int kMinHeight    = 132;
  static constexpr int kMaxHeight    = 320;
  static constexpr int kMargin       = 16;
  static constexpr const wchar_t* kClassName =
      L"PAI_DesktopNotification_Window";
};

#endif  // RUNNER_DESKTOP_NOTIFICATION_WINDOW_H_
