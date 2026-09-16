/**
 * 目的地代表性封面单测（无外部网络）：
 *
 * 行程卡海报背景的保证链：wikipediaLeadImage（zh/en 条目主图并行）→
 * wikidataLeadImage（P18，wikipedia 主站被墙时的形象照通道）→
 * fetchDestinationCover（地理锚定/文本搜索）→ 失败返回 undefined
 * （诚实降级，不放与目的地不符的图）。
 *
 * 覆盖：
 *   - 封面缓存库：名称归一化命中（杭州市≈杭州）、落盘持久化、空 URL 拒绝；
 *   - 条目主图：zh 优先、旗/徽标类文件名拒绝、过小图拒绝；
 *   - Wikidata P18：imageinfo 补全真实 URL、旗帜文件名拒绝；
 *   - resolveDestinationCover：主图命中写缓存（二次调用零请求）、全链失败
 *     返回 undefined 且不写缓存。
 *
 * fetch 全部替换为本地桩，MediaWiki/Wikidata 响应结构照真实 API 造。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// 封面缓存指向临时目录：单例在 import 时读环境变量，必须先设再动态 import
const coverDir = mkdtempSync(join(tmpdir(), "dest-cover-test-"));
process.env.TRAVEL_MEDIA_STORE_DIR = coverDir;

const { destinationCoverStore } = await import(
  "../src/skills/travel-planning/travel-destination-cover-store.js"
);
const { PlanningService } = await import(
  "../src/skills/travel-planning/travel-planning-service.js"
);

// ==================== fetch 桩 ====================

type FetchStub = (url: string) => Promise<Response>;

const realFetch = globalThis.fetch;
let fetchCalls = 0;
let stub: FetchStub | null = null;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** pageimages 响应（单页） */
function pageImageResponse(file: string, width: number, height: number): Response {
  return jsonResponse({
    query: {
      pages: {
        "11800": {
          title: "测试目的地",
          pageimage: file,
          thumbnail: { source: `https://upload.wikimedia.org/${file}`, width, height },
        },
      },
    },
  });
}

function emptyPagesResponse(): Response {
  return jsonResponse({ query: { pages: {} } });
}

/** wikidata wbgetentities 响应：实体的 P18（图像）声明 */
function wikidataP18Response(file: string | null): Response {
  const entities = file
    ? { Q4970: { claims: { P18: [{ mainsnak: { datavalue: { value: file } } }] } } }
    : {};
  return jsonResponse({ entities });
}

/** commons imageinfo 响应：文件真实 URL 与尺寸 */
function imageInfoResponse(file: string, width = 4000, height = 2600): Response {
  return jsonResponse({
    query: {
      pages: {
        "-1": {
          title: `File:${file}`,
          imageinfo: [{
            thumburl: `https://upload.wikimedia.org/thumb/${file}`,
            url: `https://upload.wikimedia.org/original/${file}`,
            width,
            height,
          }],
        },
      },
    },
  });
}

function installStub(fn: FetchStub | null): void {
  stub = fn;
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    if (!stub) throw new Error("测试未配置 fetch 桩");
    fetchCalls++;
    return stub(String(input));
  }) as typeof fetch;
}

after(() => {
  globalThis.fetch = realFetch;
});

const service = new PlanningService();
// IPv6 定向路径是真实 socket：单测里替换为恒空桩（fetch 桩已覆盖全部响应语义，
// 两路并发中默认出口必胜，v6 桩不影响断言；未命中用例两路皆空 → 走诚实降级）
(service as unknown as { wikimediaV6Json(u: string, t: number): Promise<null> }).wikimediaV6Json =
  async () => null;
const leadImage = (dest: string): Promise<string | null> =>
  (service as unknown as { wikipediaLeadImage(d: string): Promise<string | null> }).wikipediaLeadImage(dest);
const wikidataImage = (dest: string): Promise<string | null> =>
  (service as unknown as { wikidataLeadImage(d: string): Promise<string | null> }).wikidataLeadImage(dest);
const resolveCover = (dest: string): Promise<string | undefined> =>
  (service as unknown as {
    resolveDestinationCover(d: string): Promise<string | undefined>;
  }).resolveDestinationCover(dest, { latitude: 30.25, longitude: 120.17 });

// ==================== 封面缓存库 ====================

describe("destinationCoverStore (封面缓存)", () => {
  it("名称归一化命中：杭州市 / 带空白 都命中 杭州 的封面", () => {
    destinationCoverStore.set("杭州市", { url: "https://x/westlake.jpg", source: "wikipedia-lead" });
    assert.deepEqual(destinationCoverStore.get("杭州"), {
      url: "https://x/westlake.jpg",
      source: "wikipedia-lead",
    });
    assert.deepEqual(destinationCoverStore.get(" 杭州 "), {
      url: "https://x/westlake.jpg",
      source: "wikipedia-lead",
    });
  });

  it("落盘持久化：临时目录出现 destination-covers.json 且含归一化键", () => {
    const file = join(coverDir, "destination-covers.json");
    assert.ok(existsSync(file));
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, { url: string }>;
    assert.equal(raw["杭州"]?.url, "https://x/westlake.jpg");
  });

  it("空 URL 拒绝写入：不产生坏缓存条目", () => {
    destinationCoverStore.set("空图目的地", { url: "  ", source: "wikimedia" });
    assert.equal(destinationCoverStore.get("空图目的地"), null);
  });
});

// ==================== 维基百科条目主图 ====================

describe("wikipediaLeadImage (条目主图)", () => {
  it("zh 主图命中：zh 优先于 en（并行查询，zh 胜出）", async () => {
    installStub(async (url) => {
      if (url.includes("zh.wikipedia.org")) {
        return pageImageResponse("West_Lake_Leifeng_Pagoda.jpg", 1200, 800);
      }
      return pageImageResponse("Hangzhou_EN.jpg", 1200, 800);
    });
    assert.equal(await leadImage("杭州"), "https://upload.wikimedia.org/West_Lake_Leifeng_Pagoda.jpg");
  });

  it("旗帜类文件名拒绝：en 的真实形象照补位", async () => {
    installStub(async (url) => {
      if (url.includes("zh.wikipedia.org")) {
        return pageImageResponse("Flag_of_the_People's_Republic_of_China.svg", 1200, 800);
      }
      return pageImageResponse("Hangzhou_West_Lake_panorama.jpg", 1200, 800);
    });
    assert.equal(await leadImage("杭州"), "https://upload.wikimedia.org/Hangzhou_West_Lake_panorama.jpg");
  });

  it("过小主图拒绝：宽 < 640 视为杂项插图而非形象照，返回 null", async () => {
    installStub(async () => pageImageResponse("Small_photo.jpg", 320, 200));
    assert.equal(await leadImage("小图目的地"), null);
  });
});

// ==================== Wikidata P18 ====================

describe("wikidataLeadImage (P18 形象照)", () => {
  it("pageimages 全空时 P18 补位：zhwiki 实体 → commons 真实 URL", async () => {
    installStub(async (url) => {
      if (url.includes("wikidata.org")) return wikidataP18Response("Hangzhou_West_Lake.jpg");
      if (url.includes("commons.wikimedia.org")) return imageInfoResponse("Hangzhou_West_Lake.jpg");
      return emptyPagesResponse(); // zh/en pageimages 均未命中
    });
    assert.equal(await wikidataImage("杭州"), "https://upload.wikimedia.org/thumb/Hangzhou_West_Lake.jpg");
  });

  it("P18 是旗帜/徽标类文件名时拒绝，不放非实拍图", async () => {
    installStub(async (url) => {
      if (url.includes("wikidata.org")) return wikidataP18Response("Flag_of_China.svg");
      throw new Error(`P18 被拒后不应再请求: ${url}`);
    });
    assert.equal(await wikidataImage("旗图目的地"), null);
  });
});

// ==================== 封面解析主链 ====================

describe("resolveDestinationCover (解析主链)", () => {
  it("主图命中：返回 URL 并写缓存，二次调用零网络请求", async () => {
    installStub(async (url) => {
      if (url.includes("zh.wikipedia.org")) {
        return pageImageResponse("Forbidden_City_Shenwumen_Gate.jpg", 1200, 798);
      }
      throw new Error(`不应发起其它请求: ${url}`);
    });
    const url = await resolveCover("北京封面测试甲");
    assert.equal(url, "https://upload.wikimedia.org/Forbidden_City_Shenwumen_Gate.jpg");
    assert.equal(destinationCoverStore.get("北京封面测试甲")?.url, url);

    const before = fetchCalls;
    assert.equal(await resolveCover("北京封面测试甲"), url);
    assert.equal(fetchCalls, before, "缓存命中不应再发请求");
  });

  it("全链未命中：返回 undefined 且不写缓存（诚实降级，不放不符图）", async () => {
    installStub(async () => emptyPagesResponse());
    const url = await resolveCover("荒芜封面测试乙");
    assert.equal(url, undefined);
    assert.equal(destinationCoverStore.get("荒芜封面测试乙"), null);
  });
});
