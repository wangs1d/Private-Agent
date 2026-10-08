// PATCHED (pai fork, 2026-10-08): marshal Success/Error to the platform
// thread before touching the EventSink.
//
// Upstream 4.4.1 forwards events straight into flutter::EventSink from the
// CALLING thread. AudioPlayer emits from background media threads
// (std::thread(...).detach() in SetSourceUrl etc.), which drives
// flutter::BinaryMessenger outside the platform thread. The engine only
// guarantees thread safety for AddRef/Release on the FlutterDesktopMessenger
// (see flutter_messenger.h); Send from a non-platform thread is a
// use-after-free inside the engine messenger — observed as
// flutter_windows.dll+0x14f37 AV (0xc0000005) in production.
//
// Fix: a hidden message-only window is created lazily on the platform thread
// (OnListenInternal always runs there). Media threads only heap-allocate a
// std::function and PostMessage it; the WndProc runs it on the platform
// thread. PostMessage is thread-safe; if the app is tearing down and the
// post fails, the event is dropped (a dying process losing one event is
// harmless; a UAF is not).
#include <flutter/encodable_value.h>
#include <flutter/event_channel.h>

#include <windows.h>

#include <functional>
#include <mutex>

using namespace flutter;

namespace audioplayers_pai {

constexpr UINT kDispatchMessage = WM_APP + 0x4150;

// Created on the platform thread; read from any thread after that.
// PostMessage tolerates a stale-but-valid HWND; a NULL HWND simply drops.
inline HWND& DispatchWindow() {
  static HWND hwnd = nullptr;
  return hwnd;
}

inline LRESULT CALLBACK DispatchWndProc(HWND hwnd,
                                        UINT msg,
                                        WPARAM wparam,
                                        LPARAM lparam) {
  if (msg == kDispatchMessage) {
    auto* task = reinterpret_cast<std::function<void()>*>(lparam);
    if (task != nullptr) {
      (*task)();
      delete task;
    }
    return 0;
  }
  if (msg == WM_DESTROY) {
    DispatchWindow() = nullptr;
    return 0;
  }
  return DefWindowProcW(hwnd, msg, wparam, lparam);
}

// Must be called from the platform thread only (OnListenInternal qualifies).
inline void EnsureDispatchWindow() {
  HWND& hwnd = DispatchWindow();
  if (hwnd != nullptr && IsWindow(hwnd)) return;
  static constexpr wchar_t kClassName[] = L"PaiAudioplayersDispatchWindow";
  HINSTANCE instance = GetModuleHandleW(nullptr);
  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = DispatchWndProc;
  wc.hInstance = instance;
  wc.lpszClassName = kClassName;
  RegisterClassExW(&wc);  // duplicate registration fails harmlessly
  hwnd = CreateWindowExW(0, kClassName, L"", WS_POPUP, 0, 0, 0, 0,
                         HWND_MESSAGE, nullptr, instance, nullptr);
}

// Heap-move a task to the platform thread; returns false (after freeing) if
// the dispatch window is gone.
inline bool PostToPlatform(std::function<void()>&& task) {
  HWND hwnd = DispatchWindow();
  if (hwnd == nullptr || !IsWindow(hwnd)) {
    return false;
  }
  auto* heap = new std::function<void()>(std::move(task));
  if (!PostMessageW(hwnd, kDispatchMessage, 0,
                    reinterpret_cast<LPARAM>(heap))) {
    delete heap;
    return false;
  }
  return true;
}

}  // namespace audioplayers_pai

template <typename T = EncodableValue>
class EventStreamHandler : public StreamHandler<T> {
 public:
  EventStreamHandler() = default;

  virtual ~EventStreamHandler() = default;

  void Success(std::unique_ptr<T> _data) {
    // Sink delivery now runs on the platform thread; capture ownership.
    (void)audioplayers_pai::PostToPlatform(
        [this, data = _data.release()]() {
          std::unique_ptr<T> payload(data);
          std::unique_lock<std::mutex> _ul(m_mtx);
          if (m_sink.get()) m_sink.get()->Success(*payload.get());
        });
  }

  void Error(const std::string& error_code,
             const std::string& error_message,
             const T* error_details = nullptr) {
    // error_details points into the caller's frame; copy by value.
    std::unique_ptr<T> details_copy =
        error_details != nullptr ? std::make_unique<T>(*error_details) : nullptr;
    (void)audioplayers_pai::PostToPlatform(
        [this, error_code, error_message, details = details_copy.release()]() {
          std::unique_ptr<T> payload(details);
          std::unique_lock<std::mutex> _ul(m_mtx);
          if (m_sink.get()) {
            if (payload != nullptr) {
              m_sink.get()->Error(error_code, error_message, *payload);
            } else {
              m_sink.get()->Error(error_code, error_message);
            }
          }
        });
  }

 protected:
  std::unique_ptr<StreamHandlerError<T>> OnListenInternal(
      const T* arguments,
      std::unique_ptr<EventSink<T>>&& events) override {
    audioplayers_pai::EnsureDispatchWindow();
    std::unique_lock<std::mutex> _ul(m_mtx);
    m_sink = std::move(events);
    return nullptr;
  }

  std::unique_ptr<StreamHandlerError<T>> OnCancelInternal(
      const T* arguments) override {
    std::unique_lock<std::mutex> _ul(m_mtx);
    m_sink.release();
    return nullptr;
  }

 private:
  std::mutex m_mtx;
  std::unique_ptr<EventSink<T>> m_sink;
};
