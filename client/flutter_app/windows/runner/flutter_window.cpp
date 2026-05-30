#include "flutter_window.h"

#include <optional>

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

  flutter_controller_->engine()->SetNextFrameCallback([&]() {
    this->Show();
  });

  flutter_controller_->ForceRedraw();

  return true;
}

void FlutterWindow::OnDestroy() {
  overlay_window_.reset();
  overlay_channel_.reset();
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
