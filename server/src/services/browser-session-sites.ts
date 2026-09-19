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
  tmall: {
    label: "天猫",
    hosts: ["tmall.com", "www.tmall.com", "m.tmall.com"],
    homeUrl: "https://www.tmall.com",
  },
  pdd: {
    label: "拼多多",
    hosts: ["pinduoduo.com", "www.pinduoduo.com", "m.pinduoduo.com", "yangkeduo.com"],
    homeUrl: "https://www.pinduoduo.com",
  },
  meituan: {
    label: "美团",
    hosts: ["meituan.com", "www.meituan.com", "h5.waimai.meituan.com", "i.waimai.meituan.com"],
    homeUrl: "https://www.meituan.com",
  },
  dianping: {
    label: "大众点评",
    hosts: ["dianping.com", "www.dianping.com", "m.dianping.com"],
    homeUrl: "https://www.dianping.com",
  },
  douyin: {
    label: "抖音商城",
    hosts: ["douyin.com", "www.douyin.com", "haohuo.jinritemai.com"],
    homeUrl: "https://www.douyin.com",
  },
  damai: {
    label: "大麦",
    hosts: ["damai.com", "www.damai.com", "search.damai.cn", "detail.damai.cn"],
    homeUrl: "https://www.damai.com",
  },
  maoyan: {
    label: "猫眼演出",
    hosts: ["maoyan.com", "www.maoyan.com"],
    homeUrl: "https://www.maoyan.com",
  },
  // ── 2026-09-18 新增两类非购物用途的站点 ──
  alipay: {
    // 财务后台自动拉账：用用户登录态查交易明细（Cookie 双门禁同购物站点）
    label: "支付宝",
    hosts: ["alipay.com", "www.alipay.com", "consumeprod.alipay.com", "mbillexprod.alipay.com"],
    homeUrl: "https://www.alipay.com",
  },
  netease: {
    // 媒体音乐登录音源：带 MUSIC_U Cookie 解析 VIP/版权曲目的可播放 URL
    label: "网易云音乐",
    hosts: ["music.163.com"],
    homeUrl: "https://music.163.com",
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
