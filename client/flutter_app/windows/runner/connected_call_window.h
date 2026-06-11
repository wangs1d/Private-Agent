#ifndef RUNNER_CONNECTED_CALL_WINDOW_H_
#define RUNNER_CONNECTED_CALL_WINDOW_H_

#include <windows.h>

#include <functional>
#include <string>

// 独立的"通话中"悬浮窗 —— 脱离主 Flutter 窗口存在。
//
// 仿电脑微信电话窗口设计：
//   - 竖向布局（320 x 540）
//   - 顶部：状态文字（"通话中 / 静音中"）
//   - 中央：大圆形头像（120 x 120），外圈光晕（呼吸动画表示对方在说话/音频在播）
//   - 头像下：通话对方名称
//   - 名称下：通话计时 mm:ss（每秒自增）
//   - 底部一排：静音按钮 | 免提按钮 | 挂断按钮（红色突出）
//   - 标题区可拖动
//
// 生命周期：
//   - Show(payload)        创建或更新窗口，开始计时
//   - SetMute()/SetSpeaker() 由 Dart 端 push 状态变化（用于 server 端同步后回写）
//   - SetTalking(bool)    控制头像光晕是否呼吸（true = 正在播放音频）
//   - Hide()              停计时 + 销毁窗口
//
// 事件回传（MethodChannel pai/connected_call）：
//   - onHangUp     : 用户点挂断
//   - onMuteToggle : 用户点静音（payload 包含 newMute 布尔）
//   - onSpeakerToggle
//   - onMinimize   : 用户点最小化（未来扩展）
class ConnectedCallWindow {
 public:
  using HangUpCallback = std::function<void()>;
  using MuteCallback = std::function<void(bool new_mute)>;
  using SpeakerCallback = std::function<void(bool new_speaker)>;

  ConnectedCallWindow();
  ~ConnectedCallWindow();

  void SetCallbacks(HangUpCallback on_hangup,
                    MuteCallback on_mute_toggle,
                    SpeakerCallback on_speaker_toggle);

  // 创建或更新窗口内容（不重置已通话秒数）。如果窗口已存在，仅更新 caller 字段。
  void Show(const std::string& caller_name,
            const std::string& caller_initial,
            uint32_t accent_color_hex);

  // 完全销毁窗口并停止计时
  void Hide();

  bool IsVisible() const;

  // 由 Dart 端推过来的状态（用于 server 端 mute/speaker 变更后同步 UI）
  void SetMute(bool muted);
  void SetSpeaker(bool on);
  // 控制头像呼吸光晕（TTS 播放中置 true）
  void SetTalking(bool talking);

  // 强制重置计时（一般接听瞬间在 Show 后调用，避免从 ringing 阶段累计）
  void ResetDuration();

  // 由 GetTickCount64 等推过来的 server 端时间戳校准（可选）
  void SetElapsedSeconds(int seconds);

 private:
  static LRESULT CALLBACK WndProc(HWND hwnd, UINT message,
                                  WPARAM wparam, LPARAM lparam) noexcept;
  LRESULT HandleMessage(HWND hwnd, UINT message,
                        WPARAM wparam, LPARAM lparam) noexcept;

  void EnsureClassRegistered();
  bool CreateWindowIfNeeded();
  void PositionAtBottomRight();
  void RepositionChildren();

  void StartTimer();
  void StopTimer();
  void StartPulse();
  void StopPulse();
  void DestroyNativeWindow();

  void Paint(HWND hwnd, HDC hdc);
  void DrawRoundedRect(HDC hdc, const RECT& rc, int radius, COLORREF fill,
                       COLORREF border);
  void DrawActionButton(HDC hdc, const RECT& rc, COLORREF fill, COLORREF border,
                        const std::wstring& label);
  void DrawAvatar(HDC hdc, const RECT& rc, const std::wstring& initial,
                  COLORREF bg);

  static void CALLBACK TickProc(HWND hwnd, UINT msg, UINT_PTR id,
                                DWORD time) noexcept;

  HWND window_handle_ = nullptr;
  HWND mute_btn_ = nullptr;
  HWND speaker_btn_ = nullptr;
  HWND hangup_btn_ = nullptr;

  std::wstring caller_name_;
  std::wstring caller_initial_;
  uint32_t accent_color_ = 0xFF22C55E;

  // 状态
  int elapsed_seconds_ = 0;
  bool muted_ = false;
  bool speaker_on_ = true;
  bool talking_ = false;  // 头像是否在呼吸（TTS 播放中）
  int pulse_phase_ = 0;

  // 按钮背景刷
  HBRUSH mute_brush_ = nullptr;
  HBRUSH speaker_brush_ = nullptr;
  HBRUSH hangup_brush_ = nullptr;
  HBRUSH action_border_brush_ = nullptr;

  HangUpCallback on_hangup_;
  MuteCallback on_mute_toggle_;
  SpeakerCallback on_speaker_toggle_;

  static constexpr UINT_PTR kTickTimerId = 2001;
  static constexpr UINT_PTR kPulseTimerId = 2002;

  // 自定义消息：延迟销毁窗口（避免在 WM_COMMAND 中嵌套 DestroyWindow）
  static constexpr UINT kMsgDeferredHide = WM_USER + 200;

  // 窗口尺寸
  static constexpr int kWindowWidth = 384;
  static constexpr int kWindowHeight = 296;
  static constexpr int kMargin = 16;

  static constexpr const wchar_t* kClassName =
      L"PAI_ConnectedCall_Window";

  // 按钮 ID（用于 WM_COMMAND）
  static constexpr int kIdMute = 11;
  static constexpr int kIdSpeaker = 12;
  static constexpr int kIdHangup = 13;
};

#endif  // RUNNER_CONNECTED_CALL_WINDOW_H_
