/**
 * 桌面情境感知的三个场景 handler：
 * 1. DesktopSceneMeetingHandler   会议开始/结束 → 系统勿扰开关（零 token）
 * 2. DesktopSceneDocumentHandler  前台文档停留 → 提取文本 + 一次 LLM 摘要（一次性、有界）
 * 3. DesktopScenePriceHandler     前台商品页停留 → UIA 读 URL + web_fetch/web_search + 一次 LLM 比价
 *
 * token 纪律：
 * - 检测与节流全部在 DesktopSceneWatcherService（零模型调用）；
 * - 每个场景每次触发最多一次 LLM 调用（ephemeralTurn，不污染会话线程，
 *   maxOutputTokens 封顶），全部走文本，不传图片。
 * - 失败静默降级（console 记录），绝不给用户发失败骚扰消息；只有会议
 *   勿扰开关失败才如实告知（因为用户以为已经免打扰了）。
 */

import type {
  DesktopVisualReadDocumentResult,
  DesktopVisualSetDndResult,
  DesktopVisualUiaQueryInput,
  DesktopVisualUiaQueryResult,
  DesktopVisualWebFetchResult,
  DesktopVisualWebSearchResult,
} from "./desktop-visual-port.js";
import type { ChatToolExecutionContext } from "../external-model/types.js";
import type { DesktopBridgeCoordinator } from "./desktop-bridge-coordinator.js";
import type { DesktopVisualPort } from "./desktop-visual-port.js";
import type {
  DesktopSceneDocumentInfo,
  DesktopSceneInfo,
  DesktopSceneMeetingSession,
} from "./desktop-scene-watcher-service.js";

// ─── 动作执行器：桥接优先，本机子进程兜底（与 desktop-visual-tools 策略一致） ──

const BRIDGE_TIMEOUT_MS = 30_000;

export type DesktopSceneActionExecutor = {
  readDocument(actorId: string, path: string, maxChars?: number): Promise<DesktopVisualReadDocumentResult>;
  setDnd(actorId: string, op: "enable" | "disable" | "query"): Promise<DesktopVisualSetDndResult>;
  uiaQuery(actorId: string, input: DesktopVisualUiaQueryInput): Promise<DesktopVisualUiaQueryResult>;
  webFetch(actorId: string, url: string): Promise<DesktopVisualWebFetchResult>;
  webSearch(actorId: string, query: string, limit?: number): Promise<DesktopVisualWebSearchResult>;
};

export function createDesktopSceneActionExecutor(
  local: DesktopVisualPort,
  bridge: DesktopBridgeCoordinator,
): DesktopSceneActionExecutor {
  async function viaBridge<T>(
    actorId: string,
    payload: Record<string, unknown>,
  ): Promise<T | null> {
    if (!bridge.hasExecutor(actorId)) return null;
    const result = await bridge.invoke(actorId, payload, BRIDGE_TIMEOUT_MS);
    return (result ?? null) as T | null;
  }

  return {
    async readDocument(actorId, path, maxChars) {
      const remote = await viaBridge<DesktopVisualReadDocumentResult>(actorId, {
        action: "read_document",
        path,
        maxChars: maxChars ?? null,
      });
      if (remote) return remote;
      if (local.isEnabled() && local.readDocument) {
        return local.readDocument({ path, maxChars });
      }
      return { ok: false, error: "桌面能力不可用（桥接离线且本机未启用）" };
    },
    async setDnd(actorId, op) {
      const remote = await viaBridge<DesktopVisualSetDndResult>(actorId, {
        action: "set_dnd",
        dndOp: op,
      });
      if (remote) return remote;
      if (local.isEnabled() && local.setDnd) {
        return local.setDnd({ op });
      }
      return { ok: false, error: "桌面能力不可用（桥接离线且本机未启用）" };
    },
    async uiaQuery(actorId, input) {
      const remote = await viaBridge<DesktopVisualUiaQueryResult>(actorId, {
        action: "uia_query",
        mode: input.mode,
        selector: input.selector ?? null,
        point: input.point ?? null,
        topOnly: input.topOnly ?? null,
        limit: input.limit ?? null,
        windowTitle: input.windowTitle ?? null,
        maxDepth: input.maxDepth ?? null,
      });
      if (remote) return remote;
      if (local.isEnabled() && local.uiaQuery) {
        return local.uiaQuery(input);
      }
      return { ok: false, error: "桌面能力不可用（桥接离线且本机未启用）" };
    },
    async webFetch(actorId, url) {
      const remote = await viaBridge<DesktopVisualWebFetchResult>(actorId, {
        action: "web_fetch",
        url,
      });
      if (remote) return remote;
      if (local.isEnabled() && local.webFetch) {
        return local.webFetch({ url });
      }
      return { ok: false, error: "桌面能力不可用（桥接离线且本机未启用）" };
    },
    async webSearch(actorId, query, limit) {
      const remote = await viaBridge<DesktopVisualWebSearchResult>(actorId, {
        action: "web_search",
        query,
        limit: limit ?? null,
      });
      if (remote) return remote;
      if (local.isEnabled() && local.webSearch) {
        return local.webSearch({ query, limit });
      }
      return { ok: false, error: "桌面能力不可用（桥接离线且本机未启用）" };
    },
  };
}

// ─── 一次性 LLM 调用（ExternalChatProvider 的结构化最小接口） ──

/** ExternalChatProvider 的结构化最小接口（恰好兼容，装配层可直接传实例）。 */
export type DesktopSceneChatLike = {
  isEnabled(): boolean;
  streamCompletion(
    sessionId: string,
    userTurn: { text: string; clientMessageId?: string },
    onDelta: (delta: string) => void,
    tools?: ChatToolExecutionContext,
    streamOpts?: {
      ephemeralTurn?: boolean;
      systemPromptOverride?: string;
      maxOutputTokens?: number;
      disableThinking?: boolean;
    },
  ): Promise<string>;
};

export type ProactiveOutboundLike = {
  send(message: {
    actorId: string;
    title: string;
    text: string;
    reason: string;
    channel?: "websocket";
    meta?: Record<string, unknown>;
  }): Promise<boolean> | boolean;
};

async function oneShotCompletion(
  chat: DesktopSceneChatLike | null,
  actorId: string,
  lane: string,
  systemPrompt: string,
  userText: string,
  maxOutputTokens: number,
): Promise<string | null> {
  if (!chat || !chat.isEnabled()) return null;
  try {
    return await chat.streamCompletion(
      `scene-${lane}:${actorId}`,
      { text: userText, clientMessageId: `scene-${lane}-${Date.now()}` },
      () => {},
      undefined,
      {
        ephemeralTurn: true,
        systemPromptOverride: systemPrompt,
        maxOutputTokens,
        disableThinking: true,
      },
    );
  } catch (error) {
    console.error(
      `[DesktopSceneHandlers] oneShotCompletion(${lane}) failed:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

// ─── 1. 会议 → 勿扰 ──

export class DesktopSceneMeetingHandler {
  constructor(
    private readonly exec: DesktopSceneActionExecutor,
    private readonly outbound: ProactiveOutboundLike,
  ) {}

  async onMeetingStarted(actorId: string, info: DesktopSceneInfo): Promise<void> {
    const result = await this.exec.setDnd(actorId, "enable");
    const text = result.ok
      ? "检测到你正在开会，已为你静音系统通知（勿扰已开启），会议结束后自动恢复。"
      : `检测到你正在开会，但开启勿扰失败：${result.error ?? "未知原因"}。可手动开启勿扰。`;
    try {
      await this.outbound.send({
        actorId,
        title: "🔇 检测到视频会议",
        text,
        reason: "scene:meeting_started",
        channel: "websocket",
        meta: {
          scene: "meeting",
          dndOk: result.ok,
          meetingTitle: info.title.slice(0, 120),
          process: info.process,
        },
      });
    } catch (error) {
      console.error("[DesktopSceneHandlers] meeting start notify failed:", error);
    }
  }

  async onMeetingEnded(actorId: string, session: DesktopSceneMeetingSession): Promise<void> {
    const result = await this.exec.setDnd(actorId, "disable");
    const minutes = Math.max(1, Math.round(session.durationMs / 60_000));
    const dndText = result.ok
      ? "系统通知已恢复。"
      : `通知恢复失败：${result.error ?? "未知原因"}，请手动检查勿扰设置。`;
    try {
      await this.outbound.send({
        actorId,
        title: "🔊 会议已结束",
        text: `刚才的会议（约 ${minutes} 分钟）已结束。${dndText}`,
        reason: "scene:meeting_ended",
        channel: "websocket",
        meta: {
          scene: "meeting",
          durationMs: session.durationMs,
          dndOk: result.ok,
        },
      });
    } catch (error) {
      console.error("[DesktopSceneHandlers] meeting end notify failed:", error);
    }
  }
}

// ─── 2. 文档 → 摘要 + 关键问题 ──

const DOC_SYSTEM_PROMPT = `你是私人助手的文档速读模块。用户正在电脑上阅读一份文档，你收到文档文本摘录。
只输出以下两部分，不要寒暄、不要重复原文：
【摘要】不超过 200 字，概括这份文档讲什么、核心结论或要点。
【关键问题】3 条用户可能想追问的问题，每条一行，以 - 开头。`;

const DOC_EXCERPT_CHARS = 16_000;

export class DesktopSceneDocumentHandler {
  constructor(
    private readonly exec: DesktopSceneActionExecutor,
    private readonly chat: DesktopSceneChatLike | null,
    private readonly outbound: ProactiveOutboundLike,
  ) {}

  async onDocumentDetected(actorId: string, info: DesktopSceneDocumentInfo): Promise<void> {
    const target = info.filePath ?? info.fileName;
    if (!target) return;
    try {
      const doc = await this.exec.readDocument(actorId, target, DOC_EXCERPT_CHARS);
      if (!doc.ok || !doc.text?.trim()) {
        console.error(
          `[DesktopSceneHandlers] readDocument failed for ${target}: ${doc.error ?? "empty"}`,
        );
        return;
      }
      const summary = await oneShotCompletion(
        this.chat,
        actorId,
        "document",
        DOC_SYSTEM_PROMPT,
        `文件：${doc.title ?? info.fileName}${doc.pages ? `（PDF 共 ${doc.pages} 页）` : ""}\n` +
          `文本摘录（可能截断）：\n${doc.text.slice(0, DOC_EXCERPT_CHARS)}`,
        800,
      );
      if (!summary?.trim()) return;
      await this.outbound.send({
        actorId,
        title: `📄 ${doc.title ?? info.fileName} 速读`,
        text: summary.trim(),
        reason: "scene:document",
        channel: "websocket",
        meta: {
          scene: "document",
          path: doc.path,
          chars: doc.chars,
          truncated: doc.truncated,
        },
      });
    } catch (error) {
      console.error("[DesktopSceneHandlers] document handler failed:", error);
    }
  }
}

// ─── 3. 商品页 → 比价 ──

const PRICE_SYSTEM_PROMPT = `你是私人助手的购物比价模块。用户正在浏览一个商品页面，你收到商品线索。
只输出以下内容，不要寒暄：
【商品】一句话说明识别到的商品。
【价格线索】当前页面与搜索到的其他渠道价格（没有就写“未找到可靠价格信息”）。
【建议】不超过 80 字的购买建议（价格是否合理、要不要等促销）。
信息不足时如实说明，不要编造价格。`;

/** URL 提取：UIA 查询浏览器地址栏（Edit 控件的 name 常为当前 URL） */
async function extractBrowserUrl(
  exec: DesktopSceneActionExecutor,
  actorId: string,
  windowTitle: string,
): Promise<string | null> {
  try {
    const result = await exec.uiaQuery(actorId, {
      mode: "query",
      selector: { control_type: "Edit" },
      windowTitle: windowTitle.slice(0, 60),
      topOnly: false,
      limit: 80,
    });
    if (!result.ok || !Array.isArray(result.elements)) return null;
    const url = result.elements
      .map((e) => String(e.name ?? ""))
      .find((n) => /^https?:\/\//i.test(n));
    return url ?? null;
  } catch {
    return null;
  }
}

const PAGE_CONTEXT_CHARS = 6000;

export class DesktopScenePriceHandler {
  constructor(
    private readonly exec: DesktopSceneActionExecutor,
    private readonly chat: DesktopSceneChatLike | null,
    private readonly outbound: ProactiveOutboundLike,
  ) {}

  async onProductPageDetected(actorId: string, info: DesktopSceneInfo): Promise<void> {
    try {
      const url = await extractBrowserUrl(this.exec, actorId, info.title);
      let userContext: string;
      let meta: Record<string, unknown> = { scene: "shopping", productTitle: info.title.slice(0, 120) };

      if (url) {
        meta = { ...meta, url };
        const page = await this.exec.webFetch(actorId, url);
        if (page.ok && (page.content || page.title)) {
          userContext =
            `商品页 URL：${url}\n` +
            `页面标题：${page.title ?? info.title}\n` +
            `页面正文摘录：\n${(page.content ?? "").slice(0, PAGE_CONTEXT_CHARS)}`;
        } else {
          userContext = `商品页 URL：${url}\n页面正文抓取失败（${page.error ?? "未知"}）。`;
        }
        // 无论正文是否抓到，都补一轮搜索结果
        userContext += await this.searchContext(actorId, info.title);
      } else {
        // 拿不到 URL：仅凭窗口标题搜索
        userContext =
          `未能读取浏览器地址栏 URL。\n` +
          `浏览器窗口标题：${info.title}\n` +
          (await this.searchContext(actorId, info.title));
      }

      const answer = await oneShotCompletion(
        this.chat,
        actorId,
        "shopping",
        PRICE_SYSTEM_PROMPT,
        userContext.slice(0, PAGE_CONTEXT_CHARS + 4000),
        700,
      );
      if (!answer?.trim()) return;
      await this.outbound.send({
        actorId,
        title: `🛒 比价：${info.title.slice(0, 40)}`,
        text: answer.trim(),
        reason: "scene:shopping",
        channel: "websocket",
        meta,
      });
    } catch (error) {
      console.error("[DesktopSceneHandlers] price handler failed:", error);
    }
  }

  private async searchContext(actorId: string, title: string): Promise<string> {
    const query = title.replace(/[【】\[\]|｜—_-].*$/, "").trim().slice(0, 60) || title.slice(0, 60);
    if (!query) return "";
    try {
      const search = await this.exec.webSearch(actorId, `${query} 价格`, 6);
      if (!search.ok || !search.items?.length) return "";
      const lines = search.items
        .map((item) => `- ${item.title}（${item.url}）：${item.snippet.slice(0, 120)}`)
        .join("\n");
      return `\n相关搜索结果：\n${lines}`;
    } catch {
      return "";
    }
  }
}
