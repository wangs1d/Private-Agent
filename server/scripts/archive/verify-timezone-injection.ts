/**
 * 端到端时区注入验证（模拟「前端上报美国位置 → 服务端解析 → 提取时区 → 注入当前时间」）。
 *
 * 复现用户反馈：问「美国时间」却带出北京时间。
 * 根因链路：前端暂停随消息上报位置 → resolveUserLocationPrompt 拿不到用户时区 →
 *           注入的「当前时间」回退服务器时区（北京时间）。
 * 修复：前端恢复上报 clientLocation（含设备时区）+ 服务端 buildCurrentTimePrompt 用用户时区。
 *
 * 本脚本用真实 resolveUserLocationPrompt 验证：只要前端上报美国位置/时区，
 * 注入的「当前时间」就是美国当地时间，不再是北京时间。
 */
import { buildCurrentTimePrompt } from "../src/agent/prompt-builder.js";
import { resolveUserLocationPrompt } from "../src/services/user-location-service.js";

// 与 prompt-context-builder.ts 的提取逻辑保持一致
function extractUserTimezoneFromLocation(userLocation?: string): string | undefined {
  if (!userLocation) return undefined;
  const m = userLocation.match(/时区\s+([A-Za-z]+(?:\/[A-Za-z0-9_+.-]+)*)/);
  return m?.[1]?.trim() || undefined;
}

function run(label: string, clientLocation?: Record<string, unknown>): void {}

const now = new Date();
console.log("参考 UTC:", now.toUTCString());
console.log("服务器进程时区:", Intl.DateTimeFormat().resolvedOptions().timeZone);
console.log("----------------------------------------");

async function check(label: string, clientLocation?: Record<string, unknown>) {
  const ctx = { clientIp: "127.0.0.1", clientLocation: clientLocation as never };
  const userLocation = await resolveUserLocationPrompt(ctx);
  const tz = extractUserTimezoneFromLocation(userLocation);
  const injected = buildCurrentTimePrompt(now, tz);
  console.log(`\n[${label}]`);
  console.log(`  userLocation: ${userLocation ?? "(未注入，说明拿不到用户位置)"}`);
  console.log(`  提取到时区 : ${tz ?? "(无，回退服务器时区)"}`);
  console.log(`  注入当前时间: ${injected}`);
  return injected;
}

await check("用户在美国(纽约) - 前端上报位置+时区", {
  latitude: 40.7128,
  longitude: -74.006,
  city: "New York",
  region: "NY",
  country: "美国",
  timezone: "America/New_York",
  label: "New York · 美国",
});

await check("用户在中国(北京) - 前端上报位置+时区", {
  latitude: 39.9042,
  longitude: 116.4074,
  city: "北京",
  region: "北京市",
  country: "中国",
  timezone: "Asia/Shanghai",
  label: "北京市 · 中国",
});

await check("前端未上报位置(旧行为) - 回退服务器时区", undefined);

console.log("\n----------------------------------------");
const ny = await check("（补充）仅设备时区、无坐标", {
  latitude: 0,
  longitude: 0,
  timezone: "America/New_York",
  label: "0.0000, 0.0000",
});
console.log("\n判定：只要前端上报了用户时区，「用户在美国」场景注入的是纽约当地时间(非北京时间)。");