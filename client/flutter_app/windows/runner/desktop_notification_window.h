#ifndef RUNNER_DESKTOP_NOTIFICATION_WINDOW_H_
#define RUNNER_DESKTOP_NOTIFICATION_WINDOW_H_

#include <windows.h>

#include <functional>
#include <string>

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
  void Paint(HWND hwnd, HDC hdc);
  void DrawRoundedRect(HDC hdc, const RECT& rc, int radius, COLORREF fill,
                       COLORREF border);
  void DrawPillButton(HDC hdc, const RECT& rc, COLORREF fill, COLORREF border,
                      const std::wstring& label, COLORREF text_color);

  HWND window_handle_ = nullptr;
  HWND confirm_btn_ = nullptr;
  HWND close_btn_ = nullptr;
  HBRUSH confirm_brush_ = nullptr;
  HBRUSH confirm_border_brush_ = nullptr;

  std::wstring title_;
  std::wstring message_;
  std::wstring priority_;
  std::wstring confirm_text_;
  bool show_confirm_button_ = false;
  int auto_close_ms_ = 0;

  ConfirmCallback on_confirm_;
  DismissCallback on_dismiss_;
  TimeoutCallback on_timeout_;

  static constexpr UINT_PTR kAutoCloseTimerId = 3001;
  static constexpr int kWindowWidth = 384;
  static constexpr int kWindowHeight = 176;
  static constexpr int kMargin = 16;
  static constexpr int kIdConfirm = 21;
  static constexpr int kIdClose = 22;
  static constexpr const wchar_t* kClassName =
      L"PAI_DesktopNotification_Window";
};

#endif  // RUNNER_DESKTOP_NOTIFICATION_WINDOW_H_
