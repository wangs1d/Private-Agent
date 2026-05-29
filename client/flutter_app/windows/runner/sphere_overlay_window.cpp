#include "sphere_overlay_window.h"

#include <shlobj.h>
#include <shellscalingapi.h>

#include <algorithm>
#include <cmath>

#include <wrl.h>

#include "WebView2EnvironmentOptions.h"

namespace {

std::wstring GetWebViewUserDataFolder() {
  wchar_t path[MAX_PATH] = {};
  if (FAILED(SHGetFolderPathW(nullptr, CSIDL_LOCAL_APPDATA, nullptr, 0, path))) {
    return L"";
  }
  std::wstring folder = std::wstring(path) + L"\\PrivateAIAgent\\SphereOverlayWebView2";
  CreateDirectoryW((std::wstring(path) + L"\\PrivateAIAgent").c_str(), nullptr);
  CreateDirectoryW(folder.c_str(), nullptr);
  return folder;
}

std::wstring JsonExtractStr(const std::wstring& json, const std::wstring& key) {
  auto pos = json.find(L"\"" + key + L"\"");
  if (pos == std::wstring::npos) return L"";
  pos = json.find(L":", pos);
  if (pos == std::wstring::npos) return L"";
  ++pos;
  while (pos < json.size() && (json[pos] == L' ' || json[pos] == L'\t')) ++pos;
  if (pos >= json.size()) return L"";
  if (json[pos] == L'"') {
    ++pos;
    auto end = json.find(L'"', pos);
    if (end == std::wstring::npos) return L"";
    return json.substr(pos, end - pos);
  }
  return L"";
}

double JsonExtractNum(const std::wstring& json, const std::wstring& key) {
  auto s = JsonExtractStr(json, key);
  if (s.empty()) {
    auto pos = json.find(L"\"" + key + L"\"");
    if (pos == std::wstring::npos) return 0;
    pos = json.find(L":", pos);
    if (pos == std::wstring::npos) return 0;
    ++pos;
    while (pos < json.size() && (json[pos] == L' ' || json[pos] == L'\t' || json[pos] == L'\n'))
      ++pos;
    auto start = pos;
    while (pos < json.size() && (json[pos] >= L'0' && json[pos] <= L'9' ||
                                  json[pos] == L'-' || json[pos] == L'.' ||
                                  json[pos] == L'e' || json[pos] == L'E'))
      ++pos;
    s = json.substr(start, pos - start);
  }
  try { return std::stod(s); } catch (...) { return 0; }
}

bool JsonExtractBool(const std::wstring& json, const std::wstring& key) {
  auto pos = json.find(L"\"" + key + L"\"");
  if (pos == std::wstring::npos) return false;
  pos = json.find(L":", pos);
  if (pos == std::wstring::npos) return false;
  ++pos;
  while (pos < json.size() && (json[pos] == L' ' || json[pos] == L'\t'))
    ++pos;
  if (pos + 3 < json.size() && json.substr(pos, 4) == L"true") return true;
  return false;
}

}  // namespace

void SphereOverlayWindow::EnsureClassRegistered() {
  static bool registered = false;
  if (registered) return;

  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(WNDCLASSEXW);
  wc.style = CS_HREDRAW | CS_VREDRAW;
  wc.lpfnWndProc = SphereOverlayWindow::WndProc;
  wc.hInstance = GetModuleHandle(nullptr);
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.hbrBackground = nullptr;
  wc.lpszClassName = kClassName;

  RegisterClassExW(&wc);
  registered = true;
}

SphereOverlayWindow::SphereOverlayWindow() = default;

SphereOverlayWindow::~SphereOverlayWindow() {
  Destroy();
}

bool SphereOverlayWindow::Create(HWND parent, const std::string& overlay_url) {
  if (window_handle_) return true;

  parent_handle_ = parent;
  EnsureClassRegistered();

  HMONITOR monitor = MonitorFromWindow(parent, MONITOR_DEFAULTTONEAREST);
  MONITORINFO mi = {sizeof(mi)};
  GetMonitorInfoW(monitor, &mi);

  const int x = mi.rcWork.right - overlay_width_ - 24;
  const int y = mi.rcWork.bottom - overlay_height_ - 24;

  window_handle_ = CreateWindowExW(
      WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
      kClassName, L"Agent Sphere",
      WS_POPUP,
      x, y, overlay_width_, overlay_height_,
      parent, nullptr, GetModuleHandle(nullptr), this);

  if (!window_handle_) return false;

  ShowWindow(window_handle_, SW_SHOW);

  stored_url_ = overlay_url;

  const std::wstring user_data = GetWebViewUserDataFolder();
  HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(
      nullptr, user_data.empty() ? nullptr : user_data.c_str(), nullptr,
      Microsoft::WRL::Callback<
          ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
          [this](HRESULT result, ICoreWebView2Environment* env) -> HRESULT {
            if (FAILED(result) || !env || !window_handle_) {
              return result;
            }

            return env->CreateCoreWebView2Controller(
                window_handle_,
                Microsoft::WRL::Callback<
                    ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                    [this](HRESULT controller_result,
                           ICoreWebView2Controller* controller) -> HRESULT {
                      if (FAILED(controller_result) || !controller) {
                        return controller_result;
                      }

                      webview_controller_.Attach(controller);

                      Microsoft::WRL::ComPtr<ICoreWebView2> webview;
                      if (FAILED(webview_controller_->get_CoreWebView2(&webview)) ||
                          !webview) {
                        return E_FAIL;
                      }
                      webview_ = webview;

                      ApplyWebviewBounds();

                      Microsoft::WRL::ComPtr<ICoreWebView2Settings> settings;
                      if (SUCCEEDED(webview_->get_Settings(&settings)) &&
                          settings) {
                        settings->put_AreDefaultContextMenusEnabled(FALSE);
                        settings->put_AreDevToolsEnabled(FALSE);
                        settings->put_IsStatusBarEnabled(FALSE);
                      }

                      Microsoft::WRL::ComPtr<ICoreWebView2Controller2> controller2;
                      if (SUCCEEDED(webview_controller_.As(&controller2)) &&
                          controller2) {
                        COREWEBVIEW2_COLOR transparent = {0, 0, 0, 0};
                        controller2->put_DefaultBackgroundColor(transparent);
                      }

                      OnWebviewReady();
                      return S_OK;
                    })
                    .Get());
          })
          .Get());

  if (FAILED(hr)) {
    OutputDebugStringW(
        L"[SphereOverlay] Failed to create WebView2 environment\n");
  }

  return true;
}

void SphereOverlayWindow::Destroy() {
  if (anim_state_.timer_id) {
    KillTimer(window_handle_, anim_state_.timer_id);
    anim_state_.timer_id = 0;
  }

  webview_controller_.Reset();
  webview_.Reset();

  if (window_handle_) {
    DestroyWindow(window_handle_);
    window_handle_ = nullptr;
  }
}

void SphereOverlayWindow::Show() {
  if (window_handle_) ShowWindow(window_handle_, SW_SHOW);
}

void SphereOverlayWindow::Hide() {
  if (window_handle_) ShowWindow(window_handle_, SW_HIDE);
}

bool SphereOverlayWindow::IsVisible() const {
  return window_handle_ && IsWindowVisible(window_handle_);
}

bool SphereOverlayWindow::IsCreated() const {
  return window_handle_ != nullptr;
}

void SphereOverlayWindow::ApplyWebviewBounds() {
  if (!webview_controller_ || !window_handle_) return;
  RECT bounds{};
  bounds.right = overlay_width_;
  bounds.bottom = overlay_height_;
  webview_controller_->put_Bounds(bounds);
}

void SphereOverlayWindow::SetBounds(int x, int y, int width, int height,
                                    int duration_ms) {
  if (!window_handle_) return;

  overlay_width_ = std::max(80, width);
  overlay_height_ = std::max(80, height);

  if (duration_ms <= 16 || duration_ms > 5000) {
    SetWindowPos(window_handle_, nullptr, x, y, overlay_width_, overlay_height_,
                 SWP_NOZORDER | SWP_NOACTIVATE);
    ApplyWebviewBounds();
    return;
  }

  AnimateMove(x, y, duration_ms);
  SetWindowPos(window_handle_, nullptr, 0, 0, overlay_width_, overlay_height_,
               SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
  ApplyWebviewBounds();
}

RECT SphereOverlayWindow::GetBounds() const {
  RECT rc = {};
  if (window_handle_) {
    GetWindowRect(window_handle_, &rc);
  }
  return rc;
}

void SphereOverlayWindow::MoveTo(int x, int y, int duration_ms) {
  if (duration_ms <= 16 || duration_ms > 5000) {
    if (window_handle_)
      SetWindowPos(window_handle_, nullptr, x, y, 0, 0,
                   SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    return;
  }
  AnimateMove(x, y, duration_ms);
}

void SphereOverlayWindow::MoveBy(int dx, int dy) {
  if (!window_handle_) return;
  RECT rc;
  GetWindowRect(window_handle_, &rc);
  MoveTo(rc.left + dx, rc.top + dy, 0);
}

void SphereOverlayWindow::SetIgnoreMouseEvents(bool ignore, bool forward) {
  ignore_mouse_ = ignore;
  mouse_forward_ = forward;
  if (webview_) {
    std::wstring js = L"(function(){try{if(window.__sphereOverlayBridge){window.__sphereOverlayBridge._ignoreMouse=";
    js.append(ignore ? L"true" : L"false");
    js.append(L";window.__sphereOverlayBridge._mouseForward=");
    js.append(forward ? L"true" : L"false");
    js.append(L"}}catch(_){}})();");
    webview_->ExecuteScript(
        js.c_str(),
        Microsoft::WRL::Callback<ICoreWebView2ExecuteScriptCompletedHandler>(
            [](HRESULT, LPCWSTR) { return S_OK; })
            .Get());
  }
}

void SphereOverlayWindow::Roam() {
  if (!window_handle_) return;

  HMONITOR monitor =
      MonitorFromWindow(parent_handle_ ? parent_handle_ : window_handle_,
                         MONITOR_DEFAULTTONEAREST);
  MONITORINFO mi = {sizeof(mi)};
  GetMonitorInfoW(monitor, &mi);

  const int margin = 12;
  const int work_w = static_cast<int>(mi.rcWork.right - mi.rcWork.left);
  const int work_h = static_cast<int>(mi.rcWork.bottom - mi.rcWork.top);
  const int max_w = (std::max)(40, work_w - overlay_width_ - margin * 2);
  const int max_h = (std::max)(40, work_h - overlay_height_ - margin * 2);

  const int x = mi.rcWork.left + margin + (rand() % max_w);
  const int y = mi.rcWork.top + margin + (rand() % max_h);

  MoveTo(x, y, 1200);
}

RECT SphereOverlayWindow::GetWorkArea() const {
  MONITORINFO mi = {sizeof(mi)};
  HMONITOR monitor =
      MonitorFromWindow(parent_handle_ ? parent_handle_ : window_handle_,
                         MONITOR_DEFAULTTONEAREST);
  GetMonitorInfoW(monitor, &mi);
  return mi.rcWork;
}

void SphereOverlayWindow::PatchMood(const std::string& json_patch) {
  if (!webview_) return;

  std::wstring script;
  script.reserve(json_patch.size() + 100);
  script.append(
      L"(function(){try{if(window.__sphereOverlayBridge){window.__sphereOverlayBridge.onPatch(");
  for (char c : json_patch) {
    script.push_back(static_cast<wchar_t>(c));
  }
  script.append(L")}}catch(_){}})();");

  webview_->ExecuteScript(
      script.c_str(),
      Microsoft::WRL::Callback<ICoreWebView2ExecuteScriptCompletedHandler>(
          [](HRESULT, LPCWSTR) { return S_OK; })
          .Get());
}

void SphereOverlayWindow::SetPatchMoodCallback(PatchMoodCallback cb) {
  patch_callback_ = std::move(cb);
}

std::wstring SphereOverlayWindow::GetDistPath() const {
  wchar_t exe_path[MAX_PATH] = {};
  GetModuleFileNameW(nullptr, exe_path, MAX_PATH);
  std::wstring path(exe_path);
  auto last_slash = path.rfind(L'\\');
  if (last_slash != std::wstring::npos)
    path = path.substr(0, last_slash + 1);

  for (int i = 0; i < 5; ++i) {
    auto test = path + L"..\\..\\..\\..\\agent-sphere-avatar\\dist\\";
    DWORD attr = GetFileAttributesW(test.c_str());
    if (attr != INVALID_FILE_ATTRIBUTES &&
        (attr & FILE_ATTRIBUTE_DIRECTORY)) {
      wchar_t full[MAX_PATH];
      GetFullPathNameW(test.c_str(), MAX_PATH, full, nullptr);
      return std::wstring(full);
    }
  }

  wchar_t* buf = nullptr;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppDataLow, 0, nullptr,
                                     &buf))) {
    std::wstring result(buf);
    CoTaskMemFree(buf);
    return result;
  }

  return L"";
}

LRESULT CALLBACK SphereOverlayWindow::WndProc(HWND hwnd, UINT message,
                                              WPARAM wparam,
                                              LPARAM lparam) noexcept {
  if (message == WM_NCCREATE) {
    auto* cs = reinterpret_cast<CREATESTRUCT*>(lparam);
    SetWindowLongPtr(hwnd, GWLP_USERDATA,
                     reinterpret_cast<LONG_PTR>(cs->lpCreateParams));
  } else {
    auto* that = reinterpret_cast<SphereOverlayWindow*>(
        GetWindowLongPtr(hwnd, GWLP_USERDATA));
    if (that) return that->HandleMessage(hwnd, message, wparam, lparam);
  }
  return DefWindowProc(hwnd, message, wparam, lparam);
}

LRESULT SphereOverlayWindow::HandleMessage(HWND hwnd, UINT message,
                                           WPARAM wparam,
                                           LPARAM lparam) noexcept {
  switch (message) {
    case WM_NCHITTEST:
      if (ignore_mouse_) {
        return mouse_forward_ ? HTTRANSPARENT : HTNOWHERE;
      }
      return HTCLIENT;

    case WM_TIMER:
      if (wparam == anim_state_.timer_id && anim_state_.timer_id) {
        const DWORD now = GetTickCount();
        const double t = std::min(1.0, static_cast<double>(
            now - anim_state_.start_time) / anim_state_.duration_ms);
        const double ease = t < 0.5
            ? 2 * t * t
            : 1 - pow(-2 * t + 2, 2) / 2.0;
        const int cx = static_cast<int>(
            anim_state_.start_x +
            (anim_state_.target_x - anim_state_.start_x) * ease);
        const int cy = static_cast<int>(
            anim_state_.start_y +
            (anim_state_.target_y - anim_state_.start_y) * ease);

        SetWindowPos(hwnd, nullptr, cx, cy, 0, 0,
                     SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);

        if (t >= 1.0) {
          KillTimer(hwnd, anim_state_.timer_id);
          anim_state_.timer_id = 0;
        }
        return 0;
      }
      break;

    case WM_DESTROY:
      window_handle_ = nullptr;
      break;
  }

  return DefWindowProc(hwnd, message, wparam, lparam);
}

void SphereOverlayWindow::AnimateMove(int target_x, int target_y,
                                      int duration_ms) {
  if (!window_handle_) return;

  RECT rc;
  GetWindowRect(window_handle_, &rc);

  anim_state_.start_x = rc.left;
  anim_state_.start_y = rc.top;
  anim_state_.target_x = target_x;
  anim_state_.target_y = target_y;
  anim_state_.start_time = GetTickCount();
  anim_state_.duration_ms = duration_ms;

  if (anim_state_.timer_id)
    KillTimer(window_handle_, anim_state_.timer_id);

  anim_state_.timer_id = 1;
  SetTimer(window_handle_, anim_state_.timer_id, 16, nullptr);
}

void SphereOverlayWindow::OnWebviewReady() {
  if (!webview_) return;

  webview_->add_WebMessageReceived(
      Microsoft::WRL::Callback<ICoreWebView2WebMessageReceivedEventHandler>(
          [this](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args)
              -> HRESULT {
            LPWSTR raw = nullptr;
            if (SUCCEEDED(args->get_WebMessageAsJson(&raw)) && raw) {
              std::wstring msg(raw);
              CoTaskMemFree(raw);
              OnWebMessage(msg);
            }
            return S_OK;
          })
          .Get(),
      nullptr);

  webview_->AddScriptToExecuteOnDocumentCreated(
      LR"(
(function(){
  function __postNative(type, data){
    try{
      window.chrome.webview.postMessage(JSON.stringify({t:type,d:data}));
    }catch(_){}
  }

  var bridge = {
    _patchCb: null,
    _roamCb: null,
    _ignoreMouse: false,
    _mouseForward: true,

    onPatch: function(p){ if(this._patchCb){ try{this._patchCb(p);}catch(_){} } },
    setOnPatch: function(cb){ this._patchCb = cb; },

    getWorkArea: function(){
      return new Promise(function(resolve){
        __postNative('getWorkArea',null);
        var h = function(e){
          if(e.data && typeof e.data==='string'){
            try{
              var d=JSON.parse(e.data);
              if(d.t==='workArea'){ resolve(d.d); window.removeEventListener('message',h); }
            }catch(_){}
          }
        };
        window.addEventListener('message',h);
      });
    },

    moveTo: function(x,y,ms){
      __postNative('moveTo',{x:x||0,y:y||0,ms:ms||1200});
    },

    moveBy: function(dx,dy){
      __postNative('moveBy',{dx:dx||0,dy:dy||0});
    },

    setIgnoreMouseEvents: function(fwd){
      __postNative('setIgnoreMouse',{forward:!!fwd});
    },

    onRoam: function(cb){ this._roamCb = cb; },
    roamNow: function(){ __postNative('roam',null); }
  };

  window.__sphereOverlayBridge = bridge;
  window.sphereOverlay = bridge;
})()
)",
      Microsoft::WRL::Callback<
          ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler>(
          [](HRESULT, LPCWSTR) { return S_OK; })
          .Get());

  if (!stored_url_.empty()) {
    std::wstring wurl(stored_url_.begin(), stored_url_.end());
    webview_->Navigate(wurl.c_str());
  } else {
    auto dist_dir = GetDistPath();
    if (!dist_dir.empty()) {
      std::wstring path = dist_dir;
      path += L"overlay.html";
      webview_->Navigate(path.c_str());
    }
  }
}

void SphereOverlayWindow::OnWebMessage(const std::wstring& json_msg) {
  try {
    std::wstring type_val = JsonExtractStr(json_msg, L"t");

    if (type_val == L"moveTo") {
      double x = JsonExtractNum(json_msg, L"x");
      double y = JsonExtractNum(json_msg, L"y");
      double ms = JsonExtractNum(json_msg, L"ms");
      MoveTo(static_cast<int>(x), static_cast<int>(y), static_cast<int>(ms));
    } else if (type_val == L"moveBy") {
      double dx = JsonExtractNum(json_msg, L"dx");
      double dy = JsonExtractNum(json_msg, L"dy");
      MoveBy(static_cast<int>(dx), static_cast<int>(dy));
    } else if (type_val == L"setIgnoreMouse") {
      bool forward = JsonExtractBool(json_msg, L"forward");
      SetIgnoreMouseEvents(true, forward);
    } else if (type_val == L"roam") {
      Roam();
    } else if (type_val == L"getWorkArea") {
      RECT wa = GetWorkArea();
      wchar_t buf[256];
      swprintf_s(buf, LR"({"t":"workArea","d":{"x":%ld,"y":%ld,"width":%ld,"height":%ld}})",
                  static_cast<long>(wa.left), static_cast<long>(wa.top),
                  static_cast<long>(wa.right - wa.left),
                  static_cast<long>(wa.bottom - wa.top));
      webview_->PostWebMessageAsJson(buf);
    }
  } catch (...) {
  }
}
