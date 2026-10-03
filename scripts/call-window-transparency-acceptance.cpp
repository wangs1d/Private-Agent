// 通话弹窗透明底真机验收 harness。
//
// 直接装配应用里同一份窗口类（outgoing/incoming/connected + call_visuals.h），
// 脱离 Flutter app 驱动真实窗口，供拖动取证：
//
//   call-window-transparency-acceptance.exe [out|in|conn]
//
// 启动后窗口停在工作区右下角；拖到任何背景上，卡片透出的都应是
// 当下画面（半透明逐像素 alpha，DWM 实时合成）。点挂断/关闭即退出。
#include <windows.h>
#include <stdio.h>
#include <cstdlib>
#include <memory>
#include <string>

#include "outgoing_call_window.h"
#include "incoming_call_window.h"
#include "connected_call_window.h"
#include "desktop_notification_window.h"
#include "glass_notify_window.h"

#pragma comment(lib, "gdiplus.lib")

namespace {

void PrintEvent(const char* what) { printf("[event] %s\n", what); }

}  // namespace

int wmain(int argc, wchar_t** argv) {
  std::wstring which = argc > 1 ? argv[1] : L"out";

  std::unique_ptr<OutgoingCallWindow> outgoing;
  std::unique_ptr<IncomingCallWindow> incoming;
  std::unique_ptr<ConnectedCallWindow> connected;
  std::unique_ptr<DesktopNotificationWindow> notification;
  std::unique_ptr<GlassNotifyWindow> glass;

  if (which == L"in") {
    incoming = std::make_unique<IncomingCallWindow>();
    incoming->SetCallbacks(
        [] { PrintEvent("ACCEPT"); },
        [] { PrintEvent("DECLINE"); exit(0); },
        [] { PrintEvent("TIMEOUT"); });
    incoming->Show("王哥", "语音提醒", "王", 0, 0xFF4A8DF0);
    printf("shown: incoming (%ls)\n", which.c_str());
  } else if (which == L"conn") {
    connected = std::make_unique<ConnectedCallWindow>();
    connected->SetCallbacks(
        [] { PrintEvent("HANGUP"); exit(0); },
        [](bool muted) { printf("[event] MUTE=%d\n", muted ? 1 : 0); },
        [](bool on) { printf("[event] SPEAKER=%d\n", on ? 1 : 0); });
    connected->Show("王哥", "王", 0xFF4A8DF0);
    connected->SetTalking(true);
    printf("shown: connected (%ls)\n", which.c_str());
  } else if (which == L"notif") {
    notification = std::make_unique<DesktopNotificationWindow>();
    notification->SetCallbacks(
        [] { PrintEvent("CONFIRM"); exit(0); },
        [] { PrintEvent("DISMISS"); exit(0); },
        [] { PrintEvent("TIMEOUT"); exit(0); });
    // 常驻无超时，便于拖动/截屏取证；点按钮即退出
    notification->Show("邮件", "NEXTBOT 登录验证码: 664658", "high",
                       "我知道了", 0);
    printf("shown: notification (%ls)\n", which.c_str());
  } else if (which == L"glass") {
    glass = std::make_unique<GlassNotifyWindow>();
    glass->SetEventCallback(
        [](const std::string& id, const std::string& event) {
          printf("[event] %s %s\n", id.c_str(), event.c_str());
          exit(0);
        });
    glass->Show("proactive-1", "系统通知", "蹲了九分钟，提醒你活动一下",
                "normal", "我知道了", 0);
    printf("shown: glass (%ls)\n", which.c_str());
  } else {
    outgoing = std::make_unique<OutgoingCallWindow>();
    outgoing->SetCallbacks([] { PrintEvent("HANGUP"); exit(0); });
    outgoing->Show("Agent", "正在接通", "A", 0xFF4A8DF0);
    printf("shown: outgoing (%ls)\n", which.c_str());
  }

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  return 0;
}
