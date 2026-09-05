/**
 * 用户位置：仅接受前端 GPS 经纬度 + 逆地理编码，不使用 IP 地理库。
 */

import type { ClientGeoContext, ClientLocationWire } from "../types/client-location.js";
import { reverseGeocodeCoordinates } from "./reverse-geocode-service.js";

export type UserGeoInfo = {
  timezone: string;
  country: string;
  region: string;
  district: string;
  city: string;
  ip: string;
  source: string;
  latitude?: number;
  longitude?: number;
};

/** @deprecated 兼容旧名 */
export type UserTimezoneInfo = UserGeoInfo;

function buildLabel(info: {
  district?: string;
  city?: string;
  region?: string;
  country?: string;
}): string {
  return [info.district, info.city, info.region, info.country].filter(Boolean).join(" · ");
}

async function geoFromClientLocation(loc: ClientLocationWire): Promise<UserGeoInfo | null> {
  const rev = await reverseGeocodeCoordinates(loc.latitude, loc.longitude);
  if (!rev) {
    const fallbackLabel = loc.label?.trim() || buildLabel(loc);
    if (!fallbackLabel) return null;
    return {
      timezone: loc.timezone?.trim() || "Asia/Shanghai",
      country: loc.country?.trim() ?? "",
      region: loc.region?.trim() ?? "",
      district: loc.district?.trim() ?? "",
      city: loc.city?.trim() ?? "",
      ip: "",
      source: "client-gps",
      latitude: loc.latitude,
      longitude: loc.longitude,
    };
  }

  return {
    timezone: rev.timezone,
    country: rev.country,
    region: rev.region,
    district: rev.district,
    city: rev.city,
    ip: "",
    source: rev.source,
    latitude: loc.latitude,
    longitude: loc.longitude,
  };
}

/** 解析用户位置：必须有前端上报的 GPS；无则返回 null（不回退 IP）。 */
export async function resolveUserGeo(ctx?: ClientGeoContext): Promise<UserGeoInfo | null> {
  if (!ctx?.clientLocation) return null;
  return geoFromClientLocation(ctx.clientLocation);
}

export function formatUserLocationLabel(info: UserGeoInfo): string {
  const label = buildLabel(info);
  if (label) return label;
  if (info.latitude != null && info.longitude != null) {
    return `${info.latitude.toFixed(4)}, ${info.longitude.toFixed(4)}`;
  }
  return "未知";
}

export async function resolveUserLocationPrompt(ctx?: ClientGeoContext): Promise<string | undefined> {
  const info = await resolveUserGeo(ctx);
  if (!info) return undefined;
  const label = formatUserLocationLabel(info);
  if (!label || label === "未知") return undefined;
  const coordNote =
    info.latitude != null && info.longitude != null
      ? `（GPS ${info.latitude.toFixed(4)}, ${info.longitude.toFixed(4)}）`
      : "";
  const tzNote = info.timezone ? `，时区 ${info.timezone}` : "";
  // 「禁止反问」约束（2026-07-29 反问 bug 的根治位）：位置是系统后台注入的背景，
  // 措辞必须压制 LLM 把它当话题向用户确认（"你是不是在 XX"）。
  return `用户当前所在地${coordNote}：${label}${tzNote}。此为系统后台注入的定位背景（前端 GPS + 逆地理编码），回答位置/天气/时间类问题时必须直接以此为准，禁止向用户反问或确认所在位置，也不要主动提及本条来源。`;
}

/** @deprecated IP 定位已移除 */
export async function getUserGeoByIP(_clientIp?: string): Promise<UserGeoInfo | null> {
  return null;
}

export const getUserTimezoneByIP = getUserGeoByIP;
