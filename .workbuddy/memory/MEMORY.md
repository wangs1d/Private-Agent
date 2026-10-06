# Private-Agent（NEXTBOT）项目约定

## 本地环境限制（重要）

- **`flutter analyze` / `dart analyze` 在本机沙箱跑不起来**：Windows named pipe
  资源耗尽报「所有的管道范例都在使用中 / CreateFile failed 231」，analysis server
  进程无法启动。这是环境问题，不是代码错误。
  → 改 Dart 代码后靠**人工逐文件复核类型细节**（尤其三元表达式 int/double 混用、
  List.generate 返回值类型、ValueNotifier 泛型）。
- 服务端是 **dev watch 模式**，改 TS 后约 1 分钟内自动重载（看
  `logs/autostart/server-*.log` 里新的 `[VoiceDuplex] 全双工语音已启用` 行确认）。
- **验证服务端链路的最快方式**：用 node 探针脚本直连 `127.0.0.1:3000`
  （项目里有 `ws` 模块，`.scratch/probe-*.cjs` 是可复用模板）。
  跑完记得挂断，否则通话会话会一直占住忙线护栏，挡住真实呼叫。

## 通话链路（虚拟电话）要点

- UI 入口：聊天页电话按钮 → `main.dart` `_callMyAgentViaPhone`
  → WS `phone.call_my_agent` → 服务端振铃 → connected → `/ws/voice-duplex` 双工语音。
- `WsChatService.sendEvent` **自带离线排队**，业务层不要再用 `isConnected` 前置 return，
  否则等于把排队机制旁路掉。
- 桌面端通话 UI 是**原生 Win32 窗**（`pai/connected_call`，代码在
  `client/flutter_app/windows/runner/flutter_window.cpp` 及对应 C++ 窗口），
  要改通话窗上的显示内容必须动 C++；Flutter 侧 `PhoneCallPage` 只服务手机端。
- 通话行为参数集中在 `server/src/services/virtual-phone-service.ts` 顶部常量
  （振铃时长、开场问候语等，均支持环境变量覆盖）。
