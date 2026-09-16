import type { Browser, Page } from "playwright";

/**
 * 共用浏览器可信输入网关（CDP 桥）。
 *
 * 客户端开启 WebView2 remote-debugging-port 并经 browser.bridge.info 上报
 * 端点后，本网关用 Playwright connectOverCDP 直连**用户正在看的那个浏览器**，
 * 派发 isTrusted=true 的真实输入事件（带轨迹），过注入式点击（合成事件）
 * 过不了的风控。DOM 感知仍走注入运行时——"注入读 + CDP 写"分工。
 *
 * 安全约束（缺一不用）：
 *   - 端口只绑 127.0.0.1（客户端保证）
 *   - 由用户在客户端显式开启（SharedBrowserHost.remoteDebugPort，默认关闭）
 *   - 服务端总开关 SHARED_BROWSER_CDP_ENABLED=1（部署方控制），默认关闭
 *   - 客户端断连即清端点（coordinator.unbindIfSocket）
 *
 * 已知限制：服务端与客户端须同机或可达客户端 localhost（私有化部署通常满足；
 * 远程部署时 CDP 端口不可达，工具层自动回退注入路径）。
 */
export class SharedBrowserCdpGateway {
  private browser?: Browser;
  private endpoint = "";
  private connecting?: Promise<boolean>;

  constructor(
    private readonly enabled: boolean =
      process.env.SHARED_BROWSER_CDP_ENABLED === "1",
  ) {}

  /** 服务端总开关是否打开（未打开时 trusted 工具直接回退注入路径）。 */
  get available(): boolean {
    return this.enabled;
  }

  /** 连接/重连客户端上报的 CDP 端点。失败返回 false（不抛错）。 */
  async connect(endpoint: string): Promise<boolean> {
    if (!this.enabled || !endpoint) return false;
    if (this.browser && this.endpoint === endpoint && this.browser.isConnected()) {
      return true;
    }
    this.connecting ??= this._connect(endpoint).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async _connect(endpoint: string): Promise<boolean> {
    try {
      await this.close();
      const { chromium } = await import("playwright");
      this.browser = await chromium.connectOverCDP(endpoint, { timeout: 5000 });
      this.endpoint = endpoint;
      return true;
    } catch {
      this.browser = undefined;
      this.endpoint = "";
      return false;
    }
  }

  /** 取最近活动的页面（无页面返回 null）。 */
  private async activePage(): Promise<Page | null> {
    const browser = this.browser;
    if (!browser || !browser.isConnected()) return null;
    const contexts = browser.contexts();
    if (contexts.length === 0) return null;
    const pages = contexts.flatMap((c) => c.pages());
    if (pages.length === 0) return null;
    return pages[pages.length - 1];
  }

  /** 可信点击（Playwright 定位引擎 + 真实输入事件）。 */
  async click(opts: {
    text?: string;
    selector?: string;
    timeoutMs?: number;
  }): Promise<{ ok: boolean; error?: string }> {
    const page = await this.activePage();
    if (!page) return { ok: false, error: "CDP 桥未连接或无活动页面" };
    const timeout = opts.timeoutMs ?? 8000;
    try {
      const locator = opts.text
        ? page.getByText(opts.text, { exact: false }).first()
        : opts.selector
          ? page.locator(opts.selector).first()
          : null;
      if (!locator) return { ok: false, error: "缺少 text/selector" };
      await locator.click({ timeout });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `可信点击失败：${String(e).slice(0, 200)}` };
    }
  }

  /** 可信输入（真实键盘事件；对受控组件/风控表单更友好）。 */
  async type(opts: {
    text: string;
    selector?: string;
    submit?: boolean;
    timeoutMs?: number;
  }): Promise<{ ok: boolean; error?: string }> {
    const page = await this.activePage();
    if (!page) return { ok: false, error: "CDP 桥未连接或无活动页面" };
    const timeout = opts.timeoutMs ?? 8000;
    try {
      const locator = opts.selector
        ? page.locator(opts.selector).first()
        : page.locator("input:visible, textarea:visible").first();
      await locator.click({ timeout });
      await locator.fill(opts.text, { timeout });
      if (opts.submit) await locator.press("Enter", { timeout });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `可信输入失败：${String(e).slice(0, 200)}` };
    }
  }

  async close(): Promise<void> {
    try {
      if (this.browser?.isConnected()) await this.browser.close();
    } catch {
      // ignore
    }
    this.browser = undefined;
    this.endpoint = "";
  }
}
