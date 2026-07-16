import type { ShoppingPlatformAdapter } from "./types.js";
import { TaobaoAdapter, TmallAdapter } from "./taobao-adapter.js";
import { JdAdapter } from "./jd-adapter.js";
import { MeituanAdapter } from "./meituan-adapter.js";

export * from "./types.js";

/**
 * 已实现的平台 adapter 注册表。
 *
 * MVP 阶段实现 4 个 adapter（taobao/tmall/jd/meituan）。
 * 其余平台（pdd/dianping/douyin）在 `chat-tools.ts` 的 enum 中列出，
 * 但调用时 `getAdapter` 返回 null，由 service 层返回"暂不支持"错误。
 */
const adapters: Record<string, ShoppingPlatformAdapter> = {
  taobao: new TaobaoAdapter(),
  tmall: new TmallAdapter(),
  jd: new JdAdapter(),
  meituan: new MeituanAdapter(),
};

/** 获取平台 adapter；未实现时返回 null。 */
export function getShoppingPlatformAdapter(platform: string): ShoppingPlatformAdapter | null {
  return adapters[platform] ?? null;
}

/** 列出所有已实现 adapter 的 platform 名。 */
export function listSupportedPlatforms(): string[] {
  return Object.keys(adapters);
}
