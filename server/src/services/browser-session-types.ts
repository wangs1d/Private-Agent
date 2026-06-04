import type { BrowserSessionSiteId } from "./browser-session-sites.js";

/** 与 Chrome 扩展 / EditThisCookie 等导出的 JSON 数组兼容。 */
export type ImportedBrowserCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None" | string;
};

export type PersistedBrowserSiteSession = {
  siteId: BrowserSessionSiteId;
  label: string;
  cookiesEnc: string;
  importedAt: string;
  updatedAt: string;
  /** 用户是否允许 Agent 使用此站登录态读价（默认 false） */
  agentAllowed: boolean;
  cookieCount: number;
};

export type ActorBrowserSessionsFile = {
  actorId: string;
  sites: Record<string, PersistedBrowserSiteSession>;
};
