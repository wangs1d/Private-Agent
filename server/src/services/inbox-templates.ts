/**
 * 站内信模板：系统事件自动通知的文案出口。
 *
 * 管理后台/系统事件（账号状态变更、后续的审核结果等）不直接拼文案，
 * 一律经这里渲染，保证标题口径统一、客户端图标分类（kind）稳定。
 * 新事件接入：加一个模板 key + render 分支，发送方拿 InboxTemplateContent
 * 直接喂 InboxService.send() 即可。
 */

import type { InboxImportance } from "./inbox-service.js";

export type InboxTemplateKey = "account.disabled" | "account.restored";

export type InboxTemplateContent = {
  title: string;
  body: string;
  kind: string;
  importance: InboxImportance;
};

export type InboxTemplateParams = {
  displayName?: string;
  /** 预留：处置原因（暂无入口传入，模板里留位） */
  reason?: string;
};

export function renderInboxTemplate(
  key: InboxTemplateKey,
  params: InboxTemplateParams = {},
): InboxTemplateContent {
  const name = params.displayName?.trim() || "";
  const who = name ? `，${name}` : "";
  switch (key) {
    case "account.disabled":
      return {
        title: "账号已暂停使用",
        body:
          `你好${who}，你的账号已被管理员暂停使用，期间将无法与 Agent 继续对话。` +
          (params.reason?.trim() ? `原因：${params.reason.trim()}。` : "") +
          "如有疑问请联系平台管理员。",
        kind: "system",
        importance: "high",
      };
    case "account.restored":
      return {
        title: "账号已恢复使用",
        body: `你好${who}，你的账号已恢复正常，欢迎回来继续使用。`,
        kind: "system",
        importance: "normal",
      };
  }
}
