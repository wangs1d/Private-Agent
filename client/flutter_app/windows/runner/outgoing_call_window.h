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
  HWND hangup_btn_ = nullptr;
  HBRUSH hangup_brush_ = nullptr;
  std::wstring caller_name_;
  std::wstring subtitle_;
  std::wstring caller_initial_;
  uint32_t accent_color_ = 0xFF22C55E;
  int pulse_phase_ = 0;
  HangUpCallback on_hangup_;

  static constexpr UINT_PTR kPulseTimerId = 4001;
  static constexpr int kIdHangup = 31;
  static constexpr int kWindowWidth = 384;
  static constexpr int kWindowHeight = 224;
  static constexpr int kMargin = 16;
  static constexpr const wchar_t* kClassName = L"PAI_OutgoingCall_Window";
};

#endif  // RUNNER_OUTGOING_CALL_WINDOW_H_
