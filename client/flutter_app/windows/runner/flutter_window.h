#ifndef RUNNER_FLUTTER_WINDOW_H_
#define RUNNER_FLUTTER_WINDOW_H_

#include <flutter/dart_project.h>
#include <flutter/encodable_value.h>
#include <flutter/flutter_view_controller.h>
#include <flutter/method_channel.h>
#include <flutter/method_result_functions.h>
#include <flutter/standard_method_codec.h>

#include <memory>

#include "win32_window.h"
#include "sphere_overlay_window.h"
#include "desktop_notification_window.h"
#include "incoming_call_window.h"
#include "connected_call_window.h"
#include "outgoing_call_window.h"

// A window that does nothing but host a Flutter view.
class FlutterWindow : public Win32Window {
 public:
  // Creates a new FlutterWindow hosting a Flutter view running |project|.
  explicit FlutterWindow(const flutter::DartProject& project);
  virtual ~FlutterWindow();

 protected:
  // Win32Window:
  bool OnCreate() override;
  void OnDestroy() override;
  LRESULT MessageHandler(HWND window, UINT const message, WPARAM wparam,
                         LPARAM lparam) noexcept override;

 private:
  // The project to run.
  flutter::DartProject project_;

  // The Flutter instance hosted by this window.
  std::unique_ptr<flutter::FlutterViewController> flutter_controller_;

  // Desktop overlay window for 3D Agent sphere.
  std::unique_ptr<SphereOverlayWindow> overlay_window_;

  // 独立来电悬浮窗（脱离主窗口存在）
  std::unique_ptr<IncomingCallWindow> incoming_call_window_;
  std::unique_ptr<DesktopNotificationWindow> desktop_notification_window_;

  // 独立"通话中"悬浮窗（接通后展示，仿电脑微信电话）
  std::unique_ptr<ConnectedCallWindow> connected_call_window_;
  std::unique_ptr<OutgoingCallWindow> outgoing_call_window_;

  // Method channel for overlay control.
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>>
      overlay_channel_;

  void HandleOverlayMethodCall(
      const flutter::MethodCall<flutter::EncodableValue>& call,
      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result);

  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>>
      desktop_bridge_channel_;

  void HandleDesktopBridgeMethodCall(
      const flutter::MethodCall<flutter::EncodableValue>& call,
      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result);

  // pai/incoming_call MethodChannel —— 控制独立来电悬浮窗
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>>
      incoming_call_channel_;
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>>
      desktop_notification_channel_;

  void HandleIncomingCallMethodCall(
      const flutter::MethodCall<flutter::EncodableValue>& call,
      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result);
  void HandleDesktopNotificationMethodCall(
      const flutter::MethodCall<flutter::EncodableValue>& call,
      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result);

  // 把 IncomingCallWindow 的回调以 EventChannel / invokeMethod 方式回报给 Dart
  void ReportIncomingCallEvent(const std::string& event,
                               const std::string& detail);
  void ReportDesktopNotificationEvent(const std::string& event);

  // pai/connected_call MethodChannel —— 控制独立"通话中"窗口
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>>
      connected_call_channel_;
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>>
      outgoing_call_channel_;

  void HandleConnectedCallMethodCall(
      const flutter::MethodCall<flutter::EncodableValue>& call,
      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result);
  void HandleOutgoingCallMethodCall(
      const flutter::MethodCall<flutter::EncodableValue>& call,
      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result);

  // 把 ConnectedCallWindow 的回调以 invokeMethod 方式回报给 Dart
  void ReportConnectedCallEvent(const std::string& event,
                                const flutter::EncodableMap& extra);
  void ReportOutgoingCallEvent(const std::string& event);

  // pai/window_titlebar —— 动态切换 Windows 标题栏深色/亮色
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>>
      window_titlebar_channel_;

  void HandleWindowTitleBarMethodCall(
      const flutter::MethodCall<flutter::EncodableValue>& call,
      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result);
};

#endif  // RUNNER_FLUTTER_WINDOW_H_
