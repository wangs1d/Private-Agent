#ifndef RUNNER_SPHERE_OVERLAY_WINDOW_H_
#define RUNNER_SPHERE_OVERLAY_WINDOW_H_

#include <windows.h>

#include <functional>
#include <memory>
#include <string>

class SphereOverlayWindow {
 public:
  using PatchMoodCallback = std::function<void(const std::string& json)>;

  SphereOverlayWindow();
  ~SphereOverlayWindow();

  bool Create(HWND parent, const std::string& overlay_url);
  void Destroy();

  void Show();
  void Hide();
  bool IsVisible() const;
  bool IsCreated() const;
  bool IsWebViewReady() const;

  void MoveTo(int x, int y, int duration_ms = 1200);
  void MoveBy(int dx, int dy);

  void SetBounds(int x, int y, int width, int height, int duration_ms = 0);
  RECT GetBounds() const;

  void SetIgnoreMouseEvents(bool ignore, bool forward = true);

  void Roam();

  void PatchMood(const std::string& json_patch);

  void SetPatchMoodCallback(PatchMoodCallback cb);

  RECT GetWorkArea() const;

  HWND GetHandle() const { return window_handle_; }

 private:
  static LRESULT CALLBACK WndProc(HWND hwnd, UINT message,
                                  WPARAM wparam, LPARAM lparam) noexcept;

  LRESULT HandleMessage(HWND hwnd, UINT message,
                        WPARAM wparam, LPARAM lparam) noexcept;

  void AnimateMove(int target_x, int target_y, int duration_ms = 1200);

  static void EnsureClassRegistered();

  void OnWebviewReady();
  void OnWebMessage(const std::wstring& json_msg);

  HWND window_handle_ = nullptr;
  HWND parent_handle_ = nullptr;

  std::string stored_url_;

  struct AnimState {
    int start_x = 0, start_y = 0;
    int target_x = 0, target_y = 0;
    DWORD start_time = 0;
    int duration_ms = 1200;
    UINT_PTR timer_id = 0;
  } anim_state_;

  PatchMoodCallback patch_callback_;

  bool ignore_mouse_ = false;
  bool mouse_forward_ = true;
  bool webview_ready_ = false;

  int overlay_width_ = 300;
  int overlay_height_ = 380;

  void ApplyWebviewBounds();

  static constexpr const wchar_t* kClassName =
      L"PAI_SphereOverlay_Window";

};

#endif  // RUNNER_SPHERE_OVERLAY_WINDOW_H_
