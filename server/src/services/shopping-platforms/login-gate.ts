import type { Page } from "playwright";

/**
 * 购物流程登录门。
 *
 * shared（客户端内置浏览器）与 headless（服务端无头兜底）两条执行路径在导航到
 * 平台页后都先过本门：命中登录页时由调用方截图二维码并推送聊天/依赖浏览器可见性，
 * 然后轮询等待用户扫码登录（URL 离开登录域）后重新落回目标页。
 * 这样「未导入 Cookie / Cookie 过期」不再意味着静默查不到数据。
 */

/** 各平台登录页 URL 启发式（hostname / URL 命中即认为需要登录）。 */
const LOGIN_URL_PATTERNS: Record<string, RegExp[]> = {
  jd: [/passport\.jd\.com/i],
  taobao: [/login\.taobao\.com/i, /login\.tmall\.com/i],
  tmall: [/login\.taobao\.com/i, /login\.tmall\.com/i],
  pdd: [/passport\.(pinduoduo|yangkeduo)\.com/i, /login\.(pinduoduo|yangkeduo)/i],
  meituan: [/passport\.meituan\.com/i, /account\.meituan\.com/i],
  douyin: [/sso\.douyin\.com/i, /passport\.douyin\.com/i],
  damai: [/passport\.damai\.cn/i],
  maoyan: [/passport\.maoyan\.com/i],
  ctrip: [/passport\.ctrip\.com/i, /login\.ctrip/i],
  qunar: [/user\.qunar\.com\/login/i],
  fliggy: [/login\.fliggy\.com/i],
  dianping: [/passport\.dianping\.com/i, /account\.dianping\.com/i],
  alipay: [/authstore\.alipay\.com/i, /login\.alipay/i],
  netease: [/login\.163\.com/i, /id\.163\.com/i],
};

/** 兜底正文关键词（URL 未命中时，正文出现即认为登录页）。 */
const LOGIN_BODY_KEYWORDS = ["扫码登录", "二维码登录", "欢迎登录", "登录后查看"];

/** 扫码登录最长等待（毫秒）。可用 SHOPPING_LOGIN_WAIT_MS 覆盖。 */
export function getLoginWaitMs(): number {
  const v = Number.parseInt(process.env.SHOPPING_LOGIN_WAIT_MS ?? "120000", 10);
  return Number.isFinite(v) && v > 0 ? v : 120_000;
}

export type LoginPageDetection = {
  isLogin: boolean;
  /** 判中依据（审计/提示用） */
  reason?: string;
};

/** 判断当前页面是否为平台登录页（URL 启发式 + 正文关键词兜底）。 */
export async function detectLoginPage(platform: string, page: Page): Promise<LoginPageDetection> {
  const url = page.url();
  const patterns = LOGIN_URL_PATTERNS[platform] ?? [];
  if (patterns.some((re) => re.test(url))) {
    return { isLogin: true, reason: `URL 命中登录页（${url}）` };
  }
  // 通用兜底：host 带 passport./login./signin. 或路径以 /login 开头（只看 host+path，避免误判 query）
  let host = "";
  let path = "";
  try {
    const u = new URL(url);
    host = u.hostname;
    path = u.pathname;
  } catch {
    /* 非 http(s) URL 不做通用判定 */
  }
  if (host && (/^passport\.|^login\.|^signin\.|\.login\./i.test(host) || /^\/login/i.test(path))) {
    return { isLogin: true, reason: `host/path 含登录段（${url}）` };
  }
  try {
    const bodyHead = await page.evaluate(() => (document.body?.innerText ?? "").slice(0, 600));
    const hit = LOGIN_BODY_KEYWORDS.find((kw) => bodyHead.includes(kw));
    if (hit) return { isLogin: true, reason: `正文命中「${hit}」` };
  } catch {
    /* evaluate 失败（页面跳转中/CDP 断开）不影响判定 */
  }
  return { isLogin: false };
}

/**
 * 等待用户扫码登录：轮询检测登录页，成功后重新落回 targetUrl。
 * 调用方需在此之前完成二维码截图/推送（登录页不会自己消失，轮询只看 URL）。
 */
export async function waitForLogin(
  platform: string,
  page: Page,
  targetUrl: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ ok: boolean; error?: string }> {
  const timeoutMs = opts.timeoutMs ?? getLoginWaitMs();
  const intervalMs = opts.intervalMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(intervalMs).catch(() => {});
    const det = await detectLoginPage(platform, page).catch(() => ({ isLogin: false }));
    if (!det.isLogin) {
      // 登录成功后站点通常跳到首页/个人页，重新落回目标页再交给调用方解析
      if (page.url() !== targetUrl) {
        await page
          .goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 15_000 })
          .catch(() => {});
        await page.waitForTimeout(2_000).catch(() => {});
      }
      return { ok: true };
    }
  }
  return { ok: false, error: `等待扫码登录超时（${Math.round(timeoutMs / 1000)}s）` };
}
