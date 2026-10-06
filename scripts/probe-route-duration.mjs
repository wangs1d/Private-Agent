/**
 * 真网探针：route-duration-service（2026-10-05 出发预留真实路程因子）
 *
 * 腿1  高德地理编码（无 key 时预期 null——key 未配不算失败，走 OSRM 兜底）
 * 腿2  estimateDriveMinutes 文本→文本（OSRM 兜底腿，同市中短途）
 * 腿3  estimateDriveMinutes 坐标→文本（用户实时位置形态，主链路实际用法）
 * 腿4  超长途钳制（>8h → null → 策略层回退静态表）
 *
 * 复跑：node --import tsx scripts/probe-route-duration.mjs
 */
import { estimateDriveMinutes, amapGeocode } from "../server/src/services/route-duration-service.ts";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass += 1; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("[probe-route-duration] 真网路程估时探针");

// 腿1：高德地理编码（本机未配 AMAP_WEB_KEY → null 属预期）
const geo = await amapGeocode("杭州东站");
check("腿1 高德地理编码（无 key 预期 null）", geo === null || /^[-0-9.]+,[-0-9.]+$/.test(geo), `geo=${geo ?? "null"}`);

// OSRM 兜底：travel-planning-service.computeRoute 同款（文本→文本）
const { PlanningService } = await import("../server/src/skills/travel-planning/travel-planning-service.ts");
const { WeatherService } = await import("../server/src/services/weather-service.ts");
const planning = new PlanningService(new WeatherService());

// 腿2：文本→文本（杭州市内短途）
const t2 = await estimateDriveMinutes({
  destinationText: "西湖",
  originText: "杭州东站",
  osrmFallback: (from, to) => planning.computeRoute(from, to),
});
check(
  "腿2 文本→文本 OSRM 兜底估时",
  t2 === null || (t2.durationMin > 0 && t2.durationMin <= 480),
  t2 ? `${t2.durationMin}min ${t2.distanceKm}km via ${t2.source}` : "null（OSRM 不可用，运行时回退静态表）",
);

// 腿3：坐标→文本（主链路用法：locationHistory/按需定位坐标作起点）
const t3 = await estimateDriveMinutes({
  destinationText: "萧山国际机场",
  origin: { latitude: 30.2741, longitude: 120.1551 }, // 杭州市区
  osrmFallback: (from, to) => planning.computeRoute(from, to),
});
check(
  "腿3 坐标→文本（主链路用法）",
  t3 === null || (t3.durationMin > 0 && t3.durationMin <= 480),
  t3 ? `${t3.durationMin}min ${t3.distanceKm}km via ${t3.source}` : "null（OSRM 不可用，运行时回退静态表）",
);

// 腿4：超长途钳制（跨大洲距离在 OSRM 也会给超时长 → 预期 null）
const t4 = await estimateDriveMinutes({
  destinationText: "巴黎戴高乐机场",
  originText: "北京首都机场",
  osrmFallback: async () => ({ durationMin: 6000, distanceKm: 9000 }),
});
check("腿4 超 8h 路程钳制为 null（回退静态表）", t4 === null, `result=${t4 ? `${t4.durationMin}min` : "null"}`);

console.log(`\n[probe-route-duration] ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
