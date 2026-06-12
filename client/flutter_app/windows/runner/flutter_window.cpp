#include "flutter_window.h"

#include <dwmapi.h>

#ifndef DWMWA_USE_IMMERSIVE_DARK_MODE
#define DWMWA_USE_IMMERSIVE_DARK_MODE 20
#endif

#include <optional>
#include <string>
#include <vector>

#include "desktop_screen_capture.h"
#include "flutter/generated_plugin_registrant.h"

FlutterWindow::FlutterWindow(const flutter::DartProject& project)
    : project_(project) {}

FlutterWindow::~FlutterWindow() {}

bool FlutterWindow::OnCreate() {
  if (!Win32Window::OnCreate()) {
    return false;
  }

  RECT frame = GetClientArea();

  flutter_controller_ = std::make_unique<flutter::FlutterViewController>(
      frame.right - frame.left, frame.bottom - frame.top, project_);
  if (!flutter_controller_->engine() || !flutter_controller_->view()) {
    return false;
  }
  RegisterPlugins(flutter_controller_->engine());
  SetChildContent(flutter_controller_->view()->GetNativeWindow());

  overlay_channel_ = std::make_unique<
      flutter::MethodChannel<flutter::EncodableValue>>(
      flutter_controller_->engine()->messenger(), "pai/sphere_overlay",
      &flutter::StandardMethodCodec::GetInstance());

  overlay_channel_->SetMethodCallHandler(
      [this](const auto& call, auto result) {
        HandleOverlayMethodCall(call, std::move(result));
      });

  desktop_bridge_channel_ = std::make_unique<
      flutter::MethodChannel<flutter::EncodableValue>>(
      flutter_controller_->engine()->messenger(), "pai/desktop_bridge",
      &flutter::StandardMethodCodec::GetInstance());

  desktop_bridge_channel_->SetMethodCallHandler(
      [this](const auto& call, auto result) {
        HandleDesktopBridgeMethodCall(call, std::move(result));
      });

  // 独立来电悬浮窗 MethodChannel —— pai/incoming_call
  incoming_call_channel_ = std::make_unique<
      flutter::MethodChannel<flutter::EncodableValue>>(
      flutter_controller_->engine()->messenger(), "pai/incoming_call",
      &flutter::StandardMethodCodec::GetInstance());

  incoming_call_channel_->SetMethodCallHandler(
      [this](const auto& call, auto result) {
        HandleIncomingCallMethodCall(call, std::move(result));
      });

  desktop_notification_channel_ = std::make_unique<
      flutter::MethodChannel<flutter::EncodableValue>>(
      flutter_controller_->engine()->messenger(), "pai/desktop_notification",
      &flutter::StandardMethodCodec::GetInstance());

  desktop_notification_channel_->SetMethodCallHandler(
      [this](const auto& call, auto result) {
        HandleDesktopNotificationMethodCall(call, std::move(result));
      });

  // 独立"通话中"窗口 MethodChannel —— pai/connected_call
  connected_call_channel_ = std::make_unique<
      flutter::MethodChannel<flutter::EncodableValue>>(
      flutter_controller_->engine()->messenger(), "pai/connected_call",
      &flutter::StandardMethodCodec::GetInstance());

  connected_call_channel_->SetMethodCallHandler(
      [this](const auto& call, auto result) {
        HandleConnectedCallMethodCall(call, std::move(result));
      });

  outgoing_call_channel_ = std::make_unique<
      flutter::MethodChannel<flutter::EncodableValue>>(
      flutter_controller_->engine()->messenger(), "pai/outgoing_call",
      &flutter::StandardMethodCodec::GetInstance());

  outgoing_call_channel_->SetMethodCallHandler(
      [this](const auto& call, auto result) {
        HandleOutgoingCallMethodCall(call, std::move(result));
      });

  // pai/window_titlebar —— 动态切换 Windows 标题栏深色/亮色
  window_titlebar_channel_ = std::make_unique<
      flutter::MethodChannel<flutter::EncodableValue>>(
      flutter_controller_->engine()->messenger(), "pai/window_titlebar",
      &flutter::StandardMethodCodec::GetInstance());

  window_titlebar_channel_->SetMethodCallHandler(
      [this](const auto& call, auto result) {
        HandleWindowTitleBarMethodCall(call, std::move(result));
      });

  flutter_controller_->engine()->SetNextFrameCallback([&]() {
    this->Show();
  });

  flutter_controller_->ForceRedraw();

  // 清空窗口标题栏文字（Flutter 引擎会自动设置标题，需在初始化后覆盖）
  SetWindowText(GetHandle(), L"");

  return true;
}

namespace {

std::string Base64Encode(const std::vector<uint8_t>& data) {
  static const char kTable[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve(((data.size() + 2) / 3) * 4);
  size_t i = 0;
  while (i + 2 < data.size()) {
    const uint32_t n = (static_cast<uint32_t>(data[i]) << 16) |
                       (static_cast<uint32_t>(data[i + 1]) << 8) |
                       static_cast<uint32_t>(data[i + 2]);
    out.push_back(kTable[(n >> 18) & 63]);
    out.push_back(kTable[(n >> 12) & 63]);
    out.push_back(kTable[(n >> 6) & 63]);
    out.push_back(kTable[n & 63]);
    i += 3;
  }
  if (i < data.size()) {
    const uint32_t n = static_cast<uint32_t>(data[i]) << 16;
    out.push_back(kTable[(n >> 18) & 63]);
    if (i + 1 < data.size()) {
      const uint32_t n2 = n | (static_cast<uint32_t>(data[i + 1]) << 8);
      out.push_back(kTable[(n2 >> 12) & 63]);
      out.push_back(kTable[(n2 >> 6) & 63]);
      out.push_back('=');
    } else {
      out.push_back(kTable[(n >> 12) & 63]);
      out.push_back('=');
      out.push_back('=');
    }
  }
  return out;
}

std::string GetEncodableString(const flutter::EncodableMap* args,
                               const char* key,
                               const std::string& fallback = std::string()) {
  if (!args) return fallback;
  auto it = args->find(flutter::EncodableValue(key));
  if (it == args->end() || it->second.IsNull()) return fallback;
  if (const auto* value = std::get_if<std::string>(&it->second)) {
    return *value;
  }
  return fallback;
}

int GetEncodableInt(const flutter::EncodableMap* args,
                    const char* key,
                    int fallback) {
  if (!args) return fallback;
  auto it = args->find(flutter::EncodableValue(key));
  if (it == args->end() || it->second.IsNull()) return fallback;
  if (const auto* value = std::get_if<int32_t>(&it->second)) {
    return static_cast<int>(*value);
  }
  if (const auto* value = std::get_if<int64_t>(&it->second)) {
    return static_cast<int>(*value);
  }
  if (const auto* value = std::get_if<double>(&it->second)) {
    return static_cast<int>(*value);
  }
  return fallback;
}

uint32_t GetEncodableUint32(const flutter::EncodableMap* args,
                            const char* key,
                            uint32_t fallback) {
  if (!args) return fallback;
  auto it = args->find(flutter::EncodableValue(key));
  if (it == args->end() || it->second.IsNull()) return fallback;
  if (const auto* value = std::get_if<int32_t>(&it->second)) {
    return static_cast<uint32_t>(*value);
  }
  if (const auto* value = std::get_if<int64_t>(&it->second)) {
    return static_cast<uint32_t>(*value);
  }
  if (const auto* value = std::get_if<double>(&it->second)) {
    return static_cast<uint32_t>(*value);
  }
  return fallback;
}

bool GetEncodableBool(const flutter::EncodableMap* args,
                      const char* key,
                      bool fallback) {
  if (!args) return fallback;
  auto it = args->find(flutter::EncodableValue(key));
  if (it == args->end() || it->second.IsNull()) return fallback;
  if (const auto* value = std::get_if<bool>(&it->second)) {
    return *value;
  }
  return fallback;
}

}  // namespace

void FlutterWindow::OnDestroy() {
  incoming_call_window_.reset();
  incoming_call_channel_.reset();
  desktop_notification_window_.reset();
  desktop_notification_channel_.reset();
  connected_call_window_.reset();
  connected_call_channel_.reset();
  outgoing_call_window_.reset();
  outgoing_call_channel_.reset();
  window_titlebar_channel_.reset();
  overlay_window_.reset();
  overlay_channel_.reset();
  desktop_bridge_channel_.reset();
  if (flutter_controller_) {
    flutter_controller_ = nullptr;
  }
  Win32Window::OnDestroy();
}

LRESULT
FlutterWindow::MessageHandler(HWND hwnd, UINT const message,
                              WPARAM const wparam,
                              LPARAM const lparam) noexcept {
  if (flutter_controller_) {
    std::optional<LRESULT> result =
        flutter_controller_->HandleTopLevelWindowProc(hwnd, message, wparam,
                                                      lparam);
    if (result) {
      return *result;
    }
  }

  switch (message) {
    case WM_SETTEXT:
      // 拦截标题设置，保持标题栏为空
      return 0;
    case WM_FONTCHANGE:
      flutter_controller_->engine()->ReloadSystemFonts();
      break;
  }

  return Win32Window::MessageHandler(hwnd, message, wparam, lparam);
}

void FlutterWindow::HandleOverlayMethodCall(
    const flutter::MethodCall<flutter::EncodableValue>& call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
  const std::string& method = call.method_name();

  if (method == "create") {
    const auto* args = std::get_if<flutter::EncodableMap>(call.arguments());
    std::string url;
    if (args) {
      auto it = args->find(flutter::EncodableValue("url"));
      if (it != args->end() && !it->second.IsNull()) {
        url = std::get<std::string>(it->second);
      }
    }

    if (!overlay_window_) {
      overlay_window_ = std::make_unique<SphereOverlayWindow>();
    }

    bool ok = overlay_window_->Create(GetHandle(), url);
    result->Success(flutter::EncodableValue(ok));
    return;
  }

  if (method == "isCreated") {
    const bool created =
        overlay_window_ && overlay_window_->IsCreated();
    result->Success(flutter::EncodableValue(created));
    return;
  }

  if (method == "getAppBounds") {
    RECT rc;
    GetWindowRect(GetHandle(), &rc);
    flutter::EncodableMap app_bounds;
    app_bounds[flutter::EncodableValue("x")] =
        flutter::EncodableValue(static_cast<int64_t>(rc.left));
    app_bounds[flutter::EncodableValue("y")] =
        flutter::EncodableValue(static_cast<int64_t>(rc.top));
    app_bounds[flutter::EncodableValue("width")] = flutter::EncodableValue(
        static_cast<int64_t>(rc.right - rc.left));
    app_bounds[flutter::EncodableValue("height")] = flutter::EncodableValue(
        static_cast<int64_t>(rc.bottom - rc.top));
    result->Success(flutter::EncodableValue(app_bounds));
    return;
  }

  if (method == "destroy") {
    if (overlay_window_) {
      overlay_window_.reset();
    }
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "isWebViewReady") {
    const bool ready =
        overlay_window_ && overlay_window_->IsCreated() &&
        overlay_window_->IsWebViewReady();
    result->Success(flutter::EncodableValue(ready));
    return;
  }

  if (!overlay_window_ || !overlay_window_->IsCreated()) {
    result->NotImplemented();
    return;
  }

  if (method == "show") {
    overlay_window_->Show();
    result->Success(flutter::EncodableValue(true));
  } else if (method == "hide") {
    overlay_window_->Hide();
    result->Success(flutter::EncodableValue(true));
  } else if (method == "isVisible") {
    result->Success(flutter::EncodableValue(overlay_window_->IsVisible()));
  } else if (method == "moveTo") {
    const auto* args = std::get_if<flutter::EncodableMap>(call.arguments());
    int x = 0, y = 0, duration = 1200;
    if (args) {
      auto it_x = args->find(flutter::EncodableValue("x"));
      if (it_x != args->end())
        x = static_cast<int>(std::get<int64_t>(it_x->second));
      auto it_y = args->find(flutter::EncodableValue("y"));
      if (it_y != args->end())
        y = static_cast<int>(std::get<int64_t>(it_y->second));
      auto it_d = args->find(flutter::EncodableValue("duration"));
      if (it_d != args->end())
        duration = static_cast<int>(std::get<int64_t>(it_d->second));
    }
    overlay_window_->MoveTo(x, y, duration);
    result->Success(nullptr);
  } else if (method == "moveBy") {
    const auto* args = std::get_if<flutter::EncodableMap>(call.arguments());
    int dx = 0, dy = 0;
    if (args) {
      auto it_dx = args->find(flutter::EncodableValue("dx"));
      if (it_dx != args->end())
        dx = static_cast<int>(std::get<int64_t>(it_dx->second));
      auto it_dy = args->find(flutter::EncodableValue("dy"));
      if (it_dy != args->end())
        dy = static_cast<int>(std::get<int64_t>(it_dy->second));
    }
    overlay_window_->MoveBy(dx, dy);
    result->Success(nullptr);
  } else if (method == "setBounds") {
    const auto* args = std::get_if<flutter::EncodableMap>(call.arguments());
    int x = 0, y = 0, width = 300, height = 380, duration = 0;
    if (args) {
      auto it_x = args->find(flutter::EncodableValue("x"));
      if (it_x != args->end())
        x = static_cast<int>(std::get<int64_t>(it_x->second));
      auto it_y = args->find(flutter::EncodableValue("y"));
      if (it_y != args->end())
        y = static_cast<int>(std::get<int64_t>(it_y->second));
      auto it_w = args->find(flutter::EncodableValue("width"));
      if (it_w != args->end())
        width = static_cast<int>(std::get<int64_t>(it_w->second));
      auto it_h = args->find(flutter::EncodableValue("height"));
      if (it_h != args->end())
        height = static_cast<int>(std::get<int64_t>(it_h->second));
      auto it_d = args->find(flutter::EncodableValue("duration"));
      if (it_d != args->end())
        duration = static_cast<int>(std::get<int64_t>(it_d->second));
    }
    overlay_window_->SetBounds(x, y, width, height, duration);
    result->Success(nullptr);
  } else if (method == "getBounds") {
    RECT rc = overlay_window_->GetBounds();
    flutter::EncodableMap bounds;
    bounds[flutter::EncodableValue("x")] =
        flutter::EncodableValue(static_cast<int64_t>(rc.left));
    bounds[flutter::EncodableValue("y")] =
        flutter::EncodableValue(static_cast<int64_t>(rc.top));
    bounds[flutter::EncodableValue("width")] = flutter::EncodableValue(
        static_cast<int64_t>(rc.right - rc.left));
    bounds[flutter::EncodableValue("height")] = flutter::EncodableValue(
        static_cast<int64_t>(rc.bottom - rc.top));
    result->Success(flutter::EncodableValue(bounds));
  } else if (method == "roam") {
    overlay_window_->Roam();
    result->Success(nullptr);
  } else if (method == "setIgnoreMouseEvents") {
    const auto* args = std::get_if<flutter::EncodableMap>(call.arguments());
    bool ignore = true, forward = true;
    if (args) {
      auto it_i = args->find(flutter::EncodableValue("ignore"));
      if (it_i != args->end())
        ignore = std::get<bool>(it_i->second);
      auto it_f = args->find(flutter::EncodableValue("forward"));
      if (it_f != args->end())
        forward = std::get<bool>(it_f->second);
    }
    overlay_window_->SetIgnoreMouseEvents(ignore, forward);
    result->Success(nullptr);
  } else if (method == "patchMood") {
    const auto* args = std::get_if<flutter::EncodableMap>(call.arguments());
    std::string json_patch;
    if (args) {
      auto it = args->find(flutter::EncodableValue("patch"));
      if (it != args->end() && !it->second.IsNull()) {
        json_patch = std::get<std::string>(it->second);
      }
    }
    overlay_window_->PatchMood(json_patch);
    result->Success(nullptr);
  } else if (method == "getWorkArea") {
    RECT wa = overlay_window_->GetWorkArea();
    flutter::EncodableMap area;
    area[flutter::EncodableValue("x")] =
        flutter::EncodableValue(static_cast<int64_t>(wa.left));
    area[flutter::EncodableValue("y")] =
        flutter::EncodableValue(static_cast<int64_t>(wa.top));
    area[flutter::EncodableValue("width")] = flutter::EncodableValue(
        static_cast<int64_t>(wa.right - wa.left));
    area[flutter::EncodableValue("height")] = flutter::EncodableValue(
        static_cast<int64_t>(wa.bottom - wa.top));
    result->Success(flutter::EncodableValue(area));
  } else {
    result->NotImplemented();
  }
}

void FlutterWindow::HandleDesktopBridgeMethodCall(
    const flutter::MethodCall<flutter::EncodableValue>& call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
  const std::string& method = call.method_name();

  if (method == "captureScreen") {
    std::optional<int> left, top, width, height;
    const auto* args = std::get_if<flutter::EncodableMap>(call.arguments());
    if (args) {
      auto read_int = [&](const char* key) -> std::optional<int> {
        auto it = args->find(flutter::EncodableValue(key));
        if (it == args->end() || it->second.IsNull()) return std::nullopt;
        return static_cast<int>(std::get<int64_t>(it->second));
      };
      left = read_int("left");
      top = read_int("top");
      width = read_int("width");
      height = read_int("height");
    }

    auto cap = CaptureDesktopPng(left, top, width, height);
    if (!cap || !cap->ok) {
      flutter::EncodableMap err;
      err[flutter::EncodableValue("ok")] = flutter::EncodableValue(false);
      err[flutter::EncodableValue("error")] = flutter::EncodableValue(
          cap ? cap->error : "capture failed");
      result->Success(flutter::EncodableValue(err));
      return;
    }

    flutter::EncodableMap ok;
    ok[flutter::EncodableValue("ok")] = flutter::EncodableValue(true);
    ok[flutter::EncodableValue("imageBase64")] =
        flutter::EncodableValue(Base64Encode(cap->png_bytes));
    ok[flutter::EncodableValue("mimeType")] =
        flutter::EncodableValue("image/png");
    ok[flutter::EncodableValue("width")] =
        flutter::EncodableValue(static_cast<int64_t>(cap->width));
    ok[flutter::EncodableValue("height")] =
        flutter::EncodableValue(static_cast<int64_t>(cap->height));
    result->Success(flutter::EncodableValue(ok));
    return;
  }

  result->NotImplemented();
}

void FlutterWindow::HandleIncomingCallMethodCall(
    const flutter::MethodCall<flutter::EncodableValue>& call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
  const std::string& method = call.method_name();

  if (method == "show") {
    // 解析参数
    std::string caller_name;
    std::string subtitle = "语音提醒";
    std::string caller_initial;
    int ring_timeout_ms = 30000;
    uint32_t accent = 0xFF22C55E;  // 默认绿

    if (auto* args = std::get_if<flutter::EncodableMap>(call.arguments())) {
      caller_name = GetEncodableString(args, "callerName");
      const std::string subtitle_arg =
          GetEncodableString(args, "subtitle", subtitle);
      subtitle = subtitle_arg.empty() ? subtitle : subtitle_arg;
      caller_initial = GetEncodableString(args, "callerInitial");
      ring_timeout_ms = GetEncodableInt(args, "ringTimeoutMs", ring_timeout_ms);
      accent = GetEncodableUint32(args, "accentColor", accent);
    }

    // 首次创建 + 绑定一次性回调
    if (!incoming_call_window_) {
      incoming_call_window_ = std::make_unique<IncomingCallWindow>();
      incoming_call_window_->SetCallbacks(
          [this]() { ReportIncomingCallEvent("accept", ""); },
          [this]() { ReportIncomingCallEvent("decline", ""); },
          [this]() { ReportIncomingCallEvent("timeout", ""); });
    }

    // 唤起主窗口（用户从任务栏点了来电窗后能切回主窗）
    HWND self = GetHandle();
    if (self) {
      if (IsIconic(self)) {
        ShowWindow(self, SW_RESTORE);
      } else {
        ShowWindow(self, SW_SHOW);
      }
      BringWindowToTop(self);
      SetForegroundWindow(self);
    }

    incoming_call_window_->Show(caller_name, subtitle, caller_initial,
                                ring_timeout_ms, accent);
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "hide") {
    if (incoming_call_window_) {
      incoming_call_window_->Hide();
    }
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "isVisible") {
    const bool visible =
        incoming_call_window_ && incoming_call_window_->IsVisible();
    result->Success(flutter::EncodableValue(visible));
    return;
  }

  if (method == "bringToFront") {
    HWND self = GetHandle();
    if (self) {
      if (IsIconic(self)) {
        ShowWindow(self, SW_RESTORE);
      } else {
        ShowWindow(self, SW_SHOW);
      }
      BringWindowToTop(self);
      SetForegroundWindow(self);
    }
    result->Success(flutter::EncodableValue(true));
    return;
  }

  result->NotImplemented();
}

void FlutterWindow::ReportIncomingCallEvent(const std::string& event,
                                            const std::string& detail) {
  if (!incoming_call_channel_) return;
  flutter::EncodableMap payload;
  payload[flutter::EncodableValue("event")] =
      flutter::EncodableValue(event);
  if (!detail.empty()) {
    payload[flutter::EncodableValue("detail")] =
        flutter::EncodableValue(detail);
  }
  payload[flutter::EncodableValue("timestampMs")] = flutter::EncodableValue(
      static_cast<int64_t>(GetTickCount64()));
  incoming_call_channel_->InvokeMethod(
      "onNativeEvent",
      std::make_unique<flutter::EncodableValue>(payload));
}

void FlutterWindow::HandleDesktopNotificationMethodCall(
    const flutter::MethodCall<flutter::EncodableValue>& call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
  const std::string& method = call.method_name();

  if (method == "show") {
    std::string title;
    std::string message;
    std::string priority = "normal";
    bool show_confirm_button = false;
    std::string confirm_text = "我知道了";
    int auto_close_ms = 0;

    if (auto* args = std::get_if<flutter::EncodableMap>(call.arguments())) {
      title = GetEncodableString(args, "title");
      message = GetEncodableString(args, "message");
      priority = GetEncodableString(args, "priority", priority);
      show_confirm_button =
          GetEncodableBool(args, "showConfirmButton", show_confirm_button);
      confirm_text = GetEncodableString(args, "confirmText", confirm_text);
      auto_close_ms = GetEncodableInt(args, "autoCloseMs", auto_close_ms);
    }

    if (!desktop_notification_window_) {
      desktop_notification_window_ = std::make_unique<DesktopNotificationWindow>();
      desktop_notification_window_->SetCallbacks(
          [this]() { ReportDesktopNotificationEvent("confirm"); },
          [this]() { ReportDesktopNotificationEvent("dismiss"); },
          [this]() { ReportDesktopNotificationEvent("timeout"); });
    }

    desktop_notification_window_->Show(title, message, priority,
                                       show_confirm_button, confirm_text,
                                       auto_close_ms);
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "hide") {
    if (desktop_notification_window_) desktop_notification_window_->Hide();
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "isVisible") {
    const bool visible = desktop_notification_window_ &&
                         desktop_notification_window_->IsVisible();
    result->Success(flutter::EncodableValue(visible));
    return;
  }

  result->NotImplemented();
}

void FlutterWindow::ReportDesktopNotificationEvent(const std::string& event) {
  if (!desktop_notification_channel_) return;
  flutter::EncodableMap payload;
  payload[flutter::EncodableValue("event")] = flutter::EncodableValue(event);
  payload[flutter::EncodableValue("timestampMs")] = flutter::EncodableValue(
      static_cast<int64_t>(GetTickCount64()));
  desktop_notification_channel_->InvokeMethod(
      "onNativeEvent", std::make_unique<flutter::EncodableValue>(payload));
}

void FlutterWindow::HandleConnectedCallMethodCall(
    const flutter::MethodCall<flutter::EncodableValue>& call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
  const std::string& method = call.method_name();

  if (method == "show") {
    std::string caller_name;
    std::string caller_initial;
    uint32_t accent = 0xFF22C55E;

    if (auto* args = std::get_if<flutter::EncodableMap>(call.arguments())) {
      caller_name = GetEncodableString(args, "callerName");
      caller_initial = GetEncodableString(args, "callerInitial");
      accent = GetEncodableUint32(args, "accentColor", accent);
    }

    if (!connected_call_window_) {
      connected_call_window_ = std::make_unique<ConnectedCallWindow>();
      connected_call_window_->SetCallbacks(
          [this]() {
            flutter::EncodableMap extra;
            ReportConnectedCallEvent("hangup", extra);
          },
          [this](bool new_mute) {
            flutter::EncodableMap extra;
            extra[flutter::EncodableValue("muted")] =
                flutter::EncodableValue(new_mute);
            ReportConnectedCallEvent("muteToggle", extra);
          },
          [this](bool new_speaker) {
            flutter::EncodableMap extra;
            extra[flutter::EncodableValue("speakerOn")] =
                flutter::EncodableValue(new_speaker);
            ReportConnectedCallEvent("speakerToggle", extra);
          });
    }

    // 接通后让主窗口可被看到（如果用户没启动过主窗口就保持后台）
    HWND self = GetHandle();
    if (self) {
      if (IsIconic(self)) {
        ShowWindow(self, SW_RESTORE);
      } else {
        ShowWindow(self, SW_SHOW);
      }
      BringWindowToTop(self);
    }

    connected_call_window_->Show(caller_name, caller_initial, accent);
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "hide") {
    if (connected_call_window_) {
      connected_call_window_->Hide();
    }
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "isVisible") {
    const bool visible =
        connected_call_window_ && connected_call_window_->IsVisible();
    result->Success(flutter::EncodableValue(visible));
    return;
  }

  if (method == "setMute") {
    bool muted = false;
    if (auto* args = std::get_if<flutter::EncodableMap>(call.arguments())) {
      muted = GetEncodableBool(args, "muted", muted);
    }
    if (connected_call_window_) connected_call_window_->SetMute(muted);
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "setSpeaker") {
    bool on = true;
    if (auto* args = std::get_if<flutter::EncodableMap>(call.arguments())) {
      on = GetEncodableBool(args, "on", on);
    }
    if (connected_call_window_) connected_call_window_->SetSpeaker(on);
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "setTalking") {
    bool talking = false;
    if (auto* args = std::get_if<flutter::EncodableMap>(call.arguments())) {
      talking = GetEncodableBool(args, "talking", talking);
    }
    if (connected_call_window_) connected_call_window_->SetTalking(talking);
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "resetDuration") {
    if (connected_call_window_) connected_call_window_->ResetDuration();
    result->Success(flutter::EncodableValue(true));
    return;
  }

  result->NotImplemented();
}

void FlutterWindow::ReportConnectedCallEvent(
    const std::string& event, const flutter::EncodableMap& extra) {
  if (!connected_call_channel_) return;
  flutter::EncodableMap payload = extra;
  payload[flutter::EncodableValue("event")] = flutter::EncodableValue(event);
  payload[flutter::EncodableValue("timestampMs")] = flutter::EncodableValue(
      static_cast<int64_t>(GetTickCount64()));
  connected_call_channel_->InvokeMethod(
      "onNativeEvent",
      std::make_unique<flutter::EncodableValue>(payload));
}

void FlutterWindow::HandleOutgoingCallMethodCall(
    const flutter::MethodCall<flutter::EncodableValue>& call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
  const std::string& method = call.method_name();

  if (method == "show") {
    std::string caller_name;
    std::string subtitle = "正在呼叫";
    std::string caller_initial;
    uint32_t accent = 0xFF22C55E;

    if (auto* args = std::get_if<flutter::EncodableMap>(call.arguments())) {
      caller_name = GetEncodableString(args, "callerName");
      subtitle = GetEncodableString(args, "subtitle", subtitle);
      caller_initial = GetEncodableString(args, "callerInitial");
      accent = GetEncodableUint32(args, "accentColor", accent);
    }

    if (!outgoing_call_window_) {
      outgoing_call_window_ = std::make_unique<OutgoingCallWindow>();
      outgoing_call_window_->SetCallbacks(
          [this]() { ReportOutgoingCallEvent("hangup"); });
    }

    outgoing_call_window_->Show(caller_name, subtitle, caller_initial, accent);
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "hide") {
    if (outgoing_call_window_) outgoing_call_window_->Hide();
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "isVisible") {
    const bool visible =
        outgoing_call_window_ && outgoing_call_window_->IsVisible();
    result->Success(flutter::EncodableValue(visible));
    return;
  }

  result->NotImplemented();
}

void FlutterWindow::ReportOutgoingCallEvent(const std::string& event) {
  if (!outgoing_call_channel_) return;
  flutter::EncodableMap payload;
  payload[flutter::EncodableValue("event")] = flutter::EncodableValue(event);
  payload[flutter::EncodableValue("timestampMs")] = flutter::EncodableValue(
      static_cast<int64_t>(GetTickCount64()));
  outgoing_call_channel_->InvokeMethod(
      "onNativeEvent", std::make_unique<flutter::EncodableValue>(payload));
}

void FlutterWindow::HandleWindowTitleBarMethodCall(
    const flutter::MethodCall<flutter::EncodableValue>& call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
  const std::string& method = call.method_name();

  if (method == "setDarkMode") {
    bool is_dark = false;
    if (auto* args = std::get_if<flutter::EncodableMap>(call.arguments())) {
      is_dark = GetEncodableBool(args, "isDark", false);
    }
    HWND hwnd = GetHandle();
    if (hwnd) {
      BOOL enable_dark_mode = is_dark ? TRUE : FALSE;
      DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE,
                            &enable_dark_mode, sizeof(enable_dark_mode));
    }
    result->Success(flutter::EncodableValue(true));
    return;
  }

  result->NotImplemented();
}
