# 电话代办（phone-call）能力架构设计

> 范围说明：本文是「agent 拨打真实电话号码（商户/机构/个人），通过语音对话代用户完成预约、确认、回电咨询等任务」的实现方案。
> 状态：**P0（脚本托管：确认门 + 手机桥拨出 + 结果回填）已实现并有测试覆盖**（`server/src/services/phone-call-coordinator.ts`、`server/src/tools/capability-modules/phone-call/`、`server/test/phone-call.test.ts`；默认 `PHONE_CALL_ENABLED=false`）。P1 端侧实时语音、P2 云线路仍为设计稿。
> 关系：不改动现有 `phone.*`（端侧拨号桥 + 应用内虚拟电话）语义；新能力使用独立命名空间 `phone_call.*`。

## 〇、一句话定位

agent 代表用户向**第三方真人**发起真实语音通话，在通话中用「目标要素 + 话术脚本 + 实时语音回路」完成事务（订座、预约、确认订单、询问营业信息等），挂断后把**结构化结果**回填到会话（卡片 + 日程 + 收件箱），全程有确认门、审计与录音转写。

它是什么：
- 一个新的 capability module（`phone_call.*` 工具族）+ 一个通话会话协调服务 + 一条复用全双工语音管线的实时回路。
- 端侧优先：P1 阶段用用户自己的安卓手机拨出（主叫号码 = 用户真实手机号，天然满足「用户提供真实手机号」），P2 才考虑云端线路。

它不是什么：
- 不是替换现有 `phone.dial`（打开拨号盘）——`phone.dial` 保留为"只拨号不对话"的兜底。
- 不是应用内虚拟电话（`virtual-phone-service.ts`）的扩展——对端是 PSTN 真人，不是站内 agent。
- 不是自动群呼/营销外呼系统——有单任务、单号码、频控与用途约束。

### 与虚拟电话（virtual-phone）的分界

现网已有一套"虚拟电话"（`services/virtual-phone-service.ts`：6 位站内号、用户↔agent 应用内互拨、不接触 PSTN）。本能力与它是**两个并行体系**：只允许借鉴代码模式（如回复总线的等待原语写法），**不得共享运行时实例、号码体系、会话存储与 UI 状态**。

| 维度 | 虚拟电话（既有，`phone.virtual_call` 等） | 真实外呼（本方案 `phone_call.*`） |
| --- | --- | --- |
| 对端 | 站内 agent / 用户本人 | PSTN 真人（商户/机构/个人） |
| 号码体系 | 6 位站内虚拟号 | 真实手机号/固话（11 位/带区号/E.164） |
| 外部性与费用 | 无话费、无外部打扰 | 真实话费、真实打扰第三方 → 确认门+频控+合规全套 |
| 事件族 | `agent.phone.*` | `phone_call.*` |
| 客户端会话/UI | `PhoneCallSession` + `phone_call_page`（保持不动） | `AgentCallSession` + `agent_call_page`（独立实例，可与虚拟通话并存） |
| 录音/合规 | 无此要求 | AI 身份声明 + 录音告知 + 频控 + 审计 |

LLM 路由硬规则（写入各工具 description 与 `phone-call-skills.ts`，intent 配反例测试）：对端是站内 agent/用户 → 虚拟电话工具；对端是外部真实号码且要 agent 替说话 → `phone_call.*`；只需打开拨号盘由用户自己讲 → `phone.dial`。

号码格式护栏互斥：`phone_call.*` 拒绝 6 位纯数字目标号（那是站内虚拟号）；`phone.virtual_call` 只收 6 位站内号——从入口上杜绝两体系串线。

## 一、现状盘点：能复用什么、缺什么

已有积木（全部可复用，见引用路径）：

| 积木 | 位置 | 复用方式 |
| --- | --- | --- |
| capability module 模式 | `server/src/tools/capability-modules/index.ts`（`CapabilityModule` L137、deps L163、聚合 L197） | 新模块四件套即可自动并入工具/意图/注册 |
| 设备执行器协调器模式 | `server/src/services/shared-browser-coordinator.ts:118-171`（jobId invoke → WS → completeFromSocket，30s 超时） | `phone-call-coordinator` 照此实现 |
| 端侧电话桥 | `client/flutter_app/android/.../PhoneBridgePlugin.kt`（channel `pai/phone_bridge`，`dial`）+ `DialConfirmActivity.kt`（CALL_PHONE 运行时权限 + ACTION_CALL） | 新增"受控外呼 + 采音 + 播放"方法 |
| 拨号安全护栏 | `server/src/tools/phone-bridge-tools.ts:37`（`normalizeDialNumber` 紧急号码守卫）、`:47-59`（按轮去重） | 直接复用 |
| 拨打前确认令 | `server/src/agent/agent-access-mode.ts:151-199`（远程拨号必须先向用户确认的产品规则） | 继承并强化为确认卡 |
| 全双工语音管线 | `server/src/services/voice-duplex/` + `server/src/ws/voice-duplex-route.ts`（base64 PCM JSON 帧）；ASR `services/funasr-auto-starter.ts`；TTS `services/tts-service.ts`（SiliconFlow→OpenAI 兜底） | 通话音频帧格式与 VAD/打断逻辑直接照搬 |
| 通话 UI | `client/flutter_app/lib/core/services/phone_call_session.dart`（ChangeNotifier：phase/transcript/agentTalking）+ `lib/core/presentation/phone_call_page.dart`；Win32 浮窗 `windows/runner/flutter_window.cpp:85-119` | 扩展出呼（outbound agent-driven）模式 |
| 事件协议 | `packages/agent-protocol/src/events.ts`（已有 `agent.phone.*`、`phone.bridge.*`、`device.*`） | 新增 `phone_call.*` 事件族 |
| 后台长任务面 | `server/src/tools/task-dispatch-tool.ts` + `services/agent-task-orchestrator.ts`（`chat.task_update`，state `awaiting_input`，结果以新消息回流） | 分钟级通话挂在任务面，不占工具循环 |
| 交互确认卡 | `server/src/services/agent-result-formatter.ts:136`（card `actions`）→ 客户端 `AgentActionChoiceCard` → `chat.user_action` 回传 | 拨打前确认卡零成本 |

缺口（本方案要补的）：
1. agent 与电话对端真人的**实时语音对话回路**（现在只能拨号、不能替用户说话）。
2. 第三方外呼的**会话状态机**（拨前确认 → 振铃 → 通话 → 挂断 → 结果回填）。
3. 通话任务的**脚本/要素结构化**与**挂断后结果回填闭环**。
4. 外呼场景的**频控、录音告知、AI 身份标识**等合规护栏。

## 二、执行面选择与分期决策

| 维度 | P0 脚本托管 | P1 端侧实时语音（推荐主路线） | P2 云端线路（SIP/智能外呼） |
| --- | --- | --- | --- |
| 主叫号码 | 用户真实手机号 | 用户真实手机号 | 平台线路号码（国内个人号码做主叫基本不可行，代拨他人号码有合规风险） |
| 对话能力 | 无（agent 不参与通话，仅脚本+回填） | 有：手机开免提，麦克风采对端声音上行 ASR，agent TTS 经扬声器说出 | 有：云端全托管，用户设备可离线 |
| 依赖 | 现有 phone.dial 即可 | RECORD_AUDIO + AEC + 语音管线 | 运营商线路资质、企业实名、AI 外呼报备（国内门槛高） |
| 限制 | 用户需自己通话 | 用户需在场；外放有环境音/隐私问题 | 成本、接通率、合规审核周期 |
| 风险 | 低 | 中 | 高（资质） |

**决策：按 P0 → P1 → P2 分期。** P0 打通编排/确认/回填闭环（1 周量级），P1 用端侧外放模式实现真正的"agent 替你打电话"（核心增量），P2 作为可选云线路 provider 接入（接口在 P1 就抽象好，`CallTransport` 双实现）。若用户接受平台号码作为主叫，P2 可提前。

## 三、通话会话模型（CallSession）

新服务 `server/src/services/phone-call-coordinator.ts`，组合 `SharedBrowserCoordinator` 的 invoke/waiter 模式与 `VirtualPhoneService` 回复总线（`waitForCallReply`，virtual-phone-service.ts:140）的**写法范式**——仅借鉴模式，不共享虚拟电话的任何运行时（见 §〇 分界）。

状态机：

```
drafting → awaiting_confirm ──(拒绝)──→ cancelled
                │(确认, phone_call.start)
                ▼
             dialing → ringing → active ──(通话完成/失败)──→ ended → summarized
                         │(无人接听/占线, 重试退避≤2次)           │
                         └──→ failed ◀───────────────────────────┘
```

核心接口（伪代码）：

```ts
interface CallTransport {                    // P1 端侧实现 / P2 云线路实现
  readonly kind: "bridge" | "cloud";
  dial(req: DialRequest): Promise<void>;                 // 发起外呼
  openAudio(callId: string): AudioStream;                // 双向 PCM 流
  hangup(callId: string, reason: string): Promise<void>;
}

class PhoneCallCoordinator {
  createSession(task: CallTask): CallSession;            // drafting
  requestConfirm(callId): void;                          // 推确认卡
  start(callId): { callId };                             // 校验确认→dial，异步推进状态机
  say(callId, text): Promise<void>;                      // TTS 排队播报（工具）
  status(callId): CallStatusSnapshot;                    // 工具轮询
  hangup(callId, reason): Promise<CallSummary>;          // 工具
  onTranscriptDelta(callId, entry): void;                // 推 phone_call.transcript_delta
  finalize(callId): CallSummary;                         // 结构化结果 + 落盘
}
```

- 持久化：`data/phone-call/{callId}.json`（`storage/atomic-json.ts` 原子写）：任务要素、确认记录、事件流水、转写、录音索引、结果摘要；TTL 清理（默认 30 天，可配置）。
- 状态推送：`ClientPushPort.trySend(actorId, …)`（`server/src/ports/client-push-port.ts`，由 `ws-connection-registry.ts` 实现），事件族 `phone_call.*`（见 §五）。
- 审计：每次 dial/say/hangup 写 `AuditService`（同 shared-browser）。

## 四、服务端改动清单（文件级）

**新建：**

1. `server/src/services/phone-call-coordinator.ts` — CallSession 状态机、CallTransport 抽象、bridge 实现经 `PhoneBridgeCoordinator` 下发、状态/转写推送、TTL/频控、审计。
2. `server/src/tools/capability-modules/phone-call/chat-tools.ts` — 工具 schema（ dotted 名，沿用 `code.run` 风格）：

```jsonc
// phone_call.start —— 返回 {callId, state}，绝不在工具调用内等接通
{ "name": "phone_call.start", "parameters": {
  "callId":  "string, 由 phone_call.prepare 返回，证明用户已确认",
  "goal":    "string, 一句话通话目标",
  "facts":   "object, 已知要素 {人数/时间/联系人/订单号/特殊需求...}",
  "mustAsk": ["string, 必须问清的问题"],
  "fallback":"string, 对方无法满足时的底线方案",
  "maxDurationSec": "number, 默认 300"
}}
// phone_call.status —— 轮询 {state, transcriptTail, pendingQuestion?}
// phone_call.say    —— 主动播报一句（P0 仅在 active 时记录为话术提示）
// phone_call.hangup —— 挂断并返回摘要
// phone_call.prepare —— 生成确认卡（话术摘要+要素），返回 callId(drafting)
```

   每个工具的 description 写明与虚拟电话/`phone.dial` 的路由边界（详见 §〇 分界），`intent.ts` 配反例（"打给我自己的 agent"不得触发 `phone_call.*`）；`prepare/start` 校验目标号为真实号格式，拒绝 6 位纯数字站内虚拟号。

3. `server/src/tools/capability-modules/phone-call/handlers.ts` — handler 工厂 + `registerPhoneCallTools(registry, deps)`；`phone.call` 同款拨号去重（`ctx.chatUserMessageId`）、紧急号码守卫复用 `normalizeDialNumber`；结果一律 `{ok, state, summary}` 小体积（大转写走 ObservationPack 句柄，`external-model/observation-pack.ts`）。
4. `server/src/tools/capability-modules/phone-call/intent.ts` — BM25 规则：打电话/帮我预约/致电/订座/回电/call/reservation…；类别映射 `phone`。
5. `server/src/tools/capability-modules/phone-call/index.ts` — `buildPhoneCallModule(deps)`。
6. `server/src/services/phone-call/call-policy.ts` — 通话系统提示词组装：目标要素、话术风格、**硬规则**（开口表明"我是 AI 助手，受机主委托来电"；对方询问超纲/涉钱涉验证码一律记录待回电；不编造事实；对方录音告知回应）、黑名单校验。
7. `server/src/ws/phone-call-route.ts`（P1）— 通话音频专用 WS：上行对端 PCM → FunASR；下行 TTS PCM；帧格式照抄 `voice-duplex-route.ts`。
8. `server/src/skills/builtin/phone-call-skills.ts` — 程序性技能（预约场景 SOP：先要素后拨号、必问清单、挂断后回填模板），在 bootstrap 按 `registerVirtualPhoneBuiltinSkills`（create-app-services.ts:976）同款注册。
9. `docs/phone-call-architecture.md` — 本文。

**修改（共 5 处，均为仓库约定的唯二/唯三接线点）：**

- `server/src/tools/capability-modules/index.ts` — `CapabilityModuleDeps` 增加 `phoneCallCoordinator`，`buildCapabilityModules` 数组加一项。
- `server/src/bootstrap/create-app-services.ts` — 构造 coordinator（放在 `new SharedBrowserCoordinator(auditService)` L726 附近），传入 `capabilityModuleDeps`（L934-953），注册技能。
- `server/src/external-model/openai-compatible-tool-loop.ts:290` `resolveToolExecutionTimeoutMs` — 显式按名覆盖（**不能用 classTimeouts，它被封顶在 30s**）：`phone_call.start`=60s（等拨号应答状态，不是等通话），其余 `phone_call.*`=15s。
- `packages/agent-protocol/src/events.ts` — 新增 `ServerEventType.PhoneCallStatusUpdate: "phone_call.status_update"`、`PhoneCallTranscriptDelta: "phone_call.transcript_delta"`、`PhoneCallConfirmRequest: "phone_call.confirm_request"` 及 payload 类型；重建 workspace 包。
- `server/.env.example` — 配置块（见 §九）。

**长任务约束（来自现状，必须遵守）：**

- 工具循环是请求作用域的：新用户消息会中断当前 turn（chat-user-message.ts:524-527），且默认工具超时 30s、无 AbortSignal。⇒ **通话本体绝不放进单次工具调用**：`phone_call.start` 立即返回 `callId`，通话推进由 coordinator 驱动，模型用 `phone_call.status` 轮询（或经任务面 `chat.task_update(state=awaiting_input)` 被唤醒），长等待期间沿 `chat.agent_status` 心跳（chat-user-message.ts:707/916 已有 30s 心跳先例）。
- 单飞保护：同号码同任务进行中时再次 `start` 直接返回现有 callId（overrun guard 语义，tool-loop L409-431 的应用层等价物）。

## 五、事件与实时语音管线（P1）

电话相关事件族共三套，命名即语义，客户端按前缀分流、互不复用：

| 事件族 | 归属 | 语义 |
| --- | --- | --- |
| `agent.phone.*` | 虚拟电话 | 站内用户↔agent 应用内通话（入呼/振铃/语音回复），无 PSTN |
| `phone.bridge.*` | 设备桥 | 服务器↔手机能力 RPC（拨号/短信/定位…），非通话会话 |
| `phone_call.*` | 本方案：真实外呼 | agent↔第三方真人的 PSTN 通话会话 |

本方案新增事件（不与上表任何既有事件名重叠）：

| 事件 | 方向 | 载荷要点 |
| --- | --- | --- |
| `phone_call.confirm_request` | S→C | callId、目标号码（脱敏显示）、目标摘要、话术脚本预览、`actions:[confirm_call, cancel]` |
| `phone_call.status_update` | S→C | callId、state、reason（呼损原因：busy/no_answer/declined…） |
| `phone_call.transcript_delta` | S→C | callId、speaker(callee/agent/user)、text、ts |
| `phone_call.audio` | C→S / S→C | {callId, dir, seq, pcm(base64, 16k mono), vad?} —— 复用 voice-duplex 帧约定 |
| `phone_call.user_takeover` | C→S | 用户按"我来接听"，agent 静音、仅转写 |

语音回路（端侧外放模式）：

```
对端声音 → 手机扬声器 → 手机麦克风(RECORD_AUDIO, AEC 开) 
   → PhoneBridgePlugin 采音 → WS phone_call.audio 上行 
   → FunASR 流式转写 → LLM(通话策略提示词 + 转写窗口) → TTS(SiliconFlow)
   → PCM 下行 → 手机扬声器播放 → 对端听到
```

- 打断（barge-in）：对端说话时 VAD 抑制 TTS 播报，复用 voice-duplex 已有逻辑。
- 转写实时推 `phone_call.transcript_delta` 供通话页字幕；全量随会话落盘。
- 延迟预算：ASR 尾点 ≤300ms + LLM 首 token ≤500ms + TTS 首包 ≤300ms，目标对端感知响应 ≤1.5s；不达标时先上"逐句半实时"（对方说完一句，agent 回一句），不追求抢话。
- 用户随时可按"我来接"接管（`phone_call.user_takeover`），agent 转字幕辅助模式。

P0 简化：无音频回路，通话期间 agent 只展示脚本要点 + 用户挂断后口述/发消息回填，`phone_call.hangup` 触发结构化摘要（预约号/时间/注意事项 → 日程 + 收件箱 + 结果卡）。

## 六、客户端改动清单（文件级）

**Android（`client/flutter_app/android/app/src/main/kotlin/com/example/private_ai_app/`）：**

1. `PhoneBridgePlugin.kt` — channel `pai/phone_bridge` 新增方法：
   - `startAgentCall(callId, number, speaker=true)`：走 `DialConfirmActivity` 同款全屏确认（复用运行时 CALL_PHONE 流程），`ACTION_CALL` 拨出并强制免提（`audioManager.isSpeakerphoneOn = true`）。
   - `startCallAudio(callId)` / `stopCallAudio(callId)`：前台服务（复用 `ScreenRecordService` 的 foregroundServiceType 模式）内 `AudioRecord` 采音（16k/mono/PCM）+ `AudioTrack` 播放下行；AEC 用 `AcousticEchoCanceler`。
2. `AndroidManifest.xml` — 追加 `RECORD_AUDIO`（现未显式声明）与前台麦克风 service type；`CALL_PHONE` 已有。
3. 通话状态上报：`PhoneDataReader` 同款广播/`readState` 方式上报 `IDLE/RINGING/OFFHOOK`，驱动服务端状态机（振铃→active→挂断）。

**Flutter：**

1. **会话隔离**：现有 `lib/core/services/phone_call_session.dart` 保持只服务虚拟电话入呼（`agent.phone.*`），一行不改；新增 `lib/core/services/agent_call_session.dart`（`AgentCallSession` ChangeNotifier：`state: awaiting_confirm/dialing/ringing/active/ended`、transcript、agentTalking），只消费 `phone_call.*`。两套会话零共享状态，虚拟来电与真实外呼可并存（移动端前台同时只显示一个，另一个走系统通知）。
2. `lib/core/presentation/agent_call_page.dart`（新建）— 出呼 UI：确认态（要素+话术预览+"真实通话、将产生话费"明示）、拨号态、通话态（实时字幕、说话方指示、"我来接听"/"挂断"）、结束态（结果摘要卡）。结构可复制自 `phone_call_page.dart`，但页面顶部固定"真实电话"角标，与虚拟电话 UI 不混用。
3. `main.dart` `_ws.events.listen`（~L833）与 `lib/mobile_ui/mobile_chat_controller.dart:136` switch — 新增 `phone_call.*` 分支驱动 `AgentCallSession`；`agent.phone.*` 分支继续驱动 `PhoneCallSession`（照 L1785-2100 接线方式），两族分支互斥。
4. 确认卡：服务端下发 replyBlocks `card` + `actions`，`AgentActionChoiceCard`（`lib/features/chat/agent_action_choice_card.dart`）零改动渲染，点击走 `chat.user_action` → 服务端确认放行。
5. Win32 桌面端：通话在手机上执行、桌面端仅看字幕与结果（浮窗 `outgoing_call_window.cpp` 仅作状态提示，不做音频）；P2 云线路时桌面端才有音频参与。

## 七、安全与合规（硬约束，全部服务端强制）

1. **拨打前确认门**：无确认记录（`callId` 未过 `awaiting_confirm`）的 `start` 一律拒绝；确认卡必须展示目标号码、通话目标、话术要点，并明示**"这是真实电话：对方是真人、将产生真实话费、通话将被录音转写"**——这是与免费虚拟电话的本质差异，必须让用户在确认时感知到。继承 agent-access-mode.ts:151-199 的既有产品规则并升级为强制门。
2. **号码黑名单/紧急号码**：复用 `normalizeDialNumber`；110/120/119/122/955xx 等紧急与金融热线直接拒绝；短信验证码、支付、贷款等敏感意图在 `call-policy.ts` 硬编码拒绝并解释。
3. **AI 身份标识**：通话开场白强制包含"我是 AI 助手，受机主委托来电"（国内 AI 外呼标识要求）；被要求"转人工/你是机器人吗"必须如实回答。
4. **录音告知**：端侧采音即录音，开场白第二句告知"为保证服务质量将录音与转写"；对方拒绝录音→停录仅留实时转写，或结束通话（策略可配）。
5. **频控与防骚扰**：同号码 24h 内最多 2 次外呼（重试间隔 ≥10 分钟，遇 busy/no_answer 退避）；单设备日上限可配（默认 20）；凌晨时段（可配，默认 22:00–8:00）禁止外呼。
6. **隐私最小化**：agent 只掌握任务要素，被问及无关个人信息一律回避；号码在日志/转写落盘中脱敏存储（`138****1234`），录音文件本地 `data/phone-call/audio/` 加密存放、随会话 TTL（默认 30 天）删除、用户可随时删除。
7. **审计**：dial/say/hangup/确认事件全量进 `AuditService`，含 actorId、callId、目标号码哈希。
8. **服务端不落明文手机号清单**：目标号码仅存在于会话作用域 + 脱敏日志。

## 八、关键时序

P1 端侧实时通话全链路：

```
用户: "帮我订周六晚上7点4人火锅，海底捞XX店，电话是用户提供的 138xxxx"
LLM: 要素不全 → 追问（联系人姓名/忌口）→ 齐备
LLM: phone_call.prepare {goal, facts, mustAsk} 
  → coordinator: drafting → 下发 phone_call.confirm_request（确认卡）
用户: 点击"确认拨打"（chat.user_action）
LLM(下一轮): phone_call.start {callId} → 立即 {state:"dialing"}
  coordinator → PhoneBridge → DialConfirmActivity(端上二次确认) → ACTION_CALL 免提拨出
  状态机: ringing → active（端侧上报 OFFHOOK + 采音开始）
  音频回路: 麦克风→WS→ASR→LLM(call-policy prompt)→TTS→扬声器   [phone_call.transcript_delta 实时字幕]
  用户可 phone_call.user_takeover
  对端挂断 → 端侧 IDLE → ended → finalize：CallSummary{结果,预约号,时间,注意}
LLM(轮询 status 得 summarized): 输出结果卡（replyBlocks）+ 写日程/收件箱
```

## 九、配置（`server/.env.example` 新块）

```bash
# ── 电话代办（phone-call）──────────────────────────
PHONE_CALL_ENABLED=false                # 总开关（false 时工具不可见）
PHONE_CALL_EXECUTOR=bridge              # bridge=端侧外放 | cloud=云线路 | mock=测试
PHONE_CALL_CLOUD_PROVIDER=              # twilio | sip-trunk | (P2)
PHONE_CALL_CLOUD_API_KEY=
PHONE_CALL_MAX_DURATION_SEC=300         # 单通硬上限
PHONE_CALL_DAILY_LIMIT=20               # 单设备日呼出上限
PHONE_CALL_PER_NUMBER_24H_LIMIT=2
PHONE_CALL_QUIET_HOURS=22:00-08:00      # 禁呼时段
PHONE_CALL_RECORDING_ENABLED=true       # 录音（仍需开场告知）
PHONE_CALL_RETENTION_DAYS=30
PHONE_CALL_TAKEOVER_ENABLED=true
```

密钥实际值放 `.env.local`（gitignored），与 `SEARCH_API_PROVIDER` 同款"开关+单键"模式（`.env.example:126-136`）。

## 十、测试策略

1. **服务端单测**：状态机全迁移路径；频控/黑名单/未确认拒绝；`phone_call.*` 超时覆盖值生效；拨号去重（同 chatUserMessageId 只拨一次）。`executor=mock`：假 transport + 脚本化音频（预录 PCM 循环）跑通 prepare→start→transcript→finalize 全链路。
2. **协议/渲染配对**：`render-forms-coverage.test.ts` ↔ `test/render_forms_client_coverage_test.dart` 惯例，补确认卡与结果卡；`reply_blocks_render_test.dart` 风格补 widget 测试。
3. **GUI 黑盒**（web-gui-tester）：确认卡交互、通话页字幕、"我来接听"接管、拒绝路径。
4. **真机冒烟**：安卓真机 + 测试号码（自己的第二台手机），验证 AEC 后 ASR 可用性、打断行为、挂断回填。
5. 灰度：`PHONE_CALL_ENABLED` 默认 false，按设备白名单放开。

## 十一、分期落地计划

| 阶段 | 范围 | 验收标准 | 量级 |
| --- | --- | --- | --- |
| P0 | capability module + coordinator + 确认卡 + `phone.dial` 托管拨号 + 挂断后结果回填（摘要/日程/收件箱） | 一句话"帮我预约X"能走完 确认→拨号→回填 闭环；未确认/黑名单/频控全部被拒；**工具路由反例通过**（"打给我的 agent"→虚拟电话，"帮我预约餐厅"→`phone_call.*`，"帮我拨号我自己说"→`phone.dial`，三者不互串） | ~1 周 |
| P1 | 端侧音频回路（采音/播放/AEC/前台服务）+ ASR/LLM/TTS 通话管线 + 通话页实时字幕 + 接管/挂断 | agent 能在真实通话中听懂对方并完成 ≥3 轮预约对话，端到端响应 ≤1.5s（半实时可放宽） | ~2-3 周 |
| P2 | `CallTransport` cloud 实现（SIP/智能外呼 provider）+ 云线路合规接入 | 用户设备离线场景下同 P1 验收（主叫为平台号码，需资质） | 视资质 2-4 周 |

## 十二、已知边界与开放问题

1. **iOS 不支持端侧方案**：iOS 无法程序化拨号并采集通话音频（无等价 CALL_PHONE + 通话音频通路）。iOS 上降级为 `tel://` 跳转 + 脚本托管（P0 形态），或等 P2 云线路。
2. **外放模式音质/隐私**：环境噪音影响 ASR；通话内容外放有旁人可闻的隐私问题——确认卡上明示"将外放通话"，建议戴耳机场景不做（蓝牙通话音频不可同时采音，属系统限制，转写退化为无）。
3. **主叫身份**：端侧=用户真实号码（可能被对方回拨，符合预期）；云线路=平台号码（对方回拨打不到用户，需在话术中说明）。
4. **开放问题**：云线路国内供应商选型（阿里智能外呼/容联/自建 SIP）依赖资质进度；转写文本的个人信息是否进入长期记忆（默认：不进，仅会话内 ObservationPack）。
