/** 支持 Cookie 导入与 Agent 读价的站点（用户须在客户端授权 agentAllowed）。 */
export const BROWSER_SESSION_SITES = {
  ctrip: {
    label: "携程",
    hosts: ["ctrip.com", "www.ctrip.com", "m.ctrip.com"],
    homeUrl: "https://www.ctrip.com",
  },
  taobao: {
    label: "淘宝",
    hosts: ["taobao.com", "www.taobao.com", "m.taobao.com"],
    homeUrl: "https://www.taobao.com",
  },
  jd: {
    label: "京东",
    hosts: ["jd.com", "www.jd.com", "m.jd.com"],
    homeUrl: "https://www.jd.com",
  },
  qunar: {
    label: "去哪儿",
    hosts: ["qunar.com", "www.qunar.com", "m.qunar.com"],
    homeUrl: "https://www.qunar.com",
  },
  fliggy: {
    label: "飞猪",
    hosts: ["fliggy.com", "www.fliggy.com", "m.fliggy.com"],
    homeUrl: "https://www.fliggy.com",
  },
} as const;

export type BrowserSessionSiteId = keyof typeof BROWSER_SESSION_SITES;

export function isBrowserSessionSiteId(id: string): id is BrowserSessionSiteId {
  return id in BROWSER_SESSION_SITES;
}

export function hostMatchesSite(host: string, siteId: BrowserSessionSiteId): boolean {
  const h = host.toLowerCase().replace(/^\.+/, "");
  return BROWSER_SESSION_SITES[siteId].hosts.some(
    (allowed) => h === allowed || h.endsWith(`.${allowed}`),
  );
}

export function resolveSiteIdFromUrl(url: string): BrowserSessionSiteId | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const id of Object.keys(BROWSER_SESSION_SITES) as BrowserSessionSiteId[]) {
      if (hostMatchesSite(host, id)) return id;
    }
  } catch {
    /* ignore */
  }
  return null;
}
