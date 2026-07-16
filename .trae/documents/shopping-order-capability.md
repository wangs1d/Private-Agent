# 购物/下单能力（后台无头浏览器路线）

## 摘要

新增 `shopping_order` 能力域，让 Agent 在**服务端后台启动 Playwright 无头浏览器**，注入用户预先导入并授权的 Cookie，直接在后台完成搜索商品 / 加入购物车 / 提交订单 / 查询订单 / 取消订单等操作，把结果（订单摘要、价格、截图）呈现给用户。

**核心定位**：既不调平台开放 API（如美团跑腿那种），也不操控用户电脑上的真实软件（`desktop.visual.run_task`），而是**服务端自己开一个虚拟浏览器**，用用户的登录态在后台完成下单。兼容所有支持 Cookie 登录的购物软件（淘宝/京东/天猫/拼多多/抖音/美团/点评等）。

**基础设施复用**：项目已有完整的浏览器 Cookie 会话管理（加密存储 + per-site 授权 + Playwright 抓页），见 [browser-session-service.ts](file:///e:\ws-project\Private-Agent\server\src\services\browser-session-service.ts) 与 [browser-page-fetch.ts](file:///e:\ws-project\Private-Agent\server\src\services\browser-page-fetch.ts)。Playwright `^1.60.0` 已是 server 的依赖。本期把「只读抓页」扩展为「多步操作 + 下单」。

## 当前状态分析

### 已有基础设施（直接复用）

| 设施 | 文件 | 复用点 |
|---|---|---|
| Cookie 加密存储 | [browser-session-crypto.ts](file:///e:\ws-project\Private-Agent\server\src\services\browser-session-crypto.ts) | AES-256-GCM，`encryptJson` / `decryptJson` |
| Cookie 会话服务 | [browser-session-service.ts](file:///e:\ws-project\Private-Agent\server\src\services\browser-session-service.ts) | `importCookies` / `setAgentAllowed` / `getCookiesForAgent`（双重门禁：有 Cookie 且 `agentAllowed===true`） |
| 站点白名单 | [browser-session-sites.ts](file:///e:\ws-project\Private-Agent\server\src\services\browser-session-sites.ts) | 已有 5 站点（ctrip/taobao/jd/qunar/fliggy），**需扩展** |
| Playwright 抓页 | [browser-page-fetch.ts](file:///e:\ws-project\Private-Agent\server\src\services\browser-page-fetch.ts) | `playwrightFetch` 已实现 launch→newContext→addCookies→goto→evaluate，**需扩展为多步操作** |
| Cookie 导入路由 | [browser-sessions.ts](file:///e:\ws-project\Private-Agent\server\src\routes\http\browser-sessions.ts) | 用户在客户端 POST `/integrations/browser-sessions/import` + `/consent` |
| 模块化注册 | [capability-modules/index.ts](file:///e:\ws-project\Private-Agent\server\src\tools\capability-modules\index.ts) | 四文件 + `buildCapabilityModules` 自动合并 |

### 现有相关能力（边界区分）

| 现有能力 | 行为 | 与新能力关系 |
|---|---|---| 
| `browser.fetch_page` | Playwright 抓页读价，**明文禁止下单**（[browser-session-chat-tools.ts:20](file:///e:\ws-project\Private-Agent\server\src\tools\browser-session-chat-tools.ts)） | 新能力突破此边界，加确认机制后允许下单 |
| `shopping.suggest` | 仅比价建议 | 互补 |
| `wallet.purchase` | 纯内存记账，不调外部 API | 互补：真实下单后调它记账 |
| `desktop.visual.run_task` | 操控用户电脑真实软件 | 不同路线：本能力在服务端无头浏览器，不碰用户电脑 |
| `meituan.create_order` | 调美团开放 API | 不同路线：本能力走浏览器，不依赖平台开放 API |

### task-router 影响

[task-router.ts:18-35](file:///e:\ws-project\Private-Agent\server\src\agent\task-router.ts) 的 `DELEGATE_KEYWORDS` 已含 `/下单|支付|购物|网购|买.*东西/`，会路由到 `master_delegate` 由 life 子 agent 处理。本计划**接受现状**，life 子 agent 调用新 `shopping.order.*` 工具。

## 设计决策

### D1. 后台无头浏览器路线（核心）
`ShoppingOrderService` 内部启动 Playwright `chromium.launch({ headless: true })`，用 `browserSessionService.getCookiesForAgent(actorId, siteId)` 拿到用户解密 Cookie，`context.addCookies()` 注入，然后在后台驱动浏览器多步操作完成下单。整个过程对用户透明，用户只看到最终结果。

### D2. 平台 Adapter 模式（架构）
照搬 [social-outreach-service.ts](file:///e:\ws-project\Private-Agent\server\src\services\social-outreach-service.ts) 的 `SocialPlatformAdapter` 模式。定义 `ShoppingPlatformAdapter` 接口，每平台一个 adapter 文件，封装该平台的搜索 URL、商品卡片选择器、加购/结算按钮选择器。`ShoppingOrderService` 持有 `Map<platform, Adapter>`，统一调度。

MVP 阶段先实现 3 个高频平台 adapter（taobao/jd/meituan），其余平台返回"暂不支持，请用 desktop.visual.run_task"。

### D3. 两阶段确认（安全核心）
`shopping.order.place` 必须两阶段：
- **阶段一**（`confirm=false` 或缺省）：Playwright 走到结算页（**不点最终提交订单按钮**）→ 截图 + 读取订单摘要（商品名/数量/单价/总价/收货地址）→ 生成 5 分钟 TTL 的 `confirmationToken` → 返回 `{ needsConfirmation: true, confirmationToken, summary, screenshotBase64 }`。LLM 向用户复述摘要。
- **阶段二**（`confirm=true` + `confirmationToken`）：service 校验 token 有效 → 重新启动浏览器注入 Cookie → 重新走到结算页（或复用 stage 1 的 page，若仍存活）→ 点击提交订单按钮 → 读取订单号 → 返回最终结果。

### D4. 安全护栏
1. **复用 browser-session 双重门禁**：必须先导入 Cookie 且 `agentAllowed===true`，否则拒绝
2. **强制 `agentAccessMode === "full"`**：沙箱模式拒绝（与 `desktop.visual.run_task` 一致）
3. **平台白名单**：`ShoppingPlatformAdapter` 注册时声明支持的 platform 名，未知 platform 拒绝
4. **金额上限**：`SHOPPING_ORDER_MAX_AMOUNT_CNY` 环境变量（默认 5000），结算页总价超阈值拒绝提交
5. **确认 token 5 分钟过期**：内存 Map，进程重启丢失（可接受）
6. **审计日志**：每次 search/place/track/cancel 落 `AuditService`（参照 `desktop.run_shell` 模式）
7. **禁止自动支付**：阶段二只点"提交订单"按钮，不点"立即支付"按钮（若平台流程是提交后弹支付页），把支付环节留给用户在客户端完成

### D5. 与现有 `browser.fetch_page` 的关系
不修改 `browser.fetch_page`（它仍只读抓价）。新能力是独立工具族 `shopping.order.*`，复用底层 Cookie 基础设施但走独立的 Playwright 编排逻辑。

## 提议变更

### 变更 1：扩展 `server/src/services/browser-session-sites.ts`

在 `BROWSER_SESSION_SITES` 对象追加 5 个站点（现有 5 个 + 新增 5 个 = 10 个）：

```ts
tmall: { label: "天猫", hosts: ["tmall.com","www.tmall.com","m.tmall.com"], homeUrl: "https://www.tmall.com" },
pdd: { label: "拼多多", hosts: ["pinduoduo.com","www.pinduoduo.com","m.pinduoduo.com","yangkeduo.com"], homeUrl: "https://www.pinduoduo.com" },
meituan: { label: "美团", hosts: ["meituan.com","www.meituan.com","h5.waimai.meituan.com","i.waimai.meituan.com"], homeUrl: "https://www.meituan.com" },
dianping: { label: "大众点评", hosts: ["dianping.com","www.dianping.com","m.dianping.com"], homeUrl: "https://www.dianping.com" },
douyin: { label: "抖音商城", hosts: ["douyin.com","www.douyin.com","haohuo.jinritemai.com"], homeUrl: "https://www.douyin.com" },
```

### 变更 2：新建 `server/src/services/shopping-platforms/` 目录（平台 Adapter）

#### 2a. `types.ts` — 接口定义
```ts
export interface ShoppingPlatformAdapter {
  platform: string;                                          // taobao/jd/meituan/...
  searchUrl(query: string, filters?: SearchFilters): string; // 直达搜索 URL
  orderListUrl(): string;                                    // 订单列表页 URL
  /** 在已打开搜索页的 Playwright Page 上读取商品列表 */
  extractProducts(page: Page, limit: number): Promise<ProductSummary[]>;
  /** 走到结算页（不点提交），返回订单摘要 + 截图 */
  navigateToCheckout(page: Page, product: ProductSummary, quantity: number): Promise<CheckoutSnapshot>;
  /** 点击提交订单按钮，返回订单号 */
  submitOrder(page: Page): Promise<{ orderId: string }>;
  /** 在订单列表页读取订单状态 */
  readOrderStatus(page: Page, orderId?: string): Promise<OrderStatus[]>;
  /** 取消指定订单 */
  cancelOrder(page: Page, orderId: string): Promise<void>;
}
```

#### 2b. `taobao-adapter.ts` / `jd-adapter.ts` / `meituan-adapter.ts`
每个 adapter 实现上述接口，封装平台特定的 URL 模板与 Playwright 选择器。例：
- `taobao.searchUrl("iPhone 15")` → `https://s.taobao.com/search?q=iPhone%2015`
- `taobao.extractProducts(page, 5)` → `page.$$('.Card--doubleCardWrapper...')` 读取标题/价格/链接
- `taobao.navigateToCheckout` → 点商品 → 点"立即购买" → 等结算页加载 → 截图 + 读取 `.orderPrice` / `.addressInfo`
- `taobao.submitOrder` → 点 `.go-btn`（提交订单按钮）

选择器会随平台改版失效，adapter 内加 try/catch + 多组选择器兜底，失败时返回 `{ ok: false, error: "页面结构变更，请更新 adapter", retryable: false }`。

#### 2c. `index.ts` — adapter 注册表
```ts
export const SHOPPING_PLATFORM_ADAPTERS: Record<string, ShoppingPlatformAdapter> = {
  taobao: new TaobaoAdapter(),
  tmall: new TmallAdapter(),   // 复用 taobao 逻辑
  jd: new JdAdapter(),
  meituan: new MeituanAdapter(),
};
export function getAdapter(platform: string): ShoppingPlatformAdapter | null { ... }
```

### 变更 3：新建 `server/src/services/shopping-order-service.ts`

`ShoppingOrderService` 类，编排层：
- **构造依赖**：`browserSessionService: BrowserSessionService`、`audit?: AuditService`
- **状态**：`private pendingConfirmations = new Map<token, PendingConfirmation>()`（5 分钟 TTL），`private activePages = new Map<token, Page>()`（阶段一存活的 Playwright Page，阶段二复用）
- **方法**：
  - `async searchProduct(ctx, platform, query, filters): Promise<Result>` — 取 Cookie → 启动 Playwright → `adapter.searchUrl` → `page.goto` → `adapter.extractProducts` → 关浏览器 → 审计 → 返回商品列表
  - `async placeOrder(ctx, platform, item, quantity, confirm, token): Promise<Result>` — 两阶段确认编排：
    - `confirm=false`：取 Cookie → 启动 Playwright → `adapter.navigateToCheckout` → 截图 + 读摘要 → 生成 token + 存 Page → 返回 `{ needsConfirmation, token, summary, screenshotBase64 }`
    - `confirm=true`：校验 token → 取存活 Page（或重建）→ `adapter.submitOrder` → 读订单号 → 关浏览器 → 审计 → 返回 `{ ok, orderId, ... }`
  - `async trackOrder(ctx, platform, orderId?): Promise<Result>` — 取 Cookie → 启动 Playwright → `adapter.orderListUrl` → `adapter.readOrderStatus` → 关浏览器 → 审计
  - `async cancelOrder(ctx, platform, orderId, confirm, token): Promise<Result>` — 两阶段确认（同 place 模式）
  - **金额校验**：`placeOrder` 阶段一读到总价后调 `isAmountAllowed(priceCny)`，超阈值拒绝
  - **Playwright 生命周期**：每个方法 try/finally 确保浏览器关闭；阶段一的 Page 在 token 过期时主动 close
- **配置**：`SHOPPING_ORDER_MAX_AMOUNT_CNY`（默认 5000）、`SHOPPING_ORDER_CONFIRMATION_TTL_MS`（默认 300_000）

### 变更 4：新建 `server/src/tools/capability-modules/shopping-order/` 目录（4 文件）

#### 4a. `chat-tools.ts`
导出 `SHOPPING_ORDER_CHAT_TOOLS: ChatCompletionTool[]`：

| 工具名 | 参数 | 行为 |
|---|---|---|
| `shopping.order.search` | `platform`(enum: taobao/tmall/jd/meituan/dianping/pdd/douyin), `query`(string), `filters?`(object: maxPrice/sort/limit 默认5) | 后台浏览器搜索，返回商品列表（名称/价格/链接） |
| `shopping.order.place` | `platform`, `item`(string 商品描述或 URL), `quantity?`(int 默认1), `confirm`(bool 默认false), `confirmationToken?`(string) | 两阶段确认。`confirm=false` 走到结算页返回确认摘要+token+截图；`confirm=true`+token 完成提交订单 |
| `shopping.order.track` | `platform`, `orderId?`(string) | 后台浏览器打开订单页，返回订单状态/物流 |
| `shopping.order.cancel` | `platform`, `orderId`(string), `confirm`(bool), `confirmationToken?`(string) | 两阶段确认取消订单 |

每个工具 `description` 须明确：① 后台无头浏览器操作，用户须先导入 Cookie 并授权 ② 须「完全访问」 ③ 与 `browser.fetch_page`（只读）/ `shopping.suggest`（建议）/ `wallet.purchase`（记账）区别 ④ place/cancel 两阶段确认 ⑤ 金额上限。

#### 4b. `handlers.ts`
- 定义 `ShoppingOrderModuleDeps = { shoppingOrderService: ShoppingOrderService }`
- 4 个 handler 工厂：`createShoppingSearchHandler` / `createShoppingPlaceHandler` / `createShoppingTrackHandler` / `createShoppingCancelHandler`
- 每个 handler 先检查 `context.agentAccessMode === "full"`，否则返回 `{ ok: false, error: sandboxDeniedToolMessage(...) }`
- 统一返回 `{ ok: true, ..., summary }` / `{ ok: false, error, retryable? }`
- `registerShoppingOrderTools(registry, deps)` 注册 4 个工具

#### 4c. `intent.ts`
导出 `SHOPPING_ORDER_INTENT_RULES` + `SHOPPING_ORDER_CATEGORY_MAPPING`：
- `prefix: "shopping.order."` 覆盖整族
- **aliases**：下单/购买/买东西/在淘宝下单/在京东买/美团点外卖/帮我买/place order/buy now/add to cart/checkout
- **negativeAliases**（避免冲突）：建议/推荐/比价/suggest/recommend/wallet/余额/记账/记录消费/读价/fetch_page
- **examples**：在淘宝帮我买个 iPhone 15 / 帮我在京东下单卫生纸 / 在美团点一份肯德基
- **negativeExamples**：帮我推荐买什么手机（→ shopping.suggest）/ 记一下这笔消费（→ wallet.purchase）/ 帮我读一下淘宝这个商品价格（→ browser.fetch_page）
- `CATEGORY_MAPPING.keywords`：购物/下单/购买/买东西/淘宝/京东/天猫/美团/拼多多/抖音/点评/shopping/order/buy/cart/checkout

#### 4d. `index.ts`
export `SHOPPING_ORDER_CHAT_TOOLS` / `SHOPPING_ORDER_INTENT_RULES` / `SHOPPING_ORDER_CATEGORY_MAPPING` / `registerShoppingOrderTools`（参照 image-gen 简单风格）。

### 变更 5：改 `server/src/tools/capability-modules/index.ts`

1. 顶部 import（`:64-69` 后追加）：
   ```ts
   import { SHOPPING_ORDER_CHAT_TOOLS, SHOPPING_ORDER_INTENT_RULES, SHOPPING_ORDER_CATEGORY_MAPPING, registerShoppingOrderTools } from "./shopping-order/index.js";
   import type { ShoppingOrderService } from "../../services/shopping-order-service.js";
   ```
2. `CapabilityModuleDeps` 接口（`:102-113`）加 `shoppingOrderService: ShoppingOrderService;`
3. `buildCapabilityModules` 数组（code_sandbox 后）追加：
   ```ts
   {
     domain: "shopping_order",
     label: "购物/下单（后台无头浏览器代用户下单）",
     chatTools: SHOPPING_ORDER_CHAT_TOOLS,
     intentRules: SHOPPING_ORDER_INTENT_RULES,
     register: (registry) => registerShoppingOrderTools(registry, { shoppingOrderService: deps.shoppingOrderService }),
     category: SHOPPING_ORDER_CATEGORY_MAPPING,
   },
   ```

### 变更 6：改 `server/src/agent/agent-capabilities.ts`

1. `CAPABILITY_DOMAINS`（`:7-36`）末尾加 `"shopping_order"`
2. `DOMAIN_LABELS`（`:39-69`）加 `shopping_order: "购物/下单（后台无头浏览器代用户下单）"`
3. `buildStaticSections()`（code_sandbox section 后）追加：
   ```ts
   {
     domain: "shopping_order",
     lines: [
       "🛒 购物/下单（服务端后台无头浏览器代用户真实下单）：",
       "   - shopping.order.search（搜索商品）：后台 Playwright 打开平台搜索页，读取商品列表（名称/价格/链接）",
       "   - shopping.order.place（下单）：两阶段确认。confirm=false 走到结算页返回订单摘要+确认 token+截图；confirm=true+token 完成提交订单",
       "   - shopping.order.track（查订单）：后台浏览器打开订单页读取状态/物流",
       "   - shopping.order.cancel（取消订单）：两阶段确认取消",
       "   - 平台：taobao/tmall/jd/meituan/dianping/pdd/douyin",
       "   - 前置条件：用户须先导入平台 Cookie 并授权 agentAllowed（POST /integrations/browser-sessions/import + /consent）",
       "   - 须「完全访问」；金额上限 SHOPPING_ORDER_MAX_AMOUNT_CNY（默认 5000）",
       "   - 与 browser.fetch_page（只读读价）/ shopping.suggest（仅建议）/ wallet.purchase（仅记账）区别：本工具真实提交订单",
       "   - 下单前必须先返回确认摘要让用户确认，得到用户明确同意后再带 confirm=true+token 执行",
     ],
   },
   ```

### 变更 7：改 `server/src/bootstrap/create-app-services.ts`

1. 顶部 import `ShoppingOrderService`
2. 在 `browserSessionService` 实例化后（`:212` 附近）追加：
   ```ts
   const shoppingOrderService = new ShoppingOrderService({
     browserSessionService,
     audit: auditService,
   });
   ```
3. `capabilityModuleDeps` 对象（`:504-514`）加 `shoppingOrderService`

### 变更 8：改 `server/src/external-model/openai-compatible-tool-loop.ts`

1. `resolveToolExecutionTimeoutMs`（`:112-154`）加超时（Playwright 多步操作耗时）：
   ```ts
   if (registryToolName === "shopping.order.search") return 90_000;    // 90 秒
   if (registryToolName === "shopping.order.place") return 180_000;    // 3 分钟
   if (registryToolName === "shopping.order.track") return 60_000;     // 60 秒
   if (registryToolName === "shopping.order.cancel") return 90_000;    // 90 秒
   ```
2. `TOOL_RESULT_PRESET_MAX_CHARS`（`:62-79`）加输出预算：
   ```ts
   "shopping.order.search": 1500,
   "shopping.order.place": 1000,
   "shopping.order.track": 1000,
   "shopping.order.cancel": 800,
   ```

### 不需要改的文件（自动合并）
- `tool-search/intent-metadata.ts`、`tool-search/core-tool-library.ts`、`getBuiltinAgentChatTools`、`TOOL_CATEGORY_MAPPINGS`、`task-router.ts`、Flutter 客户端

## 假设与决策

1. **假设**：用户已通过 `/integrations/browser-sessions/import` 导入目标平台 Cookie 并 `/consent` 授权 `agentAllowed=true`，否则工具返回错误提示用户先导入
2. **假设**：服务端已执行 `npx playwright install chromium`（Playwright 已是依赖，但浏览器二进制需单独装）
3. **假设**：目标平台的 Cookie 未过期（若过期，工具返回"登录态失效，请重新导入 Cookie"）
4. **决策**：MVP 先实现 3 个高频平台 adapter（taobao/jd/meituan），其余平台（tmall/dianping/pdd/douyin）在 chat-tools 的 `platform` enum 里列出但调用时返回"暂不支持，请用 desktop.visual.run_task"
5. **决策**：阶段一存活 Page 在 token 过期时主动 close，避免内存泄漏；阶段二优先复用存活 Page，若已 close 则重建并重新走到结算页
6. **决策**：不自动完成支付——阶段二只点"提交订单"按钮，若平台流程要求支付密码/二次验证，返回"订单已提交，请在客户端完成支付"
7. **决策**：金额上限默认 5000 元，可通过 `SHOPPING_ORDER_MAX_AMOUNT_CNY` 环境变量调整
8. **决策**：确认 token 5 分钟过期，存内存 Map（进程重启丢失，可接受）
9. **决策**：adapter 选择器失效时返回明确错误，不引入 VLM 视觉兜底（后续增强项）

## 验证步骤

1. **TypeScript 编译**：`cd server && npx tsc --noEmit`，预期 0 新增错误
2. **Playwright 安装检查**：`npx playwright install chromium` 已执行
3. **启动检查**：启动 server，日志确认 `shopping_order` 模块注册成功，4 个工具出现在 `getBuiltinAgentChatTools()` 输出
4. **Cookie 缺失拒绝**：未导入淘宝 Cookie 时调 `shopping.order.search({platform:"taobao",query:"test"})`，返回"未导入淘宝 Cookie"错误
5. **授权缺失拒绝**：导入 Cookie 但未 `/consent` 时，返回"用户未授权 Agent 操作淘宝"错误
6. **沙箱拒绝**：未开启"完全访问"时调用，返回沙箱拒绝提示
7. **平台白名单**：调用 `shopping.order.search({platform:"unknown",...})`，返回平台不支持错误
8. **搜索端到端**（需真实淘宝 Cookie）：用户说"帮我在淘宝搜 iPhone 15"，返回 5 条商品列表（名称/价格）
9. **两阶段确认**：调 `shopping.order.place({confirm:false,...})`，返回 `needsConfirmation:true` + token + 摘要 + 截图；带 `confirm:true` + token 再调，提交订单成功返回 orderId
10. **金额上限**：结算页总价超过 `SHOPPING_ORDER_MAX_AMOUNT_CNY` 时拒绝提交
11. **查订单端到端**：调 `shopping.order.track({platform:"taobao"})`，返回最近订单状态
12. **边界区分**：用户说"帮我推荐买什么手机"应走 `shopping.suggest` 而非 `shopping.order.*`（验证 negativeAliases）
13. **token 过期**：阶段一后等 5 分钟再带 token 调阶段二，返回"确认已过期，请重新下单"
