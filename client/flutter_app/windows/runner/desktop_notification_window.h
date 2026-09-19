#ifndef RUNNER_DESKTOP_NOTIFICATION_WINDOW_H_
#define RUNNER_DESKTOP_NOTIFICATION_WINDOW_H_

#include <windows.h>
#include <gdiplus.h>

#include <functional>
#include <memory>
#include <string>

// ── 桌面通知弹窗（v4 全透明玻璃版） ──
//    玻璃背景 = 弹出前抓拍弹窗将覆盖的桌面像素 → 降采样模糊 → 全窗绘制，
//    再叠一层极薄渐变托住文字对比度。不依赖系统 Acrylic/"透明效果"开关
//    （未公开的 AccentPolicy 接口在部分 Win11 版本上已失效），任何环境下
//    都呈现"透明玻璃盖在桌面上"的效果；DWM 系统级圆角；
//    形状与文字全部 GDI+ 抗锯齿渲染。
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
  POINT BottomRightOrigin() const;
  void CaptureBackdrop(int origin_x, int origin_y);
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

  // 热区命中：0=无，1=关闭，3=知道了(confirm)
  int  HitTest(const POINT& pt) const;

  HWND window_handle_ = nullptr;
  // 弹出前抓拍并模糊的桌面背景（自绘毛玻璃底）
  std::unique_ptr<Gdiplus::Bitmap> backdrop_;
  // 毛玻璃底的自适应压暗系数（1=不压；背后桌面太亮时 <1，保证白字可读）
  float backdrop_dim_ = 1.0f;

  std::wstring title_;         // 正文粗标题（原 title 字段）
  std::wstring message_;       // 正文描述
  std::wstring confirm_text_;  // 主按钮文字（唯一按钮）
  int auto_close_ms_ = 0;
  COLORREF accent_color_ = RGB(0x7A, 0xA2, 0xFF);  // 按 priority 着色
  int window_height_ = 172;                        // Show 时按内容计算
  ULONGLONG show_tick_ = 0;                        // 自动关闭进度起点

  // 布局热区
  RECT rc_close_{};
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
