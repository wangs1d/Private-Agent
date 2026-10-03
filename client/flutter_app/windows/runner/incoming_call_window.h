#ifndef RUNNER_INCOMING_CALL_WINDOW_H_
#define RUNNER_INCOMING_CALL_WINDOW_H_

#include <windows.h>

#include <functional>
#include <memory>
#include <string>

// 独立的来电悬浮窗 —— 脱离主 Flutter 窗口存在。
//
// 真透明深卡（视觉原语见 call_visuals.h）：卡片恒定半透明逐像素 alpha，
// 全自绘无子控件（按钮手动命中），DWM 系统圆角。位于工作区右下角，
// 带铃声循环 + 接听/挂断按钮。
// 主窗口最小化、被遮挡都不会影响该窗口可见。
//
// 生命周期：
// - Show(payload)：创建/更新窗口内容 + 启动铃声
// - Hide()：停止铃声 + 销毁窗口
// - 用户点接听 → 触发 on_accept 回调，Dart 端会拉起主窗口并打开通话 UI
// - 用户点挂断/标题栏 × → 触发 on_decline 回调，Dart 发 voice.hangup
// - 超时（默认 30s）→ 触发 on_timeout 回调
class IncomingCallWindow {
 public:
  using AcceptCallback = std::function<void()>;
  using DeclineCallback = std::function<void()>;
  using TimeoutCallback = std::function<void()>;

  IncomingCallWindow();
  ~IncomingCallWindow();

  // 创建窗口（首次调用），或更新内容（已存在则只更新字段 + 续命定时器）。
  // payload 字段：
  //   - caller_name    : 来电者名称
  //   - subtitle       : 副标题（如"语音提醒"或"来电中"）
  //   - caller_initial : 头像首字母（用于头像圆圈内单字符）
  //   - ring_timeout_ms: 振铃超时（默认 30000ms），0 表示无超时
  //   - accent_color_hex: 头像底色（0xAARRGGBB），默认绿色
  void Show(const std::string& caller_name,
            const std::string& subtitle,
            const std::string& caller_initial,
            int ring_timeout_ms,
            uint32_t accent_color_hex);

  // 停止铃声 + 隐藏 + 销毁窗口
  void Hide();

  bool IsVisible() const;

  // 注册回调（在 Show 之前调用一次即可）
  void SetCallbacks(AcceptCallback on_accept,
                    DeclineCallback on_decline,
                    TimeoutCallback on_timeout);

 private:
  static LRESULT CALLBACK WndProc(HWND hwnd, UINT message,
                                  WPARAM wparam, LPARAM lparam) noexcept;
  LRESULT HandleMessage(HWND hwnd, UINT message,
                        WPARAM wparam, LPARAM lparam) noexcept;

  void EnsureClassRegistered();
  bool CreateWindowIfNeeded();
  void PositionAtBottomRight();
  void StartRingtone();
  void StopRingtone();
  void StartTimeoutTimer();
  void StopTimeoutTimer();
  void StartPulseTimer();
  void StopPulseTimer();
  void StartAcceptButtonGlow();
  void StopAcceptButtonGlow();
  void DestroyNativeWindow();

  void Paint(HWND hwnd, HDC hdc);
  // 头像首字符（payload 未带时退回姓名首字，空名返回 nullptr）
  const wchar_t* AvatarInitial() const;

  HWND window_handle_ = nullptr;

  // 内容字段
  std::wstring caller_name_;
  std::wstring subtitle_;
  std::wstring caller_initial_;
  int ring_timeout_ms_ = 30000;

  // 玻璃底已改为逐像素 alpha 半透明（见 call_visuals.h），不再抓拍桌面

  // 状态
  bool ringing_ = false;
  int pulse_phase_ = 0;       // 0..30 循环（用于头像光晕）
  bool accept_glow_ = true;   // 接听按钮呼吸高亮
  bool accept_hovered_ = false;  // 接听按钮悬停
  bool decline_hovered_ = false; // 挂断按钮悬停
  bool title_min_hover_ = false; // 标题栏最小化悬停
  bool title_close_hover_ = false;  // 标题栏关闭悬停

  // 定时器 id
  static constexpr UINT_PTR kTimeoutTimerId = 1001;
  static constexpr UINT_PTR kPulseTimerId = 1002;

  // 自定义消息：延迟销毁窗口（避免在 WM_TIMER/WM_COMMAND 中嵌套 DestroyWindow）
  static constexpr UINT kMsgDeferredHide = WM_USER + 100;

  // 回调
  AcceptCallback on_accept_;
  DeclineCallback on_decline_;
  TimeoutCallback on_timeout_;

  static constexpr const wchar_t* kClassName =
      L"PAI_IncomingCall_Window";
};

#endif  // RUNNER_INCOMING_CALL_WINDOW_H_
