#ifndef RUNNER_DESKTOP_NOTIFICATION_WINDOW_H_
#define RUNNER_DESKTOP_NOTIFICATION_WINDOW_H_

#include <windows.h>
#include <gdiplus.h>

#include <functional>
#include <memory>
#include <string>

// ── 桌面通知弹窗（真透明玻璃版） ──
//    卡片 = 恒定半透明深渐变（逐像素 alpha），WS_EX_LAYERED +
//    UpdateLayeredWindow 上屏，DWM 实时合成——背后桌面/窗口变化、
//    弹窗存活期内始终透出当下画面（旧版弹出前抓拍桌面当假玻璃，
//    背景永远停在抓拍帧，已废）。玻璃视觉原语与通话弹窗家族同源
//    （call_visuals.h）；形状与文字全部 GDI+ 抗锯齿渲染进 PARGB 表面；
//    DWM 系统级圆角。
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
  void ApplyRoundedCorners(HWND hwnd);
  POINT BottomRightOrigin() const;
  void ComputeLayout();
  void DestroyNativeWindow();
  void StartTimer();
  void StopTimer();
  void Repaint();

  // ── 绘制 ──
  // hdc 仅用于字体度量；像素全部画进 call_vis::GlassSurface（PARGB），
  // 随后 UpdateLayeredWindow 整窗上屏（半透明区域 DWM 实时合成）。
  void Paint(HWND hwnd, HDC hdc);
  void PaintLayered(HWND hwnd);
  void DrawBellGlyph(Gdiplus::Graphics& g, const RECT& rc, COLORREF color);
  int  MeasureButtonWidth(HDC hdc, const std::wstring& label) const;
  int  MeasureMessageHeight(HDC hdc) const;

  // 热区命中：0=无，1=关闭，3=知道了(confirm)
  int  HitTest(const POINT& pt) const;

  HWND window_handle_ = nullptr;

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
