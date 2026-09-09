# 旅行票务预订（travel_booking）配置与运行说明

统一预订抽象层（`server/src/services/booking/`）在 travel 域（机票/火车票/酒店）的能力现状与开启方式。

## 链路总览

```
travel_booking.search（多源报价比价）
  → travel_booking.book（两阶段确认 → 待支付订单 bkg_*，cashierUrl 随单落库）
  → booking.travel-pay（支付宝 AI 支付，用户本人钱包真实扣款）
  → booking.travel-pay-check（轮询支付结果 → confirmed）
  → booking.travel-issue（出票确认 → 票夹 + in_progress）
  → travel.arrival-monitor（到站管家，接力接站/到站打车）

已支付/已出票订单退改：
  travel_booking.refund（两阶段确认 → 退改工单 rft_*，随订单保存）
  → agent_browser 导航到原平台订单页退改签入口（最终提交须用户本人点击）
```

## 报价比价抽象层（services/booking/quote/）

三个源并行拉取、按总价升序归一；任一源失败不影响整体，失败源如实记入汇总 note。

| 源 | priceSource | 依赖 | 开启方式 |
|---|---|---|---|
| 本地价格库（保底） | database / list / estimated | 无 | 默认启用 |
| RollingGo 酒店 MCP | api | `data/mcp-servers.json` 配 `alias=rollinggo` 的 http server（填 url + key） | 配置后自动挂载 |
| 浏览器代查·携程机票 | scraped | Playwright（`cd server && npm install playwright && npx playwright install chromium`） | 安装后自动挂载 |

诚实边界：scraped/estimated 价必须向用户转述「以平台实价为准」；解析失败返回空，绝不编造。

## 商家真实下单（收银台链接）

`travel_booking.book` 的 `cashierUrl` 参数（或经 `agent_browser` 在商家站点走完下单流程后从支付页提取）随两阶段确认落库为订单 `paymentUrl`，`booking.travel-pay` 直接取用发起支付宝 AI 支付。携程/飞猪等站点已在 `browser-session-sites` 白名单内，用户授权导入 Cookie 后可带登录态代操作。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `BOOKING_MODE` | `mock` | `live` 时不注册模拟 Provider；travel 域两种模式下均注册（book 只建待支付订单，真实扣款必须经用户钱包授权） |
| `BOOKING_MAX_AMOUNT_CNY` | `1000` | 单笔上限，超限拒绝 |
| `BOOKING_DAILY_BUDGET_CNY` | `500` | 单日累计上限（0=不限） |
| `BOOKING_CONFIRMATION_TTL_MS` | `300000` | 两阶段确认 token TTL |
| `ALIPAY_*`（见 payment-config） | — | 支付宝 AI 支付通道（travel-pay 依赖） |

## 测试

```bash
cd server
node --import tsx --test test/travel-booking-golden-path.test.ts test/booking-travel-provider.test.ts test/booking-service.test.ts test/booking-confirmation.test.ts
```

- `travel-booking-golden-path.test.ts`：多源比价（MCP/浏览器桩）→ 两阶段下单 → 支付/出票推进 → 退改工单全链路
- `booking-travel-provider.test.ts`：Provider 报价/状态机/退改工单边界
- `booking-service.test.ts` / `booking-confirmation.test.ts`：统一编排与安全护栏
