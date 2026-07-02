#ifndef RUNNER_AGENT_PROFILE_OVERLAY_WINDOW_H_
#define RUNNER_AGENT_PROFILE_OVERLAY_WINDOW_H_

#include <windows.h>

#include <functional>
#include <memory>
#include <string>
#include <vector>

/// Agent 主页信息弹出窗（同进程 HWND + GDI 自绘）。
///
///   - WS_POPUP + WS_EX_TOPMOST + WS_EX_TOOLWINDOW，与主 Flutter 窗口同进程
///   - 点击聊天中 agent 头像时，在头像右侧弹出一个信息卡片
///   - 显示：头像、名称、@handle、心情状态、签名、身份信息
///   - 点击窗口外部自动关闭
///
/// 通过 MethodChannel `pai/agent_profile` 与 Dart 端通信：
///   - Dart -> C++：create / show / hide / destroy / setBounds / setProfile
class AgentProfileOverlayWindow {
 public:
  /// 头像预设（与 Dart 端 AvatarPreset 对应）
  struct ProfileData {
    std::string display_name;    // 主页名称
    std::string handle;          // 网络名称（不含 @）
    std::string signature;       // 个性签名
    std::string mood_style;      // gentle/funny/sad/cool/energetic/mysterious
    std::string status_text;     // 状态文本
    std::string avatar_preset;   // dawn/ember/tide/eclipse/neon/mist
    std::string last_profile_event; // 最近事件
  };

  enum class EventType {
    kCloseClicked,
  };
  using EventCallback = std::function<void(EventType type, const std::string& payload)>;

  AgentProfileOverlayWindow();
  ~AgentProfileOverlayWindow();

  AgentProfileOverlayWindow(const AgentProfileOverlayWindow&) = delete;
  AgentProfileOverlayWindow& operator=(const AgentProfileOverlayWindow&) = delete;

  bool Create();
  void Destroy();

  void Show();
  void Hide();
  bool IsVisible() const;
  bool IsCreated() const { return window_handle_ != nullptr; }

  void SetOnTop(bool on_top);
  bool IsOnTop() const { return on_top_; }

  void SetBounds(int x, int y, int width, int height);
  RECT GetBounds() const;

  void SetProfile(ProfileData data);

  void SetEventCallback(EventCallback cb) { event_callback_ = std::move(cb); }

 private:
  static constexpr const wchar_t* kClassName = L"PAI_AgentProfile_Window";
  static constexpr int kMinWidth = 280;
  static constexpr int kDefaultWidth = 320;
  static constexpr int kDefaultHeight = 160;
  static constexpr int kCornerRadius = 14;
  static constexpr int kPadding = 16;
  static constexpr int kAvatarSize = 56;
  static constexpr int kCloseBtnSize = 22;

  static constexpr UINT_PTR kButtonCloseId = 3001;

  static LRESULT CALLBACK WndProc(HWND hwnd, UINT message,
                                  WPARAM wparam,
                                  LPARAM lparam) noexcept;
  LRESULT HandleMessage(HWND hwnd, UINT message,
                        WPARAM wparam,
                        LPARAM lparam) noexcept;

  static void EnsureClassRegistered();

  void EnsureButtons();
  void EnsureFonts();
  void LayoutChildren();
  void ApplyWindowRgn();
  void Paint(HWND hwnd, HDC hdc);
  void FireEvent(EventType type, const std::string& payload = "");

  std::wstring Utf8ToWide(const std::string& s) const;

  void DrawRoundedRect(HDC hdc, const RECT& rc, int radius,
                       COLORREF fill, COLORREF border);
  void DrawUiText(HDC hdc, const RECT& rc, const std::wstring& text,
                  HFONT font, COLORREF color,
                  UINT flags = DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS);

  HWND window_handle_ = nullptr;
  HWND btn_close_ = nullptr;

  HFONT font_name_ = nullptr;
  HFONT font_handle_ = nullptr;
  HFONT font_body_ = nullptr;

  bool on_top_ = true;
  ProfileData profile_;

  EventCallback event_callback_;
};

#endif  // RUNNER_AGENT_PROFILE_OVERLAY_WINDOW_H_
