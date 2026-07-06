import { createHmac, randomBytes } from "node:crypto";

/**
 * 社交主动出击服务（Social Outreach）。
 *
 * 与社交动态（world.social.* / SocialFeedService，Agent 内部世界社交）不同，
 * 本服务对接的是**外部真实社交平台**（Twitter / 微博 / 小红书 / 朋友圈），
 * 让 Agent 能在用户授权下主动跨平台发帖 / 评论 / 转发 / 点赞 / 拉取时间线 / 搜索话题。
 *
 * 平台适配器模式：
 *   - TwitterAdapter   —— X API v2，OAuth 1.0a User Context（发帖）+ Bearer Token（读）
 *   - WeiboAdapter     —— 微博开放平台，OAuth 2.0 access_token 查询参数
 *   - XiaohongshuAdapter —— 暂无官方 API，isEnabled() 返回 false
 *   - WechatMomentsAdapter —— 暂无官方 API，isEnabled() 返回 false
 *
 * 用 fetch 直接调 HTTP API，不引入完整 SDK。
 * 凭证未配置时 isEnabled() 返回 false，工具层给出友好错误「<平台>平台未配置」。
 */

/** 支持的外部社交平台。 */
export type SocialPlatform = "twitter" | "weibo" | "xiaohongshu" | "wechat_moments";

/** 已知的平台列表（用于 getEnabledPlatforms / 工具层提示）。 */
export const ALL_SOCIAL_PLATFORMS: readonly SocialPlatform[] = [
  "twitter",
  "weibo",
  "xiaohongshu",
  "wechat_moments",
];

/** 平台中文标签（用于错误消息 / summary）。 */
export const SOCIAL_PLATFORM_LABELS: Record<SocialPlatform, string> = {
  twitter: "Twitter",
  weibo: "微博",
  xiaohongshu: "小红书",
  wechat_moments: "朋友圈",
};

/** 发帖入参。 */
export interface SocialPostInput {
  /** 正文（必填） */
  content: string;
  /** 图片 URL / 本地路径列表（可选，平台不一定支持） */
  images?: string[];
  /** 平台特定选项透传，如 Twitter reply_in_reply_to_tweet_id / Weibo visible */
  platformOptions?: Record<string, unknown>;
}

/** 评论入参。 */
export interface SocialCommentInput {
  /** 被评论帖子 ID（平台原生 ID） */
  postId: string;
  /** 评论正文 */
  content: string;
}

/** 单条帖子记录（跨平台归一化）。 */
export interface SocialPostRecord {
  platform: SocialPlatform;
  postId: string;
  author: { id: string; name: string; avatar?: string };
  content: string;
  images?: string[];
  createdAt: string;
  likeCount?: number;
  commentCount?: number;
  repostCount?: number;
  url?: string;
}

/** 发帖结果。 */
export interface SocialPostResult {
  platform: SocialPlatform;
  postId: string;
  url?: string;
  createdAt: string;
  raw?: unknown;
}

/** 评论结果。 */
export interface SocialCommentResult {
  platform: SocialPlatform;
  commentId: string;
  postId: string;
  createdAt: string;
}

/** 转发结果。 */
export interface SocialRepostResult {
  platform: SocialPlatform;
  repostId: string;
  originalPostId: string;
  url?: string;
  createdAt: string;
}

/** 点赞结果。 */
export interface SocialLikeResult {
  platform: SocialPlatform;
  postId: string;
  liked: true;
}

/** 时间线 / 搜索结果。 */
export interface SocialFeedResult {
  platform: SocialPlatform;
  posts: SocialPostRecord[];
  /** 下一页游标（平台支持时返回，否则缺省） */
  nextCursor?: string;
}

/** 搜索结果。 */
export interface SocialSearchResult {
  platform: SocialPlatform;
  query: string;
  posts: SocialPostRecord[];
  nextCursor?: string;
}

/** 统一返回：成功。 */
type SocialOk<T> = { ok: true; summary: string } & T;
/** 统一返回：失败。 */
export type SocialErr = { ok: false; error: string; retryable?: boolean };
/** 统一返回类型。 */
export type SocialResult<T> = SocialOk<T> | SocialErr;

/** 平台适配器接口：每个平台一个实现。 */
export interface SocialPlatformAdapter {
  name: SocialPlatform;
  /** 平台是否已配置可用（凭证齐备） */
  isEnabled(): boolean;
  /** 发帖 */
  post(input: SocialPostInput): Promise<SocialResult<SocialPostResult>>;
  /** 评论 */
  comment(input: SocialCommentInput): Promise<SocialResult<SocialCommentResult>>;
  /** 转发 / 引用 */
  repost(postId: string, quote?: string): Promise<SocialResult<SocialRepostResult>>;
  /** 点赞 */
  like(postId: string): Promise<SocialResult<SocialLikeResult>>;
  /** 拉取最新时间线 */
  getFeed(cursor?: string, limit?: number): Promise<SocialResult<SocialFeedResult>>;
  /** 搜索话题 / 关键词 */
  searchPosts(query: string, cursor?: string, limit?: number): Promise<SocialResult<SocialSearchResult>>;
}

/* =========================================================================
 * 通用工具
 * ========================================================================= */

/** 把未知错误归一为字符串。 */
function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** HTTP 错误是否可重试（网络层 / 5xx / 限流）。 */
function isRetryableHttpError(status: number, body: string): boolean {
  if (status >= 500) return true;
  if (status === 408 || status === 429) return true;
  // 平台常见的临时错误关键字
  if (/rate.?limit|timeout|temporarily|overload|busy/i.test(body)) return true;
  return false;
}

/** 拒绝空字符串，返回 trimmed 值或 null。 */
function trimToNonEmpty(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}

/* =========================================================================
 * Twitter 适配器（X API v2）
 * ========================================================================= */

/**
 * X API v2 适配器。
 *
 * 凭证（环境变量）：
 *   - TWITTER_BEARER_TOKEN          App-only Bearer，用于读取（搜索 / 时间线）
 *   - TWITTER_API_KEY               Consumer Key（OAuth 1.0a）
 *   - TWITTER_API_SECRET            Consumer Secret
 *   - TWITTER_ACCESS_TOKEN          User Access Token（OAuth 1.0a）
 *   - TWITTER_ACCESS_TOKEN_SECRET   User Access Token Secret
 *   - TWITTER_USER_ID               （可选）当前用户 ID，用于发帖 / 点赞 / 转发接口；
 *                                  未传时首次调用 /2/users/me 自动缓存。
 *
 * 写操作（post / comment / repost / like）必须用 OAuth 1.0a User Context。
 * 读操作（getFeed / searchPosts）用 Bearer Token 即可。
 *
 * 文档：https://developer.twitter.com/en/docs/twitter-api
 */
export class TwitterAdapter implements SocialPlatformAdapter {
  readonly name = "twitter" as const;
  private readonly apiKey: string | null;
  private readonly apiSecret: string | null;
  private readonly accessToken: string | null;
  private readonly accessTokenSecret: string | null;
  private readonly bearerToken: string | null;
  /** 用户自己的 ID（写操作需要），首次发帖前补齐 */
  private cachedUserId: string | null;

  constructor(opts: {
    apiKey?: string;
    apiSecret?: string;
    accessToken?: string;
    accessTokenSecret?: string;
    bearerToken?: string;
    userId?: string;
  } = {}) {
    this.apiKey = trimToNonEmpty(opts.apiKey ?? process.env.TWITTER_API_KEY);
    this.apiSecret = trimToNonEmpty(opts.apiSecret ?? process.env.TWITTER_API_SECRET);
    this.accessToken = trimToNonEmpty(opts.accessToken ?? process.env.TWITTER_ACCESS_TOKEN);
    this.accessTokenSecret = trimToNonEmpty(opts.accessTokenSecret ?? process.env.TWITTER_ACCESS_TOKEN_SECRET);
    this.bearerToken = trimToNonEmpty(opts.bearerToken ?? process.env.TWITTER_BEARER_TOKEN);
    this.cachedUserId = trimToNonEmpty(opts.userId ?? process.env.TWITTER_USER_ID);
  }

  /** 写操作是否可用（OAuth 1.0a 凭证齐备）。 */
  isWriteEnabled(): boolean {
    return Boolean(
      this.apiKey && this.apiSecret && this.accessToken && this.accessTokenSecret,
    );
  }

  /** 读操作是否可用（Bearer Token 齐备）。 */
  isReadEnabled(): boolean {
    return Boolean(this.bearerToken);
  }

  isEnabled(): boolean {
    return this.isWriteEnabled() || this.isReadEnabled();
  }

  /** 取当前登录用户 ID（用于写操作）。 */
  private async ensureUserId(): Promise<string | SocialErr> {
    if (this.cachedUserId) return this.cachedUserId;
    if (!this.isWriteEnabled()) {
      return {
        ok: false,
        error:
          "Twitter 写操作未配置：服务端需设置 TWITTER_API_KEY / TWITTER_API_SECRET / TWITTER_ACCESS_TOKEN / TWITTER_ACCESS_TOKEN_SECRET",
        retryable: false,
      };
    }
    // 调 /2/users/me 拿当前用户 ID
    const url = "https://api.twitter.com/2/users/me";
    const authHeader = this.buildOAuth1Header("GET", url, {});
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Authorization: authHeader },
      });
      const body = (await res.json()) as { data?: { id: string }; detail?: string; title?: string };
      if (!res.ok || !body.data?.id) {
        return {
          ok: false,
          error: `Twitter 获取用户信息失败：HTTP ${res.status} ${body.detail ?? body.title ?? res.statusText}`,
          retryable: isRetryableHttpError(res.status, JSON.stringify(body)),
        };
      }
      this.cachedUserId = body.data.id;
      return body.data.id;
    } catch (e) {
      return { ok: false, error: describeError(e), retryable: true };
    }
  }

  /** OAuth 1.0a 签名 + Authorization 头构造。 */
  private buildOAuth1Header(
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    queryParams: Record<string, string>,
    body?: Record<string, unknown>,
  ): string {
    if (!this.apiKey || !this.apiSecret || !this.accessToken || !this.accessTokenSecret) {
      throw new Error("Twitter OAuth 1.0a 凭证未齐备");
    }
    const oauthParams: Record<string, string> = {
      oauth_consumer_key: this.apiKey,
      oauth_nonce: randomBytes(16).toString("hex"),
      oauth_signature_method: "HMAC-SHA256",
      oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
      oauth_token: this.accessToken,
      oauth_version: "1.0",
    };

    // 收集所有参与签名的参数（oauth_* + query）
    const allParams: Record<string, string> = { ...oauthParams, ...queryParams };
    // POST body 若是 application/x-www-form-urlencoded 才参与签名；JSON body 不参与。
    // Twitter v2 全部用 JSON body，故不参与签名。

    const normalized = Object.keys(allParams)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`)
      .join("&");

    const baseString = `${method.toUpperCase()}&${encodeURIComponent(url)}&${encodeURIComponent(normalized)}`;
    const signingKey = `${encodeURIComponent(this.apiSecret)}&${encodeURIComponent(this.accessTokenSecret)}`;
    const signature = createHmac("sha256", signingKey)
      .update(baseString, "utf8")
      .digest("base64");

    const headerParams: Record<string, string> = { ...oauthParams, oauth_signature: signature };
    const header = "OAuth " + Object.keys(headerParams)
      .map((k) => `${encodeURIComponent(k)}="${encodeURIComponent(headerParams[k])}"`)
      .join(", ");
    return header;
  }

  async post(input: SocialPostInput): Promise<SocialResult<SocialPostResult>> {
    const userId = await this.ensureUserId();
    if (typeof userId !== "string") return userId;

    const text = (input.content ?? "").trim();
    if (!text) {
      return { ok: false, error: "Twitter 发帖失败：content 不能为空", retryable: false };
    }
    if (text.length > 280) {
      return { ok: false, error: `Twitter 发帖失败：正文超过 280 字符（当前 ${text.length}）`, retryable: false };
    }

    const body: Record<string, unknown> = { text };
    const opts = input.platformOptions ?? {};
    // 回复场景：reply.in_reply_to_tweet_id
    if (typeof opts.reply_in_reply_to_tweet_id === "string") {
      body.reply = { in_reply_to_tweet_id: opts.reply_in_reply_to_tweet_id };
    }
    // quote tweet：quote_tweet_id（注意：这是引用转发，与 repost 不同）
    if (typeof opts.quote_tweet_id === "string") {
      body.quote_tweet_id = opts.quote_tweet_id;
    }
    // 注意：Twitter v2 媒体上传需走 media/upload v1.1，本实现暂不支持自动上传图片；
    // 用户传 images URL 时仅记录到 raw，不实际上传。

    const url = "https://api.twitter.com/2/tweets";
    const authHeader = this.buildOAuth1Header("POST", url, {});
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { data?: { id: string; text: string }; detail?: string; title?: string };
      if (!res.ok || !json.data?.id) {
        return {
          ok: false,
          error: `Twitter 发帖失败：HTTP ${res.status} ${json.detail ?? json.title ?? res.statusText}`,
          retryable: isRetryableHttpError(res.status, JSON.stringify(json)),
        };
      }
      const postId = json.data.id;
      return {
        ok: true,
        platform: "twitter",
        postId,
        url: `https://twitter.com/i/web/status/${postId}`,
        createdAt: new Date().toISOString(),
        raw: input.images?.length ? { images: input.images } : undefined,
        summary: `已在 Twitter 发帖（id=${postId}）：${text.slice(0, 40)}${text.length > 40 ? "…" : ""}`,
      };
    } catch (e) {
      return { ok: false, error: describeError(e), retryable: true };
    }
  }

  async comment(input: SocialCommentInput): Promise<SocialResult<SocialCommentResult>> {
    const userId = await this.ensureUserId();
    if (typeof userId !== "string") return userId;

    const postId = (input.postId ?? "").trim();
    if (!postId) {
      return { ok: false, error: "Twitter 评论失败：postId 不能为空", retryable: false };
    }
    const text = (input.content ?? "").trim();
    if (!text) {
      return { ok: false, error: "Twitter 评论失败：content 不能为空", retryable: false };
    }
    if (text.length > 280) {
      return { ok: false, error: `Twitter 评论失败：正文超过 280 字符`, retryable: false };
    }

    // 评论 = reply（in_reply_to_tweet_id）
    const body = { text, reply: { in_reply_to_tweet_id: postId } };
    const url = "https://api.twitter.com/2/tweets";
    const authHeader = this.buildOAuth1Header("POST", url, {});
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { data?: { id: string }; detail?: string; title?: string };
      if (!res.ok || !json.data?.id) {
        return {
          ok: false,
          error: `Twitter 评论失败：HTTP ${res.status} ${json.detail ?? json.title ?? res.statusText}`,
          retryable: isRetryableHttpError(res.status, JSON.stringify(json)),
        };
      }
      return {
        ok: true,
        platform: "twitter",
        commentId: json.data.id,
        postId,
        createdAt: new Date().toISOString(),
        summary: `已评论 Twitter 帖子 ${postId}（comment id=${json.data.id}）`,
      };
    } catch (e) {
      return { ok: false, error: describeError(e), retryable: true };
    }
  }

  async repost(postId: string, quote?: string): Promise<SocialResult<SocialRepostResult>> {
    const userId = await this.ensureUserId();
    if (typeof userId !== "string") return userId;

    const tid = (postId ?? "").trim();
    if (!tid) {
      return { ok: false, error: "Twitter 转发失败：postId 不能为空", retryable: false };
    }

    // 转发（retweet）：POST /2/users/{id}/retweets { tweet_id }
    const url = `https://api.twitter.com/2/users/${userId}/retweets`;
    const authHeader = this.buildOAuth1Header("POST", url, {});
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ tweet_id: tid }),
      });
      const json = (await res.json()) as { data?: { retweeted: boolean; id?: string }; detail?: string; title?: string };
      if (!res.ok || !json.data?.retweeted) {
        return {
          ok: false,
          error: `Twitter 转发失败：HTTP ${res.status} ${json.detail ?? json.title ?? res.statusText}`,
          retryable: isRetryableHttpError(res.status, JSON.stringify(json)),
        };
      }
      return {
        ok: true,
        platform: "twitter",
        repostId: json.data.id ?? `${tid}-retweet`,
        originalPostId: tid,
        createdAt: new Date().toISOString(),
        summary: quote?.trim()
          ? `已转发 Twitter 帖子 ${tid}（附评论：${quote.slice(0, 30)}…）`
          : `已转发 Twitter 帖子 ${tid}`,
      };
    } catch (e) {
      return { ok: false, error: describeError(e), retryable: true };
    }
  }

  async like(postId: string): Promise<SocialResult<SocialLikeResult>> {
    const userId = await this.ensureUserId();
    if (typeof userId !== "string") return userId;

    const tid = (postId ?? "").trim();
    if (!tid) {
      return { ok: false, error: "Twitter 点赞失败：postId 不能为空", retryable: false };
    }

    const url = `https://api.twitter.com/2/users/${userId}/likes`;
    const authHeader = this.buildOAuth1Header("POST", url, {});
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ tweet_id: tid }),
      });
      const json = (await res.json()) as { data?: { liked: boolean }; detail?: string; title?: string };
      if (!res.ok || !json.data?.liked) {
        return {
          ok: false,
          error: `Twitter 点赞失败：HTTP ${res.status} ${json.detail ?? json.title ?? res.statusText}`,
          retryable: isRetryableHttpError(res.status, JSON.stringify(json)),
        };
      }
      return {
        ok: true,
        platform: "twitter",
        postId: tid,
        liked: true,
        summary: `已点赞 Twitter 帖子 ${tid}`,
      };
    } catch (e) {
      return { ok: false, error: describeError(e), retryable: true };
    }
  }

  async getFeed(cursor?: string, limit = 10): Promise<SocialResult<SocialFeedResult>> {
    if (!this.isReadEnabled()) {
      return {
        ok: false,
        error: "Twitter 读操作未配置：服务端需设置 TWITTER_BEARER_TOKEN",
        retryable: false,
      };
    }
    const userId = await this.ensureUserId();
    if (typeof userId !== "string") return userId;

    const params = new URLSearchParams({
      max_results: String(Math.min(100, Math.max(5, limit))),
      "tweet.fields": "id,text,created_at,author_id,public_metrics",
    });
    if (cursor) params.set("pagination_token", cursor);
    const url = `https://api.twitter.com/2/users/${userId}/tweets?${params.toString()}`;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.bearerToken}` },
      });
      const json = (await res.json()) as {
        data?: Array<{
          id: string;
          text: string;
          created_at?: string;
          author_id?: string;
          public_metrics?: { like_count?: number; reply_count?: number; retweet_count?: number };
        }>;
        meta?: { next_token?: string };
        detail?: string;
        title?: string;
      };
      if (!res.ok || !json.data) {
        return {
          ok: false,
          error: `Twitter 拉取时间线失败：HTTP ${res.status} ${json.detail ?? json.title ?? res.statusText}`,
          retryable: isRetryableHttpError(res.status, JSON.stringify(json)),
        };
      }
      const posts: SocialPostRecord[] = json.data.map((t) => ({
        platform: "twitter",
        postId: t.id,
        author: { id: t.author_id ?? userId, name: t.author_id ?? "twitter_user" },
        content: t.text,
        createdAt: t.created_at ?? new Date().toISOString(),
        likeCount: t.public_metrics?.like_count,
        commentCount: t.public_metrics?.reply_count,
        repostCount: t.public_metrics?.retweet_count,
        url: `https://twitter.com/i/web/status/${t.id}`,
      }));
      return {
        ok: true,
        platform: "twitter",
        posts,
        nextCursor: json.meta?.next_token,
        summary: `已拉取 Twitter 时间线 ${posts.length} 条`,
      };
    } catch (e) {
      return { ok: false, error: describeError(e), retryable: true };
    }
  }

  async searchPosts(query: string, cursor?: string, limit = 10): Promise<SocialResult<SocialSearchResult>> {
    if (!this.isReadEnabled()) {
      return {
        ok: false,
        error: "Twitter 读操作未配置：服务端需设置 TWITTER_BEARER_TOKEN",
        retryable: false,
      };
    }
    const q = (query ?? "").trim();
    if (!q) {
      return { ok: false, error: "Twitter 搜索失败：query 不能为空", retryable: false };
    }
    const params = new URLSearchParams({
      query: q,
      max_results: String(Math.min(100, Math.max(10, limit))),
      "tweet.fields": "id,text,created_at,author_id,public_metrics",
    });
    if (cursor) params.set("next_token", cursor);
    const url = `https://api.twitter.com/2/tweets/search/recent?${params.toString()}`;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.bearerToken}` },
      });
      const json = (await res.json()) as {
        data?: Array<{
          id: string;
          text: string;
          created_at?: string;
          author_id?: string;
          public_metrics?: { like_count?: number; reply_count?: number; retweet_count?: number };
        }>;
        meta?: { next_token?: string };
        detail?: string;
        title?: string;
      };
      if (!res.ok || !json.data) {
        return {
          ok: false,
          error: `Twitter 搜索失败：HTTP ${res.status} ${json.detail ?? json.title ?? res.statusText}`,
          retryable: isRetryableHttpError(res.status, JSON.stringify(json)),
        };
      }
      const posts: SocialPostRecord[] = json.data.map((t) => ({
        platform: "twitter",
        postId: t.id,
        author: { id: t.author_id ?? "twitter_user", name: t.author_id ?? "twitter_user" },
        content: t.text,
        createdAt: t.created_at ?? new Date().toISOString(),
        likeCount: t.public_metrics?.like_count,
        commentCount: t.public_metrics?.reply_count,
        repostCount: t.public_metrics?.retweet_count,
        url: `https://twitter.com/i/web/status/${t.id}`,
      }));
      return {
        ok: true,
        platform: "twitter",
        query: q,
        posts,
        nextCursor: json.meta?.next_token,
        summary: `Twitter 搜索「${q}」命中 ${posts.length} 条`,
      };
    } catch (e) {
      return { ok: false, error: describeError(e), retryable: true };
    }
  }
}

/* =========================================================================
 * 微博适配器（微博开放平台 API v2）
 * ========================================================================= */

/**
 * 微博开放平台适配器。
 *
 * 凭证（环境变量）：
 *   - WEIBO_ACCESS_TOKEN  OAuth 2.0 access_token，作为查询参数传给所有接口
 *
 * 接口（https://open.weibo.com/wiki/API）：
 *   - 发帖：  POST /2/statuses/share.json     （新接口，要求正文带 URL）
 *             或 POST /2/statuses/update.json（旧接口）
 *   - 评论：  POST /2/comments/create.json
 *   - 转发：  POST /2/statuses/repost.json
 *   - 点赞：  微博开放平台未提供公开 like 接口，这里用 favorites/create.json 收藏代替
 *   - 时间线： GET /2/statuses/home_timeline.json
 *   - 搜索：  GET /2/search/topics.json?q=...
 *
 * 凭证未配置时 isEnabled() 返回 false。
 */
export class WeiboAdapter implements SocialPlatformAdapter {
  readonly name = "weibo" as const;
  private readonly accessToken: string | null;
  private readonly baseUrl = "https://api.weibo.com";

  constructor(opts: { accessToken?: string } = {}) {
    this.accessToken = trimToNonEmpty(opts.accessToken ?? process.env.WEIBO_ACCESS_TOKEN);
  }

  isEnabled(): boolean {
    return Boolean(this.accessToken);
  }

  private requireToken(): string | SocialErr {
    if (!this.accessToken) {
      return {
        ok: false,
        error: "微博平台未配置：服务端需设置 WEIBO_ACCESS_TOKEN",
        retryable: false,
      };
    }
    return this.accessToken;
  }

  async post(input: SocialPostInput): Promise<SocialResult<SocialPostResult>> {
    const token = this.requireToken();
    if (typeof token !== "string") return token;

    const content = (input.content ?? "").trim();
    if (!content) {
      return { ok: false, error: "微博发帖失败：content 不能为空", retryable: false };
    }
    // share.json 要求正文含一个 URL；若没有则回退到 update.json
    const hasUrl = /https?:\/\//.test(content);
    const endpoint = hasUrl ? "/2/statuses/share.json" : "/2/statuses/update.json";
    const url = `${this.baseUrl}${endpoint}`;

    const params = new URLSearchParams();
    params.set("access_token", token);
    params.set("status", content);
    const visible = (input.platformOptions?.visible as unknown) as string | undefined;
    if (typeof visible === "string") params.set("visible", visible);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      const json = (await res.json()) as { idstr?: string; id?: number; text?: string; error?: string; error_code?: number };
      if (!res.ok || (!json.idstr && !json.id)) {
        return {
          ok: false,
          error: `微博发帖失败：${json.error_code ?? `HTTP ${res.status}`} ${json.error ?? res.statusText}`,
          retryable: isRetryableHttpError(res.status, JSON.stringify(json)),
        };
      }
      const postId = String(json.idstr ?? json.id);
      return {
        ok: true,
        platform: "weibo",
        postId,
        url: `https://weibo.com/detail/${postId}`,
        createdAt: new Date().toISOString(),
        summary: `已在微博发帖（id=${postId}）：${content.slice(0, 40)}${content.length > 40 ? "…" : ""}`,
      };
    } catch (e) {
      return { ok: false, error: describeError(e), retryable: true };
    }
  }

  async comment(input: SocialCommentInput): Promise<SocialResult<SocialCommentResult>> {
    const token = this.requireToken();
    if (typeof token !== "string") return token;

    const postId = (input.postId ?? "").trim();
    if (!postId) {
      return { ok: false, error: "微博评论失败：postId 不能为空", retryable: false };
    }
    const content = (input.content ?? "").trim();
    if (!content) {
      return { ok: false, error: "微博评论失败：content 不能为空", retryable: false };
    }

    const url = `${this.baseUrl}/2/comments/create.json`;
    const params = new URLSearchParams();
    params.set("access_token", token);
    params.set("id", postId);
    params.set("comment", content);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      const json = (await res.json()) as { idstr?: string; id?: number; error?: string; error_code?: number };
      if (!res.ok || (!json.idstr && !json.id)) {
        return {
          ok: false,
          error: `微博评论失败：${json.error_code ?? `HTTP ${res.status}`} ${json.error ?? res.statusText}`,
          retryable: isRetryableHttpError(res.status, JSON.stringify(json)),
        };
      }
      const commentId = String(json.idstr ?? json.id);
      return {
        ok: true,
        platform: "weibo",
        commentId,
        postId,
        createdAt: new Date().toISOString(),
        summary: `已评论微博 ${postId}（comment id=${commentId}）`,
      };
    } catch (e) {
      return { ok: false, error: describeError(e), retryable: true };
    }
  }

  async repost(postId: string, quote?: string): Promise<SocialResult<SocialRepostResult>> {
    const token = this.requireToken();
    if (typeof token !== "string") return token;

    const tid = (postId ?? "").trim();
    if (!tid) {
      return { ok: false, error: "微博转发失败：postId 不能为空", retryable: false };
    }

    const url = `${this.baseUrl}/2/statuses/repost.json`;
    const params = new URLSearchParams();
    params.set("access_token", token);
    params.set("id", tid);
    if (quote?.trim()) params.set("status", quote.trim());

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      const json = (await res.json()) as { idstr?: string; id?: number; error?: string; error_code?: number };
      if (!res.ok || (!json.idstr && !json.id)) {
        return {
          ok: false,
          error: `微博转发失败：${json.error_code ?? `HTTP ${res.status}`} ${json.error ?? res.statusText}`,
          retryable: isRetryableHttpError(res.status, JSON.stringify(json)),
        };
      }
      const repostId = String(json.idstr ?? json.id);
      return {
        ok: true,
        platform: "weibo",
        repostId,
        originalPostId: tid,
        url: `https://weibo.com/detail/${repostId}`,
        createdAt: new Date().toISOString(),
        summary: `已转发微博 ${tid}`,
      };
    } catch (e) {
      return { ok: false, error: describeError(e), retryable: true };
    }
  }

  async like(postId: string): Promise<SocialResult<SocialLikeResult>> {
    const token = this.requireToken();
    if (typeof token !== "string") return token;

    const tid = (postId ?? "").trim();
    if (!tid) {
      return { ok: false, error: "微博点赞失败：postId 不能为空", retryable: false };
    }
    // 微博未提供公开 like 接口，用 favorites/create.json 收藏代替
    const url = `${this.baseUrl}/2/favorites/create.json`;
    const params = new URLSearchParams();
    params.set("access_token", token);
    params.set("id", tid);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      const json = (await res.json()) as { id?: number; error?: string; error_code?: number };
      if (!res.ok || !json.id) {
        return {
          ok: false,
          error: `微博收藏失败：${json.error_code ?? `HTTP ${res.status}`} ${json.error ?? res.statusText}`,
          retryable: isRetryableHttpError(res.status, JSON.stringify(json)),
        };
      }
      return {
        ok: true,
        platform: "weibo",
        postId: tid,
        liked: true,
        summary: `已收藏微博 ${tid}（微博开放平台未提供 like 接口，使用收藏代替）`,
      };
    } catch (e) {
      return { ok: false, error: describeError(e), retryable: true };
    }
  }

  async getFeed(cursor?: string, limit = 10): Promise<SocialResult<SocialFeedResult>> {
    const token = this.requireToken();
    if (typeof token !== "string") return token;

    const params = new URLSearchParams({
      access_token: token,
      count: String(Math.min(50, Math.max(5, limit))),
    });
    if (cursor) params.set("max_id", cursor);
    const url = `${this.baseUrl}/2/statuses/home_timeline.json?${params.toString()}`;
    try {
      const res = await fetch(url);
      const json = (await res.json()) as {
        statuses?: Array<{
          idstr?: string;
          id?: number;
          text?: string;
          created_at?: string;
          user?: { idstr?: string; id?: number; screen_name?: string; profile_image_url?: string };
          pic_urls?: Array<{ thumbnail_pic?: string }>;
          reposts_count?: number;
          comments_count?: number;
          attitudes_count?: number;
        }>;
        next_cursor?: number;
        error?: string;
        error_code?: number;
      };
      if (!res.ok || !json.statuses) {
        return {
          ok: false,
          error: `微博拉取时间线失败：${json.error_code ?? `HTTP ${res.status}`} ${json.error ?? res.statusText}`,
          retryable: isRetryableHttpError(res.status, JSON.stringify(json)),
        };
      }
      const posts: SocialPostRecord[] = json.statuses.map((s) => ({
        platform: "weibo",
        postId: String(s.idstr ?? s.id ?? ""),
        author: {
          id: String(s.user?.idstr ?? s.user?.id ?? ""),
          name: s.user?.screen_name ?? "微博用户",
          avatar: s.user?.profile_image_url,
        },
        content: s.text ?? "",
        images: s.pic_urls?.map((p) => p.thumbnail_pic ?? "").filter(Boolean),
        createdAt: s.created_at ?? new Date().toISOString(),
        repostCount: s.reposts_count,
        commentCount: s.comments_count,
        likeCount: s.attitudes_count,
        url: s.idstr ? `https://weibo.com/detail/${s.idstr}` : undefined,
      }));
      return {
        ok: true,
        platform: "weibo",
        posts,
        nextCursor: json.next_cursor ? String(json.next_cursor) : undefined,
        summary: `已拉取微博时间线 ${posts.length} 条`,
      };
    } catch (e) {
      return { ok: false, error: describeError(e), retryable: true };
    }
  }

  async searchPosts(query: string, cursor?: string, limit = 10): Promise<SocialResult<SocialSearchResult>> {
    const token = this.requireToken();
    if (typeof token !== "string") return token;

    const q = (query ?? "").trim();
    if (!q) {
      return { ok: false, error: "微博搜索失败：query 不能为空", retryable: false };
    }
    const params = new URLSearchParams({
      access_token: token,
      q,
      count: String(Math.min(50, Math.max(5, limit))),
    });
    if (cursor) params.set("page", cursor);
    const url = `${this.baseUrl}/2/search/topics.json?${params.toString()}`;
    try {
      const res = await fetch(url);
      const json = (await res.json()) as {
        statuses?: Array<{
          idstr?: string;
          id?: number;
          text?: string;
          created_at?: string;
          user?: { idstr?: string; id?: number; screen_name?: string; profile_image_url?: string };
          pic_urls?: Array<{ thumbnail_pic?: string }>;
          reposts_count?: number;
          comments_count?: number;
          attitudes_count?: number;
        }>;
        next_cursor?: number;
        error?: string;
        error_code?: number;
      };
      if (!res.ok || !json.statuses) {
        return {
          ok: false,
          error: `微博搜索失败：${json.error_code ?? `HTTP ${res.status}`} ${json.error ?? res.statusText}`,
          retryable: isRetryableHttpError(res.status, JSON.stringify(json)),
        };
      }
      const posts: SocialPostRecord[] = json.statuses.map((s) => ({
        platform: "weibo",
        postId: String(s.idstr ?? s.id ?? ""),
        author: {
          id: String(s.user?.idstr ?? s.user?.id ?? ""),
          name: s.user?.screen_name ?? "微博用户",
          avatar: s.user?.profile_image_url,
        },
        content: s.text ?? "",
        images: s.pic_urls?.map((p) => p.thumbnail_pic ?? "").filter(Boolean),
        createdAt: s.created_at ?? new Date().toISOString(),
        repostCount: s.reposts_count,
        commentCount: s.comments_count,
        likeCount: s.attitudes_count,
        url: s.idstr ? `https://weibo.com/detail/${s.idstr}` : undefined,
      }));
      return {
        ok: true,
        platform: "weibo",
        query: q,
        posts,
        nextCursor: json.next_cursor ? String(json.next_cursor) : undefined,
        summary: `微博搜索「${q}」命中 ${posts.length} 条`,
      };
    } catch (e) {
      return { ok: false, error: describeError(e), retryable: true };
    }
  }
}

/* =========================================================================
 * 占位适配器：小红书 / 朋友圈（暂无官方 API）
 * ========================================================================= */

/** 通用占位适配器：所有方法返回「平台未配置」。 */
abstract class PlaceholderAdapter implements SocialPlatformAdapter {
  abstract readonly name: SocialPlatform;
  protected abstract readonly label: string;
  isEnabled(): boolean {
    return false;
  }
  protected notConfigured<T>(action: string): SocialResult<T> {
    return {
      ok: false,
      error: `${this.label}平台未配置：${this.label}暂无官方开放 API，${action}能力暂不可用`,
      retryable: false,
    };
  }
  post(): Promise<SocialResult<SocialPostResult>> {
    return Promise.resolve(this.notConfigured<SocialPostResult>("发帖"));
  }
  comment(): Promise<SocialResult<SocialCommentResult>> {
    return Promise.resolve(this.notConfigured<SocialCommentResult>("评论"));
  }
  repost(): Promise<SocialResult<SocialRepostResult>> {
    return Promise.resolve(this.notConfigured<SocialRepostResult>("转发"));
  }
  like(): Promise<SocialResult<SocialLikeResult>> {
    return Promise.resolve(this.notConfigured<SocialLikeResult>("点赞"));
  }
  getFeed(): Promise<SocialResult<SocialFeedResult>> {
    return Promise.resolve(this.notConfigured<SocialFeedResult>("拉取时间线"));
  }
  searchPosts(): Promise<SocialResult<SocialSearchResult>> {
    return Promise.resolve(this.notConfigured<SocialSearchResult>("搜索"));
  }
}

/** 小红书适配器（占位）。小红书目前没有官方开放 API。 */
export class XiaohongshuAdapter extends PlaceholderAdapter {
  readonly name = "xiaohongshu" as const;
  protected readonly label = "小红书";
}

/** 朋友圈适配器（占位）。微信朋友圈没有官方开放 API。 */
export class WechatMomentsAdapter extends PlaceholderAdapter {
  readonly name = "wechat_moments" as const;
  protected readonly label = "朋友圈";
}

/* =========================================================================
 * 顶层服务：聚合所有平台适配器
 * ========================================================================= */

/**
 * 社交主动出击服务。
 *
 * 由 {@link SocialOutreachHandlers} 调用，对外屏蔽具体平台差异。
 * 启用条件：至少有一个平台 isEnabled()=true（Twitter / 微博凭证齐备）。
 */
export class SocialOutreachService {
  private readonly adapters: Map<SocialPlatform, SocialPlatformAdapter>;

  constructor(opts: { adapters?: SocialPlatformAdapter[] } = {}) {
    this.adapters = new Map();
    // 默认装载 4 个平台适配器；可被外部传入覆盖
    const defaults: SocialPlatformAdapter[] = opts.adapters ?? [
      new TwitterAdapter(),
      new WeiboAdapter(),
      new XiaohongshuAdapter(),
      new WechatMomentsAdapter(),
    ];
    for (const a of defaults) this.adapters.set(a.name, a);
  }

  /** 是否至少一个平台已配置可用。 */
  isEnabled(): boolean {
    for (const a of this.adapters.values()) {
      if (a.isEnabled()) return true;
    }
    return false;
  }

  /** 列出已启用的平台（用于工具层给 LLM 反馈）。 */
  getEnabledPlatforms(): SocialPlatform[] {
    return ALL_SOCIAL_PLATFORMS.filter((p) => this.adapters.get(p)?.isEnabled());
  }

  /** 取指定平台适配器；未配置时返回友好错误。 */
  private getAdapter(platform: string): { adapter: SocialPlatformAdapter } | SocialErr {
    const p = (platform ?? "").trim().toLowerCase();
    if (!ALL_SOCIAL_PLATFORMS.includes(p as SocialPlatform)) {
      return {
        ok: false,
        error: `未知社交平台：${platform}（支持：${ALL_SOCIAL_PLATFORMS.join(" / ")}）`,
        retryable: false,
      };
    }
    const adapter = this.adapters.get(p as SocialPlatform);
    if (!adapter) {
      return {
        ok: false,
        error: `平台 ${platform} 适配器未注册`,
        retryable: false,
      };
    }
    if (!adapter.isEnabled()) {
      return {
        ok: false,
        error: `${SOCIAL_PLATFORM_LABELS[p as SocialPlatform]}平台未配置`,
        retryable: false,
      };
    }
    return { adapter };
  }

  async post(platform: string, input: SocialPostInput): Promise<SocialResult<SocialPostResult>> {
    const r = this.getAdapter(platform);
    if (!("adapter" in r)) return r;
    return r.adapter.post(input);
  }

  async comment(platform: string, input: SocialCommentInput): Promise<SocialResult<SocialCommentResult>> {
    const r = this.getAdapter(platform);
    if (!("adapter" in r)) return r;
    return r.adapter.comment(input);
  }

  async repost(platform: string, postId: string, quote?: string): Promise<SocialResult<SocialRepostResult>> {
    const r = this.getAdapter(platform);
    if (!("adapter" in r)) return r;
    return r.adapter.repost(postId, quote);
  }

  async like(platform: string, postId: string): Promise<SocialResult<SocialLikeResult>> {
    const r = this.getAdapter(platform);
    if (!("adapter" in r)) return r;
    return r.adapter.like(postId);
  }

  async getFeed(platform: string, cursor?: string, limit?: number): Promise<SocialResult<SocialFeedResult>> {
    const r = this.getAdapter(platform);
    if (!("adapter" in r)) return r;
    return r.adapter.getFeed(cursor, limit);
  }

  async searchPosts(
    platform: string,
    query: string,
    cursor?: string,
    limit?: number,
  ): Promise<SocialResult<SocialSearchResult>> {
    const r = this.getAdapter(platform);
    if (!("adapter" in r)) return r;
    return r.adapter.searchPosts(query, cursor, limit);
  }
}
