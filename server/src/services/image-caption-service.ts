/**
 * 图片卡片真实描述生成服务（Coze 式「一图一句」）。
 *
 * 背景（2026-09-03 用户反馈）：聊天照片旁的"描述文字"此前是 LLM 回复正文被
 * renderBlocks 按位置启发式切段钉到照片旁边的——LLM 只看过搜索引擎返回的
 * title/url，从未看过图片像素，所以文字经常和照片对不上。
 *
 * 本服务在 `chat.assistant_done` 组装前，对 mediaCards 里的每张图片**真正看图**
 * 生成一句描述（caption）：图片已由搜索链路转存为服务端本地 PNG，这里把每张图
 * 以 image_url 注入支持视觉的聊天模型（与主对话同一 provider），一次批量调用
 * 按顺序输出 N 句描述，再逐张回填到卡片上。前端把 caption 渲染在对应照片下方。
 *
 * 文案风格（2026-09-16 用户反馈）：caption 是「氛围感短句」——传达照片的
 * 光线、色调、情绪与瞬间感；禁止「女子穿…」式穿搭/外观清单描述。
 *
 * 降级策略（宁可没有，不可错位）：
 *   - 主模型不支持视觉 / 未配置密钥 / 调用失败 / 超时 → 不写 caption，
 *     前端回退到旧的交错排版（正文切段），不会出现"描述与照片无关"的更糟体验。
 *   - 同一图片地址（本地 PNG 路径）跨轮复用内存缓存，避免重复看图。
 *
 * 开关：`IMAGE_CAPTION_ENABLED=0` 关闭（默认开启）。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import OpenAI from "openai";

import { resolvePrimaryLlmClientConfig, bypassChatRequestExtras } from "../external-model/resolve-provider.js";
import { modelSupportsVision } from "../external-model/vision-support.js";
import type { MediaCardItem } from "./tool-result-processor.js";

/** 本地转存 PNG 的 URL 前缀（与 ImageGenerationService.downloadAndStorePng 一致） */
const LOCAL_IMAGE_URL_PREFIX = "/agent/images/";

/** caption 缓存上限（图片地址 → 描述），防止长会话内存膨胀 */
const CAPTION_CACHE_MAX = 200;
const captionCache = new Map<string, string>();

/** 单次批量看图的整体超时：caption 生成发生在回复组装阶段，会顺延
 *  chat.assistant_done 的到达时间（正文流式展示不受影响），预算控制在
 *  用户可感知范围内 */
const CAPTION_TIMEOUT_MS = 15_000;

/** 描述长度上限（字符）：一句观感描述足够，超长截断 */
const CAPTION_MAX_CHARS = 40;

/** 收尾清理：模型输出或截断可能留下「：」「—」等悬空标点（读起来像话没说完） */
function tidyCaption(raw: string): string {
  return raw.trim().replace(/[：:—–、，,；;]+$/u, "").trim();
}

export type CaptionOptions = {
  /** 整体超时（毫秒），默认 15s */
  timeoutMs?: number;
  /**
   * 拍摄位置参考（如「上海市徐汇区」）：仅在画面内容与之一致时，
   * 允许 caption 自然带出地点；画面无法确认时只描述内容，不硬塞地点。
   */
  locationHint?: string;
  /**
   * caption 生成器注入点（测试用）：默认用内置 VLM 批量看图。
   * 签名与 describeImagesWithVlm 一致（cards 已过滤为待生成的图片项）。
   */
  describeFn?: (
    cards: MediaCardItem[],
    timeoutMs: number,
  ) => Promise<string[]>;
};

/** 是否启用图片描述生成（环境变量开关，默认开启） */
export function isImageCaptionEnabled(): boolean {
  const raw = (process.env.IMAGE_CAPTION_ENABLED ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

/**
 * 给媒体卡片批量生成真实图片描述。就地写入 `card.caption`。
 *
 * 只处理 type==="image" 的卡片；任何一张失败都不影响其他卡片，
 * 整体失败也不抛异常（调用方继续走无 caption 的旧渲染路径）。
 */
export async function captionMediaCards(
  cards: MediaCardItem[],
  opts: CaptionOptions = {},
): Promise<void> {
  const imageCards = cards.filter(
    (c) => c.type === "image" && !!(c.thumbnailUrl || c.mediaUrl || "").trim(),
  );
  if (imageCards.length === 0) return;

  // 已有 caption 的不重复生成（理论上不会出现，防御性保留）
  const todo = imageCards.filter((c) => !(c.caption ?? "").trim());
  if (todo.length === 0) return;

  // 先吃缓存
  const pending: MediaCardItem[] = [];
  for (const card of todo) {
    const url = (card.thumbnailUrl || card.mediaUrl || "").trim();
    const cached = captionCache.get(url);
    if (cached) {
      card.caption = cached;
    } else {
      pending.push(card);
    }
  }
  if (pending.length === 0) return;

  const cfg = resolvePrimaryLlmClientConfig();
  if (!cfg || !cfg.model || !modelSupportsVision(cfg.model)) {
    console.info(
      "[image-caption] 主模型不支持视觉或未配置，跳过图片描述生成（回退旧渲染）",
    );
    return;
  }

  const timeoutMs = opts.timeoutMs ?? CAPTION_TIMEOUT_MS;
  const describe = opts.describeFn ?? ((cards, ms) => describeImagesWithVlm(cards, cfg, ms, opts.locationHint));
  try {
    const captions = await describe(pending, timeoutMs);
    for (let i = 0; i < pending.length; i++) {
      const caption = tidyCaption((captions[i] ?? "").slice(0, CAPTION_MAX_CHARS));
      if (!caption) continue;
      pending[i].caption = caption;
      const url = (pending[i].thumbnailUrl || pending[i].mediaUrl || "").trim();
      if (url) {
        // 简单 LRU：超限时淘汰最早写入的条目
        if (captionCache.size >= CAPTION_CACHE_MAX) {
          const first = captionCache.keys().next().value;
          if (first !== undefined) captionCache.delete(first);
        }
        captionCache.set(url, caption);
      }
    }
  } catch (err) {
    console.info(
      `[image-caption] 图片描述生成失败（回退旧渲染）: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** 轻量的 LLM 客户端配置（避免外部依赖注入，直接与主对话同源） */
type LlmConfig = { apiKey: string; baseURL: string; model: string };

/**
 * 一次批量调用视觉模型：按顺序注入 N 张图，要求输出 N 句描述的 JSON 数组。
 * 返回数组与入参卡片一一对应（解析失败/缺项的槽位为空串）。
 * locationHint 存在时作为拍摄位置参考注入（仅在画面一致时才可带出地点）。
 */
async function describeImagesWithVlm(
  cards: MediaCardItem[],
  cfg: LlmConfig,
  timeoutMs: number,
  locationHint?: string,
): Promise<string[]> {
  // 1) 逐张取出图片字节（本地 PNG 优先直读文件；远程地址限时下载）
  const images: Array<{ base64: string; mime: string }> = [];
  for (const card of cards) {
    const img = await loadImageBytes((card.thumbnailUrl || card.mediaUrl || "").trim());
    if (!img) break; // 有图拿不到就无法保证"第 i 张描述 = 第 i 张图"，整批放弃
    images.push(img);
  }
  if (images.length === 0) return [];
  if (images.length !== cards.length) return [];

  // 2) 组装消息：一张图一个 image_url part，顺序即卡片顺序
  const hint = (locationHint ?? "").trim();
  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    {
      type: "text",
      text:
        `下面按顺序给出 ${images.length} 张图片，请为每张图片生成一句中文描述，输出 JSON。` +
        (hint ? `\n拍摄位置参考：${hint}（仅当画面与之一致时才可在描述中提及地点）。` : ""),
    },
    ...images.map((img) => ({
      type: "image_url" as const,
      image_url: { url: `data:${img.mime};base64,${img.base64}` },
    })),
  ];

  const client = new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL,
    timeout: timeoutMs,
    maxRetries: 0,
  });
  const resp = await client.chat.completions.create({
    model: cfg.model,
    messages: [
      {
        role: "system",
        content: [
          "你是为照片写「氛围感」短句的助手。用户按顺序给若干张图片，你要为每张图片写一句传达照片感觉的中文短句。",
          "",
          "要求：",
          "1. 写这张照片给人的感觉：光线、色调、氛围、情绪、瞬间的生动感（参考语感：「逆光把发丝照得发亮，整个画面都是夏天的松弛感」），让没看图的人也能感受到那一刻。",
          "2. 禁止写成穿搭/物品清单：不要「女子穿…」「身穿…」「扎着…」「戴着…」式的外观罗列，也不要「服装+发型+氛围」的公式化拼接；人物只作为画面氛围的一部分自然带出，重心永远在感觉上。",
          "3. 感觉必须来自画面真实可见的内容，可适度渲染但不臆造：不编造具体人名、品牌；能可靠判断场景时（如外滩、山林步道）可把地点自然融入氛围（如「外滩夜风里的霓虹」），判断不了就不提地点。",
          "4. 每句 12~30 个字的陈述句，收尾干净完整，不要以冒号、破折号等悬空标点结尾；不要任何前缀（如「这张图片」「图中」「一张」开头），不要编号。",
          `5. 只输出 JSON：{"captions":["第1张描述","第2张描述",...]}，数组长度必须等于图片张数，顺序与图片顺序一致；不要输出 JSON 以外的任何文字。`,
        ].join("\n"),
      },
      { role: "user", content },
    ],
    temperature: 0.3,
    ...bypassChatRequestExtras(),
  });

  const raw = (resp.choices?.[0]?.message?.content ?? "").trim();
  return parseCaptionArray(raw, images.length);
}

/** 解析模型输出的 JSON（容忍 ```json 围栏与前后杂文本），返回定长数组。 */
function parseCaptionArray(raw: string, expected: number): string[] {
  const out: string[] = new Array<string>(expected).fill("");
  if (!raw) return out;
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(text) as { captions?: unknown };
    const list = Array.isArray(parsed?.captions) ? parsed.captions : [];
    for (let i = 0; i < expected && i < list.length; i++) {
      const v = String(list[i] ?? "").trim();
      if (v) out[i] = tidyCaption(v.slice(0, CAPTION_MAX_CHARS));
    }
  } catch {
    // JSON 损坏：整批放弃（返回全空），调用方走无 caption 回退
  }
  return out;
}

/**
 * 读取单张图片字节 → base64。
 * - `/agent/images/{actorId}/{file}`：直读本地 `data/images/{actorId}/{file}`；
 * - http(s)：限时下载。
 * 读取/下载/解码任何一步失败返回 null。
 */
async function loadImageBytes(
  url: string,
): Promise<{ base64: string; mime: string } | null> {
  try {
    let buf: Buffer;
    let mime = "image/png";
    if (url.startsWith(LOCAL_IMAGE_URL_PREFIX)) {
      const rel = url.slice(LOCAL_IMAGE_URL_PREFIX.length);
      // 路径穿越防护：只允许单层 actorId + 纯文件名
      const m = rel.match(/^([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)$/);
      if (!m) return null;
      const full = join(process.cwd(), "data", "images", m[1], m[2]);
      buf = await readFile(full);
    } else if (/^https?:\/\//i.test(url)) {
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) return null;
      const ct = res.headers.get("content-type") ?? "";
      if (ct.startsWith("image/")) mime = ct.split(";")[0].trim();
      buf = Buffer.from(await res.arrayBuffer());
    } else {
      return null;
    }
    if (buf.length === 0) return null;
    // 压缩到宽 640 的 JPEG，控制视觉 token 消耗；sharp 不可用时原样发送
    const compressed = await compressImage(buf, mime);
    return compressed ?? { base64: buf.toString("base64"), mime };
  } catch {
    return null;
  }
}

/** 用 sharp 压缩图片（宽 ≤640，JPEG q80）。失败返回 null（调用方回退原图）。 */
async function compressImage(
  buf: Buffer,
  mime: string,
): Promise<{ base64: string; mime: string } | null> {
  try {
    const { default: sharp } = await import("sharp");
    const out = await sharp(buf, { animated: false })
      .rotate()
      .resize({ width: 640, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return { base64: out.toString("base64"), mime: "image/jpeg" };
  } catch {
    return mime.startsWith("image/") ? { base64: buf.toString("base64"), mime } : null;
  }
}
