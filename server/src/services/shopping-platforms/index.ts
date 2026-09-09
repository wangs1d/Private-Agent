import type { ShoppingPlatformAdapter } from "./types.js";
import { TaobaoAdapter, TmallAdapter } from "./taobao-adapter.js";
import { JdAdapter } from "./jd-adapter.js";
import { MeituanAdapter } from "./meituan-adapter.js";
import { PddAdapter } from "./pdd-adapter.js";
import { DouyinAdapter } from "./douyin-adapter.js";
import { DamaiAdapter } from "./damai-adapter.js";
import { MaoyanAdapter } from "./maoyan-adapter.js";

export * from "./types.js";

/**
 * 已实现的平台 adapter 注册表。
 *
 * 综合电商：taobao / tmall / jd / meituan（外卖闪购）/ pdd / douyin；
 * 演出票务：damai（大麦）/ maoyan（猫眼）——实名制演出不代填证件信息，
 * 下单前由 agent 向用户确认观演人已在其账号内。
 */
const adapters: Record<string, ShoppingPlatformAdapter> = {
  taobao: new TaobaoAdapter(),
  tmall: new TmallAdapter(),
  jd: new JdAdapter(),
  meituan: new MeituanAdapter(),
  pdd: new PddAdapter(),
  douyin: new DouyinAdapter(),
  damai: new DamaiAdapter(),
  maoyan: new MaoyanAdapter(),
};

/** 获取平台 adapter；未实现时返回 null。 */
export function getShoppingPlatformAdapter(platform: string): ShoppingPlatformAdapter | null {
  return adapters[platform] ?? null;
}

/** 列出所有已实现 adapter 的 platform 名。 */
export function listSupportedPlatforms(): string[] {
  return Object.keys(adapters);
}
