/**
 * 经纬度 → 中文地址（国内优先 BigDataCloud；可选高德 AMAP_WEB_KEY）。
 * 不使用 IP 地理库。
 */

export type ReverseGeocodeHit = {
  city: string;
  /** 区/县，如「红花岗区」 */
  district: string;
  region: string;
  country: string;
  timezone: string;
  label: string;
  source: string;
};

const FETCH_TIMEOUT_MS = 8_000;

async function fetchJson(url: string, init?: RequestInit): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      console.warn("[ReverseGeocode] HTTP 失败:", url, res.status);
      return null;
    }
    return (await res.json()) as unknown;
  } catch (error) {
    console.warn("[ReverseGeocode] 请求异常:", url, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** WGS-84 → GCJ-02（调用高德前需转换） */
export function wgs84ToGcj02(lat: number, lon: number): { latitude: number; longitude: number } {
  if (outOfChina(lat, lon)) return { latitude: lat, longitude: lon };
  const a = 6378245.0;
  const ee = 0.006693421622965943;
  let dLat = transformLat(lon - 105.0, lat - 35.0);
  let dLon = transformLon(lon - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI);
  dLon = (dLon * 180.0) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { latitude: lat + dLat, longitude: lon + dLon };
}

function outOfChina(lat: number, lon: number): boolean {
  return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLon(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  return ret;
}

async function fetchTimezone(latitude: number, longitude: number): Promise<string> {
  const tzUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m&timezone=auto&forecast_days=1`;
  const tzData = (await fetchJson(tzUrl, { headers: { Accept: "application/json" } })) as {
    timezone?: string;
  } | null;
  return tzData?.timezone?.trim() || "Asia/Shanghai";
}

function buildLabel(parts: { district?: string; city?: string; region?: string; country?: string }): string {
  return [parts.district, parts.city, parts.region, parts.country].filter(Boolean).join(" · ");
}

async function reverseFromBigDataCloud(
  latitude: number,
  longitude: number,
): Promise<ReverseGeocodeHit | null> {
  const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=zh`;
  const data = (await fetchJson(url, { headers: { Accept: "application/json" } })) as Record<
    string,
    unknown
  > | null;
  if (!data) return null;

  const district = String(data.locality ?? "").trim();
  const city = String(data.city ?? "").trim();
  const region = String(data.principalSubdivision ?? "").trim();
  const country = String(data.countryName ?? "").trim();
  if (!city && !district && !region) return null;

  const timezone = await fetchTimezone(latitude, longitude);
  return {
    city,
    district,
    region,
    country,
    timezone,
    label: buildLabel({ district, city, region, country }),
    source: "bigdatacloud",
  };
}

async function reverseFromAmap(latitude: number, longitude: number): Promise<ReverseGeocodeHit | null> {
  const key = process.env.AMAP_WEB_KEY?.trim();
  if (!key) return null;

  const gcj = wgs84ToGcj02(latitude, longitude);
  const url = `https://restapi.amap.com/v3/geocode/regeo?key=${encodeURIComponent(key)}&location=${gcj.longitude},${gcj.latitude}&extensions=base&output=JSON`;
  const data = (await fetchJson(url)) as {
    status?: string;
    regeocode?: {
      addressComponent?: Record<string, string | string[] | undefined>;
    };
  } | null;
  if (!data || data.status !== "1" || !data.regeocode) return null;

  const comp = data.regeocode.addressComponent ?? {};
  const pick = (v: string | string[] | undefined): string => {
    if (Array.isArray(v)) return String(v[0] ?? "").trim();
    return String(v ?? "").trim();
  };

  const district = pick(comp.district) || pick(comp.township);
  const city = pick(comp.city) || pick(comp.district);
  const region = pick(comp.province);
  const country = pick(comp.country) || "中国";
  if (!city && !district && !region) return null;

  const timezone = await fetchTimezone(latitude, longitude);
  return {
    city,
    district,
    region,
    country,
    timezone,
    label: buildLabel({ district, city, region, country }),
    source: "amap",
  };
}

/** 根据 GPS 经纬度反查地址（国内准确；不依赖 IP）。 */
export async function reverseGeocodeCoordinates(
  latitude: number,
  longitude: number,
): Promise<ReverseGeocodeHit | null> {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const amap = await reverseFromAmap(latitude, longitude);
  if (amap) return amap;

  return reverseFromBigDataCloud(latitude, longitude);
}
