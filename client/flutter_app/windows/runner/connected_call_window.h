#ifndef RUNNER_CONNECTED_CALL_WINDOW_H_
#define RUNNER_CONNECTED_CALL_WINDOW_H_

#include <windows.h>

#include <functional>
#include <string>

namespace Gdiplus {
class Bitmap;
}

// 独立的"通话中"悬浮窗 —— 脱离主 Flutter 窗口存在。
//
// 黑白极简玻璃深卡（视觉原语见 call_visuals.h）：
//   - 标题栏：信号条 + 「Nextbot 通话」+ 最小化/关闭（×=挂断，—=收起）
//   - 金属球头像（首字符），TTS 播放中双层光环呼吸
//   - 状态行：小波形（播报时跳动）+ 计时 mm:ss（静音时前缀「已静音」）
//   - 分隔线下：静音 / 免提两颗切换圆钮（激活=瓷白球）+ 挂断胶囊
//   - 标题区可拖动
//
// 生命周期：
//   - Show(payload)        创建或更新窗口，开始计时
//   - SetMute()/SetSpeaker() 由 Dart 端 push 状态变化（用于 server 端同步后回写）
//   - SetTalking(bool)    控制头像光晕是否呼吸（true = 正在播放音频）
//   - Hide()              停计时 + 销毁窗口
//
// 事件回传（MethodChannel pai/connected_call）：
//   - onHangUp     : 用户点挂断（挂断胶囊或标题栏 ×）
//   - onMuteToggle : 用户点静音（payload 包含 newMute 布尔）
//   - onSpeakerToggle
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

  // 窗口尺寸（.cpp 布局常量引用；对齐微信语音通话弹窗）
  static constexpr int kWindowWidth = 300;
  static constexpr int kWindowHeight = 368;

 private:
  static LRESULT CALLBACK WndProc(HWND hwnd, UINT message,
                                  WPARAM wparam, LPARAM lparam) noexcept;
  LRESULT HandleMessage(HWND hwnd, UINT message,
                        WPARAM wparam, LPARAM lparam) noexcept;

  void EnsureClassRegistered();
  bool CreateWindowIfNeeded();
  void PositionAtBottomRight();

  void StartTimer();
  void StopTimer();
  void StartPulse();
  void StopPulse();
  void DestroyNativeWindow();

  void Paint(HWND hwnd, HDC hdc);

  static void CALLBACK TickProc(HWND hwnd, UINT msg, UINT_PTR id,
                                DWORD time) noexcept;

  HWND window_handle_ = nullptr;

  std::wstring caller_name_;
  std::wstring caller_initial_;

  // 状态
  int elapsed_seconds_ = 0;
  bool muted_ = false;
  bool speaker_on_ = true;
  bool talking_ = false;  // 头像是否在呼吸（TTS 播放中）
  int pulse_phase_ = 0;
  bool title_min_hover_ = false;    // 标题栏最小化悬停
  bool title_close_hover_ = false;  // 标题栏关闭悬停
  bool mute_hover_ = false;         // 静音钮悬停
  bool speaker_hover_ = false;      // 免提钮悬停
  bool pill_hover_ = false;         // 挂断胶囊悬停

  // 玻璃底（Show 时抓拍，见 call_visuals.h）
  Gdiplus::Bitmap* backdrop_ = nullptr;
  float backdrop_dim_ = 1.0f;

  HangUpCallback on_hangup_;
  MuteCallback on_mute_toggle_;
  SpeakerCallback on_speaker_toggle_;

  static constexpr UINT_PTR kTickTimerId = 2001;
  static constexpr UINT_PTR kPulseTimerId = 2002;

  // 自定义消息：延迟销毁窗口（避免在 WM_COMMAND 中嵌套 DestroyWindow）
  static constexpr UINT kMsgDeferredHide = WM_USER + 200;

  // 窗口位置边距
  static constexpr int kMargin = 20;

  static constexpr const wchar_t* kClassName =
      L"PAI_ConnectedCall_Window";

  // 按钮 ID（用于 WM_COMMAND）
  static constexpr int kIdMute = 11;
  static constexpr int kIdSpeaker = 12;
  static constexpr int kIdHangup = 13;
};

#endif  // RUNNER_CONNECTED_CALL_WINDOW_H_
