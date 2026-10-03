#ifndef RUNNER_OUTGOING_CALL_WINDOW_H_
#define RUNNER_OUTGOING_CALL_WINDOW_H_

#include <windows.h>

#include <functional>
#include <string>

class OutgoingCallWindow {
 public:
  using HangUpCallback = std::function<void()>;

  OutgoingCallWindow();
  ~OutgoingCallWindow();

  void SetCallbacks(HangUpCallback on_hangup);
  void Show(const std::string& caller_name,
            const std::string& subtitle,
            const std::string& caller_initial,
            uint32_t accent_color_hex);
  void Hide();
  bool IsVisible() const;

  // 窗口尺寸（.cpp 布局常量引用；对齐微信语音通话弹窗）
  static constexpr int kWindowWidth = 300;
  static constexpr int kWindowHeight = 316;

 private:
  static LRESULT CALLBACK WndProc(HWND hwnd, UINT message,
                                  WPARAM wparam, LPARAM lparam) noexcept;
  LRESULT HandleMessage(HWND hwnd, UINT message,
                        WPARAM wparam, LPARAM lparam) noexcept;

  void EnsureClassRegistered();
  bool CreateWindowIfNeeded();
  void PositionAtBottomRight();
  void StartPulse();
  void StopPulse();
  void DestroyNativeWindow();
  void Paint(HWND hwnd, HDC hdc);

  HWND window_handle_ = nullptr;
  std::wstring caller_name_;
  std::wstring subtitle_;
  std::wstring caller_initial_;
  int pulse_phase_ = 0;
  bool title_min_hover_ = false;    // 标题栏最小化悬停
  bool title_close_hover_ = false;  // 标题栏关闭悬停
  bool pill_hover_ = false;         // 挂断胶囊悬停
  HangUpCallback on_hangup_;

  // 玻璃底已改为逐像素 alpha 半透明（见 call_visuals.h），不再抓拍桌面

  static constexpr UINT_PTR kPulseTimerId = 4001;
  static constexpr int kMargin = 20;
  static constexpr const wchar_t* kClassName = L"PAI_OutgoingCall_Window";
};

#endif  // RUNNER_OUTGOING_CALL_WINDOW_H_
