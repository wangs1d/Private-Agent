/**
 * 京东查单通道实测脚本（改造版：内置浏览器优先 + 无头兜底 + 扫码登录门）。
 *
 * 验证四段链路（不使用真实账号 Cookie，不产生订单）：
 *   1. 无 Cookie 且无推送通道：应被结构化拒绝（不启动浏览器，指引文案含内置浏览器路径）
 *   2. 占位 Cookie + 无头兜底：门禁放行 → 打开订单页 → 登录门识别登录页
 *      → 二维码截图落盘 → 等待扫码超时（SHOPPING_LOGIN_WAIT_MS 调短）→
 *      结构化返回 loginRequired.imageUrl
 *   3. loginRequired.imageUrl 指向的 PNG 文件真实存在（图片落盘通道可用）
 *   4. pushMediaCards 回调被触发（二维码卡片实时推送通道可用）
 *
 * 运行：cd server && SHOPPING_LOGIN_WAIT_MS=6000 node --import tsx scripts/test-jd-track-channel.ts
 * 数据写入 os.tmpdir 下的临时目录，结束后自动清理。
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempRoot = await mkdtemp(join(tmpdir(), "jd-track-test-"));
process.env.BROWSER_SESSION_DATA_DIR = join(tempRoot, "browser-sessions");
process.env.SHOPPING_LOGIN_WAIT_MS = process.env.SHOPPING_LOGIN_WAIT_MS ?? "6000";

const { BrowserSessionService } = await import("../src/services/browser-session-service.js");
const { ShoppingOrderService } = await import("../src/services/shopping-order-service.js");
const { ImageGenerationService } = await import("../src/services/image-generation-service.js");
const { QrAssistService } = await import("../src/services/qr-assist-service.js");
const { tryAttachToolResultCard } = await import("../src/services/tool-card-registry.js");

const ACTOR = "test-jd-channel-user";
let pushedCards: Array<Record<string, unknown>> = [];
/** 模拟"客户端不在线"：无中途推卡回调 → 无 Cookie 时应被结构化拒绝 */
const ctxOffline = {
  sessionId: "test-jd-channel-session",
  userId: ACTOR,
  agentAccessMode: "full" as const,
};
/** 模拟聊天主路径装配的中途推卡回调（真实环境由 chat-user-message.ts 提供） */
const ctxWithPush = {
  sessionId: "test-jd-channel-session",
  userId: ACTOR,
  agentAccessMode: "full" as const,
  pushMediaCards: (cards: Array<Record<string, unknown>>) => {
    pushedCards.push(...cards);
  },
};

function banner(title: string): void {
  console.log(`\n========== ${title} ==========`);
}

const browserSessionService = new BrowserSessionService();
const imageStore = new ImageGenerationService({ storageRoot: join(tempRoot, "images") });
const service = new ShoppingOrderService({
  browserSessionService,
  imageStore,
});

let failures = 0;

try {
  // ── 1. 无 Cookie 且无推送通道 → 结构化拒绝 ─────────────────────────
  banner("测试 1：无 Cookie + 无交互式登录通道 → 结构化拒绝（不启动浏览器）");
  const noCookie = (await service.trackOrder(ctxOffline, "jd")) as { ok: boolean; error?: string };
  console.log(JSON.stringify(noCookie, null, 2));
  const guardOk = noCookie.ok === false && /未导入 jd 的 Cookie|Cookie/.test(noCookie.error ?? "");
  console.log(guardOk ? "✅ 护栏生效：结构化拒绝且文案包含内置浏览器指引" : "❌ 护栏未按预期拒绝");
  if (!guardOk) failures++;

  // ── 2. 占位 Cookie → 无头兜底 → 登录门识别 + 二维码落盘 + 推送 + 等待超时 ──
  banner("测试 2：占位 Cookie 无头兜底 → 登录门 → 推送二维码卡片 → 等待超时");
  await browserSessionService.importCookies(
    ACTOR,
    "jd",
    [
      { name: "pt_pin", value: "test_dummy_user", domain: ".jd.com", path: "/" },
      { name: "pt_key", value: "AAJgDUMMY_KEY_FOR_CHANNEL_TEST_xxxxxxxx", domain: ".jd.com", path: "/" },
      { name: "thor", value: "DUMMY_THOR_TOKEN", domain: ".jd.com", path: "/" },
    ],
    { agentAllowed: true },
  );

  pushedCards = [];
  const trackStart = Date.now();
  const trackResult = (await service.trackOrder(ctxWithPush, "jd")) as {
    ok: boolean;
    error?: string;
    loginRequired?: { platform: string; imageUrl: string };
  };
  console.log(`耗时 ${((Date.now() - trackStart) / 1000).toFixed(1)}s`);
  console.log(JSON.stringify(trackResult, null, 2));

  const loginGateOk =
    trackResult.ok === false &&
    /等待扫码登录超时/.test(trackResult.error ?? "") &&
    Boolean(trackResult.loginRequired?.imageUrl);
  console.log(
    loginGateOk
      ? "✅ 登录门生效：识别登录页 → 截二维码落盘 → 等待超时返回结构化 loginRequired"
      : "❌ 登录门未按预期工作",
  );
  if (!loginGateOk) failures++;

  // ── 3. 二维码 PNG 真实落盘 ──────────────────────────────────────────
  banner("测试 3：loginRequired.imageUrl 指向的 PNG 真实存在");
  const imageUrl = trackResult.loginRequired?.imageUrl;
  if (imageUrl) {
    const rel = imageUrl.replace("/agent/images/", "");
    const filePath = join(tempRoot, "images", rel);
    const s = await stat(filePath).catch(() => null);
    const pngOk = s != null && s.size > 1000;
    console.log(`imageUrl: ${imageUrl}\n文件: ${filePath}\n大小: ${s?.size ?? 0} bytes`);
    console.log(pngOk ? "✅ 图片落盘通道可用（PNG 真实存在）" : "❌ 图片文件缺失或过小");
    if (!pngOk) failures++;
  } else {
    console.log("❌ 无 imageUrl 可验证");
    failures++;
  }

  // ── 4. pushMediaCards 回调被触发 ────────────────────────────────────
  banner("测试 4：pushMediaCards 回调（二维码卡片实时推送通道）");
  const pushOk =
    pushedCards.length > 0 &&
    pushedCards.some((c) => c.type === "image" && /扫码登录/.test(String(c.title ?? "")));
  console.log("推送的卡片：", JSON.stringify(pushedCards, null, 2));
  console.log(pushOk ? "✅ 中途推卡通道可用" : "❌ 未捕获到二维码卡片推送");
  if (!pushOk) failures++;

  // ── 5. 登录态持久化管线（fake executor 模拟一次已登录的无头执行） ──
  banner("测试 5：登录态捕获 → 加密落库 → 授权只升不降 → getCookiesForAgent 可读");
  const fakeActor = "test-jd-persist-user";
  const sampleCookies = [
    {
      name: "pt_key",
      value: "AAJgPERSIST_SAMPLE",
      domain: ".jd.com",
      path: "/",
      expires: 4102444800,
      httpOnly: true,
      secure: true,
      sameSite: "None",
    },
    { name: "pt_pin", value: "test_persist_user", domain: ".jd.com", path: "/", expires: 4102444800 },
  ];
  const fakePage = {
    url: () => "https://order.jd.com/center/list.action",
    evaluate: async () => "",
    waitForTimeout: async () => {},
    waitForSelector: async () => null,
    // 注意：Playwright 的 page.context() 是同步方法（返回 BrowserContext 而非 Promise）
    context: () => ({ cookies: async () => sampleCookies }),
  };
  const fakeExecutor = {
    acquirePage: async () => ({
      page: fakePage,
      mode: "headless",
      release: async () => {},
    }),
    canUseSharedBrowser: () => false,
    tryOpenSharedPage: async () => null,
  };
  const persistService = new ShoppingOrderService({
    browserSessionService,
    imageStore,
    browserExecutor: fakeExecutor as never,
  });
  try {
    const r5 = (await persistService.trackOrder(
      { sessionId: "test-persist-session", userId: fakeActor, agentAccessMode: "full" },
      "jd",
    )) as { ok: boolean; summary?: string };
    console.log("trackOrder 结果：", JSON.stringify(r5, null, 2));

    // 捕获 fired：行已落库（headless_refresh 语义：无授权时不得静默升权）
    let jdRow = (await browserSessionService.listStatuses(fakeActor)).find(
      (s) => s.siteId === "jd",
    );
    console.log("存储状态：", JSON.stringify(jdRow, null, 2));
    const capturedOk = jdRow?.hasCookies === true && (jdRow?.cookieCount ?? 0) >= 2;
    console.log(capturedOk ? "✅ Cookie 捕获落库成功" : "❌ Cookie 未捕获落库");
    if (!capturedOk) failures++;

    // 未授权时不可读（门禁仍有效）
    const denied = await browserSessionService.getCookiesForAgent(fakeActor, "jd").catch((e) => {
      return { __denied: String(e instanceof Error ? e.message : e) };
    });
    const gateKept =
      !Array.isArray(denied) || denied.every((c) => (c as { name?: string }).name !== "pt_key");
    console.log(
      gateKept ? "✅ 未授权时 Cookie 门禁仍拦截" : "❌ 未授权却被读到了 Cookie",
    );
    if (!gateKept) failures++;

    // 授权后即可读（等价于扫码授权后的状态）
    await browserSessionService.setAgentAllowed(fakeActor, "jd", true);
    const readable = await browserSessionService.getCookiesForAgent(fakeActor, "jd");
    const readableOk = readable.some((c) => c.name === "pt_key");
    console.log(`授权后可读 Cookie 数：${readable.length}`);
    console.log(readableOk ? "✅ 授权后一次登录长期可用" : "❌ 授权后仍读不到");
    if (!readableOk) failures++;
  } finally {
    await persistService.dispose().catch(() => {});
  }

  // ── 6. 通用二维码推送（QrAssistService）+ 支付确认按钮卡 ────────────
  banner("测试 6：通用推卡（dataURL→落盘→聊天卡片）+ 支付确认按钮卡 marker");
  try {
    const qrAssist = new QrAssistService({ imageStore });
    const tinyPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    const before = pushedCards.length;
    const qrUrl = await qrAssist.pushQrImage(
      ctxWithPush,
      { title: "测试：请扫码", caption: "通道验证" },
      { dataUrl: `data:image/png;base64,${tinyPng.toString("base64")}` },
    );
    const qrSaved = qrUrl != null && (await stat(join(tempRoot, "images", qrUrl.replace("/agent/images/", ""))).then((s) => s.size > 0).catch(() => false));
    const qrPushed = pushedCards.length === before + 1 && pushedCards[pushedCards.length - 1].title === "测试：请扫码";
    console.log(`qrUrl: ${qrUrl}\n落盘: ${qrSaved ? "✅" : "❌"}  推卡: ${qrPushed ? "✅" : "❌"}`);

    const payMarker = tryAttachToolResultCard(
      "已在内置浏览器打开收银台",
      "shopping.pay.submit",
      { ok: true, orderId: "so_channel_test", platform: "jd", amountCny: 42.5, itemTitle: "通道测试商品" },
    );
    const markerOk =
      payMarker != null &&
      payMarker.includes("[AGENT_RESULT_CARD_START]") &&
      payMarker.includes("shopping_pay_done") &&
      payMarker.includes("我已完成支付");
    console.log(`支付确认按钮卡 marker: ${markerOk ? "✅" : "❌"}`);
    if (markerOk && payMarker) {
      console.log(payMarker.split("\n").slice(0, 6).join("\n").slice(0, 500));
    }
    if (qrSaved && qrPushed && markerOk) {
      console.log("✅ 通用推卡 + 支付确认按钮卡全链路可用");
    } else {
      failures++;
    }
  } catch (err) {
    failures++;
    console.error("❌ 测试 6 异常：", err instanceof Error ? err.stack : err);
  }
} catch (err) {
  failures++;
  console.error("\n❌ 脚本异常：", err instanceof Error ? err.stack : err);
} finally {
  await service.dispose().catch(() => {});
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

console.log(
  failures === 0
    ? "\n===== 结论：通道 + 登录门 + 二维码推送 + 登录态持久化 + 通用推卡/支付确认卡 全链路可用 ====="
    : `\n===== 结论：${failures} 项失败 =====`,
);
process.exit(failures === 0 ? 0 : 1);
